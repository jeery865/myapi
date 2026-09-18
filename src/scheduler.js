// 后台定时任务。
//
// 有两个承诺，光靠"用户打开控制台时顺手做"是靠不住的，必须有人在后台按时做：
//
//   1. **账号状态的自动恢复**。撞一次滚动窗口限流后，状态带着 recoverAt 挂在账号上，
//      到期后选号逻辑会自动放行 —— 但状态**显示**还停在旧值上，用户看不到它已经好了，
//      于是就会去点刷新（或者干脆把号当成废号）。这里到期后用 0 消耗的探活实测一次
//      （GET /api/v1/freebuff/session，只读快照，不创建 session、不扣额度），
//      把状态刷成真实值。这就是"不用手动刷新"的另一半。
//
//   2. **模型表刷新**。refreshCatalog() 原来只在服务启动时（server.js）和控制台轮询
//      /state 时（admin.js）被调用 —— 也就是说"每 6 小时自动刷新"实际上只在
//      **有人开着控制台页面**的时候才发生。定时叫它一次，这个承诺才算数。
//
// 实现上用一个 60 秒的基准 tick、各自比较"距上次多久了"，而不是给每个任务各起一个
// setInterval：用户在控制台改了复检间隔**立刻生效**，不用重启定时器。改设置不用重算
// 任何东西，只在下一个 tick 生效。
import { store, providerOf } from './store.js';
import { probeAccount } from './probe.js';
import { probeOpencodeKey } from './opencode.js';
import { refreshCatalog } from './models.js';
import { needsRecheck, recheckIntervalMs, advanceRescue, providerHasNoProbe } from './account-status.js';
import { getUpstream } from './upstreams.js';
import { probeUpstreamKey } from './protocols/index.js';

const TICK_MS = 60 * 1000;
// 模型表自己按 REFRESH_MS（6 小时）节流，这边只要保证"总有人定期叫它"。
// 30 分钟叫一次：节流窗口最多晚 30 分钟生效，代价可以忽略。
const CATALOG_CALL_MS = 30 * 60 * 1000;
// 一次 tick 里最多复检多少个号。号池可能有几千个（控制台支持分批取回），
// 一轮全探完既慢又会把上游打出一串并发，所以分摊到多轮。
const RECHECK_BATCH = 20;

let timer = null;
let lastRecheck = 0;
let lastCatalogCall = 0;
let busy = false;

/** 找出"到期了、需要实测一下"的账号 */
function pendingAccounts(now = Date.now()) {
  return store.accounts.filter(
    (a) =>
      a.enabled !== false &&
      a.token &&
      a.token.length > 8 &&
      // 探不了活的上游（cline）不进常规复检：复检对它们只会返回 null、什么也不做，
      // 但会一直占着下面那个 batch 名额 —— 号池一多就会把真正能复检的 freebuff/opencode
      // 号挤在队列后面永远轮不到。状态的可恢复性由它们自己的 recoverAt 保证
      // （failureStatus 会给它们写冷却，见 src/account-status.js 的 NO_PROBE_PROVIDERS）。
      !providerHasNoProbe(providerOf(a)) &&
      needsRecheck(a, now)
  );
}

/**
 * 复检一批到期账号。**串行**跑：并发探活会被上游按出口 IP 记一笔，
 * 而这里本来就是低优先级的后台活，不值得为它抢配额。
 * 返回实际复检了几个。
 */
export async function recheckAccounts(batch = RECHECK_BATCH) {
  const pending = pendingAccounts().slice(0, batch);
  if (!pending.length) return 0;
  let done = 0;
  for (const acct of pending) {
    const prov = providerOf(acct);
    try {
      // 只探这两种内置上游。cline 没有 per-account 的只读端点（原版也没有），
      // 自定义上游没有统一的探活接口 —— 硬发一个最小请求过去等于拿用户的额度做体检。
      // 所以它们一律返回 null（cline 更是连 pendingAccounts 都进不来）。
      const result =
        prov === 'opencode'
          ? await probeOpencodeKey(acct.token)
          : prov === 'freebuff'
            ? await probeAccount(acct.token)
            : null;
      if (result && result.state) {
        store.setAccountStatus(acct.id, { ...result, source: 'recheck' });
        done += 1;
      }
    } catch {
      /* 单个号探测失败不影响其它号，下一轮还会再轮到它 */
    }
  }
  if (done) console.log(`[scheduler] 复检了 ${done} 个到期账号（队列里还有 ${Math.max(0, pendingAccounts().length)} 个）`);
  return done;
}

/** 跑一轮。测试可以直接调它，不用等定时器。 */
export async function runSchedulerTick() {
  if (busy) return; // 上一轮还没跑完（上游慢时会这样），别叠起来
  busy = true;
  try {
    const now = Date.now();
    const every = recheckIntervalMs();
    if (every && now - lastRecheck >= every) {
      lastRecheck = now;
      await recheckAccounts();
    }
    if (now - lastCatalogCall >= CATALOG_CALL_MS) {
      lastCatalogCall = now;
      await refreshCatalog().catch(() => {});
    }
  } finally {
    busy = false;
  }
}

// ───────────────────────────── 快速抢救期（独立细粒度 tick）
// 60 秒那个 tick 撑不住「3 秒~3 分钟」的精度（3~60 秒那段会被量化成"下一分钟"），
// 所以这里单独起一个 3 秒的 tick 专扫 retryAt <= now 的账号。它**只**管抢救期账号，
// 不动 60 秒 tick 的语义（它的文档注释解释了为什么用统一 tick，别推翻）。
// 探活串行（同 recheck）：并发会被上游按出口 IP 记一笔；用 busy 防重入。
const RESCUE_TICK_MS = 3 * 1000;
let rescueTimer = null;
let rescueBusy = false;

/** 按 provider 选探活方式。freebuff 走 raw（不带 recoverAt），否则抢救期会误判 hint。 */
async function probeAccountForRescue(acct) {
  const prov = providerOf(acct);
  if (prov === 'opencode') return probeOpencodeKey(acct.token);
  if (prov === 'freebuff') return probeAccount(acct.token, { raw: true });
  // cline 探不了活：原版 cline2api 只有一个 `/v1/health`，而且它不校验凭据、只报账号数量，
  // 拿不到任何 per-account 的结论。返回 null 让 probeAndAdvanceRescue 走
  // 「拿不到结论 → 立刻结束抢救期交回常规复检」那条分支。
  // （不过正常情况下 cline 根本不会进抢救期 —— failureStatus 对 NO_PROBE_PROVIDERS
  //   直接写 recoverAt，见 src/account-status.js。这里是第二道保险。）
  if (prov === 'cline') return null;
  // 必须排除**内置**上游：getUpstream() 对内置的也返回对象，而内置的 baseUrl 是空串，
  // 拿 probeUpstreamKey 去打只会造出一个假的失败结果。
  const up = getUpstream(prov);
  if (up && !up.builtin) return probeUpstreamKey(up, acct.token);
  return null;
}

/**
 * 探一次活，用 advanceRescue 把结果折算成新状态落盘。每次只动一个号、串行。
 *
 * 死锁不变量（防 QA 证实的卡死 bug）：本函数处理完任意一个号后，它的 retryAt
 * 必须「要么被推进到未来、要么被清成 null」——绝不允许停留在过去。一旦停留在过去，
 * needsRecheck 会因为 retryAt 仍在而永远返回 false（常规复检永不接管），
 * runRescueTick 又因为 retryAt <= now 每个 tick 都捞它却原地不动，账号永久卡在
 * 「抢救中」。下面两个出口都遵守这条：探活有结论 → advanceRescue 要么给未来 retryAt
 * 要么清 null；探活拿不到结论（provider 未注册 / 探活能力缺失，result 为 null 或没有
 * state）→ 视为「这个号根本没法探活」，立即结束抢救期交回常规复检（不写 recoverAt、
 * 不冻结：我们并不知道它坏没坏，凭空冻结是设计里否决过的行为）。
 */
async function probeAndAdvanceRescue(acct, settings, probeFn = probeAccountForRescue) {
  const result = await probeFn(acct);
  if (!result || !result.state) {
    // 探活拿不到结论：不是「账号坏」，而是「这个号没法探活」。继续随机重试对它毫无意义，
    // 直接结束抢救期、交回常规复检（清 retryAt/retryCount），至少不会让它永远卡住。
    // 注意：不写 recoverAt、不冻结 —— 凭空冻结是设计里否决过的行为。
    store.setAccountStatus(acct.id, { ...acct.status, retryCount: 0, retryAt: null, source: 'rescue-no-probe' });
    return;
  }
  store.setAccountStatus(acct.id, advanceRescue(acct.status, result, settings));
}

/**
 * 跑一轮抢救期扫描。测试可直接调它，不用等定时器。
 * probeFn 仅测试用：注入「无结论」结果以复现 / 覆盖 null 与无 state 两种分支。
 */
export async function runRescueTick(probeFn = probeAccountForRescue) {
  if (rescueBusy) return; // 上一轮还没跑完，别叠起来
  rescueBusy = true;
  try {
    const now = Date.now();
    const settings = store.settings;
    const due = store.accounts.filter(
      (a) => a.enabled !== false && a.token && a.token.length > 8 && a.status?.retryAt && Date.parse(a.status.retryAt) <= now
    );
    for (const acct of due) {
      try {
        await probeAndAdvanceRescue(acct, settings, probeFn);
      } catch {
        /* 单个号探活失败不影响其它号，下一轮还会再轮到它 */
      }
    }
  } finally {
    rescueBusy = false;
  }
}

export function startRescueScheduler() {
  if (rescueTimer) return;
  rescueTimer = setInterval(() => {
    runRescueTick().catch(() => {});
  }, RESCUE_TICK_MS);
  if (typeof rescueTimer.unref === 'function') rescueTimer.unref();
  console.log('[scheduler] 已启动：快速抢救期 3 秒一跳，扫描到点的重试账号');
}

export function stopRescueScheduler() {
  if (rescueTimer) clearInterval(rescueTimer);
  rescueTimer = null;
}

export function startScheduler() {
  if (timer) return;
  lastRecheck = Date.now();
  lastCatalogCall = Date.now();
  timer = setInterval(() => {
    runSchedulerTick().catch(() => {});
  }, TICK_MS);
  // 别让定时器把进程钉住 —— 测试里起临时服务、以及 Ctrl-C 退出都靠这个
  if (typeof timer.unref === 'function') timer.unref();
  const mins = store.settings?.accountRecheckMinutes;
  console.log(
    `[scheduler] 已启动：账号状态复检 ${Number(mins) > 0 ? `${mins} 分钟一次（可在控制台改）` : '已关闭'}，模型表每 ${CATALOG_CALL_MS / 60000} 分钟叫一次`
  );
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

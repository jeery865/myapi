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
import { needsRecheck, recheckIntervalMs } from './account-status.js';

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
    (a) => a.enabled !== false && a.token && a.token.length > 8 && needsRecheck(a, now)
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
      // 只探这两种内置上游。自定义上游没有统一的探活接口，
      // 硬发一个最小请求过去等于拿用户的额度做体检 —— 不做。
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

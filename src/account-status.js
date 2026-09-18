// 账号状态的判定与生命周期。
//
// 存在的原因：上游把两件完全不同的事都塞进 HTTP 429 ——
//   ① 滚动窗口限流（rateLimitsByModel 的 recentCount 顶到 limit）
//   ② 当天额度真的用完
// 前者窗口滚过去就恢复，是**分钟级**；后者要等重置，是**小时级**。
// 原来这里一刀切成"额度用完"，于是"撞了一下 rpm"在控制台上看起来跟号废了没区别，
// 用户只能手动点刷新才敢再用 —— 这就是要修掉的东西。
//
// 判定原则：**拿不到证据就别吓人**。默认按"临时限流"处理，只有正文明确给出一个
// 很长的 retry 时长时才判"额度用完"。反过来的默认（先判耗尽）会在检出
// 错误时把好号拉黑，而拉黑的代价远大于多试一次。
import { store } from './store.js';

/**
 * 判定"临时限流"还是"真额度耗尽"的分界线。
 * 15 分钟：滚动窗口通常是一分钟级，重试提示若是 15 分钟以上，基本不是窗口滚动能解释的。
 */
export const EXHAUSTED_THRESHOLD_MS = 15 * 60 * 1000;

/**
 * 「快速抢救期」随机重试窗口的下限 / 上限（毫秒）。
 * 3 秒 ~ 3 分钟，**每次失败重新均匀随机**一个值（不是给账号定一个固定值）。
 * 两个端点写成具名常量放在一处：下游（失败回写 / 后台探活推进）只读这两个，别散落魔数。
 * 窗口**不做成可配置** —— 用户只要求"重试上限"可调，把范围收敛住，
 * 避免有人把下限调成 0 或上限调成几小时把抢救期拖没意义。
 */
export const RESCUE_DELAY_MIN_MS = 3 * 1000;
export const RESCUE_DELAY_MAX_MS = 180 * 1000;

/**
 * 均匀随机一个抢救期重试间隔（毫秒）。
 * rng 默认 Math.random；测试可注入确定性随机源（见 tests/unit.mjs），
 * 这样既能断言区间、又能断言"多次调用结果不同"而绝不 flaky。
 */
export function randomRescueDelay(rng = Math.random) {
  const r = Math.min(0.999999, Math.max(0, rng()));
  return Math.round(RESCUE_DELAY_MIN_MS + r * (RESCUE_DELAY_MAX_MS - RESCUE_DELAY_MIN_MS));
}

/**
 * 从 429 正文里挖出上游建议的等待时长。
 * 两种已知格式：
 *   {"retryAfterMs": 15506639}        —— luna 等模型
 *   "try again in 1h 2m 3s"           —— 部分模型的文案
 * 挖不到返回 null（**不要**拿它当 0，null 表示"不知道"，0 表示"立刻可重试"）。
 */
export function parseRetryAfterMs(text, status) {
  const t = String(text || '');
  const jm = t.match(/"retryAfterMs"\s*:\s*(\d+)/);
  if (jm) {
    const ms = Number(jm[1]);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  const hm = t.match(/retry[-_ ]?after["'\s:]*\s*(\d+)/i);
  if (hm) {
    const secs = Number(hm[1]);
    if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  }
  const m = t.match(/try again in\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i);
  if (m && (m[1] || m[2] || m[3])) {
    const ms = (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) * 1000;
    if (ms > 0) return ms;
  }
  // 上游用自然语言说明"当天/每日"额度用完了 —— 没有具体时长，但语义明确
  if (/daily|per[- ]day|today'?s?\s+(quota|limit)|当日|当天|每日/.test(t)) {
    return EXHAUSTED_THRESHOLD_MS;
  }
  return null;
}

/**
 * 429 的细分。返回 'throttled'（临时限流，会自己好）或 'rate_limited'（额度用完）。
 * 非 429 由调用方处理，这里只负责 429 这一类的分流。
 */
export function classifyRateLimit(text, status) {
  if (status !== 429) return 'rate_limited';
  const hint = parseRetryAfterMs(text, status);
  if (hint !== null && hint >= EXHAUSTED_THRESHOLD_MS) return 'rate_limited';
  return 'throttled';
}

/**
 * 这类状态要冷却多久。返回值同时用来算状态的 recoverAt。
 * 拿不到提示时给一个短默认值：临时限流按 1 分钟（滚动窗口的量级），
 * 额度耗尽按 30 分钟（等重置，但别一等等到第二天 —— 中途上游可能就放开了）。
 */
export function cooldownFor(state, text, status) {
  const hint = parseRetryAfterMs(text, status);
  if (hint !== null) return Math.min(Math.max(hint, 5 * 1000), 6 * 3600 * 1000);
  return state === 'throttled' ? 60 * 1000 : 30 * 60 * 1000;
}

/**
 * 给账号状态补一个 recoverAt（到期时间戳）。
 * 只有"会自己好"的状态才带它 —— token_invalid / banned 这种是终态，
 * 给了 recoverAt 反而会让它看起来像能自动恢复。
 */
const TRANSIENT_STATES = new Set(['throttled', 'rate_limited', 'ip_capped', 'model_locked', 'network_error', 'upstream_error', 'blocked']);

/**
 * 没有 0 消耗探活能力的上游。目前只有 cline：
 * 原版 cline2api 只有一个 `/v1/health`（还不校验凭据、只报账号数量），
 * 拿不到任何 per-account 的只读快照。
 *
 * 对这类上游，「快速抢救期」是**空转**：抢救期的全部意义就是"到点自动探一次"，
 * 探不了就只能每 3 秒空跑一次、然后被 rescue-no-probe 分支立刻结束 ——
 * 结果是账号状态上连一个 recoverAt 都没有，界面上永远是个消不掉的红黄灯
 * （isStatusLive 对"没有 recoverAt 的状态"一律当有效），而选号会一直把它压在最后。
 *
 * 所以它们不进抢救期，直接按上游给的时长冷却：
 *   - 上游给了明确 retry 提示 → 按提示（在 failureStatus 里已先行处理）
 *   - 拿不到提示 → 用**原版自己的**兜底值：429 五分钟、其它 60 秒
 *     （对齐参考项目 worker.js 的 parseCooldown）
 * 想给新上游加进来之前，先确认它真的没有可用的只读探活端点。
 */
const NO_PROBE_PROVIDERS = new Set(['cline']);

/** 这个 provider 是不是"探不了活"的那类（控制台/调度器也用它来决定要不要复检） */
export function providerHasNoProbe(provider) {
  return NO_PROBE_PROVIDERS.has(String(provider || ''));
}

/** 无探活上游的冷却兜底时长；返回 null 表示"这个上游能探活，别走这条路" */
function fixedCooldownFor(provider, state) {
  if (!providerHasNoProbe(provider)) return null;
  return state === 'throttled' || state === 'rate_limited' ? 5 * 60 * 1000 : 60 * 1000;
}

export function withRecoverAt(status, text, httpStatus) {
  if (!status || typeof status !== 'object') return status;
  if (!TRANSIENT_STATES.has(status.state)) return status;
  const ms = cooldownFor(status.state, text, httpStatus);
  return { ...status, recoverAt: new Date(Date.now() + ms).toISOString(), cooldownMs: ms };
}

/**
 * 真实请求撞到 transient 失败时调用：决定进入「快速抢救期」还是按上游提示冷却/冻结。
 * `prior` 是该账号当前已存的状态（用它的 retryAt / retryCount 判断抢救期是否进行中）。
 *
 * 三条路（详见交付设计）：
 *   - 终态（token_invalid / banned ……）：不写 recoverAt，和旧行为一致；
 *   - transient **且**上游给了明确时长 hint（parseRetryAfterMs 非 null，含"当日额度用完"的
 *     15 分钟分支）：尊重上游，直接按 hint 写 recoverAt（沿用 clamp [5s, 6h]），不走随机抢救；
 *   - transient 且拿不到 hint：进入 / 继续「快速抢救期」——
 *       没有进行中的抢救期 → retryCount=1 开一个新的；
 *       已有进行中（prior.retryAt 还在未来）→ 不重置 retryCount，只把 retryAt 重新随机一次
 *       （避免后台主动探活和真实流量撞在一起把计数搅乱）。
 * accountRetryMax <= 0 视为「关闭抢救期」：退回旧行为（withRecoverAt，按 cooldownFor 写 recoverAt）。
 *
 * `provider` 用来分流"探不了活"的上游（见 NO_PROBE_PROVIDERS）：它们不进抢救期，
 * 直接按上游提示或原版兜底时长写 recoverAt。抢救期和 accountRetryMax 对它们无意义。
 */
export function failureStatus(status, text, httpStatus, prior = null, provider = '') {
  if (!TRANSIENT_STATES.has(status.state)) return status; // 终态：不写 recoverAt
  // 先看上游有没有明确提示（含"当日/每日额度用完"那个 15 分钟分支）。
  // 注意这一步**不能**放在下面 max<=0 的判断之后：旧代码走的是 withRecoverAt → cooldownFor，
  // 而 cooldownFor 第一件事也是 parseRetryAfterMs 并用同一个 clamp —— 两者等价，
  // 提前到这里不改变任何既有行为，只是让"探不了活的"分支能排在前面。
  const hint = parseRetryAfterMs(text, httpStatus);
  if (hint !== null) {
    const ms = Math.min(Math.max(hint, 5 * 1000), 6 * 3600 * 1000);
    return { ...status, recoverAt: new Date(Date.now() + ms).toISOString(), cooldownMs: ms };
  }
  const fixed = fixedCooldownFor(provider, status.state);
  if (fixed !== null) {
    return { ...status, recoverAt: new Date(Date.now() + fixed).toISOString(), cooldownMs: fixed };
  }
  const max = Number(store.settings?.accountRetryMax);
  if (!Number.isFinite(max) || max <= 0) return withRecoverAt(status, text, httpStatus); // 抢救期关闭 → 旧行为
  const now = Date.now();
  const inRescue = Boolean(prior && prior.retryAt && Date.parse(prior.retryAt) > now);
  const retryCount = inRescue ? Number(prior.retryCount || 0) : 1;
  return { ...status, retryCount, retryAt: new Date(now + randomRescueDelay()).toISOString() };
}

/**
 * 后台 3 秒 tick 探活回来后，根据探活结果推进「快速抢救期」。纯函数：给旧状态 +
 * 本次探活结果 + 设置，算出新状态，不碰网络/落盘（落盘交给调用方）。
 *
 *   - 探活成功 → 清掉 retryCount / retryAt，抢救期结束；
 *   - 探活拿到上游 hint（或终态）→ 尊重上游：hint 写 recoverAt（clamp [5s,6h]）、
 *     终态直接落定，两者都结束抢救；
 *   - transient 且无 hint 失败 → retryCount++：
 *       还 <= 上限 → 继续（再 random 一个 retryAt）；
 *       超过上限 → 抢救期结束：accountFreezeEnabled 开 → 按 accountFreezeMinutes 写
 *       recoverAt 冻结（带 frozen 标记）；关（默认）→ 状态保持原样、清掉 retryAt/retryCount，
 *       交回 5 分钟常规复检（needsRecheck 因此恢复为 true）。
 */
export function advanceRescue(prior, probe, settings) {
  const now = Date.now();
  // probe 在 raw 模式下可能带 rawText（上游原文，可能含账号信息）。它只用于在本函数里
  // parse 一次上游 retry 提示，绝不能经 {...probe} 展开写进 store，所以先把字段剥离，
  // 后续所有 {...p, ...} 都用剥离后的版本（rawText 不会出现在返回值里）。
  const { rawText: _rawText, ...p } = probe;
  if (p.state === 'ok') {
    return { ...p, retryCount: 0, retryAt: null, source: 'rescue' };
  }
  // 关键：hint 只从上游原文（rawText）里挖，绝不用 p.detail —— 那是我们自己写的
  // 格式化文案（如"当天 session 额度已用完"含"当天"，会误触发 15 分钟分支），拿它当
  // 证据等于凭空造 hint，违反设计 C。rawText 为空 = "没证据" → 继续随机重试。
  const hint = parseRetryAfterMs(_rawText || '', p.httpStatus);
  if (hint !== null) {
    const ms = Math.min(Math.max(hint, 5 * 1000), 6 * 3600 * 1000);
    return { ...p, recoverAt: new Date(now + ms).toISOString(), cooldownMs: ms, retryCount: 0, retryAt: null, source: 'rescue' };
  }
  if (!TRANSIENT_STATES.has(p.state)) {
    // 终态（token_invalid / banned …）：直接落定，结束抢救，不进随机重试
    return { ...p, retryCount: 0, retryAt: null, source: 'rescue' };
  }
  const max = Number(settings?.accountRetryMax) || 0;
  const rc = Number(prior?.retryCount || 0) + 1;
  if (rc > max) {
    if (settings?.accountFreezeEnabled) {
      const mins = Math.max(1, Math.min(1440, Number(settings.accountFreezeMinutes) || 30));
      const ms = mins * 60 * 1000;
      return { ...p, recoverAt: new Date(now + ms).toISOString(), cooldownMs: ms, frozen: true, retryCount: 0, retryAt: null, source: 'rescue' };
    }
    // 默认不冻结：状态保持原样，交回常规复检
    return { ...p, retryCount: 0, retryAt: null, source: 'rescue' };
  }
  return { ...p, retryCount: rc, retryAt: new Date(now + randomRescueDelay()).toISOString(), source: 'rescue' };
}

/**
 * 这个状态现在还"算数"吗？
 * 带 recoverAt 且已过期的 → 不算数了，等价于没标记。**这就是"不用手动刷新"的实现**：
 * 选号、控制台灯泡、健康计数都走这个函数，时间一到账号自己就绿了。
 */
export function isStatusLive(status, now = Date.now()) {
  if (!status || !status.state) return false;
  if (status.state === 'ok') return false; // ok 不算"坏"，调用方要的是"是否处于坏状态"
  if (!status.recoverAt) return true; // 终态（token_invalid / banned）永远算数
  const at = Date.parse(status.recoverAt);
  if (!Number.isFinite(at)) return true;
  return at > now;
}

/** 这个账号当前是不是处于"有效的坏状态" */
export function isAccountBad(account, now = Date.now()) {
  return isStatusLive(account && account.status, now);
}

/**
 * 后台复检的候选：状态是"会自己好"的那种，而且 recoverAt 已经过了（或压根没到期概念），
 * 需要一次实测来确认到底恢复了没有。终态不在这里 —— 复检它们纯属浪费请求。
 */
export function needsRecheck(account, now = Date.now()) {
  const st = account && account.status;
  if (!st || !st.state || st.state === 'ok') return false;
  if (!TRANSIENT_STATES.has(st.state)) return false;
  // 正在「快速抢救期」的账号由专门的 3 秒 tick 负责探活，别让 5 分钟常规复检也来捞它
  // —— 否则会出现两套机制同时探同一个号、白白多打上游。抢救期结束（成功 / 超限交回 /
  // 封冻结）时 retryAt 会被清掉，那时 needsRecheck 自然恢复为 true，重新回到常规复检手里。
  // 兜底：retryAt 若因任何原因停留在过去（理论不该发生 —— runRescueTick 的死锁不变量
  // 保证它要么在未来、要么为 null），这里也当「抢救已结束」放行，避免账号永久卡死。
  if (st.retryAt) {
    const ra = Date.parse(st.retryAt);
    if (!Number.isFinite(ra) || ra > now) return false; // 真在抢救中（retryAt 在未来）→ 排除
    // 落在过去：当抢救已结束，放行给常规复检
  }
  if (!st.recoverAt) return true;
  const at = Date.parse(st.recoverAt);
  if (!Number.isFinite(at)) return true;
  return at <= now;
}

/** 后台复检时用得到：有没有配置成要复检 */
export function recheckIntervalMs() {
  const mins = Number(store.settings?.accountRecheckMinutes);
  if (!Number.isFinite(mins) || mins <= 0) return 0;
  return Math.min(Math.max(mins, 1), 1440) * 60 * 1000;
}

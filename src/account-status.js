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

export function withRecoverAt(status, text, httpStatus) {
  if (!status || typeof status !== 'object') return status;
  if (!TRANSIENT_STATES.has(status.state)) return status;
  const ms = cooldownFor(status.state, text, httpStatus);
  return { ...status, recoverAt: new Date(Date.now() + ms).toISOString(), cooldownMs: ms };
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

// 账号 0 消耗探活：GET /api/v1/freebuff/session（只读，不创建 session、不扣额度）。
// 判定表对齐上游 freebuff-session-api.ts 语义（和原项目 extract_freebuff.py 的 _check_one 一致）。
import { config } from './config.js';
import { httpJson } from './util.js';
import { learnFromQuotaSnapshot } from './models.js';
import { classifyRateLimit, withRecoverAt } from './account-status.js';

function formatQuota(rateLimits) {
  if (!rateLimits || typeof rateLimits !== 'object') return '';
  const rows = [];
  for (const [model, info] of Object.entries(rateLimits)) {
    if (!info || typeof info !== 'object') continue;
    const used = info.recentCount;
    const limit = info.limit;
    if (used == null || limit == null) continue;
    rows.push(`${model} ${used}/${limit}`);
  }
  return rows.join('；');
}

/** @returns {{state:string, verdict:string, detail:string, quota:string, httpStatus:number}} */
export async function probeAccount(token) {
  const resp = await httpJson(`${config.upstreamBase}/api/v1/freebuff/session`, {
    headers: {
      authorization: `Bearer ${token}`,
      // 官方只读额度快照头：带上它不会创建 session
      'x-freebuff-include-unused-rate-limits': '1',
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    timeoutMs: 25000,
  });

  const data = resp.data;
  const quota = formatQuota(data?.rateLimitsByModel);
  // 顺手把"上游确实在给这个号计量哪些模型"学下来 —— 这是 0 成本拿到的真可用性信号
  try {
    learnFromQuotaSnapshot(data?.rateLimitsByModel, data?.limitedModelOffers || data?.limitedOffers);
  } catch {
    /* 学不到就算了，不影响探活结果 */
  }
  const base = {
    quota,
    httpStatus: resp.status,
    accessTier: data?.accessTier || null,
    quotaModels: data?.rateLimitsByModel && typeof data.rateLimitsByModel === 'object' ? Object.keys(data.rateLimitsByModel) : [],
  };

  if (resp.status === 0) {
    return { ...base, state: 'network_error', verdict: '网络错误', detail: resp.error || '请求上游失败' };
  }
  if (resp.status === 401) {
    return { ...base, state: 'token_invalid', verdict: 'token 失效', detail: 'HTTP 401：authToken 无效或已被撤销（不是封号），重新登录即可' };
  }
  if (resp.status === 403) {
    const st = data?.status;
    if (st === 'banned') {
      return { ...base, state: 'banned', verdict: '已封禁', detail: 'HTTP 403 + banned：官方语义为终态，账号不可恢复' };
    }
    if (st === 'country_blocked') {
      return { ...base, state: 'country_blocked', verdict: '地区受限', detail: 'HTTP 403 + country_blocked：当前出口 IP 非美国' };
    }
    return { ...base, state: 'blocked', verdict: '访问被拒', detail: `HTTP 403：${JSON.stringify(data || resp.text).slice(0, 160)}` };
  }
  if (resp.status === 429) {
    // 429 ≠ "当天额度用完"。rateLimitsByModel 里的 recentCount/limit 是**滚动窗口**
    // 计数，窗口滚过去就恢复（分钟级）。所以这里按正文的重试提示分流，
    // 详见 src/account-status.js 开头。以前一律写成"当天额度已用完"，
    // 用户看一眼就以为号废了，只能手动再来刷一次。
    const state = classifyRateLimit(resp.text, 429);
    return withRecoverAt({
      ...base,
      state,
      verdict: state === 'throttled' ? '临时限流' : '额度用完',
      detail: state === 'throttled'
        ? `HTTP 429：上游正在限流（滚动窗口打满），稍后自动恢复${quota ? `（${quota}）` : ''}`
        : `HTTP 429：当天 session 额度已用完，等重置${quota ? `（${quota}）` : ''}`,
    }, resp.text, 429);
  }
  if (resp.status === 404) {
    return { ...base, state: 'ok', verdict: '存活', detail: `HTTP 404：当前无活跃 session，账号可用${quota ? `（${quota}）` : ''}` };
  }

  const st = data?.status;
  if (st === 'banned') return { ...base, state: 'banned', verdict: '已封禁', detail: '上游返回 status=banned（终态）' };
  if (st === 'country_blocked') return { ...base, state: 'country_blocked', verdict: '地区受限', detail: '出口 IP 非美国，免费模型受限' };
  if (st === 'rate_limited') return withRecoverAt({ ...base, state: 'rate_limited', verdict: '额度用完', detail: `当天 session 额度已用完${quota ? `（${quota}）` : ''}` }, resp.text, resp.status);
  if (st === 'model_locked') return withRecoverAt({ ...base, state: 'model_locked', verdict: '存活（被占用）', detail: `另一个模型的 session 占用中，稍后释放${quota ? `（${quota}）` : ''}` }, resp.text, resp.status);
  if (st === 'ip_capped') return withRecoverAt({ ...base, state: 'ip_capped', verdict: '存活（IP 满）', detail: '当前出口 IP 活跃用户过多，稍后重试' }, resp.text, resp.status);
  if (st === 'active') {
    return { ...base, state: 'ok', verdict: '存活（session 活跃）', detail: `model=${data?.model || '?'}, tier=${data?.accessTier || '?'}${quota ? `，${quota}` : ''}` };
  }
  if (st === 'none' || st === 'ended') {
    return { ...base, state: 'ok', verdict: '存活', detail: `0 消耗探测正常${quota ? `，${quota}` : ''}` };
  }
  if (resp.status >= 200 && resp.status < 300) {
    return { ...base, state: 'ok', verdict: '存活', detail: `HTTP ${resp.status}${st ? `, status=${st}` : ''}${quota ? `，${quota}` : ''}` };
  }
  return { ...base, state: 'unknown', verdict: '未知', detail: `HTTP ${resp.status}: ${String(resp.text || '').slice(0, 160)}` };
}

// Cline 的模型命名空间与目录。
//
// 为什么必须加前缀：Cline 的模型 id 和 freebuff 的**直接撞车** ——
//   cline:    deepseek/deepseek-v4-flash   ·  z-ai/glm-5.3-flash
//   freebuff: deepseek/deepseek-v4-flash   ·  z-ai/glm-5.3-flash
// 而 models.js 的 providerForModel() 对"认不出的 id"一律回落到 freebuff，
// 所以不加前缀的话 cline 的同名模型永远路由不过去，也永远调不通。
// 这和 opencode 当年用 opencode/ 前缀是同一个理由（见 models-opencode.js 顶部）。
//
// 发给 cline 引擎前要剥掉前缀 —— 引擎只认 Cline 官方的裸 id。
//
// 模型清单：**权威来源是随包引擎自己的 GET /v1/models**（vendor/cline-worker.js 内部
// 会去拉 Cline 官方 /v1/models，10 分钟缓存，失败回退它内置的那 7 条）。
// 下面那份 BUILTIN 只是个兜底快照，拉不到时别让控制台一个 cline 模型都不剩 ——
// 和 models-opencode.js 的 buildOpencodeCatalog(null) 同一个思路。
// 改 vendor 的 MODELS 时**记得同步这里**，否则兜底快照会慢慢失真。

/** 对外暴露时的命名空间，必须和 opencode/ 一样是 `<上游 id>/` */
export const CLINE_PREFIX = 'cline/';

/** 与 vendor/cline-worker.js 的 MODELS 保持一致（兜底快照，不是权威） */
export const CLINE_BUILTIN_MODELS = [
  'cline-free/deepseek-v4.1-flash',
  'deepseek/deepseek-v4-flash',
  'poolside/laguna-s-2.1:free',
  'cline-pass/glm-5.2',
  'cline-pass/deepseek-v4-flash',
  'cline-pass/qwen3.7-max',
  'z-ai/glm-5.3-flash',
];

/**
 * 明确免费的裸 id。
 *
 * 来源：Cline 官方 `GET /api/v1/ai/cline/recommended-models` 的 `free[]`，
 * 加上引擎内置 MODELS 里标了 cost:"free" 的那几个（2026-09-18 实拉确认）。
 * 规则之外还叠两条**形态**判据（见 isFreeClineModel）：`cline-free/` 前缀、`:free` 后缀 ——
 * 上游一直用这两个约定放新的免费模型，不靠名单也能跟上。
 *
 * 判错的代价是单向的：这里漏掉一个真免费的模型 → 它被判成 paid → 没勾「允许付费」的
 * key 用不了它（保守，可接受）；反过来多判一个免费 → 拿别人的付费额度去烧（不可接受）。
 * 所以**只在有明确证据时才往这个集合里加**。
 */
export const CLINE_FREE = new Set([
  'cline-free/deepseek-v4.1-flash',
  'cline-free/muse-spark-1.3-contributor',
  'deepseek/deepseek-v4-flash',
  'poolside/laguna-s-2.1:free',
  'z-ai/glm-5.3-flash',
]);

/** 需要付费订阅才行的前缀。命中就一定不是免费（上游回 403 insufficient_credits / 需订阅） */
const CLINE_PASS_PREFIX = 'cline-pass/';
/** 官方免费通道的前缀 */
const CLINE_FREE_PREFIX = 'cline-free/';

export function isClineModel(modelId) {
  return String(modelId || '').startsWith(CLINE_PREFIX);
}

/** 'cline/deepseek/deepseek-v4-flash' → 'deepseek/deepseek-v4-flash' */
export function stripClinePrefix(modelId) {
  const s = String(modelId || '');
  return s.startsWith(CLINE_PREFIX) ? s.slice(CLINE_PREFIX.length) : s;
}

export function withClinePrefix(bareId) {
  const s = String(bareId || '').trim();
  if (!s) return '';
  return s.startsWith(CLINE_PREFIX) ? s : CLINE_PREFIX + s;
}

/** 免费？传裸 id 或带前缀的都行。见 CLINE_FREE 上方的判据说明。 */
export function isFreeClineModel(modelId) {
  const bare = stripClinePrefix(modelId);
  if (!bare) return false;
  if (CLINE_FREE.has(bare)) return true;
  if (bare.startsWith(CLINE_FREE_PREFIX)) return true;
  if (bare.endsWith(':free')) return true;
  return false;
}

/** 需要 Cline 付费订阅 */
export function isClinePassModel(modelId) {
  return stripClinePrefix(modelId).startsWith(CLINE_PASS_PREFIX);
}

/**
 * 展示名：Cline 的 id 本身就是 `厂商/模型` 形态，末段就是模型名。
 * 不做花哨的翻译 —— 用户要的是"这个 id 叫什么"，不是重新起名。
 */
export function clineDisplayName(modelId) {
  const bare = stripClinePrefix(modelId);
  const seg = bare.split('/').pop() || bare;
  return seg.replace(/:(free|batch)$/, '');
}

export function clineNote(modelId) {
  const bare = stripClinePrefix(modelId);
  if (isClinePassModel(bare)) {
    return '需要 Cline 付费订阅（cline-pass）：没有订阅的账号调它会回 403，不是号坏了';
  }
  if (isFreeClineModel(bare)) {
    return '走 Cline 官方免费额度（cline-free 通道），不花账户余额；额度用完上游会回 429 并给出恢复时间';
  }
  if (/:batch$/.test(bare)) {
    return 'Cline 的批处理通道（:batch）：按 Cline 账户余额计费，需要在 key 上勾选「允许付费」';
  }
  return '按 Cline 账户余额计费，需要在 key 上勾选「允许付费」；免费账号调它会回 403 insufficient_credits';
}

/**
 * 从引擎给的 id 列表构造目录条目。拉不到就用内置兜底快照 ——
 * 免费模型是这个号池的主要用途，不能因为一次网络抖动就让控制台里一个 cline 模型都不剩。
 */
export function buildClineCatalog(liveIds) {
  const ids = Array.isArray(liveIds) && liveIds.length ? liveIds : CLINE_BUILTIN_MODELS;
  return ids.map((bare) => ({
    id: withClinePrefix(bare),
    bare,
    free: isFreeClineModel(bare),
    pass: isClinePassModel(bare),
    displayName: clineDisplayName(bare),
    note: clineNote(bare),
  }));
}

/** 没配默认模型时，cline 号池用哪个（引擎自己的 DEFAULT_MODEL） */
export function defaultClineModel() {
  return withClinePrefix('cline-free/deepseek-v4.1-flash');
}

// 对随包引擎 vendor/worker.js 做「下载后校正」。
//
// 为什么需要这么一层：vendor/worker.js 原样引用上游，但上游有一处**手写且没有
// 回收机制**的名单 —— PAUSED_MODELS。命中的模型会在引擎本地直接回
// unsupported_model，请求根本发不到上游；而官方早就把 deepseek/deepseek-v4-flash
// 恢复了（官方表里 availability=always、premium=false、在 standard 池，还被指定为
// Muse Spark 的兜底模型），引擎里那条 2026-08-18 的残留却一直在拦。
//
// 实测过「升级引擎」这条路走不通：上游 main 的 VERSION 同样是 1.8.10.3，
// PAUSED_MODELS 一字不差，所以 npm run update-worker 拉回来还是拦。
//
// 于是改成：下载之后按官方权威名单 FREEBUFF_PAUSED_FREE_MODEL_IDS 校正一次。
// 规则刻意只有减法（官方说「已经不撤了」才放开），因为**减法不可能新增拦截** ——
// 最坏情况也只是让请求照常发到上游、由上游给出它自己的答复。反过来替上游新增
// 暂停项则会改变现有行为，那种决定不该由这个脚本替用户做。

/** 引擎里那份名单的声明前缀。换写法就没法安全定位，届时直接放弃校正。 */
const DECL = 'const PAUSED_MODELS = new Set([';

/**
 * 用户看到的错误文案。放在这个模块里只有一个理由：让它可测。
 * 这段话是用户唯一能拿到的线索（引擎原本只回一句 `unsupported_model`），
 * 必须有"是引擎本地拒的"和"下一步做什么"两块信息，别在重构里悄悄丢一半。
 */
export function enginePausedMessage(modelId) {
  return (
    `随包引擎 vendor/worker.js 把 ${modelId} 列进了它本地的暂停名单，所以这一步没发到上游（不是上游拒的）。` +
    `跑一次 npm run update-worker 会按官方 FREEBUFF_PAUSED_FREE_MODEL_IDS 校正这份名单 —— ` +
    `已经恢复上架的会被自动放开。校正后仍然被拦，说明官方确实把它撤下了：` +
    `上游对撤下的模型是**静默降级到默认模型**，这里宁可明确报错，免得你以为在用 A 其实拿的是 B。`
  );
}

/**
 * 从已标识的区块里取出当前列出的 id（保持原有顺序，去重）。
 * 只认「一行一个双引号字符串」这种形状，看不懂的行原样忽略 ——
 * 忽略等于不动它，不会误放开。
 */
function readIds(body) {
  const ids = [];
  for (const raw of body.split('\n')) {
    const m = raw.replace(/\/\/.*$/, '').trim().match(/^"([^"]+)"\s*,?$/);
    if (m && !ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

/** 找到 `const PAUSED_MODELS = new Set([` 里那对方括号的范围 */
function findBlock(text) {
  const at = text.indexOf(DECL);
  if (at < 0) return null;
  const open = at + DECL.length - 1; // 指向 '['
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']') {
      depth--;
      if (!depth) return { at, open, close: i };
    }
  }
  return null;
}

/**
 * 按官方名单把引擎里已经恢复的模型从 PAUSED_MODELS 里摘掉。
 *
 * @param {string} text  vendor/worker.js 的全文
 * @param {string[]|null} officialPaused 官方 FREEBUFF_PAUSED_FREE_MODEL_IDS
 * @returns {{text: string, changed: boolean, removed: string[]} | null}
 *   返回 null = 这次没法（或不该）判断，调用方必须原样写回。
 */
export function unpauseRecoveredModels(text, officialPaused) {
  // 拿不到官方名单就什么都不做。**绝不能把 null 当空名单** —— 那会把还在撤下
  // 状态的模型（例如 minimax-m3）一起放开，而撤销下模型在官方那边的表现是
  // 「静默降级到默认模型」，用户会拿到一个不是他要的模型的回答。
  if (!Array.isArray(officialPaused) || officialPaused.length === 0) return null;
  if (typeof text !== 'string') return null;

  const block = findBlock(text);
  if (!block) return null;

  const listed = readIds(text.slice(block.open + 1, block.close));
  const removed = listed.filter((id) => !officialPaused.includes(id));
  if (!removed.length) return { text, changed: false, removed: [] };

  const kept = listed.filter((id) => officialPaused.includes(id));
  const rebuilt = [
    DECL,
    '  // ── 本段在每次 npm run update-worker 时按官方 FREEBUFF_PAUSED_FREE_MODEL_IDS',
    '  //    校正（见 src/vendor-patch.js）。上游那份是手写名单、没有回收机制：',
    '  //    模型恢复上架后条目会一直留着，请求会被引擎本地拦掉、根本发不到上游',
    '  //    （deepseek-v4-flash 就这么被误拦了一个月）。这里只做减法 —— 官方说',
    '  //    「已不撤下」的才放开，不会替上游新增暂停项。官方名单拉不到时本段不动。',
    ...kept.map((id) => `  ${JSON.stringify(id)},`),
    ']',
  ].join('\n');

  return { text: text.slice(0, block.at) + rebuilt + text.slice(block.close + 1), changed: true, removed };
}

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
// 于是改成：下载之后按官方权威名单 FREEBUFF_PAUSED_FREE_MODEL_IDS **整体对齐**一次 ——
// 官方恢复上架的自动放开，官方新撤下的自动拦住。引擎里那份手写残留不再有任何
// 权威性：它只被当作"当前值"，唯一真源是官方那份名单。拿不到官方名单（null）时
// 一个字都不动 —— 没有证据时绝不去改 vendor 文件。
//
// 为什么现在敢替上游「新增」拦截（早先只做减法）：因为官方撤下模型后，上游服务端
// 不会报错，而是**静默降级到默认模型** —— 客户端以为在用 A，其实拿回来的是 B 的回答。
// 那种沉默比一句明确的错误危险得多。所以这里选择跟官方名单保持完全一致。
// （运行时还有一道同样的检查，见 src/models.js 的 availabilityOf / checkModelAccess：
//   那份是每 6 小时自动刷新的，不依赖手动跑 update-worker。）

/** 引擎里那份名单的声明前缀。换写法就没法安全定位，届时直接放弃校正。 */
const DECL = 'const PAUSED_MODELS = new Set([';

/** 重建时写回名单上方的说明。措辞要说明"它是自动对齐的"，否则下一个人会来手改。 */
const NOTE = [
  '  // ── 本段由 src/vendor-patch.js 在每次 npm run update-worker 时按官方',
  '  //    FREEBUFF_PAUSED_FREE_MODEL_IDS **整体对齐**（恢复上架的自动放开、',
  '  //    新撤下的自动拦住），别手改 —— 改了下次更新就被覆盖，而且运行时不读它。',
  '  //    上游那份是手写名单、没有回收机制：模型恢复上架后条目会一直留着，',
  '  //    请求会被引擎本地拦掉、根本发不到上游（deepseek-v4-flash 就这样被误拦了一个月）。',
  '  //    官方名单拉不到时本段不动。',
];

/**
 * 用户看到的错误文案。放在这个模块里只有一个理由：让它可测。
 * 这段话是用户唯一能拿到的线索（引擎原本只回一句 `unsupported_model`），
 * 必须有"是引擎本地拒的"和"下一步做什么"两块信息，别在重构里悄悄丢一半。
 */
export function enginePausedMessage(modelId) {
  return (
    `随包引擎 vendor/worker.js 把 ${modelId} 列进了它本地的暂停名单，所以这一步没发到上游（不是上游拒的）。` +
    `这份名单每次 npm run update-worker 都会按官方 FREEBUFF_PAUSED_FREE_MODEL_IDS 整体对齐：` +
    `官方恢复上架就自动放开、官方撤下就自动拦住，不需要手动改；运行时还会另按每 6 小时自动刷新的官方名单再判一次。` +
    `如果它一直被拦，说明官方确实把它撤下了 —— 这种情况下上游不会报错，而是**静默降级到默认模型**，` +
    `这里宁可明确拦下，免得你以为在用 A 其实拿的是 B。`
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
 * 把引擎的 PAUSED_MODELS 与官方名单对齐（双向：放开已恢复的 + 拦住新撤下的）。
 *
 * @param {string} text  vendor/worker.js 的全文
 * @param {string[]|null} officialPaused 官方 FREEBUFF_PAUSED_FREE_MODEL_IDS
 * @returns {{text: string, changed: boolean, removed: string[], added: string[]} | null}
 *   返回 null = 这次没法（或不该）判断，调用方必须原样写回。
 *
 * 关于 null 与 [] 的区别，这里必须守住（见 src/model-source.js 的 parsePausedIds）：
 *   null  = 官方名单没解析出来 → 返回 null，一个字都不改；
 *   []    = 官方确实一条都没撤下 → 合法输入，等于把引擎那份清空。
 * 把 null 当 [] 会让"同步"变成"无脑清空"，而清空的后果是**放开所有拦截**。
 *
 * 输出是确定性的，且幂等：已经对齐过再跑一次会得到 changed=false。
 *   顺序 = 先保留引擎里原有顺序的命中项，再按官方顺序追加新增项；
 *   官方只是重排它自己的名单时不会引起改写（kept 保持引擎侧顺序、added 为空）。
 */
export function syncPausedModels(text, officialPaused) {
  if (!Array.isArray(officialPaused)) return null; // 看不懂就别动
  if (typeof text !== 'string') return null;

  const block = findBlock(text);
  if (!block) return null;

  const listed = readIds(text.slice(block.open + 1, block.close));
  const kept = listed.filter((id) => officialPaused.includes(id));
  const removed = listed.filter((id) => !officialPaused.includes(id));
  const added = officialPaused.filter((id) => !listed.includes(id));
  if (!removed.length && !added.length) return { text, changed: false, removed: [], added: [] };

  const rebuilt = [
    DECL,
    ...NOTE,
    ...[...kept, ...added].map((id) => `  ${JSON.stringify(id)},`),
    ']',
  ].join('\n');

  return {
    text: text.slice(0, block.at) + rebuilt + text.slice(block.close + 1),
    changed: true,
    removed,
    added,
  };
}

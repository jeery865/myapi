#!/usr/bin/env node
// 把 vendor/ 下的上游文件更新到最新（上游是单文件引擎，本项目不改它，只在外面套壳）。
// 用法: npm run update-worker
//
// 例外：worker.js 下载后会做一处**校正**——把引擎里已经恢复上架的模型从它那份手写的
// PAUSED_MODELS 摘掉（详见下方 unpauseRecovered）。上游那份名单没有回收机制，
// 残留会把请求在引擎本地拦掉；只靠升级引擎修不好，因为上游自己也还带着这条。
// 校正只有减法、且拿不到官方名单时不动文件。
//
// 每个目标都有多个镜像 + 重试 + 校验：以前只试一个地址、没超时也没重试，
// 网络抖一下就报"更新失败"，然后你以为已经是最新了。
import { writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchOfficialTable } from '../src/model-source.js';
import { unpauseRecoveredModels } from '../src/vendor-patch.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'pingmike2/freebuff2api-wokers';

const TARGETS = [
  {
    file: 'vendor/worker.js',
    urls: [
      `https://raw.githubusercontent.com/${REPO}/main/worker.js`,
      `https://cdn.jsdelivr.net/gh/${REPO}@main/worker.js`,
    ],
    check(text) {
      if (!text.includes('export default')) return '没有 export default，不像 worker.js';
      if (!/const VERSION = "/.test(text)) return '找不到 VERSION 常量';
      if (text.length < 40000) return `内容太短（${text.length}B）`;
      return null;
    },
    describe: (text) => (text.match(/const VERSION = "([^"]+)"/) || [])[1] || '?',
    finalize: unpauseRecovered,
  },
  {
    file: 'vendor/freebuff-models.json',
    // release 资产最新但有时很慢；仓库文件快但可能落后几天 —— 顺序就是优先级
    urls: [
      `https://github.com/${REPO}/releases/latest/download/freebuff-models.json`,
      `https://raw.githubusercontent.com/${REPO}/main/freebuff-models.json`,
      `https://cdn.jsdelivr.net/gh/${REPO}@main/freebuff-models.json`,
    ],
    check(text) {
      let json;
      try {
        json = JSON.parse(text);
      } catch (err) {
        return `不是合法 JSON：${err.message}`;
      }
      if (!Array.isArray(json.models) || !json.models.length) return '没有 models 数组';
      if (!json.pools?.premium) return '没有 pools.premium';
      return null;
    },
    describe: (text) => JSON.parse(text).generatedAt || '?',
    finalize: async (text, before) => {
      const repaired = await repairPools(text);
      return keepFresher(repaired, before) ?? repaired;
    },
  },
];

/**
 * 第三方生成的 freebuff-models.json 有个坑：2026-09 上游把「哪些模型算付费」的名单
 * 从字面量数组改成了从 catalog 派生的表达式（filter/map），它的生成器读不懂，
 * 于是 pools.premium 是空的 —— 9 个模型全被归进 standard。
 *
 * 而这份文件里的 premium 名单正是 models.js 的"只收紧"底表（bundledPremium）：
 * 远端那份可变 URL 上的表只准把模型往付费收紧、不准放宽。空掉就等于把这层保护拆了 ——
 * 一旦远端把付费模型说成免费，没勾「允许付费」的 key 就会真的去烧 premium 额度。
 *
 * 所以拉完之后用官方常量把额度池补齐。拿不到官方源就原样返回，绝不写坏文件。
 * 输出必须是确定性的（不打时间戳），否则每次跑都会和文件内容不等、"已是最新"永远不成立。
 */
async function repairPools(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return text; // check() 已经保证合法 JSON，这里只是防御
  }
  if (json?.pools?.premium?.length) return text; // 第三方这次是对的，别动它

  let official = null;
  try {
    official = await fetchOfficialTable();
  } catch (err) {
    console.warn(`! 官方常量源拉取失败，premium 名单补不齐：${err.message}`);
  }
  if (!official?.pools?.premium?.length) {
    console.warn('! premium 名单补不齐（官方源也没解析出东西）—— 文件保持原样；');
    console.warn('  注意此时 models.js 的「远端表只准收紧」底表会是空的。');
    return text;
  }

  const had = {
    premium: json?.pools?.premium?.length || 0,
    glm: json?.pools?.glm?.length || 0,
    standard: json?.pools?.standard?.length || 0,
  };
  const standard = (had.standard ? json.pools.standard : official.pools.standard).filter(
    (id) => !official.pools.premium.includes(id)
  );
  json.pools = {
    ...json.pools,
    premium: official.pools.premium,
    glm: had.glm ? json.pools.glm : official.pools.glm,
    standard,
  };
  if (!json.limits) json.limits = official.limits;
  if (!json.limitedOffer?.length) json.limitedOffer = official.limitedOffer;
  if (!json.deepseekFamily?.length) json.deepseekFamily = official.deepseekFamily;
  json.poolsRepairedFrom = 'official';
  console.log(
    `  · 额度池已用官方常量补齐：premium ${had.premium} → ${json.pools.premium.length}，` +
      `standard ${had.standard} → ${json.pools.standard.length}`
  );
  return JSON.stringify(json, null, 2) + '\n';
}

/**
 * vendor/worker.js 下载后的校正：把引擎里**已经恢复上架**的模型从它那份手写的
 * PAUSED_MODELS 里摘掉。
 *
 * 起因：引擎的暂停名单是上游手写的，没有回收机制。deepseek/deepseek-v4-flash 在
 * 官方恢复（availability=always、premium=false、standard 池、还被指定为 Muse Spark
 * 的兜底模型）之后，引擎里那条 2026-08-18 的残留还在拦它 —— 请求被引擎本地回掉，
 * 根本发不到上游。而只靠「升级引擎」修不好：上游 main 的 VERSION 同样是 1.8.10.3、
 * 名单一字不差，拉回来还是拦。
 *
 * 所以这里按官方权威名单 FREEBUFF_PAUSED_FREE_MODEL_IDS 校正一次。规则只有减法，
 * 且**拿不到官方名单就原样返回** —— 没有证据时不动 vendor 文件，这条必须守住。
 * 输出必须确定性（不打时间戳），否则每次跑都会和文件内容不等、"已是最新"永远不成立。
 */
async function unpauseRecovered(text, before = '') {
  let official = null;
  try {
    official = await fetchOfficialTable();
  } catch (err) {
    console.warn(`! 官方常量拉取失败，引擎暂停名单这次不校正：${err.message}`);
    return text;
  }
  const result = unpauseRecoveredModels(text, official?.paused);
  if (!result) {
    console.warn('! 没能定位引擎的 PAUSED_MODELS，跳过校正（vendor 按原样写入）');
    return text;
  }
  if (!result.changed) {
    console.log('  · 引擎暂停名单已与官方一致，无需校正');
    return text;
  }
  // 每次下载回来的都是上游那份（flash 还在里面），所以"要不要放开"每次都会成立；
  // 只有最终内容确实和本地不同才值得说一句，否则日志会让人以为改了什么。
  if (before === result.text) {
    console.log('  · 引擎暂停名单需要校正，结果与本地一致（无需改动）');
    return result.text;
  }
  console.log(`  · 已放开引擎误拦的模型：${result.removed.join('、')}`);
  return result.text;
}

/**
 * 别让「更新」变成「降级」。
 *
 * 模型表有三个源，顺序是 release 资产 → raw → jsdelivr。release 资产最新，但它在
 * github.com 上、本机未必连得通（实测这台机器直接 fetch failed），一失败就回落到
 * raw 里的**仓库快照** —— 那份可能落后几周，比仓库里现有的还旧。
 *
 * 2026-09-14 实测到过一次：模型表被从 9-14 倒回 8-11，丢掉 z-ai/glm-5.3-flash 等
 * 3 个在售模型，premium 底表从 11 项掉到 7 项 —— 那份底表是「只收紧」的保险，
 * 缺项等于对某些付费模型 fail-open。所以比一下 generatedAt：远端更旧就保留本地。
 * 拿不到日期就不判定（不能因为一方没写日期就拒绝一次正常的更新）。
 */
function keepFresher(remote, local) {
  const at = (t) => {
    try {
      return Date.parse(JSON.parse(t).generatedAt) || 0;
    } catch {
      return 0;
    }
  };
  const r = at(remote);
  const l = at(local);
  if (!r || !l || r >= l) return null;
  console.warn(`! 远端模型表比本地旧（${new Date(r).toISOString()} < ${new Date(l).toISOString()}）`);
  console.warn('  保留本地这份，不降级 —— 回落到 raw 的仓库快照时会这样，那份可能落后几周。');
  console.warn('  （下面那句「已是最新」指的就是保留了本地这份）');
  return local;
}

async function grab(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

let failed = 0;
for (const target of TARGETS) {
  const path = resolve(root, target.file);
  let before = '';
  try {
    before = await readFile(path, 'utf8');
  } catch {}

  let text = null;
  const notes = [];
  for (const url of target.urls) {
    for (let attempt = 1; attempt <= 2 && !text; attempt++) {
      try {
        const body = await grab(url);
        const bad = target.check(body);
        if (bad) {
          notes.push(`${new URL(url).host} 内容不对（${bad}）`);
          break; // 内容不对就换下一个源，重试同一个没意义
        }
        text = body;
      } catch (err) {
        notes.push(`${new URL(url).host} 第 ${attempt} 次：${err.name === 'AbortError' ? '超时' : err.message}`);
      }
    }
    if (text) break;
  }

  if (!text) {
    console.error(`✘ ${target.file} 更新失败`);
    for (const n of notes) console.error(`    ${n}`);
    failed++;
    continue;
  }
  // 上游内容到手之后、比对和落盘之前做收尾（模型表补额度池 + 拒绝降级、
  // worker.js 校正暂停名单）。收尾必须是确定性的，否则「已是最新」永远不成立。
  // before 也传进去：有的收尾需要对照本地现有版本才能判断该不该用远端这份。
  if (target.finalize) {
    try {
      const finalized = await target.finalize(text, before);
      if (finalized) text = finalized;
    } catch (err) {
      console.warn(`! ${target.file} 收尾处理失败，保持原样写入：${err.message}`);
    }
  }
  if (before === text) {
    console.log(`= ${target.file} 已是最新（${target.describe(text)}）`);
    continue;
  }
  await writeFile(path, text);
  const from = before ? (() => { try { return target.describe(before); } catch { return '?'; } })() : '（新文件）';
  console.log(`✔ ${target.file} ${from} → ${target.describe(text)}`);
  if (notes.length) for (const n of notes) console.log(`    （跳过：${n}）`);
}

if (failed) {
  console.error('\n有文件没更新成功，vendor 里还是旧版本 —— 重跑一次或者检查网络。');
  process.exitCode = 1;
} else {
  console.log('\n更新完了。跑一下 npm run check && npm test 确认没被上游改动搞坏。');
}

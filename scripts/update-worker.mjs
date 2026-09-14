#!/usr/bin/env node
// 把 vendor/ 下的上游文件更新到最新（上游是单文件引擎，本项目不改它，只在外面套壳）。
// 用法: npm run update-worker
//
// 每个目标都有多个镜像 + 重试 + 校验：以前只试一个地址、没超时也没重试，
// 网络抖一下就报"更新失败"，然后你以为已经是最新了。
import { writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchOfficialTable } from '../src/model-source.js';

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
    finalize: repairPools,
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
  // 上游内容到手之后、比对和落盘之前做收尾（目前只有模型表需要补额度池）。
  // 收尾必须是确定性的，否则"已是最新"这个判断会永远不成立。
  if (target.finalize) {
    try {
      const finalized = await target.finalize(text);
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

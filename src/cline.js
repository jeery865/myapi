// cline 上游的引擎适配层：把 Node 请求转成 vendor/cline-worker.js 的 fetch(request, env) 调用。
//
// 和 freebuff 那条（src/engine.js 的 buildEnv）同一个套路：引擎是一个单文件 Cloudflare
// Worker（`export default { async fetch(request, env) }`），我们不改它，只在外面套壳 ——
// 账号选择、优先级、降级都在我们这层做，所以每次只往 env 里注入**一个** token，
// 引擎内部的池子里就只有一个号，自然不会自己去轮询（见 engine.js 开头的说明）。
//
// 两条与 freebuff 不同的地方，都必须记住：
//
// 1. **Cline 会轮换 refreshToken。** 刷新 accessToken 时上游会签发一个新的 refreshToken
//    并作废旧的，而新的只留在引擎的内存里（`accounts[i].refreshToken`）、不落盘。
//    我们每请求注入的是 store 里的 token，进程一重启就会拿旧 token 去刷新 →
//    invalid_grant → **把好号自己判死**。所以这里装一个全局回调，把轮换结果写回库。
//    回调是 src/vendor-patch.js 插进引擎的（见那里的说明），装不上就退化成"轮换不留痕"。
//
// 2. **没有 0 消耗探活。** freebuff 有个只读的 /api/v1/freebuff/session 快照，cline 没有
//    （原版也只有 /v1/health，那个不校验凭据、只报账号数量）。所以 cline 的账号状态
//    完全由真实流量驱动，不要给它做后台探活 —— 详见 src/scheduler.js 的分支注释。
import { readFileSync } from 'node:fs';
import clineWorker from '../vendor/cline-worker.js';
import { store, providerOf } from './store.js';

/**
 * 从引擎源码里读两个诊断常量（VERSION / DEFAULT_MODEL）。
 * 读不到就返回 '?' —— 这只是控制台上的一行信息，绝不能让服务起不来。
 * 用 fs 读而不是 import：它们是模块内的 const，没有 export。
 */
function readEngineConst(name) {
  try {
    const text = readFileSync(new URL('../vendor/cline-worker.js', import.meta.url), 'utf8');
    return (text.match(new RegExp(`const ${name} = "([^"]+)"`)) || [])[1] || '?';
  } catch {
    return '?';
  }
}

export const CLINE_ENGINE_VERSION = readEngineConst('VERSION');
export const CLINE_ENGINE_DEFAULT_MODEL = readEngineConst('DEFAULT_MODEL');

/**
 * 引擎要的 env。
 *
 * - `CLINE_REFRESH_TOKEN`：**每请求只放一个号**。引擎支持多行（它自己会轮询），
 *   但轮询必须由我们这层管 —— 否则"钉住一个号用到失败""降级换号"这些策略全失效。
 * - `API_KEY`：引擎用它校验入站请求头（`Authorization: Bearer <key>`）。
 *   直接把网关已经校验过的那把 key 传进去，多 key 管理由我们负责 ——
 *   和 freebuff 的 FREEBUFF_API_KEY 完全同构。
 */
export function buildClineEnv(tokens, presentedKey) {
  return {
    CLINE_REFRESH_TOKEN: (Array.isArray(tokens) ? tokens : [tokens]).filter(Boolean).join('\n'),
    API_KEY: presentedKey || 'internal-key',
  };
}

// ─────────────────────────── refreshToken 轮换回写

const ROTATE_HOOK = '__clineWorkerOnRotate';
let missingWarned = false;

/**
 * 装上引擎的轮换回调。模块加载时调一次，幂等。
 *
 * 为什么用 globalThis 而不是让引擎 import 我们：引擎是上游的原文，我们**只在
 * 下载后插一行**（src/vendor-patch.js），插不了 import。挂 globalThis 的另一个好处是
 * 补丁没打上时这里完全不报错，只是轮换不被持久化而已（会退化成"重启后需要重新粘贴
 * refreshToken"），不会让服务起不来。
 */
export function installRotateHook() {
  if (globalThis[ROTATE_HOOK]?.__myapi) return;
  const hook = (prevToken, nextToken) => {
    try {
      // 用"注入时的那个 token"定位账号，**不要**用下标 —— 并发下引擎的池子会被别的
      // 请求重建，下标指到的可能是另一个号（那就会把 A 的新 token 写到 B 身上）。
      const prev = String(prevToken || '');
      const next = String(nextToken || '').trim();
      if (!prev || !next || prev === next) return;
      const acct = store.accounts.find((a) => providerOf(a) === 'cline' && a.token === prev);
      if (!acct) {
        if (!missingWarned) {
          missingWarned = true;
          console.warn('[cline] 引擎轮换了一个不在号池里的 refreshToken，已忽略（不会自动建号）');
        }
        return;
      }
      store.rotateAccountToken(acct.id, next);
      console.log(`[cline] 账号 ${acct.id} 的 refreshToken 已轮换，已写回并落盘`);
    } catch (err) {
      // 回调抛出去会被引擎吞掉（它包了 try），但日志是我们唯一的事后线索，别让它变成静默
      console.error(`[cline] 轮换 refreshToken 回写失败：${err.message}`);
    }
  };
  hook.__myapi = true;
  globalThis[ROTATE_HOOK] = hook;
}

installRotateHook();

/** 补丁在不在（控制台/自检用）。false = 引擎被上游改回了原样，轮换不会落盘。 */
export function rotateHookPatched() {
  return Boolean(globalThis[ROTATE_HOOK]?.__myapi);
}

// ─────────────────────────── 模型列表

/** 引擎的 /v1/models（免鉴权）。引擎自己 10 分钟缓存一次上游，我们再加一层薄缓存。 */
let modelCache = { at: 0, ids: [] };
const MODEL_CACHE_MS = 5 * 60 * 1000;

/**
 * 拿 cline 的裸模型 id 列表（已剥掉 cline/ 前缀）。
 * 失败返回**上一次成功的缓存**（没有就空数组）—— 调用方有内置兜底快照，不怕空。
 */
export async function clineModelIds() {
  if (modelCache.ids.length && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.ids;
  try {
    const resp = await clineWorker.fetch(new Request('http://internal/v1/models'), buildClineEnv([], 'internal-key'));
    const data = await resp.json();
    const ids = Array.isArray(data?.data)
      ? data.data.map((m) => String(m?.id || '').trim()).filter(Boolean)
      : [];
    if (ids.length) {
      modelCache = { at: Date.now(), ids };
      return ids;
    }
  } catch (err) {
    console.warn(`[cline] 拉模型列表失败，沿用上一次的结果：${err.message}`);
  }
  return modelCache.ids;
}

/** 清掉模型缓存（控制台手动刷新 / 测试用） */
export function resetClineModelCache() {
  modelCache = { at: 0, ids: [] };
}

// 出口代理：Clash 订阅 → mihomo 内核 → 本地混合端口 → 接管所有出站 fetch。
//
// 为什么是 mihomo：Clash 订阅里的节点是 vmess/vless/trojan/ss 这类协议，
// Node 原生一个都不支持。mihomo 把它们转成本地 HTTP/SOCKS 混合端口，
// 我们再让出站请求走那个端口 —— 这是唯一可行的路子（不需要特权，不用 TUN）。
//
// 接管方式：undici 的 setGlobalDispatcher。实测它会影响 Node 内置 fetch，
// 连 vendor/worker.js 和 vendor/cline-worker.js 内部那十几处 fetch 也一起接管，
// 所以不用碰任何 vendored 引擎（那些文件会被下载流程整个覆盖）。
//
// ⚠️ 单出口。所有账号走同一个节点。要做「每账号一个出口」得换成
// patch globalThis.fetch + AsyncLocalStorage（实测也能接管引擎外呼），
// 那是另一件事，本次不做。
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { createConnection } from 'node:net';
import { lookup } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { store } from './store.js';
import { isPublicHttpUrl, isPrivateIp } from './util.js';

// undici 是可选的：万一依赖没装上，整个服务不该起不来，只是代理功能不可用。
let undici = null;
try {
  undici = await import('undici');
} catch {
  undici = null;
}

const SUB_FILE = resolve(config.clashDir, 'sub.yaml');
const CONF_FILE = resolve(config.clashDir, 'config.yaml');
const SECRET_FILE = resolve(config.clashDir, 'secret');
/** 策略组名。写在 config 里，切换节点就是 PUT 这个组。 */
const GROUP = 'PROXY';
/** 订阅以 provider 形式挂进来 —— 我们不解析 YAML，直接把订阅文件喂给 mihomo。 */
const PROVIDER = 'subscription';
const LOG_LINES = 60;

// 直连 dispatcher：拉订阅、探本机端口用它，绕开全局代理（拉订阅不能依赖代理能用）
let directAgent = null;
let proxyAgent = null;
let globalPatched = false;

let child = null;
let lastError = '';
let logRing = [];
/** 进行中的那次启动（并发调用共享同一个，别各自回 false） */
let startPromise = null;
let consecutiveFailures = 0;
let restartTimer = null;
/** 本机混合端口的最近一次探活结果（做 2 秒缓存，避免每个请求都连一次） */
let portProbe = { at: 0, ok: false };

function ensureUndici() {
  if (!undici) throw Object.assign(new Error('服务端缺少 undici 依赖，代理功能不可用'), { statusCode: 500 });
}

function ensureDir() {
  if (!existsSync(config.clashDir)) mkdirSync(config.clashDir, { recursive: true });
}

/**
 * 直连 dispatcher。惰性建，**任何用到它的地方都必须先过这里**。
 * 直接在选项里写 `dispatcher: directAgent` 是不够的 —— 值还是 null 时会被 undici
 * 当成非法 dispatcher 拒掉（UND_ERR_INVALID_ARG），症状是连本机回环都连不上。
 */
function ensureDirectAgent() {
  if (!directAgent) directAgent = new undici.Agent();
  return directAgent;
}

function log(line) {
  const s = String(line).trimEnd();
  if (!s) return;
  logRing.push(s);
  if (logRing.length > LOG_LINES) logRing = logRing.slice(-LOG_LINES);
}

// ── secret / config ─────────────────────────────────────────────────────────

/**
 * mihomo 的 API 密码。随机生成并落盘（0600）。
 * 不落盘的话每次重启都要改 config 里的 secret，而进程重启是常态（Railway）。
 */
function ensureSecret() {
  ensureDir();
  if (existsSync(SECRET_FILE)) {
    const s = readFileSync(SECRET_FILE, 'utf8').trim();
    if (s.length >= 16) return s;
  }
  const s = randomBytes(24).toString('hex');
  writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  try {
    chmodSync(SECRET_FILE, 0o600);
  } catch {
    /* 某些文件系统不支持，忽略 */
  }
  return s;
}

/**
 * 生成 mihomo 的 config。
 *
 * 关键点：
 *   allow-lan: false  —— 否则容器就成了一个开放代理，被人白嫖
 *   bind-address      —— 两个端口都只监听回环
 *   ipv6: false       —— 避免目标有 AAAA 记录时走 IPv6 直连，等于漏了真实出口
 *   proxy-providers   —— 直接吃订阅文件，我们不做 YAML 解析（实测 mihomo 能吃）
 *                       health-check 让控制台能看到节点 alive 状态
 */
export function buildConfigYaml() {
  const secret = ensureSecret();
  return [
    `mixed-port: ${config.clashMixedPort}`,
    'allow-lan: false',
    'bind-address: 127.0.0.1',
    'mode: rule',
    'log-level: warning',
    'ipv6: false',
    `external-controller: 127.0.0.1:${config.clashApiPort}`,
    `secret: ${secret}`,
    'proxy-providers:',
    `  ${PROVIDER}:`,
    '    type: file',
    `    path: ${SUB_FILE.replace(/\\/g, '/')}`,
    '    health-check:',
    '      enable: true',
    '      interval: 300',
    '      url: http://www.gstatic.com/generate_204',
    'proxy-groups:',
    `  - name: ${GROUP}`,
    '    type: select',
    '    use:',
    `      - ${PROVIDER}`,
    'proxies: []',
    'rules:',
    `  - MATCH,${GROUP}`,
    '',
  ].join('\n');
}

// ── mihomo API ──────────────────────────────────────────────────────────────

/**
 * 带超时的、**显式指定 dispatcher** 的请求。全项目只有这里需要这么做。
 *
 * 两个坑都踩过，务必照抄这个写法：
 *
 * 1. **必须用 undici.fetch，不能用内置的 fetch。**
 *    实测（Node 22.22 + undici 8.10）：内置 fetch 收到 `dispatcher:` 一个外部 undici 实例时
 *    直接抛 `TypeError: fetch failed`（cause 是 `UND_ERR_INVALID_ARG`），连本机回环都连不上。
 *    同一个 dispatcher 交给 undici 自己的 fetch 就正常。内置 fetch 只认「全局」
 *    setGlobalDispatcher，不认显式传参 —— 那是另一条路，这里用不到。
 *
 * 2. **不要用 `AbortSignal.timeout()`，用显式 AbortController + clearTimeout。**
 *    AbortSignal.timeout 是「到点必触发」的：请求早就结束了它也照触发，而 undici 在
 *    请求 settle 之后才摘除 abort 监听器（lib/web/fetch/index.js 里那个
 *    `assert(controller != null)`），两者竞态时抛**未捕获异常**，直接把进程带崩。
 *    clearTimeout 能保证 abort 只在请求进行中发生。
 *
 * 导出是为了让单测能钉住这两条 —— 谁把它改回内置 fetch 或 AbortSignal.timeout，
 * 测试会立刻红。
 */
export async function fetchWithTimeout(url, { timeoutMs = 8000, ...init } = {}) {
  ensureUndici();
  // 没指定出口就直连；指定了但值是 null 也按直连兜底（见 ensureDirectAgent 的说明）
  if (init.dispatcher == null) init.dispatcher = ensureDirectAgent();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  timer.unref?.();
  try {
    return await undici.fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function api(method, path, body) {
  ensureUndici();
  const secret = ensureSecret();
  // 本机回环请求必须显式直连，否则全局 dispatcher 会把它们也送去代理（死循环）
  const r = await fetchWithTimeout(`http://127.0.0.1:${config.clashApiPort}${path}`, {
    method,
    headers: { authorization: `Bearer ${secret}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    dispatcher: ensureDirectAgent(),
    timeoutMs: 8000,
  });
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!r.ok) {
    throw Object.assign(new Error(`mihomo API ${path} 返回 ${r.status}${data?.message ? `：${data.message}` : ''}`), {
      statusCode: 502,
    });
  }
  return data;
}

/** 混合端口在不在监听。2 秒缓存，避免高频请求下每个请求都建一次连接。 */
export function localProxyAlive() {
  const now = Date.now();
  if (now - portProbe.at < 2000) return portProbe.ok;
  return new Promise((resolveP) => {
    const sock = createConnection({ host: '127.0.0.1', port: config.clashMixedPort });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      portProbe = { at: Date.now(), ok };
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolveP(ok);
    };
    sock.setTimeout(400);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

/** 这个端口上有没有人在监听。纯 TCP 探测，不认协议。 */
function portInUse(port) {
  return new Promise((resolveP) => {
    const sock = createConnection({ host: '127.0.0.1', port });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolveP(v);
    };
    sock.setTimeout(400);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

// ── 进程生命周期 ────────────────────────────────────────────────────────────

function kernelRunning() {
  return Boolean(child && child.exitCode === null && !child.killed);
}

/**
 * 内核没跑时给一句看得懂的话，而不是把 undici 的 `fetch failed` 直接甩给用户。
 *
 * 这条路径很常被撞到：伪装开着但订阅还没拉、内核起不来、或内核刚崩还没重启完 ——
 * 用户点「刷新节点」就会走到这里。原来的表现是控制台弹一个 `fetch failed`
 * （ECONNREFUSED 127.0.0.1:9090），既不知道发生了什么、也不知道下一步做什么。
 */
function assertKernelUp(what = '这个操作') {
  if (!kernelRunning()) {
    throw Object.assign(
      new Error(`代理内核没在运行（${what}需要它）—— 请到「出口代理」点「重新加载」，或先确认订阅已拉取`),
      { statusCode: 503 }
    );
  }
}

async function waitReady(timeoutMs = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      await api('GET', '/version');
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return false;
}

/**
 * 启动内核。
 *
 * 并发调用（用户连点「保存并拉取 / 重新加载」、或 exit 里的自动重启撞上手动调用）
 * **共享同一次启动**：后到的等前一个的结果，而不是各自立刻回 false。
 *
 * 为什么必须等：原来后到的走 `if (kernelRunning() || starting) return kernelRunning()`，
 * 此时内核还没就绪 → 回 false，而 lastError 已被第一个调用者清空 → 调用方拿到
 * `{running:false, error:''}`，控制台显示"内核没跑"却给不出任何原因。
 * 实测 4 次并发里有 3 次是这样的误导结果（内核其实马上就起来了）。
 */
export async function startKernel() {
  if (startPromise) return startPromise;
  startPromise = startKernelInner().finally(() => {
    startPromise = null;
  });
  return startPromise;
}

async function startKernelInner() {
  ensureUndici();
  if (kernelRunning()) return true;
  if (!existsSync(config.mihomoBin)) {
    lastError = `找不到 mihomo 内核（${config.mihomoBin}）—— 镜像里没装？`;
    return false;
  }
  if (!existsSync(SUB_FILE)) {
    lastError = '还没有订阅文件，先去控制台填订阅地址';
    return false;
  }
  lastError = '';
  try {
    // 端口已被占用：多半是上一次运行**残留**的 mihomo（node 崩了 / 被 SIGKILL，子进程没跟着走）。
    //
    // 为什么必须在这里拦住，而不是让它自己失败：新进程绑不上端口会立刻退出，而 waitReady()
    // 是拿**同一个 secret**（同一个 DATA_DIR 生成的那份）去问那个旧实例 —— 鉴权能过、返回 200，
    // 于是判定"启动成功"。实际用的是**旧配置**（旧订阅、旧节点）：控制台显示"运行中"，
    // 节点列表却是旧的，紧接着请求被 503 拦住（kernelRunning() 看到的是那个已退出的新进程），
    // 提示还写着"内核未运行"。三个现象互相矛盾，非常难排查。直接说清楚。
    //
    // 先等 300ms 再确认一次：我们自己刚 stopKernel() 过的话，旧进程可能还在退出的路上。
    if (await portInUse(config.clashMixedPort)) {
      await new Promise((r) => setTimeout(r, 300));
      if (await portInUse(config.clashMixedPort)) {
        lastError = `混合端口 ${config.clashMixedPort} 已被占用（多半是上次残留的 mihomo 进程）。请重启容器，或用 CLASH_MIXED_PORT 指定别的端口。`;
        return false;
      }
    }
    ensureDir();
    writeFileSync(CONF_FILE, buildConfigYaml(), { mode: 0o600 });
    child = spawn(config.mihomoBin, ['-d', config.clashDir, '-f', CONF_FILE], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TZ: process.env.TZ || 'UTC' },
    });
    const onChunk = (buf) => {
      for (const line of String(buf).split('\n')) log(line);
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('exit', (code, signal) => {
      log(`[kernel] 退出 code=${code} signal=${signal}`);
      child = null;
      if (restartTimer) return;
      // 内核自己崩了就有限重试；连续失败到一定次数就停手，别变成疯狂重启
      if (store.settings?.proxyEnabled && consecutiveFailures < 3) {
        consecutiveFailures += 1;
        const delay = [5000, 15000, 45000][consecutiveFailures - 1] || 45000;
        log(`[kernel] ${delay / 1000}s 后尝试第 ${consecutiveFailures} 次重启`);
        restartTimer = setTimeout(() => {
          restartTimer = null;
          void startKernel();
        }, delay);
        restartTimer.unref?.();
      } else {
        lastError = `代理内核已退出（code=${code}），自动重启已达上限，请在控制台手动重新加载`;
        setDispatcher(false);
      }
    });

    const ok = await waitReady();
    if (!ok) {
      lastError = '代理内核启动超时（没等到 API 就绪）';
      stopKernel();
      return false;
    }
    consecutiveFailures = 0;
    // 把订阅里选中的节点恢复回去（设置里存着名字，内核每次重启都是全新的）
    const want = String(store.settings?.proxySelectedNode || '').trim();
    if (want) {
      try {
        await api('PUT', `/proxies/${encodeURIComponent(GROUP)}`, { name: want });
      } catch {
        log(`[kernel] 恢复选中节点「${want}」失败（可能订阅里已经没有它了）`);
      }
    }
    return true;
  } catch (err) {
    lastError = `启动代理内核失败：${err.message}`;
    stopKernel();
    return false;
  }
}

export function stopKernel() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (child) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    child = null;
  }
}

// ── dispatcher 开关 ─────────────────────────────────────────────────────────

/**
 * 出站是否走代理。这是「伪装 IP」总开关的落点 —— 切 dispatcher 是瞬时的，
 * 不用重启内核。
 */
function setDispatcher(on) {
  if (!undici) return;
  if (on) {
    if (!proxyAgent) proxyAgent = new undici.ProxyAgent(`http://127.0.0.1:${config.clashMixedPort}`);
    undici.setGlobalDispatcher(proxyAgent);
    globalPatched = true;
  } else {
    undici.setGlobalDispatcher(ensureDirectAgent());
    globalPatched = false;
  }
}

/** 出站此刻是否经过代理 */
export function isProxying() {
  return globalPatched;
}

/**
 * 请求前的一道闸。代理开着但内核不在时返回阻止原因 —— engine 直接回 503，
 * **一个账号状态都不写**。
 *
 * 为什么必须拦住：走到上游请求那一步就是个换号循环，代理挂掉会让每个号都失败一次，
 * 于是整池账号被连环标成 network_error，而且状态里的 recoverAt 到期后探活也要走代理
 * —— 继续失败，永远好不了。宁可整个请求失败，也不能把号池污染掉。
 */
export async function proxyBlocksRequest() {
  if (!store.settings?.proxyEnabled) return null;
  // 用户明确允许「代理挂了就回退直连」时，不拦（那意味着接受暴露真实出口）
  if (store.settings?.proxyBlockOnFailure === false) return null;
  if (kernelRunning() && (await localProxyAlive())) return null;
  return lastError || '代理内核未运行';
}

// ── 订阅 ────────────────────────────────────────────────────────────────────

/** 订阅内容大致像不像 Clash 配置（mihomo 的 file provider 只吃这一种） */
function looksLikeClashYaml(text) {
  return /^\s*proxies\s*:/m.test(text) || /^\s*proxy-providers\s*:/m.test(text);
}

/**
 * 发请求前的第二道闸：域名**解析出来的 IP** 也必须是公网。
 *
 * isPublicHttpUrl 只能判字面（协议、主机名后缀、IP 字面量）。但一个攻击者控制的域名
 * 完全可以 A 记录指向 127.0.0.1 / 169.254.169.254，字面上完全看不出来 ——
 * 所以真正发出去之前必须解析一次。
 *
 * 解析和「实际连接用的地址」之间仍有 TOCTOU 窗口（DNS rebinding），但门槛已经从
 * 「随手注册个域名」抬到「要能操纵 DNS 应答的时序」，对个人部署够用了。
 */
export async function assertPublicTarget(url) {
  if (!isPublicHttpUrl(url, { requireHttps: true })) {
    throw Object.assign(new Error('地址必须是 https 公网地址'), { statusCode: 400 });
  }
  const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  // IP 字面量：上面那道字面校验已经判过公网性了，不用再解析
  if (/^[\d.]+$/.test(host) || host.includes(':')) return;

  let addrs;
  try {
    addrs = await lookup(host, { all: true });
  } catch (err) {
    throw Object.assign(new Error(`域名解析失败（${err.code || err.message}）`), { statusCode: 502 });
  }
  if (!addrs.length) throw Object.assign(new Error('域名没有解析到任何地址'), { statusCode: 502 });
  const bad = addrs.filter((a) => isPrivateIp(a.address));
  if (bad.length) {
    throw Object.assign(
      new Error(`地址指向内网（${host} → ${bad.map((a) => a.address).join(', ')}），已拒绝`),
      { statusCode: 400 }
    );
  }
}

/** 订阅最多跟这么多跳重定向。正常机场一两跳，多了就是在耍我们 */
const MAX_SUB_REDIRECTS = 5;

/**
 * 拉订阅。**显式直连** —— 换节点这件事不能依赖代理已经能用（鸡生蛋）。
 */
export async function fetchSubscription(url) {
  ensureUndici();
  // 自己跟重定向，不用 redirect:'follow'。
  //
  // ⚠️ 这条很要紧：用 follow 等于把「能请求到哪里」的决定权交给了上游。
  // 实测（Node 22.22 + undici）一个 302 到 http://169.254.169.254/ 会被**真的跟过去**，
  // 于是「订阅地址必须是 https 公网」这道闸就被一次重定向绕开了 —— 典型 SSRF。
  // 手动跟 + 每一跳都过 assertPublicTarget，才是完整的校验。
  let current = String(url);
  let resp = null;
  for (let hop = 0; hop <= MAX_SUB_REDIRECTS; hop++) {
    await assertPublicTarget(current);
    try {
      resp = await fetchWithTimeout(current, {
        dispatcher: ensureDirectAgent(),
        redirect: 'manual',
        timeoutMs: 25000,
        // 不少机场按 UA 分发格式：给 Clash 客户端的 UA 才会返回 Clash YAML
        headers: { 'user-agent': 'mihomo/1.19.31', accept: '*/*' },
      });
    } catch (err) {
      throw Object.assign(new Error(`拉取订阅失败：${err.message}`), { statusCode: 502 });
    }
    const isRedirect = resp.status >= 300 && resp.status < 400;
    if (!isRedirect) break;
    const loc = resp.headers.get('location');
    // 重定向响应没有正文，但这个流得显式放掉，否则连接会被占着
    if (resp.body) await resp.body.cancel().catch(() => {});
    if (!loc) throw Object.assign(new Error(`订阅地址返回 ${resp.status}，但没有 Location 头`), { statusCode: 502 });
    if (hop === MAX_SUB_REDIRECTS) {
      throw Object.assign(new Error(`订阅地址重定向超过 ${MAX_SUB_REDIRECTS} 次，已中止`), { statusCode: 502 });
    }
    current = new URL(loc, current).toString();
  }
  if (!resp.ok) {
    throw Object.assign(new Error(`订阅地址返回 HTTP ${resp.status}`), { statusCode: 502 });
  }
  const text = await resp.text();
  if (!looksLikeClashYaml(text)) {
    throw Object.assign(
      new Error('订阅内容不是 Clash 格式（没有 proxies: 段）。有些机场会按 UA/订阅类型返回 base64 或其它格式，换一个「Clash」订阅链接试试'),
      { statusCode: 400 }
    );
  }
  ensureDir();
  writeFileSync(SUB_FILE, text, { mode: 0o600 });
  return { bytes: text.length };
}

/** 清空订阅：删掉落盘文件，免得下次开启伪装时又用上旧节点 */
export function clearSubscription() {
  if (!existsSync(SUB_FILE)) return false;
  try {
    unlinkSync(SUB_FILE);
    return true;
  } catch {
    return false;
  }
}

// ── 对外：状态 / 节点 ───────────────────────────────────────────────────────

export function getProxyStatus() {
  const url = String(store.settings?.proxySubscriptionUrl || '');
  let subscriptionHost = '';
  try {
    subscriptionHost = url ? new URL(url).hostname : '';
  } catch {
    subscriptionHost = '';
  }
  return {
    enabled: Boolean(store.settings?.proxyEnabled),
    blockOnFailure: store.settings?.proxyBlockOnFailure !== false,
    // 伪装开着但内核没跑 = 请求会被 503 拦掉，控制台要显眼告警
    running: kernelRunning(),
    proxying: globalPatched,
    mixedPort: config.clashMixedPort,
    apiPort: config.clashApiPort,
    kernelAvailable: existsSync(config.mihomoBin),
    undiciAvailable: Boolean(undici),
    hasSubscription: existsSync(SUB_FILE),
    // URL 里常带机场凭据，只下发展示用的 host
    subscriptionHost,
    selectedNode: String(store.settings?.proxySelectedNode || ''),
    lastError,
    log: logRing.slice(-15),
  };
}

/** 节点清单（从 mihomo 的 provider 读，含 alive 与最近一次延迟历史） */
export async function listNodes() {
  assertKernelUp('读取节点列表');
  const data = await api('GET', `/providers/proxies/${encodeURIComponent(PROVIDER)}`);
  const nodes = Array.isArray(data?.proxies) ? data.proxies : [];
  let current = '';
  try {
    const g = await api('GET', `/proxies/${encodeURIComponent(GROUP)}`);
    current = String(g?.now || '');
  } catch {
    /* 策略组还没建好时忽略 */
  }
  return {
    current,
    nodes: nodes.map((n) => {
      const h = Array.isArray(n.history) && n.history.length ? n.history[n.history.length - 1] : null;
      return {
        name: String(n.name || ''),
        type: String(n.type || ''),
        alive: n.alive !== false,
        delay: h && Number.isFinite(h.delay) ? h.delay : null,
        // 节点自带的地理/用途标签，方便挑
        udp: Boolean(n.udp),
      };
    }),
  };
}

/**
 * 让 mihomo 重读 sub.yaml。
 *
 * mihomo 的 file provider 只在**启动时**读一次盘（配置里的 health-check 是给节点探活，
 * 不是重读文件），所以要它认新订阅必须显式打这个 API。
 * 不补这一下的后果实测过：换订阅后控制台显示「已更新 N 字节」、reload 也返回成功，
 * 但节点列表和实际出口**都还是旧的** —— 用户以为换成功了，请求继续走老节点。
 */
export async function reloadProvider() {
  await api('PUT', `/providers/proxies/${encodeURIComponent(PROVIDER)}`);
  return { reloaded: true };
}

export async function selectNode(name) {
  const target = String(name || '').trim();
  if (!target) throw Object.assign(new Error('节点名不能为空'), { statusCode: 400 });
  assertKernelUp('切换节点');
  await api('PUT', `/proxies/${encodeURIComponent(GROUP)}`, { name: target });
  store.updateSettings({ proxySelectedNode: target });
  // 用户手动选节点后，把「自动重试」的计数放开 —— 这算一次人工干预
  consecutiveFailures = 0;
  return { selected: target };
}

/** 测延迟。只测指定的一个；不传就测当前选中那个（别一次性打全部节点） */
export async function testDelay(name) {
  const target = String(name || '').trim() || String(store.settings?.proxySelectedNode || '').trim();
  if (!target) throw Object.assign(new Error('还没有选中节点'), { statusCode: 400 });
  assertKernelUp('测延迟');
  const qs = `timeout=5000&url=${encodeURIComponent('http://www.gstatic.com/generate_204')}`;
  const data = await api('GET', `/proxies/${encodeURIComponent(target)}/delay?${qs}`);
  return { name: target, delay: Number.isFinite(data?.delay) ? data.delay : null };
}

// ── 生命周期入口 ────────────────────────────────────────────────────────────

/**
 * 设置变更后重算一遍：该起内核就起、该切 dispatcher 就切。
 * 控制台改开关/订阅/节点都调它。
 */
export async function applyProxySettings() {
  if (!store.settings?.proxyEnabled) {
    stopKernel();
    setDispatcher(false);
    return { enabled: false, running: false };
  }
  const block = store.settings?.proxyBlockOnFailure !== false;

  // ⚠️ 顺序是安全要求，不是风格问题：**先切到代理，再起内核**。
  // 反过来的话，内核启动那几秒里 dispatcher 还是直连的 —— 那几秒进来的请求会从
  // 真实出口出去，正好违背「宁可失败也不暴露」这个前提。
  setDispatcher(true);

  if (!existsSync(SUB_FILE)) {
    lastError = '伪装 IP 已开启，但还没有订阅内容 —— 请先填订阅地址并拉取';
    // block=true（默认）：没有订阅就没有可用出口，保持指向代理 —— 宁可请求失败也不走真实 IP。
    // block=false：用户自己要求回退直连，才放开。
    setDispatcher(block);
    return { enabled: true, running: false, error: lastError };
  }

  // 内核本来就在跑的话，startKernel 会直接早退 —— 这时它**不会**重读 sub.yaml，
  // 所以下面要显式 reload 一次（理由见 reloadProvider 的注释）。
  const wasRunning = kernelRunning();
  const ok = await startKernel();
  if (ok && wasRunning) {
    await reloadProvider().catch((err) => log(`[kernel] 重载订阅失败：${err.message}`));
  }
  if (!ok) {
    // 内核起不来：默认（block=true）**保持**指向代理端口，连不上就失败，绝不擅自回退直连；
    // 只有用户自己关了「代理不可用时阻断请求」（block=false）才回退直连。
    //
    // ⚠️ 这里是 setDispatcher(block)，不是 !block —— block 的语义就是「要不要保持指向代理」。
    // （反写会让两种设置的行为完全对调：默认放行直连、而选了回退的人反而死在代理上。）
    setDispatcher(block);
  }
  return { enabled: true, running: ok, error: ok ? '' : lastError };
}

/** 服务启动时调用 */
export async function initProxy() {
  ensureDir();
  if (!undici) {
    lastError = '缺少 undici 依赖，出口代理功能不可用（npm install 后重启）';
    return;
  }
  ensureDirectAgent();
  if (!store.settings?.proxyEnabled) {
    setDispatcher(false);
    return;
  }
  await applyProxySettings();
}

/** 进程退出前收尾 */
export function shutdownProxy() {
  stopKernel();
  try {
    if (undici && directAgent) undici.setGlobalDispatcher(directAgent);
  } catch {
    /* ignore */
  }
  if (existsSync(CONF_FILE)) {
    try {
      // config 里带 secret 与订阅路径，随进程走掉就行
      unlinkSync(CONF_FILE);
    } catch {
      /* ignore */
    }
  }
}

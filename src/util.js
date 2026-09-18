// 通用小工具：没有第三方依赖，全部基于 node 标准库。
import { randomBytes, createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { isIP } from 'node:net';

export function nowIso() {
  return new Date().toISOString();
}

/**
 * 这个 IP 是不是「非公网」（回环 / 私有 / 链路本地 / CGNAT / 组播 / 保留段）。
 *
 * 为什么不能只靠正则匹配点分十进制：同一个地址有很多写法，而且 IPv6 段更隐蔽。
 *   · 十进制 / 十六进制（2130706433、0x7f000001）—— WHATWG URL 会规范化成 127.0.0.1，能挡住，
 *     但校验函数被直接调用时不一定经过 URL，所以这里对 IPv4 数字再做一次判断更保险。
 *   · IPv4 映射的 IPv6（::ffff:127.0.0.1，URL 规范化后是 ::ffff:7f00:1）—— 老正则会漏。
 *   · IPv6 的 ULA（fc00::/7）与链路本地（fe80::/10）—— 老正则完全没覆盖。
 * 判不出来的一律当「非公网」（保守），宁可拒掉一个合法地址也不能放进来一个内网地址。
 */
export function isPrivateIp(ip) {
  const v = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!v) return true;

  // IPv4 映射 / 兼容形式的 IPv6：取其后 32 位按 IPv4 再判一次
  const mappedV4 = v.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedV4) return isPrivateIp(mappedV4[1]);
  // ::ffff:7f00:1 这种十六进制尾巴（URL 规范化后的形态）
  if (v.startsWith('::ffff:')) {
    const tail = v.slice(7).split(':');
    if (tail.length === 2 && tail.every((p) => /^[0-9a-f]{1,4}$/.test(p))) {
      const hi = parseInt(tail[0], 16);
      const lo = parseInt(tail[1], 16);
      return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return true; // 形状不认识，保守拒掉
  }

  if (isIP(v) === 4) {
    const [a, b] = v.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true; // 0.0.0.0/8、10/8、回环
    if (a === 169 && b === 254) return true; // 链路本地（云元数据 169.254.169.254 就在这）
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 192 && b === 0) return true; // 192.0.0/24 + 192.0.2/24（保留/文档段）
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a >= 224) return true; // 组播 + 保留（含 255.255.255.255）
    return false;
  }

  if (isIP(v) === 6) {
    if (v === '::' || v === '::1') return true;
    const head = parseInt(v.split(':')[0] || '0', 16);
    if (!Number.isFinite(head)) return true;
    if ((head & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
    if ((head & 0xffc0) === 0xfe80) return true; // 链路本地 fe80::/10
    if ((head & 0xff00) === 0xff00) return true; // 组播 ff00::/8
    return false;
  }

  return true; // 不是合法 IP
}

/**
 * 是不是「公网 http(s) 地址」。
 *
 * 服务端会拿这类地址去发请求（上游给的登录链接、用户填的 Clash 订阅），
 * 所以必须挡住内网 / 回环 / 本地域名 —— 否则等于开了个 SSRF 口子，
 * 让人借我们的进程去探测容器内网（Railway 内网、云元数据端点都在射程内）。
 *
 * requireHttps=true 只认 https（凭据类 URL 用这个）。
 *
 * ⚠️ 这只是**字面上**能判的部分：域名本身是不是解析到内网，这一层看不出来
 * （`evil.example.com` 完全可以 A 记录指向 127.0.0.1）。发请求前还要做一次
 * 「解析出来的 IP 必须也是公网」的校验，见 src/proxy.js 的 assertPublicTarget()。
 */
export function isPublicHttpUrl(value, { requireHttps = false } = {}) {
  let u;
  try {
    u = value instanceof URL ? value : new URL(String(value));
  } catch {
    return false;
  }
  if (requireHttps ? u.protocol !== 'https:' : !/^https?:$/.test(u.protocol)) return false;

  // URL.hostname 对 IPv6 会带方括号，先剥掉。
  // 再去掉**尾点**：`metadata.google.internal.` 是合法的 root-anchored 写法，
  // 但 `endsWith('.internal')` 判不到它 —— 不归一就等于给后缀黑名单开了个后门。
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    return false;
  }
  // 是 IP 字面量就交给 isPrivateIp 统一判（它覆盖 IPv6，且对数字写法更稳）
  if (isIP(host)) return !isPrivateIp(host);
  // 外观像数字 IP（十进制 / 十六进制 / 八进制）但没被 URL 规范化成点分形式的，一律拒
  if (/^[0-9]+$/.test(host) || /^0x[0-9a-f]+$/.test(host) || /^0[0-7]+$/.test(host)) return false;

  return true;
}

export function randomId(bytes = 8) {
  return randomBytes(bytes).toString('hex');
}

/** 生成给用户复制的 API key：sk-xxxx 形式，方便各种 OpenAI 客户端识别 */
export function generateApiKey() {
  return 'sk-fb-' + randomBytes(24).toString('base64url');
}

/**
 * 定长时序安全比较：先各自 sha256 再比，这样连"长度不同"这一位都不泄露
 * （直接 timingSafeEqual 需要先判长度，等于把长度告诉了攻击者）。
 */
export function constantTimeEqual(a, b) {
  const da = createHash('sha256').update(String(a ?? ''), 'utf8').digest();
  const db = createHash('sha256').update(String(b ?? ''), 'utf8').digest();
  return timingSafeEqual(da, db);
}

export function maskSecret(value, keep = 6) {
  const s = String(value || '');
  if (s.length <= keep + 4) return s.slice(0, 2) + '***';
  return s.slice(0, keep) + '…' + s.slice(-4);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

export function sendJson(res, status, obj, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  const body = Buffer.from(text);
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    ...extraHeaders,
  });
  res.end(body);
}

/** 读取请求体，带上限保护（默认 2MB，聊天请求可以更大，由调用方传） */
export async function readBody(req, limitBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      const err = new Error('请求体过大');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, limitBytes) {
  const raw = await readBody(req, limitBytes);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    const err = new Error('请求体不是合法 JSON');
    err.statusCode = 400;
    throw err;
  }
}

/**
 * 取客户端 IP。注意 X-Forwarded-For 的左边是客户端自己能随便写的，
 * 只有最右边那几跳是可信代理追加的 —— 取错方向会让限流被 XFF 伪造绕过。
 * hops = 你前面有几层可信代理（Railway 是 1）。
 */
export function clientIp(req, hops = 1) {
  const raw = req.headers['x-forwarded-for'];
  if (typeof raw === 'string' && raw.trim()) {
    const parts = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) {
      const idx = Math.max(0, parts.length - Math.max(1, hops));
      return parts[idx];
    }
  }
  return req.socket?.remoteAddress || 'unknown';
}

const HOST_RE = /^[a-z0-9.\-\[\]:]+$/i;

/** 反代后面拿对外地址；Host 头是客户端可控的，所以要校验并优先用部署平台给的域名 */
export function publicBaseUrl(req) {
  const configured = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;

  const railway = (process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
  const raw = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim();
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(raw);
  // Host 头带了奇怪字符（换行、路径、@ 之类）就不认，回落到平台域名
  const host = HOST_RE.test(raw) ? raw : '';
  if (!host) return railway ? `https://${railway}` : 'http://localhost';
  // 平台给了固定域名时，只接受它或本机地址，避免 Host 头注入把控制台里显示的
  // Base URL 换成攻击者的域名（管理员照着复制就会把 API key 发到别处）
  if (railway && !local && host.toLowerCase() !== railway.toLowerCase()) {
    return `https://${railway}`;
  }
  let proto = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim();
  if (!/^https?$/.test(proto)) proto = local ? 'http' : 'https';
  return `${proto}://${host}`;
}

// ---------------------------------------------------------------------------
// Cookie + 签名会话
// ---------------------------------------------------------------------------

export function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    // 非法百分号序列（例如 "a=%"）会让 decodeURIComponent 抛 URIError。
    // 这个函数在 WebSocket 升级路径上也会被调用，抛出去就是没人接的异常。
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function serializeCookie(name, value, opts = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge != null) bits.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  bits.push(`Path=${opts.path || '/'}`);
  if (opts.httpOnly !== false) bits.push('HttpOnly');
  if (opts.secure) bits.push('Secure');
  bits.push(`SameSite=${opts.sameSite || 'Lax'}`);
  return bits.join('; ');
}

/** payload(JSON) → base64url.hmac 的简易签名 token（无状态会话，重启后凭密钥继续有效） */
export function signToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyToken(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.', 2);
  const expect = createHmac('sha256', secret).update(body).digest('base64url');
  // 必须比字节长度：字符串长度相等但字节长度不等时 timingSafeEqual 会直接抛
  const a = Buffer.from(mac, 'utf8');
  const b = Buffer.from(expect, 'utf8');
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    // exp 缺失或不是有限数字一律当过期（fail-closed）：
    // SESSION_TTL_HOURS 配成非数字会让 exp 变成 null，那时候不能签出永久有效的 cookie
    if (!Number.isFinite(payload?.exp) || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 简易滑动窗口限流（内存，够用于单实例后台登录防爆破）
// ---------------------------------------------------------------------------

export function createRateLimiter({ windowMs = 15 * 60 * 1000, max = 12 } = {}) {
  const hits = new Map(); // key -> number[]（时间戳）
  return {
    check(key) {
      const now = Date.now();
      const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
      hits.set(key, arr);
      if (arr.length >= max) {
        return { ok: false, retryAfterMs: windowMs - (now - arr[0]) };
      }
      return { ok: true, remaining: max - arr.length - 1 };
    },
    hit(key) {
      const now = Date.now();
      const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
      arr.push(now);
      hits.set(key, arr);
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 简单的在飞计数闸门：超过上限直接拒，避免请求堆积把内存/事件循环打满 */
export function createGate(max) {
  let inflight = 0;
  return {
    get inflight() {
      return inflight;
    },
    tryEnter() {
      if (inflight >= max) return false;
      inflight++;
      return true;
    },
    leave() {
      inflight = Math.max(0, inflight - 1);
    },
  };
}

/** 带超时的 fetch，返回 { status, data, text } */
export async function httpJson(url, { method = 'GET', headers = {}, body, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { status: resp.status, data, text, headers: resp.headers };
  } catch (err) {
    return { status: 0, data: null, text: '', error: err.name === 'AbortError' ? '请求超时' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

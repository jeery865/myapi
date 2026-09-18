// myapi 控制台 —— 原生 ES module，无框架无构建。
// 约定：所有服务端交互都走 api()，渲染函数只读 STATE。
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let STATE = null;
let VIEW = 'overview';
let syncTimer = null;
let lastSync = 0;
let clockTimer = null;

function toast(message, kind = 'ok', ms = 4200) {
  const el = document.createElement('div');
  el.className = `toast ${kind === 'ok' ? '' : kind}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, ms);
}

async function api(path, { method = 'GET', body } = {}) {
  const resp = await fetch(`/admin/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  let data = {};
  try {
    data = await resp.json();
  } catch {}
  if (resp.status === 401 && !path.startsWith('/login')) {
    lock('登录状态过期了，重新输一次密码。');
    throw new Error('未登录');
  }
  if (!resp.ok || data.ok === false) throw new Error(data.error || `请求失败（HTTP ${resp.status}）`);
  return data;
}

async function copy(text, label = '已复制') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
    return;
  } catch {}
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    toast(label);
  } catch {
    toast('浏览器拦了复制操作，手动选中复制吧', 'warn');
  }
  ta.remove();
}

function ago(iso) {
  if (!iso) return '—';
  const d = Date.now() - new Date(iso).getTime();
  if (d < 60000) return '刚刚';
  if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
  return `${Math.floor(d / 86400000)} 天前`;
}

/** 从额度快照文本里取"用得最满"的那个比例，画通道条上的小刻度 */
function quotaRatio(text) {
  if (!text) return null;
  let worst = null;
  for (const m of String(text).matchAll(/(\d+)\s*\/\s*(\d+)/g)) {
    const used = Number(m[1]);
    const limit = Number(m[2]);
    if (!limit) continue;
    const r = Math.min(1, used / limit);
    if (worst === null || r > worst) worst = r;
  }
  return worst;
}

const POOL_LABEL = { any: '全部', free: '仅免费', paid: '付费优先' };
const POOL_FULL = { any: '全部模型', free: '仅免费模型', paid: '付费模型优先' };
// 号池里几个内置上游的标记。opencode 的号是一个 Zen API key、cline 的号是一个
// refreshToken，都不是 freebuff 那种登录出来的 authToken，所以列表里要能一眼分清
// —— 它们的「用途」「检测」含义都不一样。
const PROVIDER_NAME = { freebuff: 'freebuff', opencode: 'opencode Zen', cline: 'Cline' };
const PROVIDER_BADGE = {
  freebuff: '<span class="tag prov">freebuff</span>',
  opencode: '<span class="tag prov oc">opencode</span>',
  cline: '<span class="tag prov cl">cline</span>',
};

/** 上游角标。自定义上游的名字是用户起的，从 STATE 里查 */
function providerBadge(id) {
  const key = id || 'freebuff';
  if (PROVIDER_BADGE[key]) return PROVIDER_BADGE[key];
  const u = (STATE?.providers?.list || []).find((x) => x.id === key);
  return `<span class="tag prov oc">${esc(u?.name || key)}</span>`;
}

function providerName(id) {
  const key = id || 'freebuff';
  if (PROVIDER_NAME[key]) return PROVIDER_NAME[key];
  return (STATE?.providers?.list || []).find((x) => x.id === key)?.name || key;
}
const LAMP_BY_STATE = {
  ok: 'ok',
  metered: 'ok',
  // 临时限流：滚动窗口打满，分钟级就会自己好。是**提醒**，不是坏号 ——
  // 以前它跟"额度用完"共用同一个状态，用户看一眼就以为号废了。
  throttled: 'warn',
  model_locked: 'warn',
  rate_limited: 'warn',
  ip_capped: 'warn',
  country_blocked: 'warn',
  blocked: 'warn',
  network_error: 'warn',
  no_credit: 'bad',
  token_invalid: 'bad',
  banned: 'bad',
};

/**
 * 这个状态现在还算数吗。
 * 带 recoverAt 且已过期 → 不算数了，等价于"没标记"。后端选号逻辑用的是同一个口径
 * （src/account-status.js 的 isStatusLive），所以"时间一到自己就好"在界面上也成立，
 * 用户不需要为了消掉一个黄灯去点刷新。
 * 没有 recoverAt 的是终态（token_invalid / banned），永远算数。
 */
function statusLive(st) {
  if (!st || !st.state) return false;
  if (st.state === 'ok') return false;
  if (!st.recoverAt) return true;
  const at = Date.parse(st.recoverAt);
  return !Number.isFinite(at) || at > Date.now();
}

/** 还有多久恢复（毫秒）。没有到期时间或已过期时返回 0 */
function recoverIn(st) {
  if (!st || !st.recoverAt) return 0;
  const at = Date.parse(st.recoverAt);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, at - Date.now());
}

/** 毫秒说人话 */
function humanMs(ms) {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.ceil(s / 60);
  return m < 60 ? `${m} 分钟` : `${Math.ceil(m / 60)} 小时`;
}

function lampFor(acct) {
  if (acct.enabled === false) return '';
  if (acct.status?.state) {
    // 过期的坏状态按"已恢复"处理，给绿灯 —— 跟后端选号口径一致，别自己吓自己
    if (!statusLive(acct.status) && acct.status.state !== 'ok') return 'ok';
    return LAMP_BY_STATE[acct.status.state] || '';
  }
  if (acct.workerState?.alive === true) return 'ok';
  if (acct.workerState?.alive === false) return 'bad';
  return '';
}

// ─────────────────────────────────────────────── 解锁 / 会话
function lock(hint) {
  clearInterval(syncTimer);
  clearInterval(clockTimer);
  disconnectLive();
  $('#shell').classList.add('hidden');
  $('#gate').classList.remove('hidden');
  if (hint) $('#gate-hint').textContent = hint;
  setTimeout(() => $('#gate-pass')?.focus(), 50);
}

async function unlock() {
  $('#gate').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  await sync();
  clearInterval(syncTimer);
  syncTimer = setInterval(() => sync(true), 20000);
  clearInterval(clockTimer);
  clockTimer = setInterval(paintSynced, 5000);
  connectLive();
}

$('#gate-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = $('#gate-btn');
  btn.disabled = true;
  btn.textContent = '验证中…';
  try {
    await api('/login', { method: 'POST', body: { password: $('#gate-pass').value } });
    $('#gate-pass').value = '';
    await unlock();
  } catch (err) {
    toast(err.message, 'err');
    $('#gate-pass').select();
  } finally {
    btn.disabled = false;
    btn.textContent = '解锁控制台';
  }
});

$('#btn-logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' }).catch(() => {});
  lock('已退出。');
});

// ─────────────────────────────────────────────── 视图切换
const VIEW_TITLE = { overview: '概览', usage: '用量', upstreams: '上游', accounts: '账号池', keys: 'API Key', models: '模型', settings: '设置' };
// 每个视图配一句衬线斜体的副标题（那个 <em> 就是重音词）。
// 大标题 + 斜体重音是这套设计语言里最省力的层次手段：一眼知道在哪、这页管什么。
const VIEW_SUB = {
  overview: ['这个网关现在', '什么状态'],
  usage: ['请求、token、耗时都', '记在这'],
  upstreams: ['每个上游一套', '换号策略'],
  accounts: ['所有上游的凭据', '都在这一张表'],
  keys: ['发给客户端的', '凭证'],
  models: ['所有上游的模型', '合成一张表'],
  settings: ['默认行为、留存和', '清理'],
};

/** 数字/字节/时长的统一格式化 —— 表格里全是等宽数字，别让单位到处不一样 */
const fmtInt = (n) => Number(n || 0).toLocaleString('zh-CN');
const fmtCompact = (n) => {
  const v = Number(n || 0);
  if (v < 1000) return String(v);
  if (v < 1e6) return (v / 1000).toFixed(v < 1e4 ? 1 : 0) + 'k';
  if (v < 1e9) return (v / 1e6).toFixed(1) + 'M';
  return (v / 1e9).toFixed(1) + 'B';
};
const fmtBytes = (n) => {
  const v = Number(n || 0);
  if (v < 1024) return `${v} B`;
  if (v < 1048576) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1073741824) return `${(v / 1048576).toFixed(1)} MB`;
  return `${(v / 1073741824).toFixed(2)} GB`;
};
const fmtMs = (n) => {
  const v = Math.round(Number(n || 0));
  if (!v) return '—';
  return v < 1000 ? `${v}ms` : `${(v / 1000).toFixed(v < 10000 ? 2 : 1)}s`;
};
const clock = (iso) => new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });

/**
 * 给某个视图的顶层块重放一次入场动画（依次浮上来，错峰 0/60/120/180ms）。
 * 做法是先摘掉 .anim 再强制 reflow 再加回去 —— 不然同一个元素第二次进来时
 * 浏览器认为动画没变，不会重播。
 */
function replayReveal(view) {
  const root = $(`.view[data-view="${view}"]`);
  if (!root) return;
  const blocks = [...root.children].slice(0, 8);
  blocks.forEach((el, i) => {
    el.classList.remove('anim', 'd1', 'd2', 'd3', 'd4');
    void el.offsetWidth; // 强制 reflow，让下一行的 class 被当成新动画
    el.classList.add('anim', `d${Math.min(4, i + 1)}`);
  });
}

function show(view) {
  VIEW = view;
  $$('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
  $$('.view').forEach((s) => s.classList.toggle('hidden', s.dataset.view !== view));
  $('#view-title').textContent = VIEW_TITLE[view] || view;
  const sub = VIEW_SUB[view];
  // textContent 装不了 <em>，但这两段是代码里的常量、不是用户输入，用 innerHTML 安全
  $('#view-sub').innerHTML = sub ? `${esc(sub[0])} <em>${esc(sub[1])}</em>` : '';
  // 入场错峰：进这个视图时，它的顶层块依次浮上来。
  // 只在**切换视图**时放，20 秒的后台刷新不重放 —— 否则页面每 20 秒抖一下。
  replayReveal(view);
  if (location.hash.slice(1) !== view) history.replaceState(null, '', `#${view}`);
  window.scrollTo({ top: 0 });
  if (view === 'usage') loadUsage();
  // 出口代理的节点列表要打 mihomo 的 API，所以只在进设置页时拉一次，
  // 不跟 20 秒的后台刷新绑在一起
  if (view === 'settings') loadProxyNodes();
  if (view === 'settings') loadStorage();
}

$('#nav').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.nav-item');
  if (btn) show(btn.dataset.view);
});
window.addEventListener('hashchange', () => {
  const v = location.hash.slice(1);
  if (VIEW_TITLE[v] && v !== VIEW) show(v);
});

// ─────────────────────────────────────────────── 用量
let USAGE = null; // 完整快照（含 48 小时/30 天序列），进这个视图时拉一次
let LIVE = null; // SSE 推来的轻量数据

function renderUsageTiles() {
  const live = LIVE?.usage || USAGE || null;
  if (!live) return;
  const w = live.windows || {};
  const totals = live.totals || {};
  const today = live.today || {};
  const m5 = w.m5 || {};
  const h1 = w.h1 || {};
  const h24 = w.h24 || {};
  const tokens = (b) => (b.inputTokens || 0) + (b.outputTokens || 0);
  const avg = (b) => (b.requests ? b.latencySumMs / b.requests : 0);
  const failRate = (b) => (b.requests ? Math.round((b.failed / b.requests) * 100) : 0);
  const tiles = [
    { label: '5 分钟', value: fmtInt(m5.requests), sub: `${(m5.rpm || 0).toFixed(1)} 次/分 · p95 ${fmtMs(m5.p95)}`, cls: m5.requests ? 'accent' : '' },
    { label: '本小时', value: fmtInt(h1.requests), sub: `token ${fmtCompact(tokens(h1))} · 均 ${fmtMs(avg(h1))}` },
    { label: '24 小时', value: fmtInt(h24.requests), sub: `token ${fmtCompact(tokens(h24))} · 失败 ${failRate(h24)}%`, cls: failRate(h24) > 20 ? 'warn' : '' },
    { label: '今天', value: fmtInt(today.requests), sub: `成功 ${fmtInt(today.ok)} · 失败 ${fmtInt(today.failed)}`, cls: failRate(today) > 20 ? 'warn' : '' },
    { label: '累计请求', value: fmtCompact(totals.requests), sub: `失败率 ${failRate(totals)}%` },
    { label: '累计 token', value: fmtCompact(tokens(totals)), sub: `入 ${fmtCompact(totals.inputTokens)} / 出 ${fmtCompact(totals.outputTokens)}` },
    { label: '流式占比', value: totals.requests ? `${Math.round((totals.streamed / totals.requests) * 100)}%` : '—', sub: `估算 token ${fmtInt(totals.estimated)} 条` },
    { label: '最慢一次', value: fmtMs(totals.latencyMaxMs), sub: `平均 ${fmtMs(avg(totals))}` },
  ];
  $('#usage-tiles').innerHTML = tiles
    .map(
      (t) => `<div class="ro ${t.cls || ''}"><div class="ro-label">${esc(t.label)}</div>
      <div class="ro-value">${esc(t.value)}</div><div class="ro-sub">${esc(t.sub)}</div></div>`
    )
    .join('');
}

function renderUsageBars() {
  if (!USAGE?.hours?.length) return;
  const hours = USAGE.hours;
  const max = Math.max(1, ...hours.map((h) => h.requests));
  $('#usage-bars').innerHTML =
    hours
      .map((h) => {
        const okH = Math.round(((h.requests - h.failed) / max) * 88);
        const badH = Math.round((h.failed / max) * 88);
        const label = `${h.key.slice(11)}:00 · ${h.requests} 次${h.failed ? `（失败 ${h.failed}）` : ''} · token ${(h.inputTokens || 0) + (h.outputTokens || 0)}`;
        if (!h.requests) return `<div class="bar empty" title="${esc(label)}"></div>`;
        return `<div class="bar ${h.failed ? 'has-fail' : ''}" title="${esc(label)}">
          ${badH ? `<em style="height:${badH}px"></em>` : ''}<i style="height:${Math.max(1, okH)}px"></i></div>`;
      })
      .join('') ;
  const first = hours[0]?.key?.slice(11);
  const last = hours[hours.length - 1]?.key?.slice(11);
  $('#usage-bars-note').textContent = `${first}:00 → ${last}:00 · 峰值 ${max} 次/小时`;
}

function renderUsageTables() {
  if (!USAGE) return;
  const rows = USAGE.byModel || [];
  $('#usage-model-table tbody').innerHTML = rows.length
    ? rows
        .map(
          (m) => `<tr><td class="cell-mono">${esc(m.id)}</td>
      <td class="right cell-mono">${fmtInt(m.requests)}</td>
      <td class="right cell-mono">${fmtCompact(m.inputTokens)}</td>
      <td class="right cell-mono">${fmtCompact(m.outputTokens)}</td>
      <td class="right cell-mono">${fmtMs(m.requests ? m.latencySumMs / m.requests : 0)}</td></tr>`
        )
        .join('')
    : '<tr><td colspan="5" class="muted" style="padding:18px;text-align:center">还没有数据</td></tr>';

  const keyRows = (USAGE.byKey || []).map((k) => ({
    ...k,
    label: STATE?.keys.find((x) => x.id === k.id)?.name || k.id,
    kind: 'Key',
  }));
  const acctRows = (USAGE.byAccount || []).map((a) => ({
    ...a,
    // 'anon' 不是真账号，是 opencode 的匿名 public 凭据那条路
    label: a.id === 'anon' ? 'opencode 匿名（public）' : STATE?.accounts.find((x) => x.id === a.id)?.email || a.id,
    kind: '账号',
  }));
  const merged = [...keyRows, ...acctRows];
  $('#usage-key-table tbody').innerHTML = merged.length
    ? merged
        .map(
          (r) => `<tr><td><span class="tag">${esc(r.kind)}</span> ${esc(r.label)}</td>
      <td class="right cell-mono">${fmtInt(r.requests)}</td>
      <td class="right cell-mono">${r.failed ? `<span style="color:var(--alarm)">${fmtInt(r.failed)}</span>` : '0'}</td>
      <td class="right cell-mono">${fmtCompact((r.inputTokens || 0) + (r.outputTokens || 0))}</td></tr>`
        )
        .join('')
    : '<tr><td colspan="4" class="muted" style="padding:18px;text-align:center">还没有数据</td></tr>';
}

function renderUsageFeed() {
  const list = (LIVE?.usage?.recent?.length ? LIVE.usage.recent : USAGE?.recent) || [];
  $('#usage-blank').classList.toggle('hidden', list.length > 0);
  $('#usage-feed').classList.toggle('hidden', list.length === 0);
  $('#usage-feed tbody').innerHTML = list
    .map((e) => {
      const keyName = STATE?.keys.find((k) => k.id === e.keyId)?.name || e.keyId || '—';
      const cls = e.ok ? 'ok' : 'bad';
      const io = e.usage ? `${fmtCompact(e.usage.input)}/${fmtCompact(e.usage.output)}${e.usage.estimated ? '*' : ''}` : '—';
      return `<tr><td class="cell-mono">${clock(e.ts)}</td>
      <td class="cell-mono">${esc(e.model || '—')}${e.stream ? ' <span class="tag">流</span>' : ''}</td>
      <td>${esc(keyName)}</td>
      <td><span class="tag ${cls}">${e.ok ? e.status : `${e.status} ${esc(String(e.error || '').slice(0, 18))}`}</span></td>
      <td class="right cell-mono">${fmtMs(e.latencyMs)}</td>
      <td class="right cell-mono">${e.ttfbMs ? fmtMs(e.ttfbMs) : '—'}</td>
      <td class="right cell-mono">${io}</td></tr>`;
    })
    .join('');
  const held = LIVE?.usage?.eventsHeld ?? USAGE?.eventsHeld ?? 0;
  $('#feed-note').textContent = `内存里保留最近 ${held} 条明细（上限 ${USAGE?.eventCap || 3000}，重启清空；长期统计在上面的分布里）`;
}

async function loadUsage() {
  try {
    USAGE = (await api('/usage')).usage;
    renderUsageTiles();
    renderUsageBars();
    renderUsageTables();
    renderUsageFeed();
  } catch (err) {
    toast(`用量数据加载失败：${err.message}`, 'err');
  }
}

$('#btn-usage-reset').addEventListener('click', async () => {
  if (!confirm('把用量统计清零？聊天记录和账号不受影响。')) return;
  try {
    await api('/usage/reset', { method: 'POST' });
    toast('用量统计已清零');
    await loadUsage();
    sync(true);
  } catch (err) {
    toast(err.message, 'err');
  }
});

// ─────────────────────────────────────────────── SSE 实时推送
let sse = null;
function connectLive() {
  if (sse) return;
  sse = new EventSource('/admin/api/events');
  sse.onmessage = (ev) => {
    try {
      LIVE = JSON.parse(ev.data);
    } catch {
      return;
    }
    $('#usage-live-note').textContent = `实时连接正常 · ${clock(LIVE.at)}`;
    $('#nc-usage').textContent = fmtCompact(LIVE.usage?.totals?.requests || 0);
    if (VIEW === 'usage') {
      renderUsageTiles();
      renderUsageFeed();
    }
  };
  sse.onerror = () => {
    $('#usage-live-note').textContent = '实时连接断了，正在重连…';
  };
}
function disconnectLive() {
  try {
    sse?.close();
  } catch {}
  sse = null;
}
// ─────────────────────────────────────────────── 同步 + 渲染
$('#btn-sync').addEventListener('click', () => sync());

function paintSynced() {
  if (!lastSync) return;
  const s = Math.round((Date.now() - lastSync) / 1000);
  $('#synced').textContent = s < 8 ? '刚刚同步' : `${s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分钟`}前同步`;
}

async function sync(quiet = false) {
  // 开着弹窗时跳过后台自动刷新：重建 DOM 会把用户正在填的表单冲掉。
  // 手动点「刷新」（quiet=false）仍然照做。
  if (quiet && dialogDepth > 0) return;
  const btn = $('#btn-sync');
  if (!quiet) {
    btn.disabled = true;
    btn.textContent = '刷新中…';
  }
  try {
    // 模型表几百 KB 且几乎不变，把上次的指纹带上去，服务端没变就不重发
    const tag = STATE?.modelsTag ? `?models=${encodeURIComponent(STATE.modelsTag)}` : '';
    const next = await api(`/state${tag}`);
    if (next.modelsUnchanged && STATE?.models) next.models = STATE.models;
    STATE = next;
    lastSync = Date.now();
    render();
    paintSynced();
  } catch (err) {
    if (!quiet) toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '刷新';
  }
}

function render() {
  const s = STATE;
  if (!s) return;

  // s.accounts 可能被截断到前 200 个，计数一律用 accountsTotal
  const acctTotal = s.accountsTotal ?? s.accounts.length;
  $('#nc-accounts').textContent = acctTotal;
  $('#nc-keys').textContent = s.keys.length;
  $('#nc-models').textContent = s.models.filter((m) => m.enabled).length;
  $('#m-engine').textContent = s.workerVersion ? `worker ${s.workerVersion}` : '未知';
  $('#m-storage').textContent = s.storage.persistent ? '持久' : '临时';
  $('#m-browser').textContent = s.browser.available ? (s.browser.headless ? 'headless' : 'headful') : '关闭';

  const pill = $('#top-pill');
  // 存活数优先看我们自己探到的状态（引擎观测只是补充），没探过的按"可用"算
  // 各上游的可用数是服务端统计的（不受截断影响），优先用它
  const ups = s.providers?.list || [];
  const okCount = ups.length
    ? ups.reduce((n, u) => n + (u.accountsEnabled || 0), 0)
    // 「可用」= 没被停用，且没有**仍然算数**的坏状态。过期的坏状态不算坏 ——
    // 后端已经在用它了，计数口径得跟后端一致，否则顶栏会一直报"有号不可用"
    : s.accounts.filter((a) => a.enabled && (!a.status?.state || a.status.state === 'ok' || !statusLive(a.status))).length;
  const lamp = acctTotal === 0 ? 'bad' : okCount > 0 ? 'ok' : 'warn';
  pill.querySelector('.lamp').className = `lamp ${lamp}`;
  pill.querySelector('span').textContent = acctTotal === 0 ? '号池为空' : `${okCount}/${acctTotal} 号可用`;

  $('#nc-usage').textContent = fmtCompact(s.usageSummary?.totals?.requests || 0);
  $('#nc-upstreams').textContent = (s.providers?.list || []).length;
  renderNotice(s);
  renderOverview(s);
  renderUpstreams(s);
  renderAccounts(s);
  renderKeys(s);
  renderModels(s);
  renderSettings(s);
}

// ─────────────────────────────────────────────── 上游
const FORMAT_SHORT = { chat: 'chat', responses: 'responses', anthropic: 'anthropic', gemini: 'gemini' };

function renderUpstreams(s) {
  const list = s.providers?.list || [];
  const rotations = s.providers?.rotations || {};
  const hints = s.providers?.rotationHints || {};
  $('#upstream-list').innerHTML = list
    .map((u) => {
      const modelPills = u.builtin
        ? ''
        : `<div class="up-rot"><span>模型清单 · ${u.models.length} 个</span>
        <div class="up-models">${
          u.models.length
            ? u.models
                .slice(0, 12)
                .map((m) => `<span class="mpill">${esc(m)}<button class="js-delmodel" data-m="${esc(m)}" title="移除">×</button></span>`)
                .join('') + (u.models.length > 12 ? `<span class="more">还有 ${u.models.length - 12} 个…</span>` : '')
            : '<span class="more">还没有模型 —— 点「拉取模型」或「手动添加」</span>'
        }</div></div>`;
      return `<article class="up" data-id="${u.id}" data-off="${u.enabled ? 0 : 1}">
      <div class="up-head">
        <span class="up-name">${esc(u.name)}</span>
        <span class="tag prov${u.builtin ? '' : ' oc'}">${esc(FORMAT_SHORT[u.format] || u.format)}</span>
        ${u.builtin ? '<span class="tag">内置</span>' : ''}
        ${u.enabled ? '' : '<span class="tag bad">已停用</span>'}
        <span class="up-acts">
          <button class="btn tiny js-addkeys">加 Key</button>
          <button class="btn tiny js-check">检测</button>
          ${u.builtin ? '' : '<button class="btn tiny js-more" title="更多操作">···</button>'}
        </span>
      </div>
      <div class="up-body">
        ${u.baseUrl ? `<div class="up-url">${esc(u.baseUrl)}</div>` : ''}
        ${u.note ? `<p class="up-note">${esc(u.note)}</p>` : ''}
        <div class="up-stats">
          <div class="up-stat"><b>${u.accountsEnabled}<i>/${u.accounts}</i></b><span>可用 Key</span></div>
          ${u.builtin ? '' : `<div class="up-stat ${u.models.length ? '' : 'dim'}"><b>${u.models.length}</b><span>模型</span></div>`}
          <div class="up-stat dim"><b class="txt">${u.defaultTier === 'free' ? '免费' : '付费'}</b><span>默认分类</span></div>
        </div>
        <div class="up-rot">
          <span>换号策略</span>
          <div class="rot-seg js-rot">${Object.entries(rotations)
            .map(
              ([mode, label]) =>
                `<button data-mode="${mode}" class="${u.rotation.mode === mode ? 'is-on' : ''}" title="${esc(hints[mode] || '')}">${esc(label)}</button>`
            )
            .join('')}</div>
          <p class="rot-hint">${esc(hints[u.rotation.mode] || '')}</p>
        </div>
        ${
          // 单号策略才需要"用哪个号"。放在卡上而不是设置页：这个选择本来就是
          // 每个上游一份的，放在全局设置里既是第二个入口，也表达不了"哪个上游"
          u.rotation.mode === 'single' ? `<div class="up-rot"><span>固定用哪个号</span><select class="js-pin"></select></div>` : ''
        }
        ${modelPills}
        ${
          u.builtin
            ? ''
            : `<div class="up-more hidden">
          <button class="btn tiny js-fetch">拉取模型</button>
          <button class="btn tiny js-addmodel">手动添加模型</button>
          <button class="btn tiny js-edit">编辑</button>
          <button class="btn tiny js-toggle">${u.enabled ? '停用' : '启用'}</button>
          <button class="btn tiny danger js-del">删除</button>
        </div>`
        }
      </div>
    </article>`;
    })
    .join('');

  $$('#upstream-list .up').forEach((card) => {
    const id = card.dataset.id;
    // 每次点击都从当前 STATE 重新取这个上游：卡片是渲染时生成的，
    // 但 20 秒的后台刷新会换掉 STATE —— 闭包里抓着旧对象会拿到过期的名字、
    // 过期的模型清单，甚至一个已经被删掉的上游
    const live = () => (STATE?.providers?.list || []).find((x) => x.id === id) || u0;
    const u0 = list.find((x) => x.id === id);

    $('.js-rot', card).addEventListener('click', async (ev) => {
      const btn = ev.target.closest('button[data-mode]');
      if (!btn) return;
      try {
        await api(`/upstreams/${id}/rotation`, { method: 'POST', body: { mode: btn.dataset.mode } });
        toast(`${live().name} 的换号策略改成「${rotations[btn.dataset.mode]}」`);
        sync(true);
      } catch (err) {
        toast(err.message, 'err');
      }
    });

    $('.js-addkeys', card).addEventListener('click', () => openAddAccount(live().id));

    // 单号策略的「固定用哪个号」：这个上游的号可能不在 /state 带来的那 200 个里，
    // 所以按需去服务端取一份
    const pin = $('.js-pin', card);
    if (pin) {
      const cur = live().rotation.activeAccountId || '';
      pin.innerHTML = '<option value="">（自动挑第一个可用的）</option>';
      api(`/accounts/page?provider=${encodeURIComponent(id)}&limit=500`)
        .then((r) => {
          pin.innerHTML =
            '<option value="">（自动挑第一个可用的）</option>' +
            (r.accounts || [])
              .map(
                (a) =>
                  `<option value="${esc(a.id)}"${a.id === cur ? ' selected' : ''}${a.enabled ? '' : ' disabled'}>${esc(
                    a.email || a.name || a.tokenMasked
                  )}${a.enabled ? '' : '（已停用）'}</option>`
              )
              .join('');
        })
        .catch(() => {});
      pin.addEventListener('change', async (ev) => {
        try {
          await api(`/upstreams/${id}/rotation`, { method: 'POST', body: { activeAccountId: ev.target.value || null } });
          toast(ev.target.value ? `${live().name} 固定用这个号了` : `${live().name} 恢复自动挑第一个可用的`);
          sync(true);
        } catch (err) {
          toast(err.message, 'err');
        }
      });
    }
    $('.js-more', card)?.addEventListener('click', (ev) => {
      const box = $('.up-more', card);
      box.classList.toggle('hidden');
      ev.currentTarget.classList.toggle('is-open', !box.classList.contains('hidden'));
    });
    $('.js-check', card).addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      btn.innerHTML = '<span class="spin"></span>';
      try {
        const r = await api(`/upstreams/${id}/check`, { method: 'POST' });
        const ok = (r.results || []).filter((x) => x.state === 'ok').length;
        toast(`${live().name}：${ok}/${(r.results || []).length} 个 Key 可用`, ok ? 'ok' : 'warn', 6000);
      } catch (err) {
        toast(err.message, 'err');
      }
      btn.disabled = false;
      btn.textContent = '检测';
      sync(true);
    });

    $('.js-fetch', card)?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      btn.innerHTML = '<span class="spin"></span>';
      try {
        const r = await api(`/upstreams/${id}/models/fetch`, { method: 'POST' });
        toast(`拉到 ${r.count} 个模型`, 'ok');
        sync(true);
      } catch (err) {
        toast(err.message, 'warn', 9000);
      }
      btn.disabled = false;
      btn.textContent = '拉取模型';
    });

    $('.js-addmodel', card)?.addEventListener('click', () => openAddModels(live()));
    $('.js-edit', card)?.addEventListener('click', () => openUpstreamForm(live()));
    $('.js-toggle', card)?.addEventListener('click', async () => {
      await api(`/upstreams/${id}`, { method: 'PATCH', body: { enabled: !live().enabled } });
      sync(true);
    });
    $('.js-del', card)?.addEventListener('click', async () => {
      if (!confirm(`删掉上游「${live().name}」？它名下的 ${live().accounts} 个 Key 会一起删掉。`)) return;
      const r = await api(`/upstreams/${id}`, { method: 'DELETE' });
      toast(`已删除，连带清掉 ${r.removedAccounts} 个 Key`);
      sync();
    });
    $$('.js-delmodel', card).forEach((b) =>
      b.addEventListener('click', async () => {
        await api(`/upstreams/${id}/models`, { method: 'DELETE', body: { model: b.dataset.m } });
        sync(true);
      })
    );
  });
}

/** 添加 / 编辑一个自定义上游 */
function openUpstreamForm(existing = null) {
  const editing = Boolean(existing);
  const formats = STATE.providers?.formats || {};
  const d = openDialog(
    editing ? `编辑上游 · ${existing.name}` : '添加自定义上游',
    `<p class="muted small">填一个 OpenAI / Anthropic / Gemini 兼容的接口地址，选它说哪种协议。网关内部统一以 chat 为中枢格式，所以客户端用什么协议都能打到这个上游。</p>
    <label class="field"><span class="lbl">名称</span>
      <input type="text" id="uf-name" placeholder="例如 my-relay（也会当模型 id 的前缀）" value="${editing ? esc(existing.name) : ''}">
      <small class="muted" id="uf-prefix"></small></label>
    <label class="field"><span class="lbl">接口地址（到 /v1 这一层，不含 /chat/completions）</span>
      <input type="text" id="uf-url" placeholder="https://api.example.com/v1" value="${editing ? esc(existing.baseUrl) : ''}"></label>
    <label class="field"><span class="lbl">协议格式</span>
      <select id="uf-format">${Object.entries(formats)
        .map(([v, t]) => `<option value="${v}"${editing && existing.format === v ? ' selected' : ''}>${esc(t)}</option>`)
        .join('')}</select></label>
    <label class="field"><span class="lbl">默认分类</span>
      <select id="uf-tier">
        <option value="paid"${!editing || existing.defaultTier === 'paid' ? ' selected' : ''}>按付费处理（需要 Key 勾「允许付费」，更安全）</option>
        <option value="free"${editing && existing.defaultTier === 'free' ? ' selected' : ''}>按免费处理（所有 Key 都能用）</option>
      </select></label>
    <label class="field"><span class="lbl">备注（可选）</span>
      <input type="text" id="uf-note" placeholder="自己看的说明" value="${editing ? esc(existing.note) : ''}"></label>
    ${
      editing
        ? ''
        : `<label class="field"><span class="lbl">API key（一行一个，可以一次贴几十个）</span>
      <textarea id="uf-keys" placeholder="sk-..."></textarea></label>`
    }
    <div class="btnrow"><button class="btn primary" id="uf-go" type="button">${editing ? '保存' : '创建'}</button></div>`,
    { width: 640 }
  );
  const R = d.root;
  // 名字实时预览模型前缀：填完才发现前缀不是自己想的那个很烦
  const nameBox = $('#uf-name', R);
  const preview = $('#uf-prefix', R);
  const paintPrefix = () => {
    const v = nameBox.value.trim();
    preview.textContent = v ? `模型 id 会长这样：${slugOf(v)}/你的模型名` : '';
  };
  nameBox.addEventListener('input', paintPrefix);
  paintPrefix();

  $('#uf-go', R).addEventListener('click', async (ev) => {
    const name = $('#uf-name', R).value.trim();
    const url = $('#uf-url', R).value.trim();
    // 前端先挡一道：后端也校验，但当场提示比等一轮往返舒服
    if (!url) return toast('接口地址不能为空', 'warn');
    if (!editing && !name) return toast('给这个上游起个名字（会当模型 id 的前缀）', 'warn');
    const body = {
      name,
      baseUrl: url,
      format: $('#uf-format', R).value,
      defaultTier: $('#uf-tier', R).value,
      note: $('#uf-note', R).value,
    };
    if (!editing) body.keys = $('#uf-keys', R).value;
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      if (editing) {
        await api(`/upstreams/${existing.id}`, { method: 'PATCH', body });
        toast('已保存');
      } else {
        const r = await api('/upstreams', { method: 'POST', body });
        toast(`上游已创建${r.addedKeys ? `，加了 ${r.addedKeys} 个 Key` : ''}`, 'ok');
      }
      d.close();
      sync();
    } catch (err) {
      // 原因留在弹窗里：只发 toast 的话 4 秒就没了，用户以为"点了没反应"
      d.fail(err.message);
      toast(err.message, 'err', 8000);
      btn.disabled = false;
    }
  });
}

/** 往某个上游批量加 key */
function openAddKeys(u) {
  const d = openDialog(
    `给「${u.name}」加 Key`,
    `<p class="muted small">一行一个，可以一次贴几十个。重复的会自动跳过。${
      u.builtin ? '' : `这个上游的默认分类是<b>${u.defaultTier === 'free' ? '免费' : '付费'}</b>。`
    }</p>
    <label class="field"><span class="lbl">${esc(u.credentialLabel || 'API key')}</span>
      <textarea id="ak-keys" placeholder="每行一个" style="min-height:150px"></textarea></label>
    ${poolSelect('ak-pool', u.defaultTier === 'free' ? 'free' : 'any')}
    <div class="btnrow"><button class="btn primary" id="ak-go" type="button">加入号池</button></div>`,
    { width: 620 }
  );
  const R = d.root;
  $('#ak-go', R).addEventListener('click', async () => {
    const btn = $('#ak-go', R);
    btn.disabled = true;
    try {
      const r = await api(`/upstreams/${u.id}/keys`, {
        method: 'POST',
        body: { keys: $('#ak-keys', R).value, pool: $('#ak-pool', R).value },
      });
      toast(`加了 ${r.added} 个${r.skipped ? `，跳过 ${r.skipped} 个（重复或太短）` : ''}`, 'ok');
      d.close();
      sync();
    } catch (err) {
      // 原因留在弹窗里：toast 4 秒就没了，用户会以为"点了没反应"
      d.fail(err.message);
      toast(err.message, 'err');
      btn.disabled = false;
    }
  });
}

/** 上游名 → 模型前缀。必须和后端 upstreams.js 的 slugOf 保持一致 */
const slugOf = (name) =>
  String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'upstream';

/** 手动填模型名 */
function openAddModels(u) {
  const d = openDialog(
    `给「${u.name}」添加模型`,
    `<p class="muted small">一行一个模型名，填上游认的原名（不用带前缀）。对外暴露时会自动加成
      <code>${esc(slugOf(u.name))}/模型名</code>，避免和别的上游撞车。</p>
    <label class="field"><span class="lbl">模型名</span>
      <textarea id="am-models" placeholder="gpt-4o&#10;gpt-4o-mini" style="min-height:130px"></textarea></label>
    <label class="row"><input type="checkbox" id="am-replace"><span>替换现有清单（不勾＝追加）</span></label>
    <div class="btnrow"><button class="btn primary" id="am-go" type="button">添加</button></div>`,
    { width: 600 }
  );
  const R = d.root;
  $('#am-go', R).addEventListener('click', async (ev) => {
    const raw = $('#am-models', R).value.trim();
    if (!raw) return toast('先填至少一个模型名', 'warn');
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      const r = await api(`/upstreams/${u.id}/models`, {
        method: 'POST',
        body: { models: raw, replace: $('#am-replace', R).checked },
      });
      toast(`清单里现在有 ${r.models.length} 个模型`, 'ok');
      d.close();
      sync();
    } catch (err) {
      // 原因留在弹窗里：toast 4 秒就没了，用户会以为"点了没反应"
      d.fail(err.message);
      toast(err.message, 'err');
      btn.disabled = false;
    }
  });
}

/** 批量把同一个策略套到多个上游 */
function openBulkRotation() {
  const list = STATE.providers?.list || [];
  const rotations = STATE.providers?.rotations || {};
  const hints = STATE.providers?.rotationHints || {};
  const d = openDialog(
    '批量设置换号策略',
    `<p class="muted small">选一个策略，再勾要套用的上游。不勾就是全部。</p>
    <label class="field"><span class="lbl">策略</span>
      <select id="br-mode">${Object.entries(rotations).map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join('')}</select></label>
    <p class="rot-hint" id="br-hint">${esc(hints.roundrobin || '')}</p>
    <div class="field"><span class="lbl">套用到</span>
      <div style="display:flex;flex-direction:column;gap:6px">${list
        .map(
          (u) =>
            `<label class="row"><input type="checkbox" class="js-up" value="${u.id}" checked><span>${esc(u.name)}
             <small class="muted">（当前：${esc(rotations[u.rotation.mode] || u.rotation.mode)}）</small></span></label>`
        )
        .join('')}</div></div>
    <div class="btnrow"><button class="btn primary" id="br-go" type="button">一键应用</button></div>`,
    { width: 560 }
  );
  const R = d.root;
  const modeSel = $('#br-mode', R);
  modeSel.addEventListener('change', () => ($('#br-hint', R).textContent = hints[modeSel.value] || ''));
  $('#br-go', R).addEventListener('click', async () => {
    const providers = $$('.js-up', R).filter((c) => c.checked).map((c) => c.value);
    if (!providers.length) return toast('至少勾一个上游', 'warn');
    try {
      const r = await api('/rotation/bulk', { method: 'POST', body: { mode: modeSel.value, providers } });
      toast(`${r.applied.length} 个上游都改成了「${rotations[modeSel.value]}」`, 'ok');
      d.close();
      sync();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

function renderNotice(s) {
  const box = $('#notice');
  if (!s.storage.persistent) {
    box.classList.remove('hidden');
    box.innerHTML =
      '<b>数据没有落到持久盘上。</b> Railway 服务里加一个 Volume 挂到 <code>/data</code>，否则每次重新部署账号池和 Key 都会清空。想先凑合用就去「设置 → 导出备份」留一份。';
    return;
  }
  box.classList.add('hidden');
}

function renderOverview(s) {
  const defaultKey = s.keys.find((k) => k.enabled) || s.keys[0];
  $('#v-base').textContent = s.apiBase;
  $('#v-key').textContent = defaultKey ? defaultKey.key : '还没有 Key';
  $('#v-anthropic').textContent = s.baseUrl;
  $('#v-keyinfo').innerHTML = defaultKey
    ? `默认用第一个可用 Key「${esc(defaultKey.name)}」 · 付费模型 ${
        defaultKey.allowPaid ? '<span class="tag paid">允许</span>' : '<span class="tag free">不允许</span>'
      }`
    : '去「API Key」新建一个。';

  // 通道条：一个上游一条，不是一个 key 一条 ——
  // 自定义上游动辄几十个 key，逐个画出来只会糊成一片，也看不出重点
  const wrap = $('#channels');
  const rotLabel = s.providers?.rotations || {};
  const strips = (s.providers?.list || [])
    .filter((u) => u.accounts > 0 || u.builtin)
    .map((u) => {
      const mine = s.accounts.filter((a) => (a.provider || 'freebuff') === u.id);
      const alive = mine.filter(
        (a) =>
          a.enabled !== false &&
          (!a.status?.state || a.status.state === 'ok' || a.status.state === 'metered' || !statusLive(a.status))
      );
      // 只有**仍然算数**的坏状态才算坏；过期的已经在正常参与调度了
      const bad = mine.filter((a) => a.status && statusLive(a.status) && ['token_invalid', 'banned', 'no_credit'].includes(a.status.state));
      // 最满的那个额度，画在条上
      let worst = null;
      for (const a of mine) {
        const r = quotaRatio(a.status?.quota);
        if (r !== null && (worst === null || r > worst)) worst = r;
      }
      const lamp = !mine.length ? '' : alive.length ? 'ok' : bad.length === mine.length ? 'bad' : 'warn';
      const state = !mine.length
        ? '还没有 Key'
        : bad.length
          ? `${alive.length} 可用 · ${bad.length} 失效`
          : `${alive.length} 个 Key 可用`;
      return `<div class="ch" data-off="${u.enabled ? 0 : 1}" data-up="${u.id}"
        title="${esc(u.baseUrl || u.note || u.name)}">
      <div class="ch-top"><i class="lamp ${lamp}"></i><span class="ch-role">${esc(u.format)}</span></div>
      <div class="ch-name" title="${esc(u.name)}">${esc(u.name)}</div>
      <div class="ch-host">${esc(rotLabel[u.rotation.mode] || u.rotation.mode)}</div>
      <div class="ch-state" title="${esc(state)}">${esc(state)}</div>
      ${
        worst === null
          ? ''
          : `<div class="ch-meter ${u.defaultTier === 'free' ? 'free' : ''}"><i style="width:${Math.round(worst * 100)}%"></i></div>`
      }
      <div class="ch-quota">${
        worst === null
          ? u.builtin
            ? '模型表自动维护'
            : `${u.models.length} 个模型`
          : `额度已用 ${Math.round(worst * 100)}%`
      }</div>
    </div>`;
    });
  wrap.innerHTML =
    strips.join('') +
    `<button class="ch ghost" data-act="add-upstream"><b>+</b><span>加一个上游</span></button>`;
  $$('#channels .ch[data-up]').forEach((el) =>
    el.addEventListener('click', () => {
      show('upstreams');
    })
  );

  // 注意：s.accounts 可能只是前 200 个（见 buildState 的 accountsTruncated）。
  // 所以"多少个号"一律用 accountsTotal，只有需要逐个看字段的地方才用数组。
  const total = s.accountsTotal ?? s.accounts.length;
  const calls = s.keys.reduce((n, k) => n + (k.requests || 0), 0);
  // 能跑免费模型的比例：截断时按已知那部分估，标个"约"字
  const freeCount = s.accounts.filter((a) => a.pool !== 'paid' && a.enabled).length;
  const freeText = s.accountsTruncated
    ? `约 ${Math.round((freeCount / Math.max(1, s.accounts.length)) * total)} 个能跑免费模型`
    : `${freeCount} 个能跑免费模型`;
  const activeAcct = s.accounts.find((a) => a.active);
  // 每个上游各有策略，概览里只说"有几种"，细节在「上游」那一页
  const modes = new Set((s.providers?.list || []).filter((u) => u.accounts > 0).map((u) => u.rotation.mode));
  const rotLabels = s.providers?.rotations || {};
  const mode = modes.size === 1 ? rotLabels[[...modes][0]] || [...modes][0] : `${modes.size} 种策略`;
  $('#pool-summary').textContent = total
    ? `${total} 号 · ${freeText} · 累计 ${calls} 次调用 · 切换策略：${mode}${
        activeAcct ? ` · 当前 ${activeAcct.email || activeAcct.id}` : ''
      }`
    : '空池 —— 先加一个号';

  // 上手三步（真实顺序，做完了就打勾）
  const steps = [
    { done: total > 0, label: '给某个上游加 Key', hint: 'freebuff / cline 走登录，opencode / 自定义上游直接贴 key' },
    { done: s.keys.length > 0, label: '复制 Base URL 和 Key 到客户端', hint: '上面「复制完整配置」一键带走' },
    { done: Boolean(window.__selftestPassed), label: '跑一次自检确认链路通', hint: '右上「运行自检」' },
  ];
  $('#steps').innerHTML = steps
    .map(
      (st) => `<li class="${st.done ? 'done' : ''}">
      <i class="st"></i><span class="sl">${esc(st.label)}</span><span class="muted small">${esc(st.hint)}</span></li>`
    )
    .join('');
  const allDone = steps.every((st) => st.done);
  $('#steps').classList.toggle('hidden', allDone);
  $('#steps-eyebrow').classList.toggle('hidden', allDone);
}

let acctFilter = 'all';
// 号池可能有几千个 key，/state 只带前 200 个。这里存"额外取回来的那些"，
// 按上游筛或搜索时直接问服务端要（GET /accounts/page）。
let acctExtra = null; // { key, total, rows } —— key 是 filter+q 的组合，变了就重取
let acctQuery = '';

function renderAccounts(s) {
  const tbody = $('#acct-table tbody');
  const ups = s.providers?.list || [];
  const grandTotal = s.accountsTotal ?? s.accounts.length;
  // 号多起来之后按上游分组看更清楚；只有一个上游时不显示这排按钮
  const withAccounts = ups.filter((u) => u.accounts > 0);
  if (acctFilter !== 'all' && !withAccounts.some((u) => u.id === acctFilter)) acctFilter = 'all';
  $('#acct-filter').innerHTML =
    withAccounts.length > 1
      ? `<button data-f="all" class="${acctFilter === 'all' ? 'is-on' : ''}">全部 ${grandTotal}</button>` +
        withAccounts.map((u) => `<button data-f="${u.id}" class="${acctFilter === u.id ? 'is-on' : ''}">${esc(u.name)} ${u.accounts}</button>`).join('')
      : '';
  $$('#acct-filter button').forEach((b) =>
    b.addEventListener('click', () => {
      acctFilter = b.dataset.f;
      acctExtra = null;
      // 筛选或搜索时让服务端出结果：本地那 200 个不一定包含目标
      if (acctFilter !== 'all' || acctQuery) loadAccountPage();
      else renderAccounts(STATE);
    })
  );

  // 用哪份数据：服务端取回来的优先，否则用 /state 里带的那一批
  const useExtra = acctExtra && acctExtra.key === `${acctFilter}|${acctQuery}`;
  const rows = useExtra
    ? acctExtra.rows
    : acctFilter === 'all'
      ? s.accounts
      : s.accounts.filter((a) => (a.provider || 'freebuff') === acctFilter);
  const shownTotal = useExtra ? acctExtra.total : grandTotal;
  $('#acct-blank').classList.toggle('hidden', grandTotal > 0);
  $('#acct-table').classList.toggle('hidden', grandTotal === 0);
  tbody.innerHTML = rows
    .map((a) => {
      const st = a.status;
      // 三档：ok 绿 / 有效的坏状态 黄或红 / 已过期的坏状态 当已恢复（绿）
      let tagClass = '';
      let label = '未检测';
      let tip = '点检测做一次探活';
      if (st) {
        if (st.state === 'ok') {
          tagClass = 'ok';
          label = st.verdict;
          tip = st.detail || '';
        } else if (st.retryAt) {
          // 快速抢救期：后台正在主动重试，还没放弃这个号（见 src/account-status.js 的 failureStatus / advanceRescue）
          const max = Number(STATE.settings?.accountRetryMax) || 0;
          const left = Math.max(0, max - (Number(st.retryCount) || 0) + 1);
          tagClass = 'warn';
          label = `抢救中（还剩 ${left} 次）`;
          tip = `${st.detail || ''}\n后台正在自动重试，不用手动刷新`;
        } else if (st.frozen) {
          // 用户开了冻结且已冻结：直接给到期时间（见 advanceRescue 的冻结分支）
          const at = Date.parse(st.recoverAt);
          const hhmm = Number.isFinite(at) ? new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
          tagClass = 'bad';
          label = hhmm ? `已冻结（到 ${hhmm}）` : '已冻结';
          tip = `${st.detail || ''}\n重试用尽已按设置冻结，到时间后自动恢复`;
        } else if (statusLive(st)) {
          const wait = recoverIn(st);
          tagClass = LAMP_BY_STATE[st.state] === 'bad' ? 'bad' : 'warn';
          // 会自己好的那些，直接把倒计时摆出来 —— 用户看到"1 分钟后自动恢复"就不会
          // 以为号废了，也不会去点刷新
          label = wait ? `${st.verdict} · ${humanMs(wait)}后自动恢复` : st.verdict;
          tip = `${st.detail || ''}${wait ? `\n冷却中：约 ${humanMs(wait)} 后自动恢复，不需要手动刷新` : ''}`;
        } else {
          tagClass = 'ok';
          label = '已自动恢复';
          tip = `${st.detail || ''}\n（恢复时间已过，这个号已在正常参与调度；后台复检会实测确认一下）`;
        }
      } else if (a.workerState) {
        label = `引擎观测 ${a.workerState.state}`;
        tip = '';
      }
      // 自定义上游的号只是一个 API key，没有邮箱也没有名字 —— 那就拿打码的 key 当标题，
      // 显示"未知邮箱"只会让人以为出错了
      const title = a.email || a.name || a.tokenMasked;
      return `<tr data-id="${a.id}" class="${a.enabled ? '' : 'is-off'}">
      <td><div class="cell-main"><b${a.email || a.name ? '' : ' class="cell-mono" style="font-weight:400"'}>${esc(title)}</b>${
        a.active ? ' <span class="tag now">当前</span>' : ''
      }
        <span class="cell-sub">${providerBadge(a.provider)} · ${esc(a.source)} · ${ago(a.createdAt)}加入</span></div></td>
      <td><select class="inline js-pool" title="${esc(POOL_FULL[a.pool] || '')}">
        ${Object.entries(POOL_FULL)
          .map(([v, t]) => `<option value="${v}"${a.pool === v ? ' selected' : ''}>${t}</option>`)
          .join('')}
      </select></td>
      <td><span class="tag ${tagClass}" title="${esc(tip)}">${esc(label)}</span></td>
      <td class="cell-mono">${esc(st?.quota || '—')}</td>
      <td class="cell-mono">${a.email || a.name ? esc(a.tokenMasked) : '—'}</td>
      <td class="acts">
        <button class="btn tiny js-check">检测</button>
        <button class="btn tiny js-use"${a.active || !a.enabled ? ' disabled' : ''} title="单号策略下用它">设为当前</button>
        <button class="btn tiny js-toggle">${a.enabled ? '停用' : '启用'}</button>
        <button class="btn tiny js-token" title="复制完整凭据">复制</button>
        <button class="btn tiny danger js-del" title="删除">✕</button>
      </td></tr>`;
    })
    .join('');

  // 额度快照只有 freebuff 那类账号才有；筛到纯 API key 的上游时整列都是空的，
  // 与其留一排横杠不如把列收起来
  const anyQuota = rows.some((a) => a.status?.quota);
  const anyToken = rows.some((a) => a.email || a.name);
  $('.js-col-quota').classList.toggle('hidden', !anyQuota);
  $('.js-col-token').classList.toggle('hidden', !anyToken);
  $$('#acct-table tbody tr').forEach((tr) => {
    tr.children[3]?.classList.toggle('hidden', !anyQuota);
    tr.children[4]?.classList.toggle('hidden', !anyToken);
  });

  // 表尾：显示了几条 / 共几条，需要时给一个「再取一批」
  const foot = $('#acct-foot');
  foot.classList.toggle('hidden', grandTotal === 0);
  $('#acct-count').textContent =
    rows.length >= shownTotal ? `共 ${shownTotal} 个` : `显示 ${rows.length} / ${shownTotal} 个`;
  const more = $('#acct-more');
  more.classList.toggle('hidden', rows.length >= shownTotal);
  more.disabled = false;
  more.textContent = `再取 ${Math.min(200, shownTotal - rows.length)} 个`;

  $$('#acct-table tbody tr').forEach((tr) => {
    const id = tr.dataset.id;
    // 行有可能来自服务端分页那一批，不在 s.accounts 里 —— 两边都找一下
    const acct = rows.find((a) => a.id === id) || s.accounts.find((a) => a.id === id) || {};
    $('.js-pool', tr).addEventListener('change', async (ev) => {
      await api(`/accounts/${id}`, { method: 'PATCH', body: { pool: ev.target.value } });
      toast(`${acct.email || id} 的用途改成「${POOL_FULL[ev.target.value]}」`);
      sync(true);
    });
    $('.js-check', tr).addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      btn.innerHTML = '<span class="spin"></span>';
      try {
        const r = await api(`/accounts/${id}/check`, { method: 'POST' });
        // cline 这类"没有 0 消耗探活端点"的上游只回一句说明（probe），不改账号状态
        const info = r.probe || r.status || {};
        toast(
          `${acct.email || id}：${info.verdict || '已检测'} —— ${info.detail || ''}`,
          r.probe ? 'warn' : r.status?.state === 'ok' ? 'ok' : 'warn',
          8000
        );
      } catch (err) {
        toast(err.message, 'err');
      }
      sync(true);
    });
    $('.js-toggle', tr).addEventListener('click', async () => {
      await api(`/accounts/${id}`, { method: 'PATCH', body: { enabled: !acct.enabled } });
      sync(true);
    });
    $('.js-use', tr).addEventListener('click', async () => {
      try {
        await api(`/accounts/${id}/activate`, { method: 'POST' });
        toast(`之后的请求都走 ${acct.email || id}`);
        sync(true);
      } catch (err) {
        toast(err.message, 'err');
      }
    });
    $('.js-token', tr).addEventListener('click', async () => {
      const r = await api(`/accounts/${id}`);
      copy(r.token, 'token 已复制');
    });
    $('.js-del', tr).addEventListener('click', async () => {
      if (!confirm(`把 ${acct.email || id} 从号池里删掉？用它的请求会立刻转到别的号。`)) return;
      await api(`/accounts/${id}`, { method: 'DELETE' });
      toast('已删除');
      sync();
    });
  });
}

function renderKeys(s) {
  $('#key-table tbody').innerHTML = s.keys
    .map(
      (k) => `<tr data-id="${k.id}" class="${k.enabled ? '' : 'is-off'}">
      <td><div class="cell-main"><b>${esc(k.name)}</b><span class="cell-sub">${ago(k.createdAt)}创建</span></div></td>
      <td class="cell-mono">${esc(k.key.slice(0, 14))}…</td>
      <td><input type="checkbox" class="switch paid js-paid"${k.allowPaid ? ' checked' : ''} title="允许付费模型"></td>
      <td><input type="checkbox" class="switch js-enabled"${k.enabled ? ' checked' : ''} title="启用"></td>
      <td class="cell-mono">${k.requests || 0}</td>
      <td class="cell-mono">${ago(k.lastUsedAt)}</td>
      <td class="acts">
        <button class="btn tiny js-copy">复制</button>
        <button class="btn tiny js-rename">改名</button>
        <button class="btn tiny danger js-del">删除</button>
      </td></tr>`
    )
    .join('');

  $$('#key-table tbody tr').forEach((tr) => {
    const id = tr.dataset.id;
    const k = s.keys.find((x) => x.id === id);
    $('.js-copy', tr).addEventListener('click', () => copy(k.key, `已复制「${k.name}」`));
    $('.js-paid', tr).addEventListener('change', async (ev) => {
      await api(`/keys/${id}`, { method: 'PATCH', body: { allowPaid: ev.target.checked } });
      toast(ev.target.checked ? `「${k.name}」现在可以用付费模型（会烧 Premium 额度）` : `「${k.name}」只能用免费模型`);
      sync(true);
    });
    $('.js-enabled', tr).addEventListener('change', async (ev) => {
      await api(`/keys/${id}`, { method: 'PATCH', body: { enabled: ev.target.checked } });
      sync(true);
    });
    $('.js-rename', tr).addEventListener('click', async () => {
      const name = prompt('新名称', k.name);
      if (name === null) return;
      await api(`/keys/${id}`, { method: 'PATCH', body: { name } });
      sync(true);
    });
    $('.js-del', tr).addEventListener('click', async () => {
      if (!confirm(`删除 Key「${k.name}」？正在用它的客户端会立刻收到 401。`)) return;
      try {
        await api(`/keys/${id}`, { method: 'DELETE' });
        toast('已删除');
        sync();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  });
}

let modelFilter = 'all';

// 「有问题」这一档：只放**确实调不通**的。
// "引擎列表里没有它"（absent）不算 —— 额度每天刷新、付费能解锁，那只是个提示。
// withdrawn = 官方名单明确撤下（FREEBUFF_PAUSED_FREE_MODEL_IDS），那是硬事实，算。
const DEAD_STATES = ['unavailable', 'region_locked', 'withdrawn'];

const AVAIL_LABEL = {
  ok: ['ok', '实测可用'],
  metered: ['ok', '上游有额度记录'],
  listed: ['ok', '在上游列表里'],
  suspect: ['warn', '失败过一次'],
  unavailable: ['bad', '实测不可用'],
  absent: ['warn', '未列出 · 仍可试'],
  region_locked: ['warn', '当前地区不可用'],
  withdrawn: ['bad', '官方已撤下'],
  unverified: ['', '未验证'],
};

function renderModels(s) {
  const q = ($('#model-search').value || '').trim().toLowerCase();
  // 过滤器按钮：固定四个 + 每个有模型的上游一个（上游多了才值得单独列）
  const ups = (s.providers?.list || []).filter((u) => s.models.some((m) => m.provider === u.id));
  const known = new Set(['all', 'free', 'paid', 'dead', ...ups.map((u) => u.id)]);
  if (!known.has(modelFilter)) modelFilter = 'all';
  $('#model-filter').innerHTML =
    [
      ['all', '全部'],
      ['free', '免费'],
      ['paid', '付费'],
      ...(ups.length > 1 ? ups.map((u) => [u.id, u.name]) : []),
      ['dead', '不可用'],
    ]
      .map(([f, label]) => `<button data-filter="${f}" class="${modelFilter === f ? 'is-on' : ''}">${esc(label)}</button>`)
      .join('');

  const list = s.models.filter((m) => {
    if (q && !m.id.toLowerCase().includes(q)) return false;
    if (modelFilter === 'all') return true;
    if (modelFilter === 'dead') return DEAD_STATES.includes(m.availability?.state);
    if (modelFilter === 'free' || modelFilter === 'paid') return m.tier === modelFilter;
    return m.provider === modelFilter;
  });
  const dead = s.models.filter((m) => DEAD_STATES.includes(m.availability?.state)).length;
  $('#model-meta').textContent =
    `免费 ${s.modelStats.free} · 付费 ${s.modelStats.paid}${dead ? ` · 不可用 ${dead}` : ''}` +
    `${ups.length > 1 ? ` · ${ups.length} 个上游` : ''} · 引擎 ${s.workerVersion || '?'}`;
  $('#model-table tbody').innerHTML = list.length
    ? list
        .map((m) => {
          const av = m.availability || { state: 'unverified' };
          const [cls, label] = AVAIL_LABEL[av.state] || AVAIL_LABEL.unverified;
          // 第一列：名字这颗就是复制按钮，点一下复制的是「调用名称」= m.id（填进 {"model": "..."} 的那个字符串），
          // 不是下面那行给人看的 displayName。
          return `<tr data-id="${esc(m.id)}">
      <td><div class="cell-main">
        <button type="button" class="model-copy js-copy-id" data-copy-id="${esc(m.id)}"
          title="点击复制调用名称：${esc(m.id)}" aria-label="复制调用名称：${esc(m.id)}">
          <span class="cell-mono model-copy-id">${esc(m.id)}</span>
          <svg class="model-copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="9" y="9" width="11" height="11" rx="2"></rect>
            <path d="M5 15V5a2 2 0 0 1 2-2h8"></path>
          </svg>
        </button>
        <span class="cell-sub">${providerBadge(m.provider)} ${esc(m.displayName || '—')}${m.limitedOffer ? ' · 限量试用' : ''}${
          m.closedWindowUtc ? ` · UTC ${esc(m.closedWindowUtc)} 关闭` : ''
        }</span></div></td>
      <td><select class="inline js-tier">
        <option value="free"${m.tier === 'free' ? ' selected' : ''}>免费</option>
        <option value="paid"${m.tier === 'paid' ? ' selected' : ''}>付费</option>
      </select>${m.overridden ? ' <span class="tag">手动</span>' : ''}</td>
      <td><span class="tag ${m.tier}">${esc(m.pool)}</span></td>
      <td><span class="tag ${cls}" title="${esc(av.detail || '')}${av.at ? ` · ${ago(av.at)}` : ''}">${label}</span></td>
      <td class="muted small">${esc(m.note)}</td>
      <td class="right"><input type="checkbox" class="switch js-on"${m.enabled ? ' checked' : ''}></td>
      </tr>`;
        })
        .join('')
    : '<tr><td colspan="6" class="muted" style="padding:26px;text-align:center">没有匹配的模型</td></tr>';

  $$('#model-table tbody tr[data-id]').forEach((tr) => {
    const id = tr.dataset.id;
    $('.js-tier', tr).addEventListener('change', async (ev) => {
      await api('/models/tier', { method: 'POST', body: { id, tier: ev.target.value } });
      toast(`${id} 归类为${ev.target.value === 'paid' ? '付费' : '免费'}`);
      sync(true);
    });
    $('.js-on', tr).addEventListener('change', async (ev) => {
      const off = new Set(STATE.settings.disabledModels || []);
      ev.target.checked ? off.delete(id) : off.add(id);
      await api('/settings', { method: 'PATCH', body: { disabledModels: [...off] } });
      toast(ev.target.checked ? `${id} 已对外提供` : `${id} 已下架`);
      sync(true);
    });
    // 点模型名 = 复制调用名称。renderModels 每次重渲染都会重新绑一遍，所以这里跟着上面的模式走。
    const copyBtn = $('.js-copy-id', tr);
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        const callName = copyBtn.dataset.copyId;
        copy(callName, `已复制调用名称：${callName}`);
      });
    }
  });

  // 「列表怎么来的」面板
  const meta = s.modelStats || {};
  const SOURCE_LABEL = {
    official: '官方常量源码（最新，直接解析上游 freebuff-models.ts）',
    'github-release': '第三方 GitHub Release JSON',
    jsdelivr: 'jsDelivr 上的第三方仓库文件（可能落后几天）',
    bundled: '仓库里随包的副本（离线兜底，可能过期）',
  };
  $('#m-source').textContent = SOURCE_LABEL[meta.source] || meta.source || '—';
  const lim = meta.limits || {};
  $('#m-limits').textContent = `Premium ${lim.premium ?? '?'} 次/天 · DeepSeek 家族另限 ${lim.deepseek ?? '?'} 次/天 · 非 Premium ${lim.standard ?? '?'}（CLI 协议下不限量）`;
  // 官方「已撤下」名单是自动跟的：随模型表每 6 小时刷一次，所以这里如实报当前状态
  const paused = meta.paused || {};
  const pausedNote = paused.known
    ? ` 官方「已撤下」名单已同步（${paused.count ? paused.ids.join('、') : '当前没有撤下的模型'}），每 6 小时自动刷新一次，无需手动操作。`
    : ' 官方「已撤下」名单这次没解析到（这一轮不拦任何模型，下次刷新会重试）。';
  $('#m-source-note').textContent =
    (meta.generatedAt
      ? `表生成时间 ${new Date(meta.generatedAt).toLocaleString('zh-CN', { hour12: false })}，共 ${meta.count} 个模型。分类只跟着上游额度池走，不是"要不要花钱"。`
      : '') + pausedNote;
  $('#set-hidedead').checked = s.settings.hideUnavailableModels !== false;
  const sel = $('#set-defaultmodel');
  const cur = s.settings.defaultModel || '';
  sel.innerHTML =
    `<option value="">自动挑一个不限量的（当前：${esc(s.defaultModel || '—')}）</option>` +
    s.models
      .filter((m) => m.enabled)
      .map(
        (m) =>
          `<option value="${esc(m.id)}"${m.id === cur ? ' selected' : ''}>${esc(m.id)}${m.tier === 'paid' ? '（付费）' : ''}${
            m.availability?.state === 'withdrawn' ? '（官方已撤下）' : ''
          }</option>`
      )
      .join('');
  // 钉住的默认模型被官方撤下 = 每个不带 model 的请求都会 400。这种"配置还指着死模型"
  // 的情况必须当场说破，别让人去翻日志 —— 官方恢复上架后这句会自动消失。
  const curDead = s.models.find((m) => m.id === cur && m.availability?.state === 'withdrawn');
  $('#set-defaultmodel-note').textContent = curDead
    ? `⚠ 当前默认模型 ${cur} 已被官方撤下：不带 model 的请求会全部失败。改回「自动挑一个」或换一个模型；官方恢复后这里会自动变回可用。`
    : '';
}

$('#set-hidedead').addEventListener('change', async (ev) => {
  await api('/settings', { method: 'PATCH', body: { hideUnavailableModels: ev.target.checked } });
  toast(ev.target.checked ? '实测不可用的模型不再对外提供' : '所有启用的模型都会列给客户端');
  sync(true);
});
$('#set-defaultmodel').addEventListener('change', async (ev) => {
  await api('/settings', { method: 'PATCH', body: { defaultModel: ev.target.value } });
  toast(ev.target.value ? `不带 model 的请求走 ${ev.target.value}` : '恢复自动选择');
  sync(true);
});
$('#btn-model-status-reset').addEventListener('click', async () => {
  await api('/models/status/reset', { method: 'POST', body: {} });
  toast('实测状态已清空，下次真实请求会重新学');
  sync(true);
});

function renderSettings(s) {
  $('#set-allowpaid').checked = Boolean(s.settings.allowPaidDefault);
  // 限流与降级：默认都是最保守的一档，用户自己决定要不要更激进的接管
  const fb = s.settings.modelFallback || 'off';
  $('#set-fallback').value = fb;
  $('#s-fallback-state').textContent =
    fb === 'off' ? '关闭' : fb === 'tier' ? '同档位内接管' : '可跨档位接管';
  const recheck = Number(s.settings.accountRecheckMinutes);
  $('#set-recheck').value = Number.isFinite(recheck) ? recheck : 5;
  // 快速抢救期设置：重试上限 / 重试用尽是否冻结 / 冻结时长
  const retryMax = Number(s.settings.accountRetryMax);
  $('#set-retrymax').value = Number.isFinite(retryMax) ? retryMax : 5;
  $('#set-freeze').checked = Boolean(s.settings.accountFreezeEnabled);
  const freezeMin = Number(s.settings.accountFreezeMinutes);
  $('#set-freezemin').value = Number.isFinite(freezeMin) ? freezeMin : 30;
  // 出口代理（伪装 IP）。订阅 URL 服务端只回 host（里面常带机场凭据），
  // 所以输入框保持空、用 placeholder 说明"已经配过了"。
  const px = s.proxy || {};
  $('#set-px').checked = Boolean(px.enabled);
  $('#set-pxblock').checked = px.blockOnFailure !== false;
  $('#set-pxurl').placeholder = s.proxySubscriptionUrlSet
    ? `已保存：${px.subscriptionHost || '(地址不合法)'} —— 填新地址可替换`
    : 'https://example.com/clash';
  $('#px-state').textContent = px.enabled
    ? px.running
      ? px.proxying
        ? `已开启 · 流量走代理 · :${px.mixedPort}`
        : '已开启 · 内核在跑但流量未切换'
      : '⚠️ 已开启但内核没跑 —— 请求会被拒绝'
    : '直连';
  $('#px-state').style.color = px.enabled && !px.running ? 'var(--alarm)' : '';
  const pxBtn = $('#btn-px-save');
  if (pxBtn) pxBtn.disabled = false;
  // 目录和持久性挤在一行：持久性是这个目录的属性，分成两行反而要来回看
  $('#s-datadir').textContent = `${s.storage.dir}　${s.storage.persistent ? '持久' : '临时 · 重新部署会清空'}`;
  $('#s-persist-note').textContent = s.storage.volume
    ? `Railway Volume 已挂载在 ${s.storage.volume}。`
    : s.storage.onRailway
      ? '没检测到 Railway Volume。加一个挂到 /data，账号池才能跨部署留下来。'
      : '本地运行，数据就在上面这个目录里。';
  $('#s-browser').textContent = s.browser.available
    ? `可用 · ${s.browser.headless ? 'headless' : 'headful (Xvfb)'}`
    : `关闭 · ${s.browser.reason || s.browser.loadError || '未安装 Chromium'}`;
  $('#s-proxy').textContent = s.browser.proxy || '直连';
  // 聊天记录
  const chat = s.chatlog || {};
  $('#set-chatlog').checked = Boolean(chat.enabled);
  $('#s-chat-size').textContent = chat.files
    ? `${fmtBytes(chat.bytes)} · ${chat.files} 个文件${chat.full ? ' · 已写满，停止记录' : ''}`
    : '还没有记录';
  $('#s-chat-limit').textContent = fmtBytes(chat.limitBytes || 0);
  // 分组标题右边那句状态：开着还是关着，一眼看见
  $('#s-chat-state').textContent = chat.enabled ? '正在记录' : '已关闭';

  const cred = s.credentials || {};
  const parts = [];
  if (cred.env) parts.push('环境变量 ADMIN_PASSWORD');
  if (cred.console) parts.push(cred.consoleGenerated ? '首次启动自动生成的临时密码（建议尽快改掉）' : '控制台里设置的密码');
  $('#s-creds').textContent = parts.length ? `${parts.length} 种：${parts.join(' + ')}` : '（没有设置密码）';
}

// ─────────────────────────────────────────────── 概览上的动作
$('#channels').addEventListener('click', (ev) => {
  if (ev.target.closest('[data-act="add-upstream"]')) openUpstreamForm();
});
$('#acct-blank').addEventListener('click', (ev) => {
  if (ev.target.closest('[data-act="add-account"]')) openAddAccount();
});
$$('[data-copy]').forEach((btn) =>
  btn.addEventListener('click', () => {
    const text = $(btn.dataset.copy).textContent.trim();
    copy(text);
  })
);

$('#btn-copy-all').addEventListener('click', () => {
  const k = STATE.keys.find((x) => x.enabled) || STATE.keys[0];
  const usable = STATE.models.filter((m) => m.enabled && (k?.allowPaid || m.tier === 'free')).map((m) => m.id);
  copy(
    [
      `Base URL (OpenAI): ${STATE.apiBase}`,
      `Base URL (Anthropic): ${STATE.baseUrl}`,
      `API Key: ${k ? k.key : '(还没有 Key)'}`,
      `可用模型: ${usable.join(', ') || '(无)'}`,
    ].join('\n'),
    '配置已复制'
  );
});

$('#btn-selftest').addEventListener('click', async () => {
  const btn = $('#btn-selftest');
  const out = $('#selftest-out');
  btn.disabled = true;
  out.innerHTML = '<span class="spin"></span> 正在用免费模型跑一次真实请求…';
  try {
    const r = await api('/selftest', { method: 'POST', body: {} });
    if (r.ok) {
      window.__selftestPassed = true;
      out.innerHTML = `<span class="tag ok">通过</span> ${r.ms}ms · ${esc(r.model)} 回复：<b>${esc(r.reply.slice(0, 80))}</b>`;
      renderOverview(STATE);
    } else {
      out.innerHTML = `<span class="tag bad">失败 HTTP ${r.status}</span> ${esc((r.raw || '').slice(0, 200))}`;
    }
  } catch (err) {
    out.innerHTML = `<span class="tag bad">失败</span> ${esc(err.message)}`;
  } finally {
    btn.disabled = false;
  }
});

/**
 * 从服务端取一批账号。/state 只带前 200 个，按上游筛或搜索时目标可能不在里面，
 * 所以这些操作一律问服务端要。append=true 是「再取一批」。
 */
async function loadAccountPage({ append = false } = {}) {
  const key = `${acctFilter}|${acctQuery}`;
  // 「再取一批」的起点：已经取过就接着往后，否则从 /state 带来的那批之后开始 ——
  // 不能一律从 0 开始，那样第一次点「再取」只会把原来那 200 个重新拿一遍
  let have = [];
  if (append) {
    if (acctExtra?.key === key) have = acctExtra.rows;
    else if (acctFilter === 'all' && !acctQuery) have = STATE?.accounts || [];
  }
  try {
    const qs = new URLSearchParams({ offset: String(have.length), limit: '200' });
    if (acctFilter !== 'all') qs.set('provider', acctFilter);
    if (acctQuery) qs.set('q', acctQuery);
    const r = await api(`/accounts/page?${qs}`);
    acctExtra = { key, total: r.total, rows: [...have, ...r.accounts] };
    renderAccounts(STATE);
  } catch (err) {
    toast(err.message, 'err');
  }
}

$('#acct-more').addEventListener('click', (ev) => {
  ev.currentTarget.disabled = true;
  ev.currentTarget.innerHTML = '<span class="spin"></span>';
  loadAccountPage({ append: true });
});

let acctSearchTimer = null;
$('#acct-search').addEventListener('input', (ev) => {
  const v = ev.target.value.trim();
  clearTimeout(acctSearchTimer);
  // 打字防抖：别每敲一个字就打一次服务端
  acctSearchTimer = setTimeout(() => {
    acctQuery = v;
    acctExtra = null;
    if (acctQuery || acctFilter !== 'all') loadAccountPage();
    else renderAccounts(STATE);
  }, 250);
});

$('#btn-check-all').addEventListener('click', async () => {
  const btn = $('#btn-check-all');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> 检测中';
  try {
    const r = await api('/accounts/check-all', { method: 'POST' });
    const ok = r.results.filter((x) => x.state === 'ok').length;
    toast(`检测完成：${ok}/${r.results.length} 个号存活`, ok === r.results.length ? 'ok' : 'warn');
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '全部检测';
    sync();
  }
});

$('#model-filter').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button');
  if (!btn) return;
  modelFilter = btn.dataset.filter;
  renderModels(STATE);
});
$('#model-search').addEventListener('input', () => renderModels(STATE));
$('#btn-model-refresh').addEventListener('click', async () => {
  const btn = $('#btn-model-refresh');
  btn.disabled = true;
  try {
    await api('/models/refresh', { method: 'POST' });
    toast('模型表已刷新');
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    sync();
  }
});
$('#set-allowpaid').addEventListener('change', async (ev) => {
  await api('/settings', { method: 'PATCH', body: { allowPaidDefault: ev.target.checked } });
  toast('已保存');
});
$('#set-fallback').addEventListener('change', async (ev) => {
  try {
    await api('/settings', { method: 'PATCH', body: { modelFallback: ev.target.value } });
    toast(ev.target.value === 'off' ? '已关闭模型降级' : '已保存 —— 限流时会先换模型顶上');
  } catch (err) {
    toast(err.message, 'err');
    sync(true);
  }
});
$('#set-recheck').addEventListener('change', async (ev) => {
  const n = Math.max(0, Math.min(1440, Math.round(Number(ev.target.value) || 0)));
  ev.target.value = n;
  try {
    await api('/settings', { method: 'PATCH', body: { accountRecheckMinutes: n } });
    toast(n === 0 ? '已关闭后台复检' : `已保存 —— 每 ${n} 分钟复检一次限流账号`);
  } catch (err) {
    toast(err.message, 'err');
    sync(true);
  }
});
$('#set-retrymax').addEventListener('change', async (ev) => {
  const n = Math.max(0, Math.min(20, Math.round(Number(ev.target.value) || 0)));
  ev.target.value = n;
  try {
    await api('/settings', { method: 'PATCH', body: { accountRetryMax: n } });
    toast(n === 0 ? '已关闭快速抢救期（退回旧行为）' : `已保存 —— 重试用尽上限 ${n} 次`);
  } catch (err) {
    toast(err.message, 'err');
    sync(true);
  }
});
$('#set-freeze').addEventListener('change', async (ev) => {
  const on = ev.target.checked;
  try {
    await api('/settings', { method: 'PATCH', body: { accountFreezeEnabled: on } });
    toast(on ? '已开启：重试用尽后冻结账号' : '已关闭：重试用尽后放回常规复检');
  } catch (err) {
    toast(err.message, 'err');
    sync(true);
  }
});
$('#set-freezemin').addEventListener('change', async (ev) => {
  const n = Math.max(1, Math.min(1440, Math.round(Number(ev.target.value) || 1)));
  ev.target.value = n;
  try {
    await api('/settings', { method: 'PATCH', body: { accountFreezeMinutes: n } });
    toast(`已保存 —— 冻结时长 ${n} 分钟`);
  } catch (err) {
    toast(err.message, 'err');
    sync(true);
  }
});
// ─── 出口代理（伪装 IP）────────────────────────────────────────────────────
// 节点列表要打 mihomo 的 API，所以按需拉，不塞进 /state（那会让每 20 秒的轮询变重）。

let proxyNodesBusy = false;

async function loadProxyNodes() {
  const box = $('#px-nodes');
  if (!box) return;
  const px = STATE.proxy || {};
  if (!px.enabled) {
    box.innerHTML = '<div class="muted small">伪装 IP 关着，出站走直连。</div>';
    $('#px-note').textContent =
      px.kernelAvailable === false
        ? '镜像里没找到 mihomo 内核 —— 需要重新部署（Dockerfile 会装好它）。'
        : '开启后这里会列出订阅里的节点。';
    return;
  }
  // 内核没跑时别去发这个注定失败的请求：直接把原因显示出来。
  // 顺带避免每次切进设置页都撞一次 503（切来切去会反复触发，看着像控制台坏了）。
  if (!px.running) {
    box.innerHTML = '<div class="muted small">内核没在运行，暂时读不到节点列表。</div>';
    $('#px-note').textContent = px.lastError || '点下面的「重新加载」把内核拉起来。';
    return;
  }
  // 切视图够快时可能连着进来几次，同一份列表不用发两遍
  if (proxyNodesBusy) return;
  proxyNodesBusy = true;
  try {
    const d = await api('/proxy/nodes');
    const nodes = Array.isArray(d.nodes) ? d.nodes : [];
    box.innerHTML = nodes.length
      ? nodes
          .map((n) => {
            const cur = n.name === d.current;
            return `<div class="pxnode${cur ? ' on' : ''}" data-node="${esc(n.name)}">
              <span class="pxdot${n.alive ? '' : ' off'}"></span>
              <span class="pxnm">${esc(n.name)}</span>
              <span class="pxmeta">${esc(n.type)}</span>
              <span class="pxmeta">${cur ? '当前' : n.delay != null ? `${n.delay}ms` : '未测'}</span>
            </div>`;
          })
          .join('')
      : '<div class="muted small">订阅里没有节点。确认订阅是 Clash 格式（有 <code>proxies:</code> 段），再点「保存并拉取」。</div>';
    const alive = nodes.filter((n) => n.alive).length;
    $('#px-note').textContent = nodes.length
      ? `共 ${nodes.length} 个节点，${alive} 个探活通过${px.running ? '' : ' · ⚠️ 内核当前没在跑，请求会被拒绝'}`
      : px.lastError || '';
  } catch (err) {
    box.innerHTML = `<div class="muted small">读节点失败：${esc(err.message)}</div>`;
  } finally {
    proxyNodesBusy = false;
  }
}

$('#set-px').addEventListener('change', async (ev) => {
  const on = ev.target.checked;
  try {
    const r = await api('/settings', { method: 'PATCH', body: { proxyEnabled: on } });
    if (on && r.settings && r.settings.proxySubscriptionUrl === '' && !STATE.proxy?.hasSubscription) {
      toast('已开启伪装 IP —— 但没有订阅内容，请填订阅地址并拉取；在那之前请求会被拒绝', 'warn', 9000);
    } else {
      toast(on ? '已开启伪装 IP：出站走订阅节点' : '已关闭伪装 IP：出站回到直连');
    }
    await sync(true);
    await loadProxyNodes();
  } catch (err) {
    toast(err.message, 'err');
    sync(true);
  }
});

$('#set-pxblock').addEventListener('change', async (ev) => {
  const on = ev.target.checked;
  try {
    await api('/settings', { method: 'PATCH', body: { proxyBlockOnFailure: on } });
    toast(on ? '已保存：代理不可用时拒绝请求（不暴露真实出口）' : '已保存：代理不可用时回退直连（会暴露真实 IP）', on ? 'ok' : 'warn');
  } catch (err) {
    toast(err.message, 'err');
    sync(true);
  }
});

$('#btn-px-save').addEventListener('click', async () => {
  const btn = $('#btn-px-save');
  const url = $('#set-pxurl').value.trim();
  btn.disabled = true;
  btn.textContent = '拉取中…';
  try {
    const r = await api('/proxy/subscription', { method: 'POST', body: { url } });
    $('#set-pxurl').value = '';
    toast(
      url
        ? `订阅已更新：${r.bytes} 字节，${r.nodes || 0} 个节点`
        : '已清空订阅并停用节点'
    );
    await sync(true);
    await loadProxyNodes();
  } catch (err) {
    toast(err.message, 'err', 9000);
  } finally {
    btn.disabled = false;
    btn.textContent = '保存并拉取';
  }
});

$('#btn-px-refresh').addEventListener('click', async () => {
  const btn = $('#btn-px-refresh');
  btn.disabled = true;
  try {
    await loadProxyNodes();
  } finally {
    btn.disabled = false;
  }
});

$('#btn-px-reload').addEventListener('click', async () => {
  const btn = $('#btn-px-reload');
  btn.disabled = true;
  btn.textContent = '重启中…';
  try {
    const r = await api('/proxy/reload', { method: 'POST' });
    toast(r.running ? '内核已重启，流量走代理' : `内核没起来：${r.error || '未知原因'}`, r.running ? 'ok' : 'err', 8000);
    await sync(true);
    await loadProxyNodes();
  } catch (err) {
    toast(err.message, 'err', 8000);
  } finally {
    btn.disabled = false;
    btn.textContent = '重载内核';
  }
});

$('#px-nodes').addEventListener('click', async (ev) => {
  const row = ev.target.closest('[data-node]');
  if (!row) return;
  const name = row.dataset.node;
  try {
    await api('/proxy/nodes/select', { method: 'POST', body: { name } });
    toast(`已切到节点「${name}」`);
    await sync(true);
    await loadProxyNodes();
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#btn-export').addEventListener('click', async () => {
  const btn = $('#btn-export');
  btn.disabled = true;
  try {
    // 走 POST：GET 的备份接口可以被恶意页面用顶层跳转触发，而这份备份里是明文 token
    const data = await api('/export', { method: 'POST' });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `myapi-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('备份已下载 —— 里面是明文 token，别乱放');
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

// ─────────────────────────────────────────────── 对话框
// 开着弹窗的数量。后台刷新会重建整片 DOM 并换掉 STATE，
// 弹窗又是从 STATE 拿数据填的表单 —— 边填边被刷会很难受，所以开着弹窗就暂停自动刷新。
let dialogDepth = 0;

function openDialog(title, html, { width = 560, onClose } = {}) {
  const dlg = document.createElement('dialog');
  dlg.style.setProperty('--dlg-w', `${width}px`);
  dlg.innerHTML = `<div class="dlg-head"><b>${esc(title)}</b><span class="grow"></span>
    <button class="btn quiet tiny js-x" type="button">关闭</button></div>
    <div class="dlg-body">${html}<div class="dlg-err hidden"></div></div>`;
  $('#dialogs').appendChild(dlg);
  dialogDepth++;
  dlg.addEventListener('close', () => {
    dialogDepth = Math.max(0, dialogDepth - 1);
    onClose?.();
    dlg.remove();
  });
  $('.js-x', dlg).addEventListener('click', () => dlg.close());
  dlg.showModal();
  // 首个可输入元素自动聚焦，省一次点击
  setTimeout(() => $('input:not([readonly]), textarea, select', dlg)?.focus(), 60);
  /**
   * 提交失败时把原因**留在弹窗里**，不能只靠 toast —— toast 4 秒就没了，
   * 用户看到的就是"点了没反应，录不进去"。这一条是从真实反馈里改出来的。
   */
  const fail = (msg) => {
    const box = $('.dlg-err', dlg);
    box.textContent = String(msg || '出错了');
    box.classList.remove('hidden');
    box.scrollIntoView({ block: 'nearest' });
  };
  const clearFail = () => $('.dlg-err', dlg).classList.add('hidden');
  return { root: dlg, close: () => dlg.close(), fail, clearFail };
}

$('#btn-add-key').addEventListener('click', () => {
  const d = openDialog(
    '新建 API Key',
    `<label class="field"><span class="lbl">名称</span>
      <input type="text" id="nk-name" placeholder="给谁用的，比如 Cherry Studio"></label>
    <label class="row-toggle"><span>允许使用付费(Premium)模型<br><small class="muted">号池每天一共 6 次 Premium session，不开就只给免费模型。</small></span>
      <input type="checkbox" class="switch paid" id="nk-paid"${STATE.settings.allowPaidDefault ? ' checked' : ''}></label>
    <div class="dlg-foot"><button class="btn js-cancel" type="button">取消</button>
      <button class="btn primary" id="nk-go" type="button">生成并复制</button></div>`,
    { width: 520 }
  );
  $('.js-cancel', d.root).addEventListener('click', d.close);
  $('#nk-go', d.root).addEventListener('click', async () => {
    try {
      const r = await api('/keys', {
        method: 'POST',
        body: { name: $('#nk-name', d.root).value, allowPaid: $('#nk-paid', d.root).checked },
      });
      d.close();
      await sync();
      copy(r.key.key, '新 Key 已生成并复制');
    } catch (err) {
      toast(err.message, 'err');
    }
  });
});

$('#btn-passwd').addEventListener('click', () => {
  const d = openDialog(
    '修改管理密码',
    `<label class="field"><span class="lbl">当前密码</span>
      <input type="password" id="pw-cur" autocomplete="current-password"></label>
    <label class="field"><span class="lbl">新密码（至少 10 位，别用纯数字）</span>
      <input type="password" id="pw-next" autocomplete="new-password"></label>
    <p class="muted small">保存后所有设备上的登录状态都会失效（这台会自动续上）。环境变量 ADMIN_PASSWORD 里那个密码依然有效 —— 想只留新密码，把那个变量删掉再部署。</p>
    <div class="dlg-foot"><button class="btn js-cancel" type="button">取消</button>
      <button class="btn primary" id="pw-go" type="button">保存</button></div>`,
    { width: 460 }
  );
  $('.js-cancel', d.root).addEventListener('click', d.close);
  $('#pw-go', d.root).addEventListener('click', async () => {
    const btn = $('#pw-go', d.root);
    btn.disabled = true;
    try {
      const r = await api('/password', {
        method: 'POST',
        body: { current: $('#pw-cur', d.root).value, next: $('#pw-next', d.root).value },
      });
      toast(r.note || '密码已更新');
      d.close();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });
});

$('#btn-logout-all').addEventListener('click', async () => {
  if (!confirm('把所有设备上的登录状态都作废？（这台浏览器会自动续上）')) return;
  try {
    const r = await api('/logout-all', { method: 'POST' });
    toast(r.note || '已登出所有设备');
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#btn-import').addEventListener('click', () => {
  const d = openDialog(
    '导入备份',
    `<label class="field"><span class="lbl">粘贴导出的 JSON</span>
      <textarea id="imp-text" placeholder='{"accounts":[…],"keys":[…]}' style="min-height:160px"></textarea></label>
    <label class="row-toggle"><span>先清空现有账号和 Key</span><input type="checkbox" class="switch" id="imp-replace"></label>
    <div class="dlg-foot"><button class="btn js-cancel" type="button">取消</button>
      <button class="btn primary" id="imp-go" type="button">导入</button></div>`,
    { width: 600 }
  );
  $('.js-cancel', d.root).addEventListener('click', d.close);
  $('#imp-go', d.root).addEventListener('click', async () => {
    try {
      const payload = JSON.parse($('#imp-text', d.root).value);
      const r = await api('/import', { method: 'POST', body: { payload, replace: $('#imp-replace', d.root).checked } });
      toast(`导入完成：账号 +${r.accounts}，Key +${r.keys}`);
      d.close();
      sync();
    } catch (err) {
      toast(`导入失败：${err.message}`, 'err');
    }
  });
});

// ─────────────────────────────────────────────── 添加账号
// selected：opencode 那个面板默认选「仅免费模型」——Zen 的付费模型是真花钱的，
// 别让人点两下就把余额挂上去
const poolSelect = (id, selected = 'any') => `<label class="field" style="max-width:190px;margin:0">
  <span class="lbl">用途</span>
  <select id="${id}">${Object.entries(POOL_FULL)
    .map(([v, t]) => `<option value="${v}"${v === selected ? ' selected' : ''}>${t}</option>`)
    .join('')}</select>
</label>`;

/** 内置浏览器画面的那一块 HTML（两个弹窗共用，按 id 前缀区分） */
// 内置浏览器那一块的 HTML。id 一律用 `<前缀>-vw-*`：
// 早先这里的「前往」按钮是 `<前缀>-go`，正好和 opencode 弹窗里「加入号池」的
// id 撞了，$() 取到藏在 .viewer.hidden 里的那个，导致 key 根本提交不上去。
// 加个 -vw- 段把命名空间隔开。
const viewerMarkup = (p) => `<div class="viewer hidden" id="${p}-viewer">
  <div class="viewer-bar">
    <button class="btn tiny" data-nav="back" type="button" title="后退">←</button>
    <button class="btn tiny" data-nav="forward" type="button" title="前进">→</button>
    <button class="btn tiny" data-nav="reload" type="button" title="刷新">↻</button>
    <input type="text" id="${p}-vw-url" placeholder="https://" class="grow">
    <button class="btn tiny" id="${p}-vw-go" type="button">前往</button>
    <span class="pill"><i class="lamp" id="${p}-vw-lamp"></i><span id="${p}-vw-conn">未连接</span></span>
  </div>
  <div class="screen" id="${p}-vw-screen" tabindex="0">
    <img id="${p}-vw-img" alt="服务器浏览器画面">
    <div class="glass" id="${p}-vw-glass"></div>
    <div class="veil" id="${p}-vw-veil"><span><span class="spin"></span> 正在启动 Chromium，首次大约 5~15 秒…</span></div>
  </div>
  <div class="viewer-bar">
    <input type="text" id="${p}-vw-text" placeholder="要输入的文字 —— 先在画面里点一下输入框，再发送" class="grow">
    <button class="btn tiny" id="${p}-vw-send" type="button">发送文字</button>
    <button class="btn tiny" id="${p}-vw-enter" type="button">回车</button>
  </div>
</div>`;

/**
 * 内置浏览器画面 + 输入转发。freebuff 和 opencode 两个弹窗都要用，
 * 所以提到模块级并按 id 前缀参数化 —— 复制一份出来早晚会两边改不同步。
 * ws 的所有权留在调用方（它要负责关闭），这里通过 io.get/io.set 存取。
 */
function mountViewer(prefix, R, io, { onFrame } = {}) {
  const img = $(`#${prefix}-vw-img`, R);
  const glass = $(`#${prefix}-vw-glass`, R);
  const screen = $(`#${prefix}-vw-screen`, R);
  if (!screen) return null;
  const send = (msg) => {
    const ws = io.get();
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  };

  // 鼠标位置 → 画面内 0~1 归一化坐标（img 是 contain，要减掉黑边）
  const norm = (ev) => {
    const r = img.getBoundingClientRect();
    const nw = img.naturalWidth || 1440;
    const nh = img.naturalHeight || 900;
    const scale = Math.min(r.width / nw, r.height / nh);
    const dw = nw * scale;
    const dh = nh * scale;
    const clamp = (v) => Math.max(0, Math.min(1, v));
    return {
      x: clamp((ev.clientX - (r.left + (r.width - dw) / 2)) / dw),
      y: clamp((ev.clientY - (r.top + (r.height - dh) / 2)) / dh),
    };
  };

  const conn = (state, text) => {
    const lamp = $(`#${prefix}-vw-lamp`, R);
    if (lamp) lamp.className = `lamp ${state}`;
    const label = $(`#${prefix}-vw-conn`, R);
    if (label) label.textContent = text;
  };

  const connect = (flowId) => {
    const ws = new WebSocket(
      `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/admin/ws/browser?flow=${encodeURIComponent(flowId)}`
    );
    io.set(ws);
    ws.onopen = () => conn('busy', '等首帧');
    ws.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.t === 'frame') {
        img.src = `data:image/jpeg;base64,${m.data}`;
        $(`#${prefix}-vw-veil`, R).classList.add('hidden');
        conn('ok', '已连接');
        onFrame?.();
      } else if (m.t === 'status') {
        const box = $(`#${prefix}-vw-url`, R);
        if (box && document.activeElement !== box) box.value = m.url || '';
      } else if (m.t === 'closed') {
        conn('bad', '已断开');
        const veil = $(`#${prefix}-vw-veil`, R);
        veil.classList.remove('hidden');
        veil.innerHTML = '<span>浏览器已关闭。重新点上面的按钮可以再开一个。</span>';
      } else if (m.t === 'error') {
        toast(m.message, 'warn', 6000);
      }
    };
    ws.onclose = () => {
      io.set(null);
      conn('', '未连接');
    };
  };

  let lastMove = 0;
  glass.addEventListener('mousemove', (ev) => {
    if (Date.now() - lastMove < 45) return;
    lastMove = Date.now();
    send({ t: 'move', ...norm(ev) });
  });
  glass.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    screen.focus();
    send({ t: 'down', ...norm(ev), button: ev.button, clickCount: ev.detail || 1 });
  });
  glass.addEventListener('mouseup', (ev) => {
    ev.preventDefault();
    send({ t: 'up', ...norm(ev), button: ev.button, clickCount: ev.detail || 1 });
  });
  glass.addEventListener('contextmenu', (ev) => ev.preventDefault());
  glass.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      send({ t: 'wheel', ...norm(ev), dx: ev.deltaX, dy: ev.deltaY });
    },
    { passive: false }
  );
  screen.addEventListener('keydown', (ev) => {
    if (ev.key === 'F5' || (ev.ctrlKey && ev.key === 'r') || ev.key === 'Escape') return;
    ev.preventDefault();
    send({ t: 'key', key: ev.key, ctrl: ev.ctrlKey, alt: ev.altKey, meta: ev.metaKey, shift: ev.shiftKey });
  });
  screen.addEventListener('paste', (ev) => {
    const text = ev.clipboardData?.getData('text');
    if (!text) return;
    ev.preventDefault();
    send({ t: 'text', text });
  });
  // 导航按钮限定在这个 viewer 内部找：两个弹窗不会同时存在，
  // 但限定作用域比按前缀区分属性名稳（以前用 data-nav / data-ocnav 两套，加第三个就得再改一次）
  const viewer = $(`#${prefix}-viewer`, R);
  $$('[data-nav]', viewer || R).forEach((b) =>
    b.addEventListener('click', () => send({ t: b.getAttribute('data-nav') }))
  );
  $(`#${prefix}-vw-go`, R)?.addEventListener('click', () => send({ t: 'navigate', url: $(`#${prefix}-vw-url`, R).value }));
  $(`#${prefix}-vw-url`, R)?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') send({ t: 'navigate', url: ev.target.value });
  });
  $(`#${prefix}-vw-send`, R)?.addEventListener('click', () => {
    const box = $(`#${prefix}-vw-text`, R);
    if (!box.value) return;
    send({ t: 'text', text: box.value });
    box.value = '';
  });
  $(`#${prefix}-vw-text`, R)?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') $(`#${prefix}-vw-send`, R).click();
  });
  $(`#${prefix}-vw-enter`, R)?.addEventListener('click', () => send({ t: 'key', key: 'Enter' }));
  return { connect, screen, send };
  }

/**
 * 添加账号：**先选上游，再按那个上游自己的方式录入**。
 * 几个上游的录入方式本来就不一样，混在一排标签里选会让人以为
 * "授权链接"也能用来加 opencode 的 key。
 *   freebuff  —— 授权链接 / 内置浏览器 / 粘贴 authToken（三条都保留）
 *   opencode  —— 直接贴 Zen key，或者用服务器的指纹浏览器登录后复制
 *   cline     —— 设备码授权链接 / 内置浏览器 / 粘贴 refreshToken
 *   自定义上游 —— 只有贴 key 这一种
 * preselect 传上游 id 时跳过选择那一步（上游卡上的「加 Key」就是这么进来的）。
 */
function openAddAccount(preselect = null) {
  const list = STATE.providers?.list || [];
  const picked = preselect ? list.find((u) => u.id === preselect) : null;
  // 只有一个上游可选时（比如全新部署只有内置那几个）也照样让用户确认一下，
  // 因为内置上游之间的录入方式差别很大
  if (!picked) return openPickUpstream(list);
  if (picked.id === 'freebuff') return openFreebuffAdd(picked);
  if (picked.id === 'opencode') return openOpencodeAdd(picked);
  if (picked.id === 'cline') return openClineAdd(picked);
  return openAddKeys(picked);
}

/** 第一步：选上游 */
function openPickUpstream(list) {
  const d = openDialog(
    '添加账号 · 先选上游',
    `<p class="muted small">每个上游的录入方式不一样，先选一个。</p>
    <div class="picks">${list
      .map((u) => {
        const how =
          u.id === 'freebuff'
            ? '授权链接登录 / 内置浏览器登录 / 粘贴 authToken'
            : u.id === 'opencode'
              ? '贴 Zen API key，或用内置浏览器登录后复制'
              : u.id === 'cline'
                ? '设备码授权链接 / 内置浏览器登录 / 粘贴 refreshToken'
                : `贴 ${esc(u.credentialLabel || 'API key')}（${esc(u.formatLabel || u.format)}）`;
        return `<button class="pick" data-id="${esc(u.id)}" type="button"${u.enabled ? '' : ' disabled'}>
        <span class="pick-top"><b>${esc(u.name)}</b>${u.builtin ? '<span class="tag">内置</span>' : `<span class="tag prov oc">${esc(u.format)}</span>`}${
          u.enabled ? '' : '<span class="tag bad">已停用</span>'
        }</span>
        <small>${how}</small>
        <span class="pick-meta">${u.accountsEnabled}/${u.accounts} 个可用凭据</span>
      </button>`;
      })
      .join('')}</div>
    <p class="muted small" style="margin-top:14px">想接一个新的第三方接口？去「上游 → 添加上游」先把它建出来。</p>`,
    { width: 640 }
  );
  $$('.pick', d.root).forEach((b) =>
    b.addEventListener('click', () => {
      d.close();
      openAddAccount(b.dataset.id);
    })
  );
}

/** freebuff：三种登录方式，和老版本一致 */
function openFreebuffAdd() {
  const br = STATE.browser;
  const d = openDialog(
    '添加 freebuff 账号',
    `<div class="methods" id="methods">
      <button class="method is-on" data-m="link" type="button"><b>授权链接</b>
        <small>在你自己的浏览器里完成登录，服务器只负责收 token。最稳，推荐。</small></button>
      <button class="method" data-m="browser" type="button"${br.available ? '' : ' disabled'}><b>内置浏览器</b>
        <small>${br.available ? '服务器开一个 Chromium，画面推到这里，你在这儿点和打字。' : `当前不可用：${esc(br.reason || br.loadError || '未安装 Chromium')}`}</small></button>
      <button class="method" data-m="paste" type="button"><b>粘贴 token</b>
        <small>已经有 authToken（比如从别处迁移）就直接贴进来。</small></button>
    </div>

    <div data-p="link">
      <p class="muted small">和官方 CLI 走同一条链路：这里申请一个一次性登录链接，你在自己浏览器里登录 Google 或 GitHub，服务器轮询到 token 后自动入池。</p>
      <div class="fieldrow">
        ${poolSelect('link-pool')}
        <button class="btn primary" id="link-start" type="button">生成授权链接</button>
      </div>
      <div id="link-area" class="hidden" style="margin-top:14px">
        <label class="field"><span class="lbl">一次性链接 · 5 分钟内有效</span>
          <input type="text" id="link-url" readonly></label>
        <div class="btnrow" style="margin-top:0">
          <button class="btn primary" id="link-open" type="button">打开登录页</button>
          <button class="btn" id="link-copy" type="button">复制链接</button>
        </div>
        <div class="flowstate" id="link-state"></div>
        <div class="flowlog hidden" id="link-log"></div>
      </div>
    </div>

    <div data-p="browser" class="hidden">
      ${
        br.available
          ? `<p class="muted small">画面来自服务器上的 patchright Chromium（${br.headless ? 'headless' : 'headful + Xvfb，指纹更接近真机'}）。鼠标键盘会转发过去；密码这类长文本用下面的输入框发更省事。</p>
      <div class="fieldrow">
        ${poolSelect('br-pool')}
        <label class="field" style="max-width:200px;margin:0"><span class="lbl">浏览器身份</span>
          <select id="br-profile">
            <option value="fresh">全新指纹（每个号一套，推荐）</option>
            <option value="shared">复用上次会话（留 cookie）</option>
          </select></label>
        <button class="btn primary" id="br-start" type="button">启动并打开登录页</button>
      </div>
      ${viewerMarkup('br')}
      <div class="flowstate" id="br-state"></div>
      <div class="flowlog hidden" id="br-log"></div>`
          : `<p class="muted small">内置浏览器没启用，用「授权链接」加号效果完全一样 —— token 走的是同一条链路。</p>`
      }
    </div>

    <div data-p="paste" class="hidden">
      <p class="muted small">一行一个 authToken，可以一次贴多个。</p>
      <div class="fieldrow">${poolSelect('mn-pool')}</div>
      <label class="field" style="margin-top:12px"><span class="lbl">authToken</span>
        <textarea id="mn-token" placeholder="每行一个"></textarea></label>
      <div class="btnrow"><button class="btn primary" id="mn-go" type="button">加入号池</button></div>
    </div>`,
    { width: 1040, onClose: () => teardown() }
  );

  const R = d.root;
  let flow = null;
  let flowTimer = null;
  let ws = null;

  function teardown() {
    clearInterval(flowTimer);
    try {
      ws?.close();
    } catch {}
    ws = null;
    if (flow && flow.state === 'pending') api(`/login-flow/${flow.id}/cancel`, { method: 'POST' }).catch(() => {});
  }

  $('#methods', R).addEventListener('click', (ev) => {
    const btn = ev.target.closest('.method');
    if (!btn || btn.disabled) return;
    $$('.method', R).forEach((b) => b.classList.toggle('is-on', b === btn));
    $$('[data-p]', R).forEach((p) => p.classList.toggle('hidden', p.dataset.p !== btn.dataset.m));
  });

  const STATE_TEXT = {
    pending: '等你在登录页完成授权…',
    done: '登录成功，账号已入池',
    error: '没成功',
    timeout: '等太久了，重新生成链接吧',
    cancelled: '已取消',
  };

  function renderFlow() {
    if (!flow) return;
    const lampCls = flow.state === 'pending' ? 'busy' : flow.state === 'done' ? 'ok' : 'bad';
    const text = `${STATE_TEXT[flow.state] || flow.state}${flow.error ? ` —— ${flow.error}` : ''}`;
    for (const [sid, lid] of [['#link-state', '#link-log'], ['#br-state', '#br-log']]) {
      const sEl = $(sid, R);
      const lEl = $(lid, R);
      if (sEl) sEl.innerHTML = `<i class="lamp ${lampCls}"></i><span>${esc(text)}</span>`;
      if (lEl && flow.log?.length) {
        lEl.classList.remove('hidden');
        lEl.innerHTML = flow.log.map((l) => `<div>${esc(l.message)}</div>`).join('');
        lEl.scrollTop = lEl.scrollHeight;
      }
    }
    if (flow.state === 'done') {
      clearInterval(flowTimer);
      toast(`${flow.account?.email || '账号'} 已入池`, 'ok', 5000);
      sync();
      setTimeout(() => d.close(), 1600);
    } else if (['error', 'timeout', 'cancelled'].includes(flow.state)) {
      clearInterval(flowTimer);
    }
  }

  function startPolling() {
    clearInterval(flowTimer);
    flowTimer = setInterval(async () => {
      try {
        flow = (await api(`/login-flow/${flow.id}`)).flow;
        renderFlow();
      } catch {
        clearInterval(flowTimer);
      }
    }, 2500);
  }

  // ── 方式一：授权链接 ──
  $('#link-start', R).addEventListener('click', async () => {
    const btn = $('#link-start', R);
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> 申请中';
    try {
      flow = (await api('/login-flow', { method: 'POST', body: { mode: 'link', pool: $('#link-pool', R).value } })).flow;
      $('#link-area', R).classList.remove('hidden');
      $('#link-url', R).value = flow.loginUrl;
      renderFlow();
      startPolling();
      window.open(flow.loginUrl, '_blank', 'noopener');
    } catch (err) {
      toast(err.message, 'err', 7000);
    } finally {
      btn.disabled = false;
      btn.textContent = '重新生成链接';
    }
  });
  $('#link-open', R).addEventListener('click', () => flow && window.open(flow.loginUrl, '_blank', 'noopener'));
  $('#link-copy', R).addEventListener('click', () => flow && copy(flow.loginUrl, '链接已复制'));

  // ── 方式三：粘贴 token ──
  $('#mn-go', R).addEventListener('click', async () => {
    try {
      const r = await api('/accounts', {
        method: 'POST',
        body: { token: $('#mn-token', R).value, pool: $('#mn-pool', R).value },
      });
      toast(`已加入 ${r.added} 个号`);
      d.close();
      sync();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  const io = { get: () => ws, set: (v) => (ws = v) };
  const brViewer = mountViewer('br', R, io);
  if (brViewer) {
    $('#br-start', R).addEventListener('click', async () => {
      const btn = $('#br-start', R);
      btn.disabled = true;
      btn.innerHTML = '<span class="spin"></span> 启动中';
      $('#br-viewer', R).classList.remove('hidden');
      try {
        flow = (
          await api('/login-flow', {
            method: 'POST',
            body: { mode: 'browser', pool: $('#br-pool', R).value, profile: $('#br-profile', R).value },
          })
        ).flow;
        renderFlow();
        startPolling();
        brViewer.connect(flow.id);
        $('#br-viewer', R).scrollIntoView({ block: 'nearest' });
        brViewer.screen.focus();
      } catch (err) {
        toast(err.message, 'err', 9000);
        $('#br-vw-veil', R).innerHTML = `<span>${esc(err.message)}</span>`;
      } finally {
        btn.disabled = false;
        btn.textContent = '重新启动';
      }
    });
  }
}

/**
 * opencode Zen：两条路 —— 自己去网页复制 key，或者让服务器的指纹浏览器带你登，
 * 登完把 key 复制到下面的框。
 * 上游没有授权码流程（`/auth/*` 是浏览器回调端点，GET 会回 500 "No authorization
 * code found."，也没有 oauth-authorization-server 发现文档），官方文档写的流程
 * 就是"网页登录 → 复制 API key"，所以最后这一步只能由用户自己完成。
 */
function openOpencodeAdd() {
  const br = STATE.browser;
  const oc = STATE.providers?.opencode || {};
  const d = openDialog(
    '添加 opencode Zen 账号',
    `<p class="muted small">Zen 的凭据是一个 API key（<code>${esc(oc.base || 'https://opencode.ai/zen/v1')}</code>）。
      加进来的号<b>默认只服务免费模型</b>，想让它花 Zen 余额得把「用途」改掉。</p>
    <div class="fieldrow">
      ${poolSelect('oc-pool', 'free')}
      <button class="btn" id="oc-open" type="button">在我自己的浏览器里打开</button>
      ${br.available ? '<button class="btn primary" id="oc-browser" type="button">用服务器的指纹浏览器登录</button>' : ''}
    </div>
    ${br.available ? '' : `<p class="muted small">内置浏览器没启用（${esc(br.reason || br.loadError || '未安装 Chromium')}），只能自己去网页复制 key。</p>`}
    ${viewerMarkup('oc')}
    <label class="field" style="margin-top:12px"><span class="lbl">Zen API key（sk- 开头，一行一个）</span>
      <textarea id="oc-token" placeholder="sk-…"></textarea></label>
    <div class="btnrow"><button class="btn primary" id="oc-submit" type="button">加入号池</button></div>
    <div class="flowstate" id="oc-state"></div>`,
    { width: 1040, onClose: () => teardown() }
  );

  const R = d.root;
  let flow = null;
  let ws = null;
  function teardown() {
    try {
      ws?.close();
    } catch {}
    ws = null;
    if (flow && flow.state === 'pending') api(`/login-flow/${flow.id}/cancel`, { method: 'POST' }).catch(() => {});
  }

  const io = { get: () => ws, set: (v) => (ws = v) };
  const ocViewer = mountViewer('oc', R, io);

  $('#oc-open', R).addEventListener('click', () => {
    window.open(oc.loginUrl || 'https://opencode.ai/zen', '_blank', 'noopener');
  });

  $('#oc-browser', R)?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> 启动中';
    $('#oc-viewer', R).classList.remove('hidden');
    try {
      flow = (
        await api('/login-flow', {
          method: 'POST',
          body: { provider: 'opencode', mode: 'browser', pool: $('#oc-pool', R).value, profile: 'fresh' },
        })
      ).flow;
      ocViewer?.connect(flow.id);
      $('#oc-viewer', R).scrollIntoView({ block: 'nearest' });
      ocViewer?.screen.focus();
      $('#oc-state', R).innerHTML =
        '<i class="lamp busy"></i><span>在画面里登录，然后到 Zen 控制台复制 API key，粘到下面的框里</span>';
    } catch (err) {
      toast(err.message, 'err', 9000);
      $('#oc-vw-veil', R).innerHTML = `<span>${esc(err.message)}</span>`;
    } finally {
      btn.disabled = false;
      btn.textContent = '重新启动';
    }
  });

  $('#oc-submit', R).addEventListener('click', async (ev) => {
    const raw = $('#oc-token', R).value.trim();
    if (!raw) return toast('先把 API key 粘进来', 'warn');
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      // 服务器浏览器里登进去的，走 flow 收尾（它会顺手探活）；否则直接入池
      const r = flow
        ? await api(`/login-flow/${flow.id}/submit-key`, { method: 'POST', body: { token: raw } })
        : await api('/accounts', { method: 'POST', body: { token: raw, provider: 'opencode', pool: $('#oc-pool', R).value, name: 'opencode Zen' } });
      toast(r.added ? `已加入 ${r.added} 个 opencode 号` : 'key 已加入号池', 'ok');
      d.close();
      sync();
    } catch (err) {
      d.fail(err.message);
      toast(err.message, 'err', 8000);
      btn.disabled = false;
    }
  });
}

/**
 * Cline：三条路都是拿到同一个东西 —— 一个 refreshToken。
 *
 * 它走的是 WorkOS 的设备授权码流程（不是 freebuff 那种 CLI 授权码），所以链接上
 * 要配一个设备码一起给用户看：链接里通常已经带好了，但万一没带上，授权页会要求手输。
 * 用户可以在自己手机上开链接（推荐），也可以让服务器的 Chromium 去开。
 * 第三条路是直接粘贴 refreshToken（已经有号、或从别处迁移过来）。
 */
function openClineAdd() {
  const br = STATE.browser;
  const d = openDialog(
    '添加 Cline 账号',
    `<p class="muted small">Cline 的凭据是一个 <b>refreshToken</b>（不是 API key）。下面三条路拿到的都是它。</p>
    <div class="methods" id="cmethods">
      <button class="method is-on" data-m="link" type="button"><b>设备码授权</b>
        <small>生成授权链接 + 设备码，你在自己手机上打开授权，服务器轮询到就自动入池。推荐。</small></button>
      <button class="method" data-m="browser" type="button"${br.available ? '' : ' disabled'}><b>内置浏览器</b>
        <small>${br.available ? '服务器开一个 Chromium，画面推到这里，你在这儿完成授权。' : `当前不可用：${esc(br.reason || br.loadError || '未安装 Chromium')}`}</small></button>
      <button class="method" data-m="paste" type="button"><b>粘贴 refreshToken</b>
        <small>已经有 refreshToken（比如从别处迁移）就直接贴进来。</small></button>
    </div>

    <div data-p="link">
      <p class="muted small">向 WorkOS 申请一个设备码。授权链接里一般已经把设备码带上了；万一没带上，授权页会让你手输下面那个码。</p>
      <div class="fieldrow">
        ${poolSelect('cl-pool')}
        <button class="btn primary" id="cl-start" type="button">生成授权链接</button>
      </div>
      <div id="cl-area" class="hidden" style="margin-top:14px">
        <label class="field"><span class="lbl">授权链接</span>
          <input type="text" id="cl-url" readonly></label>
        <div id="cl-code-row" class="hidden">
          <label class="field"><span class="lbl">设备码 · 授权页要求时填这个</span>
            <input type="text" id="cl-code" readonly></label>
        </div>
        <div class="btnrow" style="margin-top:0">
          <button class="btn primary" id="cl-open" type="button">打开授权页</button>
          <button class="btn" id="cl-copy" type="button">复制链接</button>
        </div>
        <div class="flowstate" id="cl-state"></div>
        <div class="flowlog hidden" id="cl-log"></div>
      </div>
    </div>

    <div data-p="browser" class="hidden">
      ${
        br.available
          ? `<p class="muted small">画面来自服务器上的 patchright Chromium（${br.headless ? 'headless' : 'headful + Xvfb，指纹更接近真机'}）。在这儿完成 WorkOS 授权就行，不用另开窗口。</p>
      <div class="fieldrow">
        ${poolSelect('clb-pool')}
        <label class="field" style="max-width:200px;margin:0"><span class="lbl">浏览器身份</span>
          <select id="clb-profile">
            <option value="fresh">全新指纹（每个号一套，推荐）</option>
            <option value="shared">复用上次会话（留 cookie）</option>
          </select></label>
        <button class="btn primary" id="clb-start" type="button">启动并打开授权页</button>
      </div>
      ${viewerMarkup('clb')}
      <div class="flowstate" id="clb-state"></div>
      <div class="flowlog hidden" id="clb-log"></div>`
          : `<p class="muted small">内置浏览器没启用，用「设备码授权」加号效果完全一样。</p>`
      }
    </div>

    <div data-p="paste" class="hidden">
      <p class="muted small">一行一个 refreshToken，可以一次贴多个。</p>
      <div class="fieldrow">${poolSelect('clp-pool')}</div>
      <label class="field" style="margin-top:12px"><span class="lbl">refreshToken</span>
        <textarea id="clp-token" placeholder="每行一个"></textarea></label>
      <div class="btnrow"><button class="btn primary" id="clp-go" type="button">加入号池</button></div>
    </div>`,
    { width: 1040, onClose: () => teardown() }
  );

  const R = d.root;
  let flow = null;
  let flowTimer = null;
  let ws = null;

  function teardown() {
    clearInterval(flowTimer);
    try {
      ws?.close();
    } catch {}
    ws = null;
    if (flow && flow.state === 'pending') api(`/login-flow/${flow.id}/cancel`, { method: 'POST' }).catch(() => {});
  }

  $('#cmethods', R).addEventListener('click', (ev) => {
    const btn = ev.target.closest('.method');
    if (!btn || btn.disabled) return;
    $$('.method', R).forEach((b) => b.classList.toggle('is-on', b === btn));
    $$('[data-p]', R).forEach((p) => p.classList.toggle('hidden', p.dataset.p !== btn.dataset.m));
  });

  const STATE_TEXT = {
    pending: '等你在授权页完成登录…',
    done: '登录成功，账号已入池',
    error: '没成功',
    timeout: '等太久了，重新生成吧',
    cancelled: '已取消',
  };

  function renderFlow() {
    if (!flow) return;
    const lampCls = flow.state === 'pending' ? 'busy' : flow.state === 'done' ? 'ok' : 'bad';
    const text = `${STATE_TEXT[flow.state] || flow.state}${flow.error ? ` —— ${flow.error}` : ''}`;
    for (const [sid, lid] of [['#cl-state', '#cl-log'], ['#clb-state', '#clb-log']]) {
      const sEl = $(sid, R);
      const lEl = $(lid, R);
      if (sEl) sEl.innerHTML = `<i class="lamp ${lampCls}"></i><span>${esc(text)}</span>`;
      if (lEl && flow.log?.length) {
        lEl.classList.remove('hidden');
        lEl.innerHTML = flow.log.map((l) => `<div>${esc(l.message)}</div>`).join('');
        lEl.scrollTop = lEl.scrollHeight;
      }
    }
    // 设备码只在流程刚开始时才有意义，但显示出来不碍事（授权成功后它会跟着消失）
    if (flow.userCode && $('#cl-code', R)) {
      $('#cl-code-row', R).classList.remove('hidden');
      $('#cl-code', R).value = flow.userCode;
    }
    if (flow.state === 'done') {
      clearInterval(flowTimer);
      toast(`${flow.account?.email || '账号'} 已入池`, 'ok', 5000);
      sync();
      setTimeout(() => d.close(), 1600);
    } else if (['error', 'timeout', 'cancelled'].includes(flow.state)) {
      clearInterval(flowTimer);
    }
  }

  function startPolling() {
    clearInterval(flowTimer);
    flowTimer = setInterval(async () => {
      try {
        flow = (await api(`/login-flow/${flow.id}`)).flow;
        renderFlow();
      } catch {
        clearInterval(flowTimer);
      }
    }, 2500);
  }

  // ── 方式一：设备码授权链接 ──
  $('#cl-start', R).addEventListener('click', async () => {
    const btn = $('#cl-start', R);
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> 申请中';
    try {
      flow = (
        await api('/login-flow', { method: 'POST', body: { provider: 'cline', mode: 'link', pool: $('#cl-pool', R).value } })
      ).flow;
      $('#cl-area', R).classList.remove('hidden');
      $('#cl-url', R).value = flow.loginUrl;
      renderFlow();
      startPolling();
      window.open(flow.loginUrl, '_blank', 'noopener');
    } catch (err) {
      toast(err.message, 'err', 8000);
    } finally {
      btn.disabled = false;
      btn.textContent = '重新生成链接';
    }
  });
  $('#cl-open', R).addEventListener('click', () => flow && window.open(flow.loginUrl, '_blank', 'noopener'));
  $('#cl-copy', R).addEventListener('click', () => flow && copy(flow.loginUrl, '链接已复制'));

  // ── 方式三：粘贴 refreshToken ──
  $('#clp-go', R).addEventListener('click', async () => {
    const raw = $('#clp-token', R).value.trim();
    if (!raw) return toast('先把 refreshToken 粘进来', 'warn');
    try {
      const r = await api('/accounts', {
        method: 'POST',
        body: { token: raw, provider: 'cline', pool: $('#clp-pool', R).value, name: 'Cline' },
      });
      toast(`已加入 ${r.added} 个 Cline 号`);
      d.close();
      sync();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  // ── 方式二：内置浏览器 ──
  const io = { get: () => ws, set: (v) => (ws = v) };
  const clViewer = mountViewer('clb', R, io);
  if (clViewer) {
    $('#clb-start', R).addEventListener('click', async () => {
      const btn = $('#clb-start', R);
      btn.disabled = true;
      btn.innerHTML = '<span class="spin"></span> 启动中';
      $('#clb-viewer', R).classList.remove('hidden');
      try {
        flow = (
          await api('/login-flow', {
            method: 'POST',
            body: { provider: 'cline', mode: 'browser', pool: $('#clb-pool', R).value, profile: $('#clb-profile', R).value },
          })
        ).flow;
        renderFlow();
        startPolling();
        clViewer.connect(flow.id);
        $('#clb-viewer', R).scrollIntoView({ block: 'nearest' });
        clViewer.screen.focus();
      } catch (err) {
        toast(err.message, 'err', 9000);
        $('#clb-vw-veil', R).innerHTML = `<span>${esc(err.message)}</span>`;
      } finally {
        btn.disabled = false;
        btn.textContent = '重新启动';
      }
    });
  }
}

// ─────────────────────────────────────────────── 启动
$('#btn-add-account').addEventListener('click', () => openAddAccount());
$('#btn-add-upstream').addEventListener('click', () => openUpstreamForm());
$('#btn-bulk-rotation').addEventListener('click', () => openBulkRotation());

(async () => {
  // 首屏骨架，避免白板
  $('#channels').innerHTML = '<div class="ch skel"></div><div class="ch skel"></div><div class="ch skel"></div>';
  const hash = location.hash.slice(1);
  if (VIEW_TITLE[hash]) show(hash);
  try {
    const s = await api('/session');
    $('#gate-ver').textContent = `myapi v${s.version}`;
    if (s.authed) return unlock();
    lock(
      s.hasPassword
        ? '输入管理员密码进入控制台。'
        : '服务端还没设 ADMIN_PASSWORD —— 在 Railway 变量里加上，重新部署后再来。'
    );
  } catch {
    lock('连不上服务端，稍后重试。');
  }
})();

// ─────────────────────────────────────────────── 聊天记录 / 存储清理
async function loadStorage() {
  try {
    const info = await api('/storage');
    const st = info.storage;
    $('#s-store-total').textContent = fmtBytes(st.totalBytes);
    $('#s-disk').textContent = st.disk
      ? `磁盘剩余 ${fmtBytes(st.disk.freeBytes)} / 共 ${fmtBytes(st.disk.totalBytes)}`
      : '这个平台读不到磁盘信息';
    // 各类占用画成占比条：一列数字看不出谁大谁小，横条一眼就分得出
    const total = st.items.reduce((n, i) => n + (i.bytes || 0), 0);
    $('#s-store-items').innerHTML = st.items
      .map((i) => {
        const pct = total > 0 ? (i.bytes || 0) / total : 0;
        return `<div class="si${i.bytes ? '' : ' is-zero'}">
        <span class="si-label">${esc(i.label)}</span>
        <span class="si-bar"><i style="width:${(pct * 100).toFixed(1)}%"></i></span>
        <b>${fmtBytes(i.bytes)}</b>
      </div>`;
      })
      .join('');
  } catch (err) {
    $('#s-store-total').textContent = `读取失败：${err.message}`;
  }
}

$('#set-chatlog').addEventListener('change', async (ev) => {
  await api('/settings', { method: 'PATCH', body: { chatLogEnabled: ev.target.checked } });
  toast(
    ev.target.checked
      ? '已开始记录：之后每次请求的消息和回复都会落到 chatlog/*.jsonl'
      : '已停止记录（已经存下来的不会动）',
    ev.target.checked ? 'warn' : 'ok',
    6000
  );
  sync(true);
});

$('#btn-chat-clear').addEventListener('click', async () => {
  if (!confirm('删掉所有聊天记录文件？删了就找不回来了。')) return;
  try {
    const r = await api('/chatlog/clear', { method: 'POST' });
    toast(`${r.note}，腾出 ${fmtBytes(r.bytes)}`);
    sync(true);
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#btn-chat-view').addEventListener('click', async () => {
  let data;
  try {
    data = await api('/chatlog');
  } catch (err) {
    return toast(err.message, 'err');
  }
  const files = data.files || [];
  const recent = data.recent || [];
  const d = openDialog(
    '聊天记录',
    `<p class="muted small">${
      data.status.enabled ? '正在记录中。' : '记录当前是关闭的，下面是之前存下来的。'
    } 一行一条 JSON（JSONL），可以直接喂给训练脚本。</p>
    <div class="wire"><span class="wl">已存</span><code>${fmtBytes(data.status.bytes)} / ${files.length} 个文件</code></div>
    ${
      files.length
        ? `<div class="storelist" style="margin:12px 0">${files
            .map(
              (f) =>
                `<div><span>${esc(f.name)}</span><b>${fmtBytes(f.bytes)}</b><a class="btn tiny" href="/admin/api/chatlog/file/${esc(f.name)}" download>下载</a></div>`
            )
            .join('')}</div>`
        : '<p class="muted small">还没有文件。</p>'
    }
    <div class="panel-title" style="margin-top:14px">最近 ${recent.length} 条</div>
    <div class="tablewrap"><table>
      <thead><tr><th>时间</th><th>模型</th><th>请求</th><th>回复</th><th class="right">token</th></tr></thead>
      <tbody>${
        recent
          .map(
            (r) => `<tr><td class="cell-mono">${clock(r.at)}</td><td class="cell-mono">${esc(r.model || '—')}</td>
        <td class="muted small">${esc((r.preview || '').slice(0, 70))}</td>
        <td class="muted small">${esc((r.replyPreview || '').slice(0, 70))}</td>
        <td class="right cell-mono">${r.usage ? `${fmtCompact(r.usage.input)}/${fmtCompact(r.usage.output)}` : '—'}</td></tr>`
          )
          .join('') || '<tr><td colspan="5" class="muted" style="padding:18px;text-align:center">没有记录</td></tr>'
      }</tbody></table></div>`,
    { width: 940 }
  );
  void d;
});

$$('[data-clean]').forEach((btn) =>
  btn.addEventListener('click', async () => {
    const level = btn.dataset.clean;
    let info;
    try {
      info = await api('/storage');
    } catch (err) {
      return toast(err.message, 'err');
    }
    const preview = info.previews[level];
    const rows = (preview.rows || [])
      .map((r) => `<div><span>${esc(r.label)}</span><b>${r.bytes ? fmtBytes(r.bytes) : `${r.files} 项`}</b></div>`)
      .join('');
    const danger = level === 'full';
    const d = openDialog(
      `确认执行「${esc(preview.label)}」`,
      `<p class="${danger ? 'note warn' : 'muted'} small">${
        danger
          ? '这会把账号池和 API key 一起删掉，等于回到刚部署的状态。管理密码会保留，否则你就进不来了。删之前建议先「导出备份」。'
          : '下面这些会被删掉，其它数据不动。'
      }</p>
      <div class="storelist" style="margin:12px 0">${rows || '<div><span>没有可清理的内容</span></div>'}</div>
      <div class="wire"><span class="wl">预计腾出</span><code>${fmtBytes(preview.freesBytes)}</code></div>
      ${danger ? '<label class="field" style="margin-top:12px"><span class="lbl">确认请输入 DELETE</span><input type="text" id="clean-confirm" placeholder="DELETE"></label>' : ''}
      <div class="dlg-foot"><button class="btn js-cancel" type="button">取消</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" id="clean-go" type="button">执行清理</button></div>`,
      { width: 560 }
    );
    $('.js-cancel', d.root).addEventListener('click', d.close);
    $('#clean-go', d.root).addEventListener('click', async () => {
      const go = $('#clean-go', d.root);
      go.disabled = true;
      go.innerHTML = '<span class="spin"></span> 清理中';
      try {
        const body = { level };
        if (danger) body.confirm = $('#clean-confirm', d.root).value.trim();
        const r = await api('/cleanup', { method: 'POST', body });
        toast(`${r.label}完成：${r.done.join('、') || '没有可删的'}，腾出 ${fmtBytes(r.freedBytes)}`, 'ok', 8000);
        d.close();
        await sync();
        loadStorage();
        if (VIEW === 'usage') loadUsage();
      } catch (err) {
        toast(err.message, 'err', 7000);
        go.disabled = false;
        go.textContent = '执行清理';
      }
    });
  })
);

// 临时测试：这轮安全加固的单元级验证
process.env.DATA_DIR = './data-test-unit';
process.env.ADMIN_PASSWORD = 'unit-test-pw';
const { clientIp, publicBaseUrl, constantTimeEqual } = await import('../src/util.js');
const { safeTarget } = await import('../src/browser.js');
const { store } = await import('../src/store.js');

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✔' : '✘'} ${name}${ok ? '' : `\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};
const reqOf = (headers = {}, remote = '203.0.113.9') => ({ headers, socket: { remoteAddress: remote } });

// ── XFF 取向：客户端伪造的部分必须被忽略 ──
eq('伪造 XFF 时取代理追加的那一跳', clientIp(reqOf({ 'x-forwarded-for': '1.2.3.4, 198.51.100.7' }), 1), '198.51.100.7');
eq('多层代理按 hops 取', clientIp(reqOf({ 'x-forwarded-for': 'evil, 198.51.100.7, 10.0.0.1' }), 2), '198.51.100.7');
eq('没有 XFF 就用 socket 地址', clientIp(reqOf({}), 1), '203.0.113.9');
eq('XFF 全是空白也不炸', clientIp(reqOf({ 'x-forwarded-for': ' , ' }), 1), '203.0.113.9');

// ── Host 头注入 ──
delete process.env.PUBLIC_BASE_URL;
process.env.RAILWAY_PUBLIC_DOMAIN = 'real.up.railway.app';
eq('Host 被换成攻击者域名时回落到平台域名', publicBaseUrl(reqOf({ host: 'evil.example.com' })), 'https://real.up.railway.app');
eq('Host 是平台域名时正常用它', publicBaseUrl(reqOf({ host: 'real.up.railway.app', 'x-forwarded-proto': 'https' })), 'https://real.up.railway.app');
eq('本机访问仍然给 http://localhost', publicBaseUrl(reqOf({ host: 'localhost:8787' })), 'http://localhost:8787');
eq('Host 里塞奇怪字符直接不认', publicBaseUrl(reqOf({ host: 'a.com/x?y=1' })), 'https://real.up.railway.app');
process.env.PUBLIC_BASE_URL = 'https://api.mydomain.com';
eq('显式配了 PUBLIC_BASE_URL 就用它', publicBaseUrl(reqOf({ host: 'evil.example.com' })), 'https://api.mydomain.com');
delete process.env.PUBLIC_BASE_URL;
delete process.env.RAILWAY_PUBLIC_DOMAIN;

// ── 内置浏览器的目标限制（SSRF）──
for (const bad of [
  'http://127.0.0.1:8787/admin/api/export',
  'http://localhost/',
  'http://169.254.169.254/latest/meta-data/',
  'http://metadata.google.internal/computeMetadata/v1/',
  'http://10.0.0.5/',
  'http://192.168.1.1/',
  'http://172.16.0.9/',
  'file:///etc/passwd',
  'chrome://settings',
  'data:text/html,<h1>x',
  'http://[::1]:8787/',
  'http://railway.internal/',
]) {
  eq(`拦住 ${bad}`, safeTarget(bad), null);
}
eq('放过正常上游地址', safeTarget('https://www.codebuff.com/login?auth_code=x'), 'https://www.codebuff.com/login?auth_code=x');
eq('裸域名补 https', safeTarget('github.com/login'), 'https://github.com/login');

// ── 定长比较 ──
eq('相同字符串', constantTimeEqual('abc', 'abc'), true);
eq('长度不同也能安全返回 false', constantTimeEqual('a', 'abcdefghijklmnop'), false);
eq('空值不炸', constantTimeEqual(undefined, ''), true);

// ── API key 查表 ──
store.load();
const k = store.addKey({ name: 'unit' });
eq('能查到刚建的 key', store.findKey(k.key)?.id, k.id);
eq('查不存在的 key 返回 null', store.findKey('sk-fb-nope'), null);
eq('非字符串不炸', store.findKey({}), null);
store.removeKey(k.id);
eq('删掉之后索引跟着失效', store.findKey(k.key), null);

// ── 密码校验 ──
eq('环境变量密码有效', await store.verifyPassword('unit-test-pw'), true);
eq('错密码', await store.verifyPassword('unit-test-pw '), false);


// ─────────────────────────── 选号策略（钉住 / 手动 / 排除失效）
store.data.accounts = [
  { id: 'a1', email: 'one@x.com', token: 'tok-one-1234567890', pool: 'any', enabled: true, status: null },
  { id: 'a2', email: 'two@x.com', token: 'tok-two-1234567890', pool: 'any', enabled: true, status: null },
  { id: 'a3', email: 'three@x.com', token: 'tok-three-123456789', pool: 'free', enabled: true, status: null },
];
const { selectOrder, createAnthropicStreamPatcher, ensureMessageId, normalizeAnthropicUsage, patchAnthropicMessage } =
  await import('../src/engine.js');
const FREE = 'deepseek/deepseek-v4-flash';
const PAID = 'openai/gpt-5.6-luna';

// 这一段考的是「老的全局 autoSwitch 开关被翻译成新的 per-upstream 策略」这条路径
// （见 src/upstreams.js 的 legacyMode）。而 store.load() 读的是**真实数据文件**，
// 里面可能留着上一次跑测试时写下的 rotationRules（上面的上游那一段会用
// setRotationRule 写盘）。不清掉的话，第二次运行时 freebuff 已经有 mode 了，
// autoSwitch 就被完全忽略，下面两条断言必挂 —— 这是测试彼此污染，不是产品问题。
store.data.settings.rotationRules = {};
store.data.settings.autoSwitch = true;
store.data.settings.activeAccountId = null;
eq('没钉号时按优先级排（仅免费的号先接免费模型）', selectOrder(FREE).order.map((a) => a.id), ['a3', 'a1', 'a2']);

store.data.settings.activeAccountId = 'a3';
eq('钉住同档位的号 → 从它开始顺延', selectOrder(FREE).order.map((a) => a.id), ['a3', 'a1', 'a2']);

store.data.settings.activeAccountId = 'a2';
eq('钉住的号档位更低时不当起点（免费流量别去啃付费号）', selectOrder(FREE).order.map((a) => a.id), ['a3', 'a1', 'a2']);

store.data.settings.autoSwitch = false;
eq('单号模式只给钉住的那一个', selectOrder(FREE).order.map((a) => a.id), ['a2']);
store.data.accounts[1].enabled = false;
// 钉住的号被停用时退到第一个可用的：直接 503 太糙了，新建一个单号上游还没点过
// 「设为当前」就会全线不可用
eq('单号模式下钉住的号被停用 → 退到第一个可用的', selectOrder(FREE).order.map((a) => a.id), ['a3']);
store.data.accounts[1].enabled = true;
store.data.settings.autoSwitch = true;

store.data.accounts[0].status = { state: 'token_invalid' };
eq('标记失效的号被排除', selectOrder(FREE).order.map((a) => a.id), ['a3', 'a2']);
store.data.accounts[0].status = null;
store.data.settings.activeAccountId = null;
eq('付费模型排除"仅免费"的号', selectOrder(PAID).order.map((a) => a.id), ['a1', 'a2']);

// ─────────────────────────── Anthropic 响应补丁
eq('裸 UUID 补 msg_ 前缀', ensureMessageId('2a76b09d-7015-4984-b2b6-6f7d2e063b59'), 'msg_2a76b09d70154984b2b66f7d2e063b59');
eq('已经是 msg_ 的不动', ensureMessageId('msg_01abc'), 'msg_01abc');
eq('usage 补 cache 字段', normalizeAnthropicUsage({ input_tokens: 5, output_tokens: 7 }), {
  input_tokens: 5,
  output_tokens: 7,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
});
eq('非 message 对象不动', patchAnthropicMessage({ type: 'error', error: {} }), { type: 'error', error: {} });

const sse =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"abc-123","type":"message","role":"assistant","model":"m","content":[],"usage":{"input_tokens":3,"output_tokens":1}}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';
const patched = sse.replace(
  '{"id":"abc-123","type":"message","role":"assistant","model":"m","content":[],"usage":{"input_tokens":3,"output_tokens":1}}',
  '{"id":"msg_abc123","type":"message","role":"assistant","model":"m","content":[],"usage":{"input_tokens":3,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}'
);
for (const size of [1, 7, 33, 4096]) {
  const p = createAnthropicStreamPatcher();
  let out = '';
  for (let i = 0; i < sse.length; i += size) out += p.push(sse.slice(i, i + size));
  out += p.flush();
  eq(`SSE 切片 ${size} 字节：只改 message_start，事件边界不变`, out, patched);
}
const oaiSse = 'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
const p2 = createAnthropicStreamPatcher();
eq('没有 message_start 就原样透传', p2.push(oaiSse) + p2.flush(), oaiSse);

// ─────────────────────────── opencode 号池（不碰真上游，全是纯函数 + store 状态）
const { isFreeOpencodeModel, isOpencodeModel, stripPrefix, withPrefix } = await import('../src/models-opencode.js');
const { tierOf, providerForModel, resolveModelId, checkModelAccess, isKnownModel } = await import('../src/models.js');
const { providerOf } = await import('../src/store.js');

eq('big-pickle 是免费的（名字里没 free，只按名字判断会漏）', isFreeOpencodeModel('big-pickle'), true);
eq('带 -free 后缀的都算免费', isFreeOpencodeModel('mimo-v2.5-free'), true);
eq('deepseek-v4-pro 不是免费的', isFreeOpencodeModel('deepseek-v4-pro'), false);
eq('前缀判断', [isOpencodeModel('opencode/big-pickle'), isOpencodeModel('deepseek/deepseek-v4-flash')], [true, false]);
eq('去前缀 / 加前缀', [stripPrefix('opencode/big-pickle'), withPrefix('big-pickle')], ['big-pickle', 'opencode/big-pickle']);

const OC_FREE = 'opencode/mimo-v2.5-free';
const OC_PAID = 'opencode/claude-sonnet-5';
eq('opencode 免费模型归类为 free', tierOf(OC_FREE), 'free');
eq('opencode 付费模型归类为 paid', tierOf(OC_PAID), 'paid');
eq('模型 → 上游', [providerForModel(OC_FREE), providerForModel(FREE)], ['opencode', 'freebuff']);
eq('裸的 opencode 模型名也认', resolveModelId('mimo-v2.5-free'), OC_FREE);
eq('带前缀的原样保留', resolveModelId(OC_FREE), OC_FREE);
eq('opencode 的模型算已知', isKnownModel(OC_FREE), true);
eq('freebuff 后缀匹配没被 opencode 抢走', resolveModelId('deepseek-v4-flash'), 'deepseek/deepseek-v4-flash');

// 门禁：没勾「允许付费」的 key 不能用 Zen 的按量计费模型，免费的可以
eq('免费 key 能用 opencode 免费模型', checkModelAccess({ allowPaid: false, models: [] }, OC_FREE).ok, true);
eq('免费 key 用不了 opencode 付费模型', checkModelAccess({ allowPaid: false, models: [] }, OC_PAID).status, 403);
eq('勾了付费就能用', checkModelAccess({ allowPaid: true, models: [] }, OC_PAID).ok, true);
eq('不存在的 opencode 模型：表还没刷新时不硬判 404，交给上游说话', checkModelAccess({ allowPaid: true, models: [] }, 'opencode/not-a-model').ok, true);
eq('未知的 opencode 模型按付费处理（fail-closed）', tierOf('opencode/not-a-model'), 'paid');
eq('key 白名单对 opencode 同样生效', checkModelAccess({ allowPaid: true, models: [OC_PAID] }, OC_FREE).status, 403);

// 选号必须按上游分流：opencode 的 key 塞进 freebuff 引擎毫无意义，反之亦然
store.data.settings.autoSwitch = true;
store.data.settings.activeAccountId = null;
store.data.accounts = [
  { id: 'fb1', email: 'one@x.com', token: 'tok-one-1234567890', pool: 'any', enabled: true, status: null },
  { id: 'fb2', email: 'two@x.com', token: 'tok-two-1234567890', provider: 'freebuff', pool: 'any', enabled: true, status: null },
  { id: 'oc1', name: 'zen-a', token: 'sk-zen-aaaaaaaaaaaa', provider: 'opencode', pool: 'free', enabled: true, status: null },
  { id: 'oc2', name: 'zen-b', token: 'sk-zen-bbbbbbbbbbbb', provider: 'opencode', pool: 'any', enabled: true, status: null },
];
eq('老数据没 provider 字段时当 freebuff', providerOf(store.data.accounts[0]), 'freebuff');
eq('freebuff 模型只用 freebuff 的号', selectOrder(FREE).order.map((a) => a.id), ['fb1', 'fb2']);
eq('opencode 免费模型只用 opencode 的号', selectOrder(OC_FREE).order.map((a) => a.id), ['oc1', 'oc2']);
eq('opencode 付费模型排除"仅免费"的 opencode 号', selectOrder(OC_PAID).order.map((a) => a.id), ['oc2']);

// 关键回归：所有 opencode 号都被标失效时，fail-open 不能把 freebuff 的号捞进来
store.data.accounts[2].status = { state: 'token_invalid' };
store.data.accounts[3].status = { state: 'banned' };
eq('opencode 号全失效时也不会跨上游取号', selectOrder(OC_FREE).order.map((a) => a.id), ['oc1', 'oc2']);
store.data.accounts[2].status = null;
store.data.accounts[3].status = null;

// 一个 opencode 号都没有时，opencode 模型不该借用 freebuff 的号
store.data.accounts = [{ id: 'fb1', email: 'one@x.com', token: 'tok-one-1234567890', pool: 'any', enabled: true, status: null }];
eq('没有 opencode 号 → 空（引擎再决定要不要走匿名）', selectOrder(OC_FREE).order.length, 0);

// ─────────────────────────── Anthropic ↔ OpenAI 协议桥
// Zen 按模型钉协议：chat 原生的模型只认 chat 格式，claude-* 只认 Anthropic 格式，
// 跟客户端用了哪个端点无关。所以这两个方向的转换都得对。
const { nativeProtocol, isSupportedProtocol } = await import('../src/models-opencode.js');
const bridge = await import('../src/anthropic-bridge.js');

eq('免费模型都是 chat 原生', ['mimo-v2.5-free', 'big-pickle', 'deepseek-v4-flash-free'].map(nativeProtocol), ['chat', 'chat', 'chat']);
eq('claude / qwen 是 Anthropic 原生', [nativeProtocol('claude-sonnet-5'), nativeProtocol('qwen3.6-plus')], ['anthropic', 'anthropic']);
eq('gpt / grok / muse 是 Responses 原生', ['gpt-5', 'grok-4.6', 'muse-spark-1.2'].map(nativeProtocol), ['responses', 'responses', 'responses']);
eq('gemini 是 Google 原生', nativeProtocol('gemini-3-flash'), 'google');
eq('四种协议现在都能承接（gpt / gemini 也有适配器了）', ['mimo-v2.5-free', 'claude-sonnet-5', 'gpt-5', 'gemini-3-flash'].map(isSupportedProtocol), [true, true, true, true]);

// a2c：Anthropic 请求 → chat 请求
const a2cReq = bridge.anthropicToChat(
  {
    system: '你很简洁',
    max_tokens: 64,
    temperature: 0.3,
    stop_sequences: ['STOP'],
    tools: [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
    tool_choice: { type: 'any' },
    messages: [
      { role: 'user', content: '北京天气' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: '北京' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '晴 25 度' }] },
    ],
  },
  'mimo-v2.5-free'
);
eq('a2c：system 变成第一条 system 消息', a2cReq.messages[0], { role: 'system', content: '你很简洁' });
eq('a2c：tool_use 变成 tool_calls', a2cReq.messages[2].tool_calls, [
  { id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } },
]);
eq('a2c：tool_result 拆成 role:tool 消息', a2cReq.messages[3], { role: 'tool', tool_call_id: 'toolu_1', content: '晴 25 度' });
eq('a2c：采样参数和工具都带过去', [a2cReq.max_tokens, a2cReq.temperature, a2cReq.stop, a2cReq.tool_choice, a2cReq.tools.length], [64, 0.3, ['STOP'], 'required', 1]);

// a2c：chat 响应 → Anthropic message
const a2cResp = bridge.chatToAnthropic(
  {
    id: 'gen-abc-123',
    choices: [
      {
        finish_reason: 'tool_calls',
        message: { role: 'assistant', content: '好的', tool_calls: [{ id: 'call_9', function: { name: 'get_weather', arguments: '{"city":"上海"}' } }] },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 6 } },
  },
  'opencode/mimo-v2.5-free'
);
eq('a2c：id 变成 msg_ 前缀且只留字母数字', a2cResp.id, 'msg_genabc123');
eq('a2c：文本 + tool_use 两个块', a2cResp.content, [
  { type: 'text', text: '好的' },
  { type: 'tool_use', id: 'call_9', name: 'get_weather', input: { city: '上海' } },
]);
eq('a2c：stop_reason 映射', a2cResp.stop_reason, 'tool_use');
eq('a2c：usage 带 cache 字段', a2cResp.usage, { input_tokens: 10, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 6 });
eq('a2c：空回复也给一个空文本块（规范不允许 content 为空数组）', bridge.chatToAnthropic({ choices: [{ message: {} }] }, 'm').content, [{ type: 'text', text: '' }]);
eq('a2c：HTTP 200 但正文是错误 → 转成 error 信封', bridge.chatToAnthropic({ error: { type: 'server_error', message: '上游炸了' } }, 'm').type, 'error');

// a2c 流式：事件顺序必须合规
const a2cStream = bridge.createChatToAnthropicStream('opencode/mimo-v2.5-free');
const oaiFrames =
  'data: {"id":"gen-1","choices":[{"delta":{"role":"assistant","content":"你"}}]}\n\n' +
  ': keep-alive\n\n' +
  'data: {"id":"gen-1","choices":[{"delta":{"content":"好"}}]}\n\n' +
  'data: {"id":"gen-1","choices":[{"finish_reason":"stop","delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n' +
  'data: [DONE]\n\n';
let a2cOut = '';
for (let i = 0; i < oaiFrames.length; i += 13) a2cOut += a2cStream.push(oaiFrames.slice(i, i + 13));
a2cOut += a2cStream.flush();
const a2cEvents = a2cOut.split('\n\n').filter(Boolean).map((e) => (e.match(/^event: (\S+)/m) || [])[1]);
eq('a2c 流式：Anthropic 的事件顺序', a2cEvents, [
  'message_start',
  'content_block_start',
  'content_block_delta',
  'content_block_delta',
  'content_block_stop',
  'message_delta',
  'message_stop',
]);
eq(
  'a2c 流式：文本拼得回来',
  a2cOut
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5)))
    .filter((d) => d.type === 'content_block_delta')
    .map((d) => d.delta.text)
    .join(''),
  '你好'
);
eq('a2c 流式：每个事件之间都是空行', a2cOut.endsWith('\n\n') && !a2cOut.includes('\n\n\n'), true);

// c2a：chat 请求 → Anthropic 请求
const c2aReq = bridge.chatToAnthropicRequest(
  {
    messages: [
      { role: 'system', content: '你很简洁' },
      { role: 'user', content: '北京天气' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '晴' },
    ],
    stop: 'END',
    tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
    tool_choice: 'required',
  },
  'claude-sonnet-5'
);
eq('c2a：system 提到顶层', c2aReq.system, '你很简洁');
eq('c2a：max_tokens 必填，客户端没给就补默认值', c2aReq.max_tokens, 4096);
eq('c2a：tool_calls 变成 tool_use 块', c2aReq.messages[1].content, [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: '北京' } }]);
eq('c2a：role:tool 变成 user 里的 tool_result', c2aReq.messages[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '晴' }] });
eq('c2a：stop 字符串包成数组、tool_choice 映射', [c2aReq.stop_sequences, c2aReq.tool_choice], [['END'], { type: 'any' }]);

// c2a：Anthropic 响应 → chat 响应
const c2aResp = bridge.anthropicToChatResponse(
  {
    id: 'msg_1',
    content: [{ type: 'text', text: '晴' }, { type: 'tool_use', id: 'toolu_2', name: 'f', input: { a: 1 } }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 4 },
  },
  'opencode/claude-sonnet-5'
);
eq('c2a：finish_reason 映射', c2aResp.choices[0].finish_reason, 'tool_calls');
eq('c2a：tool_use 变回 tool_calls', c2aResp.choices[0].message.tool_calls, [
  { id: 'toolu_2', type: 'function', function: { name: 'f', arguments: '{"a":1}' } },
]);
eq('c2a：usage 换成 OpenAI 的字段名', [c2aResp.usage.prompt_tokens, c2aResp.usage.completion_tokens, c2aResp.usage.total_tokens], [8, 3, 11]);

// c2a 流式
const c2aStream = bridge.createAnthropicToChatStream('opencode/claude-sonnet-5');
const antFrames =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_9","usage":{"input_tokens":5,"output_tokens":0}}}\n\n' +
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你"}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}\n\n' +
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';
let c2aOut = '';
for (let i = 0; i < antFrames.length; i += 17) c2aOut += c2aStream.push(antFrames.slice(i, i + 17));
c2aOut += c2aStream.flush();
const c2aChunks = c2aOut
  .split('\n\n')
  .filter(Boolean)
  .map((l) => l.replace(/^data: /, ''));
eq('c2a 流式：以 [DONE] 收尾', c2aChunks[c2aChunks.length - 1], '[DONE]');
eq(
  'c2a 流式：文本拼得回来',
  c2aChunks
    .filter((c) => c !== '[DONE]')
    .map((c) => JSON.parse(c))
    .map((c) => c.choices?.[0]?.delta?.content || '')
    .join(''),
  '你好'
);
eq(
  'c2a 流式：最后带一帧 usage',
  JSON.parse(c2aChunks[c2aChunks.length - 2]).usage,
  { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
);
eq('c2a 流式：第一帧带 role', JSON.parse(c2aChunks[0]).choices[0].delta.role, 'assistant');

// ─────────────────────────── 换号策略（五种，每个上游各一套、互不干扰）
const ups = await import('../src/upstreams.js');
const { setRotationRule, setRotationRules, rotationRule, addUpstream, removeUpstream, listUpstreams, normalizeBaseUrl } = ups;

store.data.settings.rotationRules = {};
store.data.settings.activeAccountId = null;
store.data.accounts = [
  { id: 'f1', email: 'a@x.com', token: 'tok-aaaa-1234567890', provider: 'freebuff', pool: 'any', enabled: true, status: null },
  { id: 'f2', email: 'b@x.com', token: 'tok-bbbb-1234567890', provider: 'freebuff', pool: 'any', enabled: true, status: null },
  { id: 'f3', email: 'c@x.com', token: 'tok-cccc-1234567890', provider: 'freebuff', pool: 'any', enabled: true, status: null },
];

eq('默认策略沿用老的 autoSwitch 语义（钉住用到失败）', rotationRule('freebuff').mode, 'exhaust');

setRotationRule('freebuff', { mode: 'roundrobin' });
ups.resetCursor('freebuff');
const rr = [selectOrder(FREE).order[0].id, selectOrder(FREE).order[0].id, selectOrder(FREE).order[0].id, selectOrder(FREE).order[0].id];
eq('轮询：每次请求换一个起点，绕回来', rr, ['f1', 'f2', 'f3', 'f1']);
eq('轮询：order 是完整的一圈（失败还能顺延）', selectOrder(FREE).order.map((a) => a.id), ['f2', 'f3', 'f1']);

setRotationRule('freebuff', { mode: 'random' });
const randomStarts = new Set();
for (let i = 0; i < 60; i++) randomStarts.add(selectOrder(FREE).order[0].id);
eq('随机：多试几次能碰到不止一个起点', randomStarts.size > 1, true);
eq('随机：order 长度还是全部号', selectOrder(FREE).order.length, 3);

setRotationRule('freebuff', { mode: 'single', activeAccountId: 'f2' });
eq('单号：只有指定的那一个', selectOrder(FREE).order.map((a) => a.id), ['f2']);
eq('单号：manual 标记为真（engine 据此不换号）', selectOrder(FREE).manual, true);

setRotationRule('freebuff', { mode: 'exhaust', activeAccountId: 'f3' });
eq('额度用完才换：从钉住的号开始顺延', selectOrder(FREE).order.map((a) => a.id), ['f3', 'f1', 'f2']);
eq('额度用完才换：manual 为假', selectOrder(FREE).manual, false);

setRotationRule('freebuff', { mode: 'onerror', activeAccountId: 'f1' });
eq('一出错就换：顺序和 exhaust 一样（区别在重试判定）', selectOrder(FREE).order.map((a) => a.id), ['f1', 'f2', 'f3']);
eq('mode 透出给 engine', selectOrder(FREE).mode, 'onerror');

// 「固定用哪个号」要能清空。显式写 null 是"用户说了放开指定"，
// 和"从来没设过"是两件事 —— 后者才回落到全局 activeAccountId。
store.data.settings.activeAccountId = 'f3';
setRotationRule('freebuff', { activeAccountId: 'f1' });
eq('指定了就用指定的', rotationRule('freebuff').activeAccountId, 'f1');
setRotationRule('freebuff', { activeAccountId: null });
eq('显式清空后不回落到全局值', rotationRule('freebuff').activeAccountId, null);
eq('清空后落库的是 null 而不是被丢掉', Object.hasOwn(store.data.settings.rotationRules.freebuff, 'activeAccountId'), true);
setRotationRule('opencode', { mode: 'exhaust' });
eq('从没设过的上游才回落到全局 activeAccountId', rotationRule('opencode').activeAccountId, 'f3');
store.data.settings.activeAccountId = null;
setRotationRule('freebuff', { mode: 'exhaust', activeAccountId: 'f1' });

// 每个上游互不干扰
store.data.accounts.push(
  { id: 'o1', name: 'z1', token: 'sk-zen-aaaaaaaaaaaa', provider: 'opencode', pool: 'free', enabled: true, status: null },
  { id: 'o2', name: 'z2', token: 'sk-zen-bbbbbbbbbbbb', provider: 'opencode', pool: 'free', enabled: true, status: null }
);
setRotationRule('freebuff', { mode: 'single', activeAccountId: 'f2' });
setRotationRule('opencode', { mode: 'roundrobin' });
ups.resetCursor('opencode');
eq('freebuff 设成单号不影响 opencode', selectOrder(FREE).order.map((a) => a.id), ['f2']);
eq('opencode 自己走轮询', [selectOrder(OC_FREE).order[0].id, selectOrder(OC_FREE).order[0].id], ['o1', 'o2']);
eq('两个上游的策略各自独立存着', [rotationRule('freebuff').mode, rotationRule('opencode').mode], ['single', 'roundrobin']);

// 一键应用：一次把同一个策略套到多个上游
setRotationRules(['freebuff', 'opencode'], 'exhaust');
eq('一键应用：两个上游都变了', [rotationRule('freebuff').mode, rotationRule('opencode').mode], ['exhaust', 'exhaust']);
eq('一键应用：不传上游列表就套用到全部', setRotationRules(null, 'random').length >= 2, true);
eq('一键应用：非法策略名被拒', (() => { try { setRotationRules(['freebuff'], 'nope'); return 'no-throw'; } catch (e) { return e.statusCode; } })(), 400);
setRotationRule('freebuff', { mode: 'exhaust' });
setRotationRule('opencode', { mode: 'exhaust' });

// ─────────────────────────── 自定义上游
eq('base URL 补全协议并去掉尾斜杠', normalizeBaseUrl('api.example.com/v1/'), 'https://api.example.com/v1');
eq('base URL 拒绝内网地址（防 SSRF）', (() => { try { normalizeBaseUrl('http://127.0.0.1:8080'); return 'no-throw'; } catch (e) { return e.statusCode; } })(), 400);
eq('base URL 拒绝云元数据地址', (() => { try { normalizeBaseUrl('http://169.254.169.254/latest'); return 'no-throw'; } catch (e) { return e.statusCode; } })(), 400);
eq('base URL 拒绝非 http 协议', (() => { try { normalizeBaseUrl('ftp://example.com'); return 'no-throw'; } catch (e) { return e.statusCode; } })(), 400);
eq('协议格式必须是四种之一', (() => { try { addUpstream({ name: 'x', format: 'grpc', baseUrl: 'https://a.com' }); return 'no-throw'; } catch (e) { return e.statusCode; } })(), 400);

store.data.upstreams = [];
const myUp = addUpstream({ name: 'My Relay', format: 'responses', baseUrl: 'https://relay.example.com/v1', models: ['gpt-4o', 'gpt-4o-mini'] });
eq('自定义上游的 id 形状', /^up_[a-f0-9]{8}$/.test(myUp.id), true);
eq('自定义上游默认按付费处理（fail-closed）', myUp.defaultTier, 'paid');
eq('重名被拒', (() => { try { addUpstream({ name: 'My Relay', format: 'chat', baseUrl: 'https://b.com' }); return 'no-throw'; } catch (e) { return e.statusCode; } })(), 400);

const mdl = await import('../src/models.js');
const MY_MODEL = 'my-relay/gpt-4o';
eq('模型 id 带上游名前缀', mdl.withUpstreamPrefix(myUp, 'gpt-4o'), MY_MODEL);
eq('上游名里的空格收敛成连字符', mdl.upstreamSlug('My Relay'), 'my-relay');
eq('按模型 id 找回上游', mdl.upstreamForModel(MY_MODEL)?.id, myUp.id);
eq('清单里没有的模型不算这个上游的', mdl.upstreamForModel('my-relay/not-listed'), null);
eq('去前缀拿到上游认的裸名', mdl.stripUpstreamPrefix(MY_MODEL, myUp), 'gpt-4o');
eq('模型 → 上游 id', mdl.providerForModel(MY_MODEL), myUp.id);
eq('自定义上游的模型算已知', mdl.isKnownModel(MY_MODEL), true);
eq('自定义上游的模型默认按付费', mdl.tierOf(MY_MODEL), 'paid');
eq('resolveModelId 不会被 freebuff 的后缀匹配抢走', mdl.resolveModelId(MY_MODEL), MY_MODEL);
eq('免费 key 用不了自定义上游的模型', mdl.checkModelAccess({ allowPaid: false, models: [] }, MY_MODEL).status, 403);
eq('勾了付费就能用', mdl.checkModelAccess({ allowPaid: true, models: [] }, MY_MODEL).ok, true);
eq('目录里能看到自定义上游的模型', mdl.catalog().filter((m) => m.provider === myUp.id).map((m) => m.id).sort(), ['my-relay/gpt-4o', 'my-relay/gpt-4o-mini']);
eq('目录条目带上游名和协议', (() => { const m = mdl.catalog().find((x) => x.id === MY_MODEL); return [m.providerName, m.pool]; })(), ['My Relay', 'responses']);

// 整个上游标成免费之后，免费 key 就能用了
ups.updateUpstream(myUp.id, { defaultTier: 'free' });
eq('上游改成免费后 tier 跟着变', mdl.tierOf(MY_MODEL), 'free');
eq('免费 key 这时可以用', mdl.checkModelAccess({ allowPaid: false, models: [] }, MY_MODEL).ok, true);
ups.updateUpstream(myUp.id, { defaultTier: 'paid' });

// 停用的上游：模型不再对外提供
ups.updateUpstream(myUp.id, { enabled: false });
eq('停用后 checkModelAccess 给 503', mdl.checkModelAccess({ allowPaid: true, models: [] }, MY_MODEL).status, 503);
eq('停用后不出现在 /v1/models', mdl.filterModelList({ allowPaid: true, models: [] }, [{ id: MY_MODEL }]).length, 0);
ups.updateUpstream(myUp.id, { enabled: true });

// 这个上游的号只服务它自己的模型
store.data.accounts.push(
  { id: 'c1', name: 'k1', token: 'sk-relay-aaaaaaaaaaaa', provider: myUp.id, pool: 'any', enabled: true, status: null },
  { id: 'c2', name: 'k2', token: 'sk-relay-bbbbbbbbbbbb', provider: myUp.id, pool: 'any', enabled: true, status: null }
);
eq('自定义上游的模型只用它自己的号', selectOrder(MY_MODEL).order.map((a) => a.id), ['c1', 'c2']);
eq('freebuff 的模型不会用到自定义上游的号', selectOrder(FREE).order.every((a) => a.id.startsWith('f')), true);
setRotationRule(myUp.id, { mode: 'roundrobin' });
ups.resetCursor(myUp.id);
eq('自定义上游也能独立设策略', [selectOrder(MY_MODEL).order[0].id, selectOrder(MY_MODEL).order[0].id], ['c1', 'c2']);
eq('设了自定义上游的策略不影响 freebuff', rotationRule('freebuff').mode, 'exhaust');

// 删上游：名下的号一起清掉，别留孤儿
const gone = removeUpstream(myUp.id);
eq('删上游连它的号一起删', gone.removedAccounts, 2);
eq('删完 store 里没有这个上游了', listUpstreams().some((u) => u.id === myUp.id), false);
eq('删完那些号也不在了', store.data.accounts.some((a) => a.provider === myUp.id), false);
eq('删完它的策略也清掉了', Object.hasOwn(store.data.settings.rotationRules || {}, myUp.id), false);
store.data.upstreams = [];

// ── 前缀撞车：名字不同但 slug 相同的上游必须被拦住 ──
// 「My Relay」和「my-relay」会生成同一个模型前缀，两个都存在的话
// upstreamForModel 只会命中先建的那个，后建的模型永远调不通且看不出原因
store.data.upstreams = [];
const u1 = addUpstream({ name: 'Acme Relay', format: 'chat', baseUrl: 'https://a1.example.com/v1', models: ['m'] });
eq('slug 撞车（大小写/空格差异）被拒', (() => { try { addUpstream({ name: 'acme-relay', format: 'chat', baseUrl: 'https://a2.example.com/v1' }); return 'no-throw'; } catch (e) { return e.statusCode; } })(), 400);
eq('原名完全相同也被拒', (() => { try { addUpstream({ name: 'Acme Relay', format: 'chat', baseUrl: 'https://a3.example.com/v1' }); return 'no-throw'; } catch (e) { return e.statusCode; } })(), 400);
eq('和内置上游同名被拒', (() => { try { addUpstream({ name: 'opencode', format: 'chat', baseUrl: 'https://a4.example.com/v1' }); return 'no-throw'; } catch (e) { return e.statusCode; } })(), 400);
eq('freebuff 也不能占', (() => { try { addUpstream({ name: 'FreeBuff', format: 'chat', baseUrl: 'https://a5.example.com/v1' }); return 'no-throw'; } catch (e) { return e.statusCode; } })(), 400);

// 改名要把指向老 id 的设置一起搬走
store.data.settings.disabledModels = ['acme-relay/m'];
store.data.settings.modelTierOverrides = { 'acme-relay/m': 'free' };
store.data.modelStatus['acme-relay/m'] = { state: 'ok' };
store.data.keys[0].models = ['acme-relay/m'];
ups.updateUpstream(u1.id, { name: 'Beta Relay' });
eq('改名后模型 id 跟着变', mdl.catalog().some((m) => m.id === 'beta-relay/m'), true);
eq('改名后下架列表跟着搬', store.data.settings.disabledModels, ['beta-relay/m']);
eq('改名后分类覆盖跟着搬', store.data.settings.modelTierOverrides, { 'beta-relay/m': 'free' });
eq('改名后实测状态跟着搬', Object.hasOwn(store.data.modelStatus, 'beta-relay/m'), true);
eq('改名后 key 白名单跟着搬', store.data.keys[0].models, ['beta-relay/m']);
store.data.keys[0].models = [];

// 停用的上游：模型不对外，但请求时要说清是"停用"而不是"不存在"
ups.updateUpstream(u1.id, { enabled: false });
eq('停用后 checkModelAccess 说的是已停用', mdl.checkModelAccess({ allowPaid: true, models: [] }, 'beta-relay/m').status, 503);
eq('停用后不出现在 /v1/models（按前缀也拦住）', mdl.filterModelList({ allowPaid: true, models: [] }, [{ id: 'beta-relay/m' }]).length, 0);
eq('停用后不进目录', mdl.catalog().some((m) => m.id === 'beta-relay/m'), false);

// 删上游要把设置里的死数据一起清掉
ups.updateUpstream(u1.id, { enabled: true });
store.data.settings.disabledModels = ['beta-relay/m', 'mimo/mimo-v2.5'];
store.data.settings.modelTierOverrides = { 'beta-relay/m': 'free' };
store.data.modelStatus['beta-relay/m'] = { state: 'ok' };
removeUpstream(u1.id);
eq('删上游清掉它的下架条目，别的不动', store.data.settings.disabledModels, ['mimo/mimo-v2.5']);
eq('删上游清掉它的分类覆盖', Object.hasOwn(store.data.settings.modelTierOverrides, 'beta-relay/m'), false);
eq('删上游清掉它的实测状态', Object.hasOwn(store.data.modelStatus, 'beta-relay/m'), false);
store.data.upstreams = [];
store.data.settings.disabledModels = [];
store.data.settings.modelTierOverrides = {};

// ─────────────────────────── 协议适配器注册表
const proto = await import('../src/protocols/index.js');
eq('四种格式都有适配器', ['chat', 'responses', 'anthropic', 'gemini'].map((f) => proto.knownFormat(f)), [true, true, true, true]);
eq('不认识的格式回落到 chat', proto.adapterFor('grpc').FORMAT, 'chat');
eq('chat 适配器是恒等变换', proto.adapterFor('chat').requestFromChat({ messages: [{ role: 'user', content: 'hi' }] }, 'm').model, 'm');
eq('chat 适配器不需要流式转换', proto.adapterFor('chat').createStreamToChat('m'), null);
eq('anthropic 适配器用 x-api-key 并带版本号', proto.adapterFor('anthropic').authHeaders('sk-1'), { 'x-api-key': 'sk-1', 'anthropic-version': '2023-06-01' });
eq('gemini 适配器用 x-goog-api-key', proto.adapterFor('gemini').authHeaders('k'), { 'x-goog-api-key': 'k' });
eq('responses 适配器用 Bearer', proto.adapterFor('responses').authHeaders('sk-2'), { authorization: 'Bearer sk-2' });
eq('各协议的端点', ['chat', 'responses', 'anthropic'].map((f) => proto.adapterFor(f).upstreamPath('m', false)), ['/chat/completions', '/responses', '/messages']);
eq('gemini 流式和非流式端点不同', [proto.adapterFor('gemini').upstreamPath('gemini-3-flash', false), proto.adapterFor('gemini').upstreamPath('gemini-3-flash', true)], ['/models/gemini-3-flash:generateContent', '/models/gemini-3-flash:streamGenerateContent?alt=sse']);
eq('上游失败归类：401 → token 失效', proto.classifyUpstreamFailure(401, ''), 'token_invalid');
eq('上游失败归类：429 + 余额字样 → 余额不足', proto.classifyUpstreamFailure(429, 'insufficient balance'), 'no_credit');
eq('上游失败归类：429 → 限流', proto.classifyUpstreamFailure(429, 'too many requests'), 'rate_limited');
eq('上游失败归类：403 + 地区字样 → 地区受限', proto.classifyUpstreamFailure(403, 'unsupported_country_region'), 'country_blocked');
eq('上游失败归类：402 → 余额不足', proto.classifyUpstreamFailure(402, ''), 'no_credit');
eq('上游失败归类：500 → 上游失败', proto.classifyUpstreamFailure(500, 'oops'), 'upstream_error');

// ─────────────────────────── 中转不许比上游更严
// 额度每天刷新、付费能解锁，所以"引擎的 /v1/models 里没有它"绝不能成为拦请求的理由。
// 以前这里会直接回 404，用户明确指出这不合理。
const { noteEngineModelList, isEnginePaused, availabilityOf } = mdl;
// 造一个"引擎只列出两个模型"的场景：flash 不在列表里
noteEngineModelList(['mimo/mimo-v2.5', 'z-ai/glm-5.2', 'crof/kimi-k3-eco']);
eq('缺席集合里确实有 flash', isEnginePaused('deepseek/deepseek-v4-flash'), true);
eq('缺席的模型仍然放行（不再 404）', mdl.checkModelAccess({ allowPaid: true, models: [] }, 'deepseek/deepseek-v4-flash').ok, true);
eq('缺席状态叫 absent 而不是 paused', availabilityOf('deepseek/deepseek-v4-flash').state, 'absent');
eq('缺席的模型照样列进 /v1/models', mdl.filterModelList({ allowPaid: true, models: [] }, [{ id: 'deepseek/deepseek-v4-flash' }]).length, 1);
eq(
  '缺席说明里讲清是额度或付费问题，不是"被暂停"',
  /额度|付费|升级/.test(availabilityOf('deepseek/deepseek-v4-flash').detail),
  true
);
// 实测成功过的模型，即使不在引擎列表里也该显示可用
store.data.modelStatus['deepseek/deepseek-v4-flash'] = { state: 'ok', detail: '实测调用成功' };
eq('实测通过的优先显示 ok', availabilityOf('deepseek/deepseek-v4-flash').state, 'ok');
delete store.data.modelStatus['deepseek/deepseek-v4-flash'];
// 控制台手动下架仍然要拦（那是用户自己的决定，不是我们替他猜的）
store.data.settings.disabledModels = ['deepseek/deepseek-v4-flash'];
eq('手动下架照样拦（用户自己的决定）', mdl.checkModelAccess({ allowPaid: true, models: [] }, 'deepseek/deepseek-v4-flash').status, 403);
store.data.settings.disabledModels = [];
// opencode 的 gpt-* / gemini-* 现在有适配器了，不该再被拒
// （单测里没联网，opencode 表只有静态的免费名单，所以这里只验门禁不验列表）
eq('opencode 的 gpt-* 不再被拒', mdl.checkModelAccess({ allowPaid: true, models: [] }, 'opencode/gpt-5-nano').ok, true);
eq('opencode 的 gemini-* 不再被拒', mdl.checkModelAccess({ allowPaid: true, models: [] }, 'opencode/gemini-3-flash').ok, true);
eq(
  'opencode 免费模型照常进 /v1/models',
  mdl.filterModelList({ allowPaid: true, models: [] }, [{ id: 'opencode/mimo-v2.5-free' }, { id: 'opencode/big-pickle' }]).length,
  2
);
noteEngineModelList([]); // 复位，别影响后面的断言

// ─────────────────────────────────────────────── 429 细分 / 状态生命周期 / 模型降级
// 这一段围绕"撞到 rpm 不该被当成号废了"：判定要温和、坏状态要会自己过期、
// 降级候选要守住授权。全是纯函数加一个内存 store，不起服务。
const as = await import('../src/account-status.js');

// parseRetryAfterMs：认得出上游给的等待时长；认不出就老实说"不知道"
eq('{"retryAfterMs":N} → 原样取毫秒', as.parseRetryAfterMs('{"error":{"retryAfterMs":15506639}}', 429), 15506639);
eq('retry-after: N → 秒换算成毫秒', as.parseRetryAfterMs('429 retry-after: 120', 429), 120000);
eq('try again in 1h 2m 3s → 合成毫秒', as.parseRetryAfterMs('rate limited, try again in 1h 2m 3s', 429), (3600 + 120 + 3) * 1000);
eq('try again in 45s → 45 秒', as.parseRetryAfterMs('try again in 45s', 429), 45000);
eq('英文"每日额度"→ 抬到额度耗尽量级', as.parseRetryAfterMs('daily limit reached', 429), as.EXHAUSTED_THRESHOLD_MS);
eq('中文"当日额度"同样识别', as.parseRetryAfterMs('当日额度已用完', 429), as.EXHAUSTED_THRESHOLD_MS);
eq('正文没有时长 → null（null 是"不知道"，不是 0）', as.parseRetryAfterMs('too many requests', 429), null);
eq('{"retryAfterMs":0} 不算有效提示', as.parseRetryAfterMs('{"retryAfterMs":0}', 429), null);

// classifyRateLimit：默认温和 —— 拿不到证据就别吓人
eq('短时 429 → 临时限流', as.classifyRateLimit('{"retryAfterMs":5000}', 429), 'throttled');
eq('5 分钟的 429 → 仍按临时限流（滚动窗口量级）', as.classifyRateLimit('retry-after: 300', 429), 'throttled');
eq('整小时的 429 → 额度用完', as.classifyRateLimit('retry-after: 3600', 429), 'rate_limited');
eq('"每日"措辞 → 额度用完', as.classifyRateLimit('daily quota exceeded', 429), 'rate_limited');
eq('裸 429、什么都没说 → 临时限流', as.classifyRateLimit('429 Too Many Requests', 429), 'throttled');
eq('非 429 不参与细分（保持旧行为）', as.classifyRateLimit('quota exceeded', 402), 'rate_limited');

// withRecoverAt：只有"会自己好"的状态才带到期时间
const t0 = Date.now();
const throttled = as.withRecoverAt({ state: 'throttled' }, '', 429);
eq('临时限流带上 recoverAt', typeof throttled.recoverAt === 'string' && Date.parse(throttled.recoverAt) > t0, true);
eq('临时限流默认冷却 1 分钟', throttled.cooldownMs, 60 * 1000);
eq('额度耗尽默认冷却 30 分钟', as.withRecoverAt({ state: 'rate_limited' }, '', 429).cooldownMs, 30 * 60 * 1000);
eq('有 retry 提示时冷却跟着提示走（5 分钟）', as.withRecoverAt({ state: 'throttled' }, 'retry-after: 300', 429).cooldownMs, 300 * 1000);
eq('终态 token_invalid 不给 recoverAt', Object.hasOwn(as.withRecoverAt({ state: 'token_invalid' }, '', 401), 'recoverAt'), false);
eq('banned 同理', Object.hasOwn(as.withRecoverAt({ state: 'banned' }, '', 403), 'recoverAt'), false);

// isStatusLive：过期即自动恢复 —— 这就是"不用手动刷新"的核心
eq('还没到期的坏状态算数', as.isStatusLive({ state: 'throttled', recoverAt: new Date(t0 + 60000).toISOString() }, t0), true);
eq('已过期的坏状态不算数（=自动恢复）', as.isStatusLive({ state: 'throttled', recoverAt: new Date(t0 - 1).toISOString() }, t0), false);
eq('没有 recoverAt 的终态永远算数', as.isStatusLive({ state: 'banned' }, t0), true);
eq('ok 不算坏状态', as.isStatusLive({ state: 'ok' }, t0), false);
eq('没状态的号不算坏', as.isStatusLive(null, t0), false);

// needsRecheck：只挑"到点了、可能会好"的去花请求
eq('到点的临时限流要复检', as.needsRecheck({ status: { state: 'throttled', recoverAt: new Date(t0 - 1000).toISOString() } }, t0), true);
eq('还没到点的不急着重检', as.needsRecheck({ status: { state: 'throttled', recoverAt: new Date(t0 + 60000).toISOString() } }, t0), false);
eq('终态不浪费请求复检', as.needsRecheck({ status: { state: 'token_invalid' } }, t0), false);
eq('健康的号不复检', as.needsRecheck({ status: { state: 'ok' } }, t0), false);

// 复检间隔读设置
store.data.settings.accountRecheckMinutes = 0;
eq('复检间隔填 0 → 关闭', as.recheckIntervalMs(), 0);
store.data.settings.accountRecheckMinutes = 7;
eq('复检间隔填 7 → 7 分钟', as.recheckIntervalMs(), 7 * 60 * 1000);
store.data.settings.accountRecheckMinutes = -3;
eq('复检间隔负数按关闭处理', as.recheckIntervalMs(), 0);

// 设置写入要有白名单兜底，别因为拼错一个词就开始悄悄换模型
eq('降级模式写非法值 → 退回 off', store.updateSettings({ modelFallback: 'yolo' }).modelFallback, 'off');
eq('降级模式合法值能存', store.updateSettings({ modelFallback: 'tier' }).modelFallback, 'tier');
store.updateSettings({ accountRecheckMinutes: 5 });
eq('复检间隔超上限被拒（保留原值）', store.updateSettings({ accountRecheckMinutes: 99999 }).accountRecheckMinutes, 5);
eq('复检间隔 0 合法（=关闭）', store.updateSettings({ accountRecheckMinutes: 0 }).accountRecheckMinutes, 0);

// fallbackCandidates：限流时换模型顶上，但绝不越过授权
const FB_FREE = 'deepseek/deepseek-v4-flash'; // freebuff free / standard 池
const FB_PAID = 'deepseek/deepseek-v4-pro'; // freebuff paid / premium 池
const keyFree = { allowPaid: false, models: [] };
const keyPaid = { allowPaid: true, models: [] };
store.data.settings.disabledModels = [];

store.data.settings.modelFallback = 'off';
eq('降级关闭时一个候选都不给', mdl.fallbackCandidates(FB_FREE, keyPaid).length, 0);

store.data.settings.modelFallback = 'tier';
const tierCands = mdl.fallbackCandidates(FB_FREE, keyPaid, { limit: 20 });
eq('tier 模式候选非空', tierCands.length > 0, true);
eq('tier 模式只给同档位（全 free）', tierCands.every((id) => mdl.tierOf(id) === 'free'), true);
eq('tier 模式不换上游（全 freebuff）', tierCands.every((id) => mdl.providerForModel(id) === 'freebuff'), true);
eq('tier 模式候选不含原模型', tierCands.includes(FB_FREE), false);
eq('候选里不会混进 opencode 的号', tierCands.every((id) => !id.startsWith('opencode/')), true);

store.data.settings.modelFallback = 'any';
const anyCands = mdl.fallbackCandidates(FB_FREE, keyPaid, { limit: 20 });
eq('any 模式会给出跨档位候选（含付费）', anyCands.some((id) => mdl.tierOf(id) === 'paid'), true);
const anyFree = mdl.fallbackCandidates(FB_FREE, keyFree, { limit: 20 });
eq('any 模式下免费 key 也拿不到付费候选', anyFree.every((id) => mdl.tierOf(id) === 'free'), true);
eq('免费 key 在 any 模式下仍有免费备选（不会降级即断流）', anyFree.length > 0, true);
eq('付费模型为基准时，tier 模式也守同档位', ((store.data.settings.modelFallback = 'tier'), mdl.fallbackCandidates(FB_PAID, keyPaid, { limit: 20 }).every((id) => mdl.tierOf(id) === 'paid')), true);

store.data.settings.modelFallback = 'any';
eq('候选数量受 limit 限制', mdl.fallbackCandidates(FB_FREE, keyPaid, { limit: 1 }).length, 1);

// 未知 id 按 fail-closed 算付费：免费 key 不该因此拿到付费候选
store.data.settings.modelFallback = 'tier';
eq('未知模型当成付费：免费 key 一个候选都拿不到', mdl.fallbackCandidates('nope/nope', keyFree, { limit: 20 }).length, 0);

// 下架名单与 key 白名单对降级同样生效 —— 降级不是绕过授权的后门
store.data.settings.modelFallback = 'any';
store.data.settings.disabledModels = ['mimo/mimo-v2.5'];
eq('控制台下架的模型不会出现在降级候选里', mdl.fallbackCandidates(FB_FREE, keyPaid, { limit: 20 }).includes('mimo/mimo-v2.5'), false);
store.data.settings.disabledModels = [];
eq('key 的模型白名单卡住降级（只留白名单里的）', mdl.fallbackCandidates(FB_FREE, { allowPaid: true, models: ['mimo/mimo-v2.5'] }, { limit: 20 }), ['mimo/mimo-v2.5']);

// 复位：这一段碰过设置，别把后面的东西带坏
store.data.settings.modelFallback = 'off';
store.data.settings.accountRecheckMinutes = 5;

// ─────────────────────────────────────────────── 引擎暂停名单的"下载后校正"
// 引擎 vendor/worker.js 里那份 PAUSED_MODELS 是上游手写的、没有回收机制：
// deepseek-v4-flash 官方恢复上架后它还在拦，请求被引擎本地回掉、根本发不到上游。
// 这里把对齐函数和"仓库里那份已经对齐过"这个不变量一起钉住。
// 对齐是**双向**的：官方恢复上架的放开（旧行为），官方新撤下的拦住（新增）——
// 后者是因为撤下的模型上游会静默降级到默认模型，放过去等于让用户以为在用 A 拿到 B。
const { syncPausedModels } = await import('../src/vendor-patch.js');
const SAMPLE = [
  'const PAUSED_MODELS = new Set([',
  '  "deepseek/deepseek-v4-flash",',
  '  // 2026-08-20 官方下线 MiniMax M3（FREEBUFF_PAUSED_FREE_MODEL_IDS），',
  '  // admission 返回 410 model_unavailable，新会话必然失败。',
  '  "minimax/minimax-m3",',
  ']);',
  '',
  'function isPausedModel(modelId) {',
  '  return PAUSED_MODELS.has(modelId);',
  '}',
].join('\n');
/** 从文本里把 PAUSED_MODELS 取出来真跑一遍 —— 光看字符串不算"还是合法 JS" */
const pausedSetIn = (text) => {
  const block = text.match(/const PAUSED_MODELS = new Set\(\[[\s\S]*?\]\);/)[0];
  return [...new Function(`${block}\nreturn PAUSED_MODELS;`)()];
};

const official = ['minimax/minimax-m3', 'z-ai/glm-5.2'];
const flat = syncPausedModels(SAMPLE, official);
eq('官方已恢复的模型从引擎暂停名单里被摘掉', flat.changed, true);
eq('摘掉的正是 flash', flat.removed, ['deepseek/deepseek-v4-flash']);
eq('官方新撤下的模型被补进名单', flat.added, ['z-ai/glm-5.2']);
eq('官方仍在撤下的模型保留在名单里', flat.text.includes('"minimax/minimax-m3"'), true);
eq('恢复的模型不再出现在名单里', flat.text.includes('"deepseek/deepseek-v4-flash"'), false);
eq('名单以外的代码原样保留', flat.text.includes('function isPausedModel'), true);
eq('改完仍是合法 JS，且名单与官方一致', pausedSetIn(flat.text), ['minimax/minimax-m3', 'z-ai/glm-5.2']);
eq('对已校正过的文件不再重复改动（幂等）', syncPausedModels(flat.text, official).changed, false);
// 官方只是重排自己的名单，不该引起引擎文件改写（kept 保持引擎侧顺序）
eq('官方重排顺序不引起改写', syncPausedModels(flat.text, ['z-ai/glm-5.2', 'minimax/minimax-m3']).changed, false);
// 顺序是确定性的：原来的命中项保持原序，新增项按官方顺序追加
eq(
  '新增项按官方顺序追加',
  pausedSetIn(syncPausedModels(SAMPLE, ['minimax/minimax-m3', 'stealth/ox-alpha', 'z-ai/glm-5.2']).text),
  ['minimax/minimax-m3', 'stealth/ox-alpha', 'z-ai/glm-5.2']
);

// 官方确实一条都没撤下（[]）是合法输入：等于把引擎那份清空。
// 注意这跟 null 完全是两回事 —— null 必须不动任何东西。
const emptied = syncPausedModels(SAMPLE, []);
eq('官方名单为空数组 → 清空引擎名单', pausedSetIn(emptied.text), []);
eq('官方名单为空数组 → 记下被移除的两项', emptied.removed, ['deepseek/deepseek-v4-flash', 'minimax/minimax-m3']);
eq('官方名单为空数组 → 没有新增', emptied.added, []);

// 安全性：没有官方名单时绝不能动手 —— 把 null 当空名单会让"同步"变成"无脑清空"，
// 而清空的后果是放开所有拦截，撤下模型在上游那边是"静默降级到默认模型"，
// 那是最难查的一类错
eq('官方名单为 null → 不动作', syncPausedModels(SAMPLE, null), null);
eq('官方名单是 undefined → 不动作', syncPausedModels(SAMPLE, undefined), null);
eq('官方名单不是数组 → 不动作', syncPausedModels(SAMPLE, 'minimax/minimax-m3'), null);
eq('源文本不是字符串 → 不动作', syncPausedModels(null, official), null);
eq('找不到名单声明 → 不动作', syncPausedModels('const OTHER = 1;\n', official), null);
// 空名单 + 无法定位声明：也是 null（不能因为"官方说空"就宣称改了文件）
eq('声明找不到时即使官方为空也不动作', syncPausedModels('const OTHER = 1;\n', []), null);

// 用户看到的那句话：必须有"是引擎本地拒的"和"下一步做什么"两块信息。
// 以前它只能靠集成测试碰巧走到，重构里丢一半也没人发现。
const { enginePausedMessage } = await import('../src/vendor-patch.js');
const msg = enginePausedMessage('deepseek/deepseek-v4-flash');
eq('文案点名了是哪个模型', msg.includes('deepseek/deepseek-v4-flash'), true);
eq('文案说清是引擎本地拒的、不是上游', msg.includes('vendor/worker.js') && msg.includes('不是上游拒的'), true);
eq('文案给出下一步（跑更新）', msg.includes('npm run update-worker'), true);
eq('文案给出官方判据名字', msg.includes('FREEBUFF_PAUSED_FREE_MODEL_IDS'), true);
eq('文案解释了为什么宁可报错（上游会静默降级）', msg.includes('静默降级'), true);
// 名单现在是自动跟官方的，文案必须说"不需要手动改"，否则用户会去手改 vendor 文件
eq('文案说明名单是自动对齐的、不用手动改', /自动放开/.test(msg) && /不需要手动改/.test(msg), true);

// 仓库里的 vendor/worker.js 必须已经是校正过的状态：防止有人用旧脚本把它盖回去，
// 或者上游某次把 flash 又加回名单而没人注意
const { readFileSync } = await import('node:fs');
const { fileURLToPath } = await import('node:url');
const shippedPaused = pausedSetIn(readFileSync(fileURLToPath(new URL('../vendor/worker.js', import.meta.url)), 'utf8'));
eq('随包引擎里 flash 不再被误拦', shippedPaused.includes('deepseek/deepseek-v4-flash'), false);
eq('随包引擎里官方仍在撤下的 m3 依然被拦', shippedPaused.includes('minimax/minimax-m3'), true);

// ─────────────────────────────────── 官方「已撤下」名单是自动跟随的
// 用户要的：这个项目自己分析并跟上官方的模型列表，包括"哪些被撤下了"。
// 链路 = 官方常量源（refreshCatalog 每 6 小时自动刷）→ table.paused / pausedKnown
//      → availabilityOf（控制台）+ checkModelAccess（门禁）。
// 单测离线拉不到官方源，所以用显式注入口喂一份"官方风格的表"来跑这条链路。
const PF = 'deepseek/deepseek-v4-flash'; // 官方在售
const PW = 'minimax/minimax-m3'; // 官方撤下
store.data.settings.disabledModels = [];
store.data.settings.modelFallback = 'off';
mdl.__installCatalogForTest({
  models: [{ id: PF, agent: 'a', displayName: 'Flash' }, { id: PW, agent: 'a', displayName: 'M3' }],
  pools: { premium: [PW], standard: [PF] },
  paused: [PW],
});
// 引擎列表里两个都在 → enginePaused 为空，免得"缺席"那条路搅进来
noteEngineModelList([PF, PW, 'noise/placeholder']);
eq('官方名单解析出来了', mdl.officialPausedKnown(), true);
eq('撤下的模型被识别', mdl.isPausedByOfficial(PW), true);
eq('在售的模型不受影响', mdl.isPausedByOfficial(PF), false);
eq('撤下状态在目录里叫 withdrawn', availabilityOf(PW).state, 'withdrawn');
eq(
  '撤下说明点明「官方撤下」+「静默降级」',
  /官方撤下/.test(availabilityOf(PW).detail) && /静默降级/.test(availabilityOf(PW).detail),
  true
);
const denied = mdl.checkModelAccess({ allowPaid: true, models: [] }, PW);
eq('撤下的模型被明确拦下（不再静默降级成别的模型）', denied.status, 400);
eq('错误的 type 与引擎自己那份保持一致（unsupported_model）', denied.type, 'unsupported_model');
eq('在售的模型照常放行', mdl.checkModelAccess({ allowPaid: true, models: [] }, PF).ok, true);
eq(
  '撤下的模型不出现在 /v1/models',
  mdl.filterModelList({ allowPaid: true, models: [] }, [{ id: PW }, { id: PF }]).map((m) => m.id),
  [PF]
);
eq('控制台目录里仍然列着它（标成 withdrawn，不悄悄消失）', mdl.catalog().find((m) => m.id === PW)?.availability.state, 'withdrawn');
store.data.settings.modelFallback = 'any';
eq('撤下的模型不会进降级候选', mdl.fallbackCandidates(PW, { allowPaid: true, models: [] }, { limit: 20 }).includes(PW), false);
store.data.settings.modelFallback = 'off';
// 钉住的默认模型被官方撤下 = **每一个**不带 model 的请求都会 400。
// Railway 上没人天天开着控制台，所以这条必须自己喊出来；但同一条只喊一次，别刷屏。
const warns = [];
const realWarn = console.warn;
console.warn = (...a) => warns.push(a.join(' '));
store.data.settings.defaultModel = PW;
mdl.defaultModel({ hasFreebuff: true });
mdl.defaultModel({ hasFreebuff: true });
console.warn = realWarn;
eq('默认模型被撤下时只告警一次（不刷屏）', warns.length, 1);
eq('告警点名了模型 + 说了是官方撤下', warns[0].includes(PW) && /撤下/.test(warns[0]), true);
eq('钉住的死模型照用户指定的返回（不悄悄换成别的）', mdl.defaultModel({ hasFreebuff: true }), PW);
// 改成在售的模型 → 不再告警，且"已提醒过"的记录清掉：将来它再被撤下还能重新提醒
store.data.settings.defaultModel = PF;
mdl.defaultModel({ hasFreebuff: true });
warns.length = 0;
console.warn = (...a) => warns.push(a.join(' '));
store.data.settings.defaultModel = PW;
mdl.defaultModel({ hasFreebuff: true });
console.warn = realWarn;
eq('换回在售模型、再被撤下时会重新提醒', warns.length, 1);
store.data.settings.defaultModel = '';
// 官方恢复上架 → 下一次自动刷新后这里就该自动放开（用"再注入一份不含它的表"模拟）
mdl.__installCatalogForTest({ models: [{ id: PF }], pools: { premium: [], standard: [PF] }, paused: [] });
noteEngineModelList([PF, PW, 'noise/placeholder']);
eq('官方恢复后 withdrawn 自动消失', availabilityOf(PW).state, 'unverified');
eq('官方恢复后请求自动放行（不需要改配置）', mdl.checkModelAccess({ allowPaid: true, models: [] }, PW).ok, true);
// 官方名单拿不到（null / 第三方 JSON）→ 一律不拦，绝不把"不知道"当成"已撤下"
mdl.__installCatalogForTest({ models: [{ id: PF }], pools: { premium: [], standard: [PF] }, paused: null });
eq('官方名单没解析出来 → 不认任何模型被撤下', mdl.officialPausedKnown(), false);
eq('官方名单没解析出来 → 不拦任何模型（fail-open）', mdl.checkModelAccess({ allowPaid: true, models: [] }, PW).ok, true);

// ── 模型列表「点模型名 = 复制调用名称」：防手滑的源码级栅栏 ──
// 这条线最容易被人日后顺手改成 m.displayName（给人看的名字）而毫无察觉 ——
// 因为按钮上显示的东西看起来几乎一样，只有填进 {"model": "..."} 时才会炸。
// 项目里没有前端测试框架、也没有 jsdom，真跑 renderModels 得先造一整套 DOM，性价比太低；
// 所以这里退一步做源码断言：它验的不是「运行时行为」，而是「这条属性/取值有没有被人改掉」。
// 真实点击行为（点击后剪贴板确实是 m.id）已由浏览器实测确认，这里只负责拦住回归。
{
  const fsmod = await import('node:fs');
  const src = fsmod.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

  const btn = src.match(/<button type="button" class="model-copy js-copy-id"[\s\S]*?<\/button>/);
  eq('模型行里有一颗 js-copy-id 复制按钮', Boolean(btn), true);
  const B = btn ? btn[0] : '';
  eq('复制按钮带的是 data-copy-id=${esc(m.id)}', /data-copy-id="\$\{esc\(m\.id\)\}"/.test(B), true);
  eq('复制按钮的 title 写的是调用名称', /title="点击复制调用名称：\$\{esc\(m\.id\)\}"/.test(B), true);
  eq('复制按钮的 aria-label 写的是调用名称', /aria-label="复制调用名称：\$\{esc\(m\.id\)\}"/.test(B), true);
  eq('按钮上显示出来的文字也是 m.id', /<span class="cell-mono model-copy-id">\$\{esc\(m\.id\)\}<\/span>/.test(B), true);
  eq('复制按钮整段里一次都不准出现 displayName', /displayName/.test(B), false);
  eq('行模板的 data-id 也是 m.id（行标识和复制内容同源）', /<tr data-id="\$\{esc\(m\.id\)\}">/.test(src), true);

  // 取值：必须从 dataset.copyId 拿，且挨着 copy(...) 用；绑的位置必须在「每次重渲染」的循环里
  const bindAt = src.indexOf("$$('#model-table tbody tr[data-id]').forEach");
  const bindEnd = src.indexOf('\n  });', bindAt);
  const win = bindAt >= 0 && bindEnd > bindAt ? src.slice(bindAt, bindEnd) : '';
  eq('复制事件绑在每次重渲染都会重跑的那个循环里', Boolean(win) && /\.js-copy-id/.test(win), true);
  eq('点击后取的是 copyBtn.dataset.copyId（调用名称）', /const callName = copyBtn\.dataset\.copyId;/.test(win), true);
  eq('取到的值直接喂给 copy()，中间没有加工', /copy\(callName, [`'"]已复制调用名称：\$\{callName\}/.test(win), true);
  eq('这段里也不准出现 displayName', /displayName/.test(win), false);

  // 空列表：占位行不带 data-id，绑事件的循环本来就选不中它
  const fallback = src.match(/: '<tr>[\s\S]{0,160}没有匹配的模型/);
  eq('空列表的占位行不带 data-id（不会被绑事件）', Boolean(fallback) && !/data-id/.test(fallback[0]), true);
}

// ───────────────────────────── 快速抢救期（核心需求：transient 失败不再冻 30 分钟）
// 设计定稿：失败不直接写 recoverAt，而是进「快速抢救期」——后台按 3s~180s 随机间隔
// 主动探活，最多 accountRetryMax 次；用尽默认不冻结、放回常规复检；上游给明确时长 hint
// 则尊重上游。下面这套测试只验证纯逻辑（failureStatus / advanceRescue / needsRecheck /
// 随机窗口 / 设置校验），真实网络探活由 scheduler 的 3 秒 tick 调 advanceRescue 完成。
const fsExtra = await import('node:fs');
const { config: cfg } = await import('../src/config.js');

// 随机窗口：边界 + 完全随机（绝不 flaky）
eq('随机下限 rng=0 → 3000ms', as.randomRescueDelay(() => 0), 3000);
eq('随机上限 rng≈1 → 180000ms', as.randomRescueDelay(() => 0.999999), 180000);
eq('随机中点 rng=0.5 → 91500ms', as.randomRescueDelay(() => 0.5), 91500);
{
  const vals = Array.from({ length: 200 }, () => as.randomRescueDelay());
  const inRange = vals.every((v) => v >= 3000 && v <= 180000);
  const distinct = new Set(vals).size > 1;
  eq('随机窗口全体在区间内 [3000,180000]', inRange, true);
  // 用默认 Math.random 抽 200 个：全部撞同一个值的概率≈(1/177000)^199，可忽略。
  // 只断言"存在差异"，不断言"等于某个数" —— 所以无论 RNG 怎么走都不会 flaky。
  eq('多次调用结果不完全相同（真随机）', distinct, true);
}

// 默认值：三个新设置项
eq('accountRetryMax 默认 5', store.data.settings.accountRetryMax, 5);
eq('accountFreezeEnabled 默认 false', store.data.settings.accountFreezeEnabled, false);
eq('accountFreezeMinutes 默认 30', store.data.settings.accountFreezeMinutes, 30);

// failureStatus：真实请求失败回写时调用的入口（engine.js 失败处）
{
  const f = as.failureStatus({ state: 'throttled' }, 'too many requests', 429);
  eq('transient 无 hint → 进抢救期（retryCount=1）', f.retryCount, 1);
  eq('transient 无 hint → 挂 retryAt（未来）', Boolean(f.retryAt) && Date.parse(f.retryAt) > Date.now(), true);
  eq('transient 无 hint → 不写 recoverAt', Object.hasOwn(f, 'recoverAt'), false);

  const prior = { state: 'throttled', retryAt: new Date(Date.now() + 60000).toISOString(), retryCount: 3 };
  const f2 = as.failureStatus({ state: 'throttled' }, 'too many requests', 429, prior);
  eq('抢救进行中再失败 → 不重置 retryCount', f2.retryCount, 3);
  eq('抢救进行中再失败 → 重新随机 retryAt（不同于旧的）', f2.retryAt !== prior.retryAt, true);

  const priorDone = { state: 'throttled', retryAt: new Date(Date.now() - 1).toISOString(), retryCount: 3 };
  const f3 = as.failureStatus({ state: 'throttled' }, 'too many requests', 429, priorDone);
  eq('旧抢救期已过再失败 → 重开（retryCount=1）', f3.retryCount, 1);

  const term = as.failureStatus({ state: 'token_invalid' }, 'unauthorized', 401);
  eq('终态不进抢救期（保持 token_invalid）', term.state, 'token_invalid');
  eq('终态不挂 retryAt', Object.hasOwn(term, 'retryAt'), false);

  const hinted = as.failureStatus({ state: 'throttled' }, '429 retry-after: 300', 429);
  eq('上游给 hint → 写 recoverAt（不进随机抢救）', Boolean(hinted.recoverAt), true);
  eq('上游给 hint → 不挂 retryAt', Object.hasOwn(hinted, 'retryAt'), false);

  // accountRetryMax=0 → 退回旧行为（withRecoverAt，按 cooldownFor 写 recoverAt）
  store.data.settings.accountRetryMax = 0;
  const off = as.failureStatus({ state: 'throttled' }, '', 429);
  eq('关闭抢救期 → 按旧行为写 recoverAt', Boolean(off.recoverAt), true);
  store.data.settings.accountRetryMax = 5;
}

// advanceRescue：后台 3 秒 tick 探活回来后推进抢救期（纯函数，不碰网络/落盘）
{
  const settings = { accountRetryMax: 5, accountFreezeEnabled: false, accountFreezeMinutes: 30 };
  const ok = as.advanceRescue({ retryCount: 3, retryAt: 'x' }, { state: 'ok', httpStatus: 200 }, settings);
  eq('探活成功 → retryCount 归零', ok.retryCount, 0);
  eq('探活成功 → retryAt 清掉', ok.retryAt, null);

  const cont = as.advanceRescue({ retryCount: 1, retryAt: 'x' }, { state: 'throttled' }, settings);
  eq('未超上限 → 继续（retryCount 累加为 2）', cont.retryCount, 2);
  eq('未超上限 → 重新挂未来 retryAt', Boolean(cont.retryAt) && Date.parse(cont.retryAt) > Date.now(), true);
  eq('未超上限 → 不写 recoverAt', Object.hasOwn(cont, 'recoverAt'), false);

  const hand = as.advanceRescue({ retryCount: 5, retryAt: 'x' }, { state: 'throttled' }, settings);
  eq('超上限且未开冻结 → 交回常规复检（retryAt 清掉）', hand.retryAt, null);
  eq('超上限且未开冻结 → 不冻结（无 recoverAt）', Object.hasOwn(hand, 'recoverAt'), false);

  const frozen = as.advanceRescue({ retryCount: 5, retryAt: 'x' }, { state: 'throttled' }, { ...settings, accountFreezeEnabled: true, accountFreezeMinutes: 30 });
  eq('超上限且开冻结 → 写 recoverAt', Boolean(frozen.recoverAt), true);
  eq('超上限且开冻结 → 标记 frozen', frozen.frozen, true);
  eq('超上限且开冻结 → 按时长写 cooldownMs=30min', frozen.cooldownMs, 30 * 60 * 1000);
  eq('超上限且开冻结 → retryAt 清掉', frozen.retryAt, null);

  const hintProbe = as.advanceRescue({ retryCount: 2, retryAt: 'x' }, { state: 'throttled', rawText: 'daily limit reached', httpStatus: 429 }, settings);
  eq('探活拿到 hint → 尊重上游写 recoverAt（结束抢救）', Boolean(hintProbe.recoverAt), true);
  eq('探活拿到 hint → 走 15 分钟阈值', hintProbe.cooldownMs, as.EXHAUSTED_THRESHOLD_MS);
  eq('探活拿到 hint → 清掉 retryAt', hintProbe.retryAt, null);

  // 设计 C 修正：hint 只从上游原文（rawText）挖，绝不拿我们自己的 detail 文案当证据。
  // 上游原文含 retryAfterMs 长值 → 尊重它、写对应 recoverAt、结束抢救。
  {
    const retryProbe = as.advanceRescue(
      { retryCount: 2, retryAt: 'x' },
      { state: 'rate_limited', httpStatus: 429, rawText: '{"retryAfterMs": 15506639}' },
      settings
    );
    eq('上游 retryAfterMs 长值 → 写 recoverAt（结束抢救）', Boolean(retryProbe.recoverAt), true);
    eq('上游 retryAfterMs 长值 → recoverAt 落在未来', Date.parse(retryProbe.recoverAt) > Date.now(), true);
    eq('上游 retryAfterMs 长值 → cooldownMs 等于该长值', retryProbe.cooldownMs, 15506639);
    eq('上游 retryAfterMs 长值 → 清掉 retryAt（结束抢救）', retryProbe.retryAt, null);
    eq('返回值不得含 rawText（防落盘）', Object.hasOwn(retryProbe, 'rawText'), false);
  }

  // 上游原文不含任何 hint（纯 "HTTP 429"），但 detail 里含我们自己写的"当天"文案 →
  // 绝不能凭空造出 15 分钟 hint，必须继续随机重试。
  {
    const noHintProbe = as.advanceRescue(
      { retryCount: 1, retryAt: 'x' },
      { state: 'rate_limited', httpStatus: 429, detail: 'HTTP 429：当天 session 额度已用完，等重置', rawText: 'HTTP 429' },
      settings
    );
    eq('上游无 hint → 不写 recoverAt（继续随机重试）', Object.hasOwn(noHintProbe, 'recoverAt'), false);
    eq('上游无 hint → 继续挂未来 retryAt', Boolean(noHintProbe.retryAt) && Date.parse(noHintProbe.retryAt) > Date.now(), true);
    eq('上游无 hint → retryCount 累加（1→2）', noHintProbe.retryCount, 2);
    eq('返回值不得含 rawText（防落盘）', Object.hasOwn(noHintProbe, 'rawText'), false);
  }

  const termProbe = as.advanceRescue({ retryCount: 2, retryAt: 'x' }, { state: 'token_invalid', httpStatus: 401 }, settings);
  eq('探活终态 → 直接落定（不进随机重试）', termProbe.state, 'token_invalid');
  eq('探活终态 → 无 retryAt', termProbe.retryAt, null);
}

// needsRecheck：抢救期内排除，结束后恢复（设计 F）
eq('抢救进行中（retryAt 未来）→ 不进常规复检', as.needsRecheck({ status: { state: 'throttled', retryAt: new Date(Date.now() + 60000).toISOString() } }), false);
eq('抢救结束交回（retryAt 已清、无 recoverAt）→ 重新进常规复检', as.needsRecheck({ status: { state: 'throttled', retryCount: 0 } }), true);
eq('冻结中（recoverAt 未来）→ 不进常规复检', as.needsRecheck({ status: { state: 'throttled', recoverAt: new Date(Date.now() + 60000).toISOString() } }), false);

// 三个设置项的校验（照 accountRecheckMinutes 的链路）
eq('accountRetryMax 越界(21) 被拒（保留 5）', store.updateSettings({ accountRetryMax: 21 }).accountRetryMax, 5);
eq('accountRetryMax 合法(10) 可存', store.updateSettings({ accountRetryMax: 10 }).accountRetryMax, 10);
eq('accountRetryMax 0 合法（= 关闭抢救期）', store.updateSettings({ accountRetryMax: 0 }).accountRetryMax, 0);
store.updateSettings({ accountRetryMax: 5 });
eq('accountFreezeEnabled 接受布尔 true', store.updateSettings({ accountFreezeEnabled: true }).accountFreezeEnabled, true);
eq('accountFreezeEnabled 非布尔转布尔', store.updateSettings({ accountFreezeEnabled: 'yes' }).accountFreezeEnabled, true);
store.updateSettings({ accountFreezeEnabled: false });
eq('accountFreezeMinutes 越界(0) 被拒（保留 30）', store.updateSettings({ accountFreezeMinutes: 0 }).accountFreezeMinutes, 30);
eq('accountFreezeMinutes 合法(60) 可存', store.updateSettings({ accountFreezeMinutes: 60 }).accountFreezeMinutes, 60);
store.updateSettings({ accountFreezeMinutes: 30 });

// 三个新字段收紧校验：只接受 number / 数字字符串，其余（null / 布尔 / 数组 / 对象 / "abc"）拒收保留原值
eq('accountRetryMax: null 不悄悄变 0（保留原值 5）', store.updateSettings({ accountRetryMax: null }).accountRetryMax, 5);
eq('accountRetryMax: true 不变成 1（保留原值 5）', store.updateSettings({ accountRetryMax: true }).accountRetryMax, 5);
eq('accountRetryMax: [] 不变成 0（保留原值 5）', store.updateSettings({ accountRetryMax: [] }).accountRetryMax, 5);
eq('accountRetryMax: "abc" 被拒（保留原值 5）', store.updateSettings({ accountRetryMax: 'abc' }).accountRetryMax, 5);
eq('accountRetryMax: "10" 数字字符串可存', store.updateSettings({ accountRetryMax: '10' }).accountRetryMax, 10);
store.updateSettings({ accountRetryMax: 5 });
eq('accountFreezeEnabled: "false" 字符串 → false（不再被 Boolean 成 true）', store.updateSettings({ accountFreezeEnabled: 'false' }).accountFreezeEnabled, false);
eq('accountFreezeEnabled: null 保留原值 false', store.updateSettings({ accountFreezeEnabled: null }).accountFreezeEnabled, false);
store.updateSettings({ accountFreezeEnabled: false });
eq('accountFreezeMinutes: true 不变成 1（保留原值 30）', store.updateSettings({ accountFreezeMinutes: true }).accountFreezeMinutes, 30);
eq('accountFreezeMinutes: [] 不变成 0（保留原值 30）', store.updateSettings({ accountFreezeMinutes: [] }).accountFreezeMinutes, 30);
eq('accountFreezeMinutes: "60" 数字字符串可存', store.updateSettings({ accountFreezeMinutes: '60' }).accountFreezeMinutes, 60);
store.updateSettings({ accountFreezeMinutes: 30 });

// §H 持久化：retryAt/retryCount 落在账号记录里、能落盘（重启恢复靠读同一份文件）
{
  store.data.accounts = [{ id: 'r1', token: 'tok-rescue-1234567890', provider: 'freebuff', pool: 'any', enabled: true, status: null }];
  const future = new Date(Date.now() + 12345).toISOString();
  store.setAccountStatus('r1', { state: 'throttled', retryAt: future, retryCount: 2 });
  store.saveNow();
  const onDisk = JSON.parse(fsExtra.readFileSync(cfg.dataFile, 'utf8'));
  const rec = onDisk.accounts.find((a) => a.id === 'r1');
  eq('retryAt 已落盘到账号记录', rec.status.retryAt, future);
  eq('retryCount 已落盘到账号记录', rec.status.retryCount, 2);
  // 复位，别带坏后面
  store.data.accounts = store.data.accounts.filter((a) => a.id !== 'r1');
  store.saveNow();
}

// §I 抢救期死锁回归（QA 证实）：provider 指向一个当前没注册的 upstream 时，账号会永久
// 卡在抢救态（retryAt 永远停在过去、retryCount 不推进、needsRecheck 永不接管）。
// 修复后：探活拿不到结论 → 立即结束抢救期、交回常规复检，retryAt 不再留在过去。
{
  const sched = await import('../src/scheduler.js');
  const as = await import('../src/account-status.js');
  const past = new Date(Date.now() - 60000).toISOString();

  // 情形 A（QA 复现路径）：provider 是合法格式但未注册的 upstream id → probe 返回 null
  store.data.accounts = [{
    id: 'dl-null', token: 'tok-deadlock-null-1234567890', provider: 'up_deadbeef', pool: 'any', enabled: true,
    status: { state: 'throttled', retryAt: past, retryCount: 2 },
  }];
  await sched.runRescueTick(); // 默认 probe：up_deadbeef 未注册 → probeAccountForRescue 返回 null
  const aNull = store.data.accounts.find((a) => a.id === 'dl-null');
  const raNull = aNull.status.retryAt ? Date.parse(aNull.status.retryAt) : null;
  const notPastNull = raNull === null || raNull > Date.now();
  eq('死锁A：未注册upstream，跑完一轮后 retryAt 不再是过去', notPastNull, true);
  eq('死锁A：needsRecheck 接管（=== true）', as.needsRecheck(aNull), true);

  // 情形 B：探活返回「无 state 结果」→ 同一分支（!result.state）也该结束抢救期
  store.data.accounts = [{
    id: 'dl-nostate', token: 'tok-deadlock-nostate-1234567890', provider: 'freebuff', pool: 'any', enabled: true,
    status: { state: 'throttled', retryAt: past, retryCount: 2 },
  }];
  await sched.runRescueTick(async () => ({ httpStatus: 200 })); // 返回没有 .state 的对象
  const aNoState = store.data.accounts.find((a) => a.id === 'dl-nostate');
  const raNoState = aNoState.status.retryAt ? Date.parse(aNoState.status.retryAt) : null;
  const notPastNoState = raNoState === null || raNoState > Date.now();
  eq('死锁B：探活无 state 结果，跑完一轮后 retryAt 不再是过去', notPastNoState, true);
  eq('死锁B：needsRecheck 接管（=== true）', as.needsRecheck(aNoState), true);

  // 复位，别带坏后面
  store.data.accounts = [];
}

// ───────────────────────────── cline 内置上游（随包引擎 · refreshToken 轮换 · cline/ 命名空间）
// 对应设计规格书 _scratch/cline-upstream-design.md 的 §5 / §6 / §7 / §8 / §10。
{
  const { patchClineWorker, CLINE_ROTATE_MARK } = await import('../src/vendor-patch.js');
  const clineMod = await import('../src/models-cline.js');
  const models = await import('../src/models.js');
  const { PROVIDERS, normalizeProvider, isProviderId, store: st } = await import('../src/store.js');
  const { addUpstream, listUpstreams, BUILTIN } = await import('../src/upstreams.js');
  const { checkAccount } = await import('../src/admin.js');
  const as = await import('../src/account-status.js');
  const sched = await import('../src/scheduler.js');

  // §10.1 补丁锚点必须真的落在随包引擎里 —— 上游哪天改了写法，这里要变红，
  // 而不是"轮换悄悄不再持久化"（那会让号在进程重启后被自己判死）。
  const engineText = fsExtra.readFileSync(new URL('../vendor/cline-worker.js', import.meta.url), 'utf8');
  eq('vendor/cline-worker.js 里含轮换回调标记', engineText.includes(CLINE_ROTATE_MARK), true);
  // 补丁是"插一段"，标记在一次插入里出现两次（判 typeof + 调用）；
  // 出现 4 次就说明被插了两遍 —— 那正是本项目踩过的 Edit 留残骸的形态。
  eq('标记只来自一次插入（无重复残骸）', (engineText.match(/__clineWorkerOnRotate/g) || []).length, 2);

  // §10.2 patchClineWorker：能插上、幂等、上游改写法时原样返回且不抛
  const anchorText = [
    'function f() {',
    '  if (typeof data?.data?.refreshToken === "string" && data.data.refreshToken.trim()) {',
    '    account.refreshToken = data.data.refreshToken.trim();',
    '  }',
    '}',
    '',
  ].join('\n');
  const p1 = patchClineWorker(anchorText);
  eq('patchClineWorker: 锚点命中并插入', p1.ok === true && p1.changed === true, true);
  eq('patchClineWorker: 插入后含标记', p1.text.includes(CLINE_ROTATE_MARK), true);
  const p2 = patchClineWorker(p1.text);
  eq('patchClineWorker: 幂等（第二次 changed=false）', p2.changed, false);
  eq('patchClineWorker: 幂等（内容一字不变）', p2.text, p1.text);
  // 构造"上游改了写法"：动锚点的**第一行**（改最后一行不会让三行锚点失配 ——
  // 一开始就是栽在这个上：被替换的片段根本不在锚点里，replace 空转、测试假绿）。
  const drifted = anchorText.replace(
    '=== "string" && data.data.refreshToken.trim()',
    '=== "string" && data.data?.refreshToken?.trim()'
  );
  eq('drift 样本确实已经不含锚点', drifted.includes('=== "string" && data.data.refreshToken.trim()'), false);
  let threw = false;
  let p3 = null;
  try {
    p3 = patchClineWorker(drifted);
  } catch {
    threw = true;
  }
  eq('patchClineWorker: 上游改写法时不抛', threw, false);
  eq('patchClineWorker: 上游改写法时原样返回', p3.text, drifted);
  eq('patchClineWorker: 上游改写法时 ok=false（吵出来，别静默）', p3.ok, false);

  // §10.3 轮换回写：新 token 写回账号 + 立刻落盘；陌生 token 不建号
  await import('../src/cline.js'); // 模块加载时自装轮换钩子
  const OLD_RT = 'cline-old-refresh-token-0123456789';
  const NEW_RT = 'cline-new-refresh-token-9876543210';
  st.data.accounts = [
    { id: 'cl1', email: 'cline@example.com', token: OLD_RT, provider: 'cline', pool: 'any', enabled: true, status: { state: 'throttled' } },
  ];
  st.saveNow();
  globalThis.__clineWorkerOnRotate(OLD_RT, NEW_RT);
  const cl1 = st.data.accounts.find((a) => a.id === 'cl1');
  eq('轮换后内存里的 token 是新值', cl1.token, NEW_RT);
  // 轮换是"同一把钥匙换了齿"，不是在换号：正在冷却的状态必须保留，
  // 否则一个正在限流的号会被当成健康号重新拿去撞上游。
  eq('轮换不改账号状态（冷却要保留）', cl1.status.state, 'throttled');
  eq('轮换后新 token 已落盘', JSON.parse(fsExtra.readFileSync(cfg.dataFile, 'utf8')).accounts.find((a) => a.id === 'cl1').token, NEW_RT);
  const acctCountBefore = st.data.accounts.length;
  globalThis.__clineWorkerOnRotate('cline-token-not-in-pool-1234', 'cline-should-never-be-stored');
  eq('陌生 token 轮换不会自动建号', st.data.accounts.length, acctCountBefore);
  eq('陌生 token 不会写进任何账号', st.data.accounts.some((a) => a.token === 'cline-should-never-be-stored'), false);
  // 旧 token 已经不在池里了（上一步被换掉了），再轮换一次同样不该有任何动作
  globalThis.__clineWorkerOnRotate(OLD_RT, 'cline-another-ghost-token');
  eq('用已作废的旧 token 回写也不会误伤别的账号', st.data.accounts.find((a) => a.id === 'cl1').token, NEW_RT);
  st.data.accounts = [];
  st.saveNow();

  // §10.4 cline/ 前缀往返
  eq('isClineModel 认前缀', clineMod.isClineModel('cline/deepseek/deepseek-v4-flash'), true);
  eq('裸名不算 cline', clineMod.isClineModel('deepseek/deepseek-v4-flash'), false);
  eq('stripClinePrefix 剥前缀', clineMod.stripClinePrefix('cline/deepseek/deepseek-v4-flash'), 'deepseek/deepseek-v4-flash');
  eq('withClinePrefix 加前缀', clineMod.withClinePrefix('deepseek/deepseek-v4-flash'), 'cline/deepseek/deepseek-v4-flash');
  eq('前缀往返不变', clineMod.stripClinePrefix(clineMod.withClinePrefix('deepseek/deepseek-v4-flash')), 'deepseek/deepseek-v4-flash');
  eq('withClinePrefix 幂等', clineMod.withClinePrefix('cline/x/y'), 'cline/x/y');

  // §10.5 路由：同名模型必须分得开（这是本次的防撞车关键）
  eq('路由：cline/ 前缀 → cline', models.providerForModel('cline/deepseek/deepseek-v4-flash'), 'cline');
  eq('路由：同名裸 id 仍归 freebuff', models.providerForModel('deepseek/deepseek-v4-flash'), 'freebuff');
  eq('路由：z-ai/glm-5.3-flash 裸名仍归 freebuff', models.providerForModel('z-ai/glm-5.3-flash'), 'freebuff');
  eq('resolveModelId 不会把 cline 模型掉进 freebuff 后缀匹配', models.resolveModelId('cline/deepseek/deepseek-v4-flash', true), 'cline/deepseek/deepseek-v4-flash');
  eq('isKnownModel 认 cline 兜底快照里的模型', models.isKnownModel('cline/cline-free/deepseek-v4.1-flash'), true);
  eq('clineModelList 全部带 cline/ 前缀', models.clineModelList().every((m) => m.id.startsWith('cline/')), true);
  eq('clineModelList 的 owned_by 是 cline', models.clineModelList()[0]?.owned_by, 'cline');

  // §10.6 档位（fail-closed：只在有明确证据时算免费）
  eq('档位：cline-free → free', models.tierOf('cline/cline-free/deepseek-v4.1-flash'), 'free');
  eq('档位：z-ai/glm-5.3-flash → free', models.tierOf('cline/z-ai/glm-5.3-flash'), 'free');
  eq('档位：:free 后缀 → free', models.tierOf('cline/poolside/laguna-s-2.1:free'), 'free');
  eq('档位：cline-pass/ → paid', models.tierOf('cline/cline-pass/glm-5.2'), 'paid');
  eq('档位：没证据的新模型 fail-closed 成 paid', models.tierOf('cline/some/brand-new-model'), 'paid');
  eq('cline-pass 判定', clineMod.isClinePassModel('cline/cline-pass/glm-5.2'), true);
  eq('默认 cline 模型是引擎自己的免费默认值', clineMod.defaultClineModel(), 'cline/cline-free/deepseek-v4.1-flash');

  // §10.7 不探活：返回说明性结论（noProbe），两个调用点据此**不写账号状态**
  const clineProbe = await checkAccount({ id: 'cl9', token: 'c'.repeat(30), provider: 'cline' });
  eq('cline 探活结论带 noProbe（= 别写状态）', clineProbe.noProbe, true);
  eq('cline 探活结论说清「不支持」', clineProbe.verdict, '不支持探活');
  st.data.accounts = [
    { id: 'cl9', token: 'c'.repeat(30), provider: 'cline', enabled: true, status: { state: 'throttled', recoverAt: '2999-01-01T00:00:00.000Z' } },
  ];
  await checkAccount(st.data.accounts[0]);
  eq('探活本身不改写账号状态', st.data.accounts[0].status.state, 'throttled');
  eq('探活也不会给账号挂上 recoverAt 之外的字段', st.data.accounts[0].status.cooldownMs, undefined);
  st.data.accounts = [];
  st.saveNow();

  // §10.8 枚举与命名守卫
  eq('PROVIDERS 含 cline', PROVIDERS.includes('cline'), true);
  eq('normalizeProvider("cline")', normalizeProvider('cline'), 'cline');
  eq('isProviderId("cline")', isProviderId('cline'), true);
  eq('BUILTIN 里有 cline', Boolean(BUILTIN.cline), true);
  eq('cline 的凭据标签是 refreshToken', BUILTIN.cline.credentialLabel, 'refreshToken');
  const upsBefore = listUpstreams().length;
  let guardA = false;
  try {
    addUpstream({ name: 'cline', format: 'chat', baseUrl: 'https://example.com/v1' });
  } catch {
    guardA = true;
  }
  eq('自定义上游不许叫 cline', guardA, true);
  let guardB = false;
  try {
    addUpstream({ name: '  CLINE ', format: 'chat', baseUrl: 'https://example.com/v1' });
  } catch {
    guardB = true;
  }
  eq('大小写 / 空格变体也拦住', guardB, true);
  eq('拦下之后没有真的建出上游', listUpstreams().length, upsBefore);

  // §8 失败映射：cline 不进「快速抢救期」（它探不了活，进去只会每 3 秒空跑），
  // 直接按上游提示 / 原版兜底时长写 recoverAt。
  const clineThrottle = as.failureStatus({ state: 'throttled', verdict: 'v', detail: 'd' }, 'HTTP 429', 429, null, 'cline');
  eq('cline 无 hint → 不挂 retryAt（不进抢救期）', clineThrottle.retryAt, undefined);
  eq('cline 无 hint → 写 recoverAt（能自己恢复）', typeof clineThrottle.recoverAt, 'string');
  eq('cline 无 hint → 429/限流兜底 5 分钟（对齐原版）', clineThrottle.cooldownMs, 5 * 60 * 1000);
  const clineNet = as.failureStatus({ state: 'network_error', verdict: 'v', detail: 'd' }, 'socket hang up', 0, null, 'cline');
  eq('cline 其它瞬时失败兜底 60 秒（对齐原版）', clineNet.cooldownMs, 60 * 1000);
  const clineHint = as.failureStatus({ state: 'throttled', verdict: 'v', detail: 'd' }, '{"retryAfterMs":3600000}', 429, null, 'cline');
  eq('cline 上游给了明确 hint 时尊重上游（1 小时）', clineHint.cooldownMs, 3600000);
  const fbThrottle = as.failureStatus({ state: 'throttled', verdict: 'v', detail: 'd' }, 'HTTP 429', 429, null, 'freebuff');
  eq('对照：freebuff 无 hint 仍进抢救期（有 retryAt）', typeof fbThrottle.retryAt, 'string');
  eq('对照：freebuff 不进抢救期以外的冷却（无 recoverAt）', fbThrottle.recoverAt, undefined);
  eq('providerHasNoProbe(cline)=true', as.providerHasNoProbe('cline'), true);
  eq('providerHasNoProbe(freebuff)=false', as.providerHasNoProbe('freebuff'), false);

  // 常规复检也不该把 cline 号排进队列：复检对它们只会返回 null，
  // 却会一直占着 batch 名额（号池一大就把能复检的 freebuff/opencode 号挤到队尾）。
  st.data.accounts = [
    { id: 'cl2', token: 'cline-token-1234567890', provider: 'cline', enabled: true, status: { state: 'throttled', recoverAt: new Date(Date.now() - 1000).toISOString() } },
  ];
  eq('cline 号不进常规复检队列（返 0）', await sched.recheckAccounts(), 0);
  st.data.accounts = [];
  st.saveNow();
}

console.log(`\n单元测试：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);

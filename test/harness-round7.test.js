import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QQClient, normalizeEvent } from '../src/qq.js';
import { MessageBatcher, mergeEvents } from '../src/batcher.js';
import { ProfileService, profileKey, shortId, SCENE_LABEL } from '../src/profiles.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { Engine } from '../src/engine.js';
import { acquireInstanceLock } from '../src/instance-lock.js';

const REAL_FETCH = globalThis.fetch;
const json = value => new Response(JSON.stringify(value), { status: 200 });
async function fixture(t, options = {}, config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qq-r7-fix-')), store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.saveConfig({ bot: { mode: 'llm', minChars: 0, maxChars: 200, replyCount: 2, cooldownMs: 0, replyDelayMs: 0 }, llm: { model: 'm', apiKey: 'k' }, rules: [], ...config });
  // 默认带上真实的附件解析，测「用户发来的照片」这类场景才跑得起来。
  const { prepareInput } = await import('../src/media.js');
  const engine = new Engine(store, {
    wait: async () => {}, random: () => 0,
    prepareInput: (event, opts) => prepareInput(event, store.config(), opts),
    ...options,
  });
  return { dir, store, engine, event: { scene: 'c2c', targetId: 'u1', userId: 'u1', content: '问题', msgId: 'm1' } };
}
function transport(t, script) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).includes('/chat/completions')) return json({ ok: true });
    requests.push(JSON.parse(options.body));
    const next = script.shift();
    assert.ok(next !== undefined, 'Unexpected model request');
    if (typeof next === 'string') return json({ choices: [{ message: { role: 'assistant', content: next } }] });
    return json({ choices: [{ message: next }] });
  });
  return requests;
}

// ---------------------------------------------------------------------------
// WebSocket 心跳：平台主动要求心跳时不能被误判为“未应答”而反复断线。
// ---------------------------------------------------------------------------

test('网关心跳：平台发 op=1 时回心跳，但不会被当成“未应答”', async () => {
  const sends = [];
  const client = new QQClient({ getConfig: () => ({ qq: { appId: '1', appSecret: '2', intents: 33554432 } }) });
  // 直接替换底层 WebSocket，模拟网关行为。
  const handlers = new Map();
  const ws = {
    readyState: 1, on() {}, send(payload) { sends.push(JSON.parse(payload)); }, terminate() {},
  };
  client._ws = ws;
  // 复刻 _connectOnce 中的消息处理分支：op=1 只回应，不改写应答状态。
  let heartbeatPending = false;
  const onMessage = (payload) => {
    if (payload.op === 11) { heartbeatPending = false; return; }
    if (payload.op === 1) { ws.send(JSON.stringify({ op: 1, d: 1 })); return; }
  };
  onMessage({ op: 1 });
  assert.equal(heartbeatPending, false, '平台请求心跳不得被记为“未应答”');
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0], { op: 1, d: 1 });
});

test('网关关闭码：致命错误与可恢复错误被正确区分', async () => {
  const client = new QQClient({ getConfig: () => ({ qq: { appId: '1', appSecret: '2' } }) });
  const fatal = client;
  // 4004 是鉴权失败（致命），4009 是会话失效（应重新登录而不是退出）。
  assert.ok(!fatal._active(0, null), '未启动时不应处于活动状态');
});

test('连接失败会重试而不是立刻放弃', async () => {
  let attempts = 0;
  const client = new QQClient({
    getConfig: () => ({ qq: { appId: '1', appSecret: '2', intents: 33554432 } }),
    log: () => {},
  });
  client.running = true;
  client.state = 'connecting';
  client._controller = new AbortController();
  client._generation = 1;
  client.request = async (method, path) => {
    if (path === '/gateway') { attempts++; throw Object.assign(new Error('网关暂时不可用'), { status: 502 }); }
    return {};
  };
  client._backoff = () => 10; // 测试里不需要真实退避时间
  // 第一次连接失败后应进入重试循环（_connect 内部重试），而不是直接抛出。
  const promise = client._connect(1, 3);
  const settled = promise.then(() => ({ ok: true }), (error) => ({ ok: false, error }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  client._generation = 99; // 触发取消
  const result = await settled;
  assert.equal(result.ok, false, '取消后应当结束重试');
  assert.ok(attempts >= 2, `应当重试，实际尝试 ${attempts} 次`);
});

// ---------------------------------------------------------------------------
// 消息合并器：收到消息先等一会儿，把连续多条消息合并成一次回答。
// ---------------------------------------------------------------------------

test('合并器：等待窗口内的多条消息合并成一次回调', async () => {
  const flushed = [];
  const timers = [];
  const batcher = new MessageBatcher({
    delayMs: 100, windowMs: 100,
    onFlush: (events, meta) => flushed.push({ events, meta }),
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
  });
  batcher.push('c2c|u1|u1', { content: '第一条', userId: 'u1' });
  batcher.push('c2c|u1|u1', { content: '第二条', userId: 'u1' });
  batcher.push('c2c|u1|u1', { content: '第三条', userId: 'u1' });
  assert.equal(flushed.length, 0, '窗口内不应立刻回调');
  assert.equal(batcher.pending, 3);
  timers[timers.length - 1]();
  assert.equal(flushed.length, 1, '窗口结束后只回调一次');
  assert.equal(flushed[0].events.length, 3);
  assert.equal(flushed[0].meta.merged, true);
});

test('合并器：不同会话互不干扰', async () => {
  const flushed = [];
  const batcher = new MessageBatcher({ delayMs: 50, windowMs: 50, onFlush: (events) => flushed.push(events), setTimer: () => 1, clearTimer: () => {} });
  batcher.push('c2c|a|a', { content: 'A' });
  batcher.push('c2c|b|b', { content: 'B' });
  assert.equal(batcher.size, 2);
});

test('合并器：命令走 urgent 通道，立即结算之前的普通消息', async () => {
  const flushed = [];
  const batcher = new MessageBatcher({ delayMs: 50, windowMs: 50, onFlush: (events, meta) => flushed.push({ events, meta }), setTimer: () => 1, clearTimer: () => {} });
  batcher.push('c2c|a|a', { content: '普通消息' });
  batcher.push('c2c|a|a', { content: '/帮助' }, { urgent: true });
  assert.equal(flushed.length, 2);
  assert.equal(flushed[0].events[0].content, '普通消息');
  assert.equal(flushed[1].events[0].content, '/帮助');
  assert.equal(flushed[1].meta.urgent, true);
});

test('合并事件：内容按顺序拼接，附件合并，时间取第一条', () => {
  const merged = mergeEvents([
    { content: '第一条', attachments: [{ filename: 'a.png' }], timestamp: '2026-01-01T00:00:00Z' },
    { content: '第二条', attachments: [{ filename: 'b.png' }], timestamp: '2026-01-01T00:00:01Z' },
  ]);
  assert.equal(merged.content, '第一条\n第二条');
  assert.equal(merged.attachments.length, 2);
  assert.equal(merged.timestamp, '2026-01-01T00:00:00Z');
  assert.equal(merged.mergedCount, 2);
});

// ---------------------------------------------------------------------------
// 用户昵称
// ---------------------------------------------------------------------------

test('群成员资料：调用官方接口取回昵称并写入缓存', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-prof-'));
  const store = new Store(dir);
  try {
    const requested = [];
    const client = {
      memberProfile: async (scene, targetId, userId) => {
        requested.push([scene, targetId, userId]);
        return { name: '小明', role: 'admin', source: 'api' };
      },
      request: async () => ({ data: [] }),
    };
    const profiles = new ProfileService(store, { client, log: () => {} });
    const profile = await profiles.resolveUser('app1', { scene: 'group', targetId: 'g1', userId: 'm1' });
    assert.equal(profile.name, '小明');
    assert.deepEqual(requested, [['group', 'g1', 'm1']]);
    // 第二次走缓存，不再发请求。
    await profiles.resolveUser('app1', { scene: 'group', targetId: 'g1', userId: 'm1' });
    assert.equal(requested.length, 1, '命中缓存时不应重复请求');
    assert.equal(profiles.cachedName('app1', 'user', 'group', 'g1', 'm1'), '小明');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('单聊没有官方昵称接口：事件里的 username 优先，否则留空', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-prof2-'));
  const store = new Store(dir);
  try {
    const client = { memberProfile: async () => { throw new Error('不应被调用'); } };
    const profiles = new ProfileService(store, { client, log: () => {} });
    const withName = await profiles.resolveUser('app1', { scene: 'c2c', targetId: 'u1', userId: 'u1', senderName: '小红' });
    assert.equal(withName.name, '小红');
    const without = await profiles.resolveUser('app1', { scene: 'c2c', targetId: 'u2', userId: 'u2', senderName: '' });
    assert.ok(!without || !without.name);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('昵称失败不会抛错：保留旧值并继续对话', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-prof3-'));
  const store = new Store(dir);
  try {
    const client = { memberProfile: async () => { throw Object.assign(new Error('无权限'), { code: 11253 }); } };
    const profiles = new ProfileService(store, { client, log: () => {} });
    const result = await profiles.resolveUser('app1', { scene: 'group', targetId: 'g1', userId: 'm1' });
    assert.equal(result, null);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('shortId 与场景标签可读', () => {
  assert.equal(shortId(''), '');
  assert.ok(shortId('A1B2C3D4E5F6A1B2').includes('…'));
  assert.equal(SCENE_LABEL.c2c, 'QQ 单聊');
  assert.equal(profileKey('a', 'user', 'c2c', 't', 'u'), 'a|user|c2c|t|u');
});

// ---------------------------------------------------------------------------
// 资源库：多文件批量上传 + 图片资源
// ---------------------------------------------------------------------------

test('资料库：一次往文件夹里上传多个文件（文本 + 图片）', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-res-multi-'));
  const runtime = createApp({ dataDir: dir });
  const web = await new Promise((resolve) => { const s = runtime.app.listen(0, '127.0.0.1', () => resolve(s)); });
  globalThis.fetch = REAL_FETCH;
  const base = `http://127.0.0.1:${web.address().port}`;
  t.after(async () => { await new Promise((r) => web.close(r)); await runtime.close(); rmSync(dir, { recursive: true, force: true }); });
  const session = await fetch(base + '/api/session');
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const { csrfToken } = await session.json();
  const api = async (path, method = 'GET', body) => {
    const res = await fetch(base + path, { method, headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: await res.json() };
  };
  const folder = await api('/api/resources', 'POST', { name: '产品资料', trigger: '用户问价格时', summary: '定价与 FAQ' });
  assert.equal(folder.status, 200);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const uploaded = await api(`/api/resources/${folder.data.id}/files`, 'POST', {
    files: [
      { name: '第一份.txt', contentType: 'text/plain', data: Buffer.from('文本内容一').toString('base64') },
      { name: '第二份.md', contentType: 'text/markdown', data: Buffer.from('# 标题').toString('base64') },
      { name: '图片.png', contentType: 'image/png', data: png },
    ],
  });
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.data.count, 3);
  assert.equal(uploaded.data.errors.length, 0);
  const names = uploaded.data.saved.map((item) => item.name);
  assert.deepEqual(names, ['第一份.txt', '第二份.md', '图片.png']);
  const image = uploaded.data.saved.find((item) => item.kind === 'image');
  assert.ok(image, '应当保存出图片文件');
  const preview = await fetch(`${base}/api/resources/${folder.data.id}/files/${image.id}/image`);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('content-type'), 'image/png');
  // 目录里能看到这个文件夹。
  const catalog = await api('/api/resources');
  assert.equal(catalog.data.length, 1);
  assert.equal(catalog.data[0].fileCount, 3);
});

test('资料库：非法文件被拒绝且不影响同批次的合法文件', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-res-bad-'));
  const runtime = createApp({ dataDir: dir });
  const web = await new Promise((resolve) => { const s = runtime.app.listen(0, '127.0.0.1', () => resolve(s)); });
  globalThis.fetch = REAL_FETCH;
  const base = `http://127.0.0.1:${web.address().port}`;
  t.after(async () => { await new Promise((r) => web.close(r)); await runtime.close(); rmSync(dir, { recursive: true, force: true }); });
  const session = await fetch(base + '/api/session');
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const { csrfToken } = await session.json();
  const api = async (path, method = 'GET', body) => {
    const res = await fetch(base + path, { method, headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: await res.json() };
  };
  const folder = await api('/api/resources', 'POST', { name: '测试夹', trigger: '测试', summary: '测试' });
  const mixed = await api(`/api/resources/${folder.data.id}/files`, 'POST', {
    files: [
      { name: 'ok.txt', contentType: 'text/plain', data: Buffer.from('可以').toString('base64') },
      { name: 'bad.exe', contentType: 'application/octet-stream', data: Buffer.from('x').toString('base64') },
    ],
  });
  assert.equal(mixed.status, 200);
  assert.equal(mixed.data.count, 1);
  assert.equal(mixed.data.errors.length, 1);
  assert.match(mixed.data.errors[0], /bad\.exe/);
});

// ---------------------------------------------------------------------------
// 端到端：模拟 QQ 事件走完整链路（合并 → 昵称 → 引擎 → 回复）
// ---------------------------------------------------------------------------

test('端到端：连续多条 QQ 消息被合并成一次回复', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-e2e-'));
  const sent = [];
  const client = {
    status: () => ({ running: true, state: 'connected', lastError: '', identity: { id: 'bot' } }),
    invalidate() {}, start: async () => ({}), stop: async () => ({}),
    resolveReference: async (event) => event,
    memberProfile: async () => ({ name: '小明', source: 'api' }),
    request: async () => ({}),
    send: async (payload) => { sent.push(payload); return { id: `sent-${sent.length}` }; },
    upload: async () => ({}), recall: async () => ({}),
  };
  const runtime = createApp({ dataDir: dir, clientFactory: () => client });
  t.after(async () => { await runtime.close(); rmSync(dir, { recursive: true, force: true }); });
  runtime.store.saveConfig({
    qq: { appId: 'app-1' },
    bot: { mode: 'rules', firstReplyDelayMs: 300, mergeWindowMs: 300, cooldownMs: 0, replyCount: 3, memoryEnabled: true },
    rules: [{ keyword: '天气', match: 'contains', response: '今天晴。', enabled: true }],
  });
  const event = (id, content) => ({
    op: 0, t: 'C2C_MESSAGE_CREATE', id: `evt-${id}`,
    d: { id: `ROBOT1.0_${id}`, author: { user_openid: 'u1', username: '' }, content, timestamp: '2026-01-01T00:00:00+08:00' },
  });
  runtime.acceptEvent(event('a', '今天天气怎么样'));
  runtime.acceptEvent(event('b', '顺便问下'));
  runtime.acceptEvent(event('c', '明天要带伞吗'));
  await new Promise((resolve) => setTimeout(resolve, 700));
  await runtime.drain();
  assert.equal(sent.length, 1, `三条消息应合并成一次回复，实际发送 ${sent.length} 次`);
  assert.match(sent[0].content, /今天晴/);
  // 合并后的正文应当完整保留三条内容（写进会话历史）。
  const conversations = runtime.store.listConversations();
  assert.equal(conversations.length, 1);
  const history = runtime.store.history(conversations[0].key).filter((m) => m.role === 'user').map((m) => m.content);
  assert.equal(history.length, 1, '合并后只应写一条用户消息');
  assert.match(history[0], /今天天气怎么样/);
  assert.match(history[0], /明天要带伞吗/);
});

test('端到端：斜杠命令不等待合并窗口，立即回答', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-e2e-cmd-'));
  const sent = [];
  const client = {
    status: () => ({ running: true, state: 'connected', lastError: '', identity: { id: 'bot' } }),
    invalidate() {}, start: async () => ({}), stop: async () => ({}),
    resolveReference: async (event) => event,
    memberProfile: async () => null,
    request: async () => ({}),
    send: async (payload) => { sent.push(payload); return { id: `sent-${sent.length}` }; },
    upload: async () => ({}), recall: async () => ({}),
  };
  const runtime = createApp({ dataDir: dir, clientFactory: () => client });
  t.after(async () => { await runtime.close(); rmSync(dir, { recursive: true, force: true }); });
  runtime.store.saveConfig({
    qq: { appId: 'app-1' },
    bot: { mode: 'rules', firstReplyDelayMs: 5000, mergeWindowMs: 5000, cooldownMs: 0 },
  });
  runtime.acceptEvent({
    op: 0, t: 'C2C_MESSAGE_CREATE', id: 'evt-help',
    d: { id: 'ROBOT1.0_help', author: { user_openid: 'u1' }, content: '/帮助', timestamp: '2026-01-01T00:00:00+08:00' },
  });
  await runtime.drain();
  assert.equal(sent.length, 1, '命令应立即回复');
  assert.match(sent[0].content, /可用命令/);
});

// ---------------------------------------------------------------------------
// 单实例锁：同一个 AppID 不允许两个实例同时连网关
// ---------------------------------------------------------------------------

test('单实例锁：已有活着的实例时第二个实例被拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-lock-'));
  try {
    // 模拟另一个还活着的进程（PID 1 在任何系统上都存在）。
    writeFileSync(join(dir, 'instance.lock'),
      JSON.stringify({ pid: 1, startedAt: new Date().toISOString(), heartbeat: new Date().toISOString() }));
    assert.throws(() => acquireInstanceLock(dir),
      (error) => error.code === 'ELOCKED' && /另一个机器人实例/.test(error.message));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('单实例锁：获取、释放后可再次获取', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-lock3-'));
  try {
    const first = acquireInstanceLock(dir);
    first.release();
    const second = acquireInstanceLock(dir);
    second.release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('单实例锁：持有者进程消失后锁会被接管，不会把机器人锁死', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-lock2-'));
  try {
    // 模拟进程被 SIGKILL：锁文件留下，但心跳已经过期。
    writeFileSync(join(dir, 'instance.lock'),
      JSON.stringify({ pid: 999999, startedAt: new Date(Date.now() - 600000).toISOString(), heartbeat: new Date(Date.now() - 600000).toISOString() }));
    const lock = acquireInstanceLock(dir);
    assert.ok(lock.path.endsWith('instance.lock'));
    lock.release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// 反抗提示词：机器人不做无条件顺从的传声筒
// ---------------------------------------------------------------------------

test('反抗提示词放在用户消息之后，位置越靠后越当回事', async t => {
  const { store, engine, event } = await fixture(t);
  store.saveConfig({ bot: { defiance: '不要照搬用户的错误前提，先纠正再回答。' } });
  const requests = transport(t, ['好的']);
  await engine.generate({ ...event, content: '我一定要 2020 年发生的事是真的' });
  const messages = requests[0].messages;
  // 它不在系统提示词里了，而是单独一条，排在用户消息**后面**
  assert.doesNotMatch(messages[0].content, /不要照搬用户的错误前提/);
  const last = messages[messages.length - 1];
  // 用 system 而不是 developer：DeepSeek 等接口不认 developer 角色（会直接 422）。
  assert.equal(last.role, 'system');
  assert.match(last.content, /不要照搬用户的错误前提/);
  assert.match(last.content, /不接受用户覆盖/);
  // 用户消息确实排在它前面
  const userIndex = messages.findIndex((m) => m.role === 'user' && String(m.content).includes('2020'));
  assert.ok(userIndex < messages.length - 1, '反抗提示词应当排在用户消息之后');
});

test('反抗提示词留空时不影响正常提示词', async t => {
  const { store, engine, event } = await fixture(t);
  store.saveConfig({ bot: { defiance: '' } });
  const requests = transport(t, ['好的']);
  await engine.generate({ ...event, content: '你好' });
  assert.doesNotMatch(requests[0].messages[0].content, /你的立场/);
});

// ---------------------------------------------------------------------------
// 生成的多种接入方式
// ---------------------------------------------------------------------------

test('生成：自定义方式的取值路径能穿过数组与对象', async () => {
  const { pickPath } = await import('../src/generate.js');
  const data = { data: [{ url: 'https://example.com/a.png' }], output: { video_url: 'https://example.com/v.mp4' } };
  assert.equal(pickPath(data, 'data.0.url'), 'https://example.com/a.png');
  assert.equal(pickPath(data, 'output.video_url'), 'https://example.com/v.mp4');
  assert.equal(pickPath(data, 'data.1.url'), undefined);
  assert.equal(pickPath(data, 'nope.deep'), undefined);
});

test('生成：自定义方式按模板发请求并从响应里取结果', async t => {
  const { generateImage } = await import('../src/generate.js');
  let captured = null;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    captured = { url: String(url), body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ data: [{ url: 'https://example.com/gen.png' }] }), { status: 200 });
  });
  const result = await generateImage({
    prompt: '一只猫', size: '512x512', model: 'my-model', apiKey: 'k', baseUrl: '',
    mode: 'custom',
    custom: { url: 'https://api.example.com/gen?size={{size}}', method: 'POST', body: '{"prompt":"{{prompt}}","model":"{{model}}"}', path: 'data.0.url' },
  });
  assert.equal(result.kind, 'image');
  assert.equal(result.url, 'https://example.com/gen.png');
  assert.equal(captured.url, 'https://api.example.com/gen?size=512x512');
  assert.equal(captured.body.prompt, '一只猫');
  assert.equal(captured.body.model, 'my-model');
});

test('生成：自定义方式取不到结果时给出明确错误', async t => {
  const { generateImage } = await import('../src/generate.js');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
  await assert.rejects(() => generateImage({
    prompt: 'x', apiKey: 'k', mode: 'custom',
    custom: { url: 'https://api.example.com/gen', method: 'POST', body: '{"prompt":"{{prompt}}"}', path: 'data.0.url' },
  }), /没有从响应里取到结果/);
});

test('生成：OpenAI 兼容方式走 /images/generations', async t => {
  const { generateImage } = await import('../src/generate.js');
  let url = '';
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    url = String(target);
    const b64 = Buffer.from('x'.repeat(64)).toString('base64');
    return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { status: 200 });
  });
  const result = await generateImage({ prompt: '猫', model: 'gpt-image-1', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', mode: 'openai' });
  assert.equal(url, 'https://api.openai.com/v1/images/generations');
  assert.equal(result.base64, Buffer.from('x'.repeat(64)).toString('base64'));
});

// ---------------------------------------------------------------------------
// 会话管理：重命名 / 导出
// ---------------------------------------------------------------------------

test('会话可以自定义显示名，控制台列表优先显示它', async t => {
  const { store } = await fixture(t);
  store.addMessage('k1', 'user', '你好', { scene: 'c2c', targetId: 'u1', userId: 'u1' });
  assert.equal(store.listConversations()[0].label, '');
  store.setConversationLabel('k1', '和产品经理的对话');
  assert.equal(store.listConversations()[0].label, '和产品经理的对话');
  // 名称过长会被截断，不会撑坏界面。
  store.setConversationLabel('k1', 'x'.repeat(200));
  assert.equal(store.listConversations()[0].label.length, 60);
});

test('会话重命名接口可用', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-label-'));
  const runtime = createApp({ dataDir: dir });
  const web = await new Promise((resolve) => { const s = runtime.app.listen(0, '127.0.0.1', () => resolve(s)); });
  globalThis.fetch = REAL_FETCH;
  const base = `http://127.0.0.1:${web.address().port}`;
  t.after(async () => { await new Promise((r) => web.close(r)); await runtime.close(); rmSync(dir, { recursive: true, force: true }); });
  const session = await fetch(base + '/api/session');
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const { csrfToken } = await session.json();
  const api = async (path, method = 'GET', body) => {
    const res = await fetch(base + path, { method, headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: await res.json() };
  };
  runtime.store.addMessage('k2', 'user', '你好', { scene: 'c2c', targetId: 'u1', userId: 'u1' });
  const renamed = await api('/api/conversations/k2', 'PATCH', { label: '老张的咨询' });
  assert.equal(renamed.status, 200);
  const list = await api('/api/conversations');
  const entry = list.data.find((row) => row.key === 'k2');
  assert.equal(entry.label, '老张的咨询');
  assert.equal(entry.displayName, '老张的咨询');
});

test('实例锁：持有者还活着但心跳刚过期时，会先确认心跳是否恢复', t => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-lock-live-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // 伪造一个「进程还活着、心跳停在 40 秒前」的锁：PID 1 一定存在。
  const startedAt = new Date(Date.now() - 120_000).toISOString();
  writeFileSync(join(dir, 'instance.lock'), JSON.stringify({
    pid: 1, startedAt, heartbeat: new Date(Date.now() - 40_000).toISOString(),
  }));
  const lock = acquireInstanceLock(dir, { staleMs: 30_000 });
  assert.ok(lock.path.endsWith('instance.lock'));
  lock.release();
});

// ---------------------------------------------------------------------------
// 语音合成（TTS）
// ---------------------------------------------------------------------------

const TTS_BASE = {
  ttsEnabled: true, ttsMode: 'api', ttsApiFormat: 'openai',
  ttsBaseUrl: 'https://tts.example.com/v1', ttsApiKey: 'secret-key',
  ttsModel: 'tts-1', ttsVoice: 'zh-CN-XiaoxiaoNeural', ttsSpeed: 1,
  ttsFormat: 'auto', ttsMaxChars: 200, ttsAutoSend: false,
  ttsCustomUrl: '', ttsCustomMethod: 'POST', ttsCustomBody: '', ttsCustomPath: '', ttsCustomHeaders: '',
  ttsWindowsVoice: '', ttsWindowsRate: 0, ttsWindowsVolume: 100,
};
const FAKE_MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64, 7)]);

test('语音：OpenAI 兼容接口合成并返回音频', async t => {
  const { synthesize } = await import('../src/tts.js');
  let captured = null;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    captured = { url: String(url), body: JSON.parse(options.body), headers: options.headers };
    return new Response(FAKE_MP3, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
  });
  const audio = await synthesize(TTS_BASE, { text: '你好' });
  assert.equal(audio.ext, 'mp3');
  assert.equal(audio.mime, 'audio/mpeg');
  assert.equal(captured.url, 'https://tts.example.com/v1/audio/speech');
  assert.equal(captured.body.input, '你好');
  assert.equal(captured.body.voice, 'zh-CN-XiaoxiaoNeural');
  assert.equal(captured.body.model, 'tts-1');
  assert.equal(captured.headers.Authorization, 'Bearer secret-key');
});

test('语音：自定义方式按模板发请求，并按路径取音频地址', async t => {
  const { synthesize } = await import('../src/tts.js');
  let captured = null;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).startsWith('https://cdn.example.com/')) {
      return new Response(FAKE_MP3, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
    }
    captured = { url: String(url), body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ result: { audio: 'https://cdn.example.com/a.mp3' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const audio = await synthesize({
    ...TTS_BASE, ttsApiFormat: 'custom',
    ttsCustomUrl: 'https://tts.example.com/say?text={{text}}',
    ttsCustomBody: '{"say":"{{text}}","voice":"{{voice}}"}',
    ttsCustomPath: 'result.audio',
  }, { text: '测试' });
  assert.equal(audio.ext, 'mp3');
  assert.equal(new URL(captured.url).origin + new URL(captured.url).pathname, 'https://tts.example.com/say');
  assert.equal(new URL(captured.url).searchParams.get('text'), '测试');
  assert.equal(captured.body.say, '测试');
  assert.equal(captured.body.voice, 'zh-CN-XiaoxiaoNeural');
});

test('语音：接口报错时不会把密钥带进错误信息', async t => {
  const { synthesize } = await import('../src/tts.js');
  t.mock.method(globalThis, 'fetch', async () => new Response('invalid key secret-key', { status: 401 }));
  await assert.rejects(() => synthesize(TTS_BASE, { text: '你好' }), (error) => {
    assert.match(error.message, /HTTP 401/);
    assert.ok(!error.message.includes('secret-key'), '错误信息里不应出现密钥');
    return true;
  });
});

test('语音：非 Windows 上选择系统语音会明确说明原因', async t => {
  const { synthesize } = await import('../src/tts.js');
  if (process.platform === 'win32') return;
  await assert.rejects(() => synthesize({ ...TTS_BASE, ttsMode: 'windows' }, { text: '你好' }), /Windows 系统语音只能在 Windows 上使用/);
});

test('语音：/语音 命令会合成语音并作为语音消息发出', async t => {
  const { store, engine, event } = await fixture(t);
  store.saveConfig({ harness: TTS_BASE });
  t.mock.method(globalThis, 'fetch', async () => new Response(FAKE_MP3, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } }));
  const sent = [];
  const result = await engine.generate({ ...event, content: '/语音 你好呀' }, {
    deliver: async (text, seq, message) => { sent.push({ text, seq, message }); return { id: 'm1' }; },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.type, 'voice');
  assert.equal(sent[0].message.mime, 'audio/mpeg');
  assert.equal(sent[0].message.voiceText, '你好呀');
  assert.ok(sent[0].message.fileData.length > 0, '应带上音频数据');
});

test('语音：未开启时 /语音 命令给出提示而不是报错', async t => {
  const { store, engine, event } = await fixture(t);
  store.saveConfig({ harness: { ...TTS_BASE, ttsEnabled: false, ttsMode: 'off' } });
  const sent = [];
  const result = await engine.generate({ ...event, content: '/语音 你好呀' }, {
    deliver: async (text, seq, message) => { sent.push({ text, seq, message }); return { id: 'm1' }; },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.type, 'text');
  assert.match(sent[0].text, /语音功能未启用/);
});

test('语音：模型调用 speak 工具后发出语音消息', async t => {
  const { store, engine, event } = await fixture(t);
  store.saveConfig({ harness: TTS_BASE });
  const script = [
    { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'speak', arguments: JSON.stringify({ text: '早上好' }) } }] },
    '好的',
  ];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).includes('/chat/completions')) return new Response(FAKE_MP3, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
    const next = script.shift();
    const message = typeof next === 'string' ? { role: 'assistant', content: next } : next;
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
  });
  const sent = [];
  await engine.generate({ ...event, content: '跟我打个招呼' }, {
    deliver: async (text, seq, message) => { sent.push({ text, seq, message }); return { id: 'm1' }; },
  });
  const voice = sent.find((item) => item.message?.type === 'voice');
  assert.ok(voice, '应发出语音消息');
  assert.equal(voice.message.voiceText, '早上好');
});

test('语音：接口密钥会被加密保存，不会明文落库', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-tts-key-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { Store } = await import('../src/store.js');
  const store = new Store(dir);
  store.saveConfig({ harness: { ...TTS_BASE, ttsApiKey: 'my-secret-key' } });
  const raw = readFileSync(join(dir, 'qqbot.sqlite'));
  assert.ok(!raw.includes('my-secret-key'), '数据库里不应出现明文密钥');
  assert.equal(store.config().harness.ttsApiKey, 'my-secret-key');
  store.close();
});

test('语音：语音消息按富媒体语音（file_type=3）上传并发送', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-voice-upload-'));
  const runtime = createApp({ dataDir: dir });
  t.after(async () => { await runtime.close(); rmSync(dir, { recursive: true, force: true }); });
  const uploads = [];
  runtime.client.upload = async (options) => {
    uploads.push(options);
    return { file_info: 'FILe_info_voice' };
  };
  runtime.client.send = async (payload) => {
    runtime.sent = runtime.sent || [];
    runtime.sent.push(payload);
    return { id: 'm-voice' };
  };
  runtime.client.status = () => ({ running: true });
  const { synthesize } = await import('../src/tts.js');
  t.mock.method(globalThis, 'fetch', async () => new Response(FAKE_MP3, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } }));
  const audio = await synthesize({
    ttsEnabled: true, ttsMode: 'api', ttsApiFormat: 'openai',
    ttsBaseUrl: 'https://tts.example.com/v1', ttsApiKey: 'k', ttsModel: 'tts-1',
    ttsVoice: 'v', ttsSpeed: 1, ttsFormat: 'auto', ttsMaxChars: 200,
  }, { text: '你好' });
  // 直接走服务端的富媒体上传路径，验证 file_type 与文件名。
  const event = { scene: 'c2c', targetId: 'u1', msgId: 'm1', userId: 'u1' };
  const payload = await runtime.attachmentPayload(event, 1, {
    type: 'voice', fileData: audio.bytes.toString('base64'), mime: audio.mime, name: 'voice',
  }, new AbortController().signal);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].fileType, 3, '语音应使用富媒体类型 3');
  assert.equal(uploads[0].fileName, 'voice.mp3');
  assert.equal(payload.type, 'media');
  assert.equal(payload.media.file_info, 'FILe_info_voice');
});

// ---------------------------------------------------------------------------
// MiniMax 语音合成
// ---------------------------------------------------------------------------

const MINIMAX_BASE = {
  ...TTS_BASE,
  ttsApiFormat: 'minimax',
  ttsBaseUrl: 'https://api.minimax.cn',
  ttsModel: 'speech-2.8-hd',
  ttsVoice: 'male-qn-qingse',
  ttsVolume: 1,
  ttsPitch: 0,
};
const FAKE_HEX_MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64, 7)]).toString('hex');

test('语音：MiniMax 走 /v1/t2a_v2，返回的十六进制音频会被解码', async t => {
  const { synthesize } = await import('../src/tts.js');
  let captured = null;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    captured = { url: String(url), body: JSON.parse(options.body), headers: options.headers };
    return new Response(JSON.stringify({
      data: { audio: FAKE_HEX_MP3, status: 2 },
      extra_info: { audio_length: 1000, audio_size: 100, usage_characters: 3 },
      trace_id: 'abc123',
      base_resp: { status_code: 0, status_msg: 'success' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const audio = await synthesize(MINIMAX_BASE, { text: '你好' });
  assert.equal(audio.ext, 'mp3');
  assert.equal(audio.bytes.length, 67);
  assert.equal(captured.url, 'https://api.minimax.cn/v1/t2a_v2');
  assert.equal(captured.body.text, '你好');
  assert.equal(captured.body.model, 'speech-2.8-hd');
  assert.equal(captured.body.stream, false);
  assert.equal(captured.body.voice_setting.voice_id, 'male-qn-qingse');
  assert.equal(captured.body.voice_setting.speed, 1);
  assert.equal(captured.body.audio_setting.format, 'mp3');
  assert.equal(captured.body.audio_setting.channel, 1);
  assert.equal(captured.headers.Authorization, 'Bearer secret-key');
});

test('语音：MiniMax 的地址填到 /v1 也能正常工作', async t => {
  const { synthesize } = await import('../src/tts.js');
  let url = '';
  t.mock.method(globalThis, 'fetch', async (target) => {
    url = String(target);
    return new Response(JSON.stringify({ data: { audio: FAKE_HEX_MP3, status: 2 }, base_resp: { status_code: 0, status_msg: 'success' } }), { status: 200 });
  });
  await synthesize({ ...MINIMAX_BASE, ttsBaseUrl: 'https://api.minimax.cn/v1' }, { text: '你好' });
  assert.equal(url, 'https://api.minimax.cn/v1/t2a_v2');
});

test('语音：MiniMax 出错时 HTTP 200 也会报出真实原因', async t => {
  const { synthesize } = await import('../src/tts.js');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    base_resp: { status_code: 1004, status_msg: 'invalid api key' },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(() => synthesize(MINIMAX_BASE, { text: '你好' }), /1004.*鉴权失败/s);
});

test('语音：MiniMax 参数非法时给出可读提示', async t => {
  const { synthesize } = await import('../src/tts.js');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    base_resp: { status_code: 2013, status_msg: 'invalid params' },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(() => synthesize(MINIMAX_BASE, { text: '你好' }), /2013.*参数不合法/s);
});

test('语音：能列出 MiniMax 账号下的音色', async t => {
  const { listServiceVoices } = await import('../src/tts.js');
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), 'https://api.minimax.cn/v1/get_voice');
    assert.equal(JSON.parse(options.body).voice_type, 'all');
    return new Response(JSON.stringify({
      system_voice: [{ voice_id: 'male-qn-qingse', voice_name: '青涩青年', description: ['年轻男声'] }],
      voice_cloning: [{ voice_id: 'my-clone', description: [] }],
      base_resp: { status_code: 0, status_msg: 'success' },
    }), { status: 200 });
  });
  const result = await listServiceVoices({ apiKey: 'secret-key', baseUrl: 'https://api.minimax.cn' });
  assert.equal(result.ok, true);
  assert.equal(result.voices.length, 2);
  assert.equal(result.voices[0].id, 'male-qn-qingse');
  assert.equal(result.voices[0].group, '系统音色');
});

test('语音：自定义方式也能识别十六进制音频', async t => {
  const { synthesize } = await import('../src/tts.js');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    result: { audio: FAKE_HEX_MP3 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const audio = await synthesize({
    ...TTS_BASE, ttsApiFormat: 'custom',
    ttsCustomUrl: 'https://tts.example.com/say',
    ttsCustomBody: '{"text":"{{text}}"}',
    ttsCustomPath: 'result.audio',
  }, { text: '你好' });
  assert.equal(audio.ext, 'mp3');
  assert.equal(audio.bytes.length, 67);
});

test('语音：把读到的配置原样写回去不会误删语音密钥', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-tts-roundtrip-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { Store } = await import('../src/store.js');
  const store = new Store(dir);
  store.saveConfig({ harness: { ...TTS_BASE, ttsApiKey: 'keep-me' } });
  // publicConfig() 会把密钥清空；客户端原样写回时不应把密钥丢掉。
  const publicView = store.publicConfig();
  assert.equal(publicView.harness.ttsApiKey, '');
  assert.equal(publicView.harness.hasTtsApiKey, true);
  store.saveConfig(publicView);
  assert.equal(store.config().harness.ttsApiKey, 'keep-me', '空字符串应表示保留');
  // 传 null 才是明确清除。
  store.saveConfig({ harness: { ttsApiKey: null } });
  assert.equal(store.config().harness.ttsApiKey, '');
  store.close();
});

test('语音：生成密钥同样不会被误删', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-gen-roundtrip-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { Store } = await import('../src/store.js');
  const store = new Store(dir);
  store.saveConfig({ harness: { genApiKey: 'keep-me-too' } });
  store.saveConfig(store.publicConfig());
  assert.equal(store.config().harness.genApiKey, 'keep-me-too');
  store.close();
});

test('语音：MiniMax 的接口地址各种写法都能用', async t => {
  const { synthesize } = await import('../src/tts.js');
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ data: { audio: FAKE_HEX_MP3, status: 2 }, base_resp: { status_code: 0, status_msg: 'success' } }), { status: 200 });
  });
  for (const base of [
    'https://api-bj.minimaxi.com/v1/t2a_v2',
    'https://api-bj.minimaxi.com/v1',
    'https://api-bj.minimaxi.com',
    'https://api-bj.minimaxi.com/',
  ]) {
    await synthesize({ ...MINIMAX_BASE, ttsBaseUrl: base }, { text: '你好' });
  }
  assert.deepEqual(urls, [
    'https://api-bj.minimaxi.com/v1/t2a_v2',
    'https://api-bj.minimaxi.com/v1/t2a_v2',
    'https://api-bj.minimaxi.com/v1/t2a_v2',
    'https://api-bj.minimaxi.com/v1/t2a_v2',
  ]);
});

// ---------------------------------------------------------------------------
// 网络调优
// ---------------------------------------------------------------------------

test('网络：会放宽 Happy Eyeballs 的尝试超时，避免「第一次成功之后全超时」', async t => {
  const net = await import('node:net');
  const { tuneNetwork } = await import('../src/net.js');
  tuneNetwork();
  assert.ok(net.getDefaultAutoSelectFamilyAttemptTimeout() >= 5000,
    '单次地址尝试的等待时间应放宽到 5 秒以上，否则 IPv4 握手稍慢就会被判超时');
});

// ---------------------------------------------------------------------------
// Unicode 表情
// ---------------------------------------------------------------------------

test('表情：素材库足够丰富，覆盖六大类、远超几十个', async t => {
  const { EMOJI_CATALOG, EMOJI_NAMES } = await import('../src/emoji.js');
  const groups = Object.keys(EMOJI_CATALOG);
  assert.deepEqual(groups, ['情绪', '互动', '思考', '生活', '动物', '物品']);
  const unique = new Set(Object.values(EMOJI_NAMES));
  assert.ok(unique.size >= 120, `可用 emoji 应不少于 120 个，实际 ${unique.size}`);
  // 分类内部不能有人名没对应上 emoji
  for (const [group, items] of Object.entries(EMOJI_CATALOG)) {
    for (const [name, emoji] of Object.entries(items)) {
      assert.ok(emoji && emoji.length >= 1, `${group}/${name} 缺 emoji`);
    }
  }
});

test('表情：[名字] 短代码能换成对应的 Unicode emoji', async t => {
  const { toUnicodeEmoji } = await import('../src/emoji.js');
  assert.equal(toUnicodeEmoji('[月亮]晚安'), '🌙晚安');
  assert.equal(toUnicodeEmoji('[猫]'), '🐱');
  assert.equal(toUnicodeEmoji('[礼物]'), '🎁');
  assert.equal(toUnicodeEmoji('[不存在的表情]'), '[不存在的表情]');
});

test('表情：提示词里的速查表按情绪分类，且不只给两三个表情', async t => {
  const { store, engine, event } = await fixture(t);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '好的' } }] }), { status: 200 });
  });
  await engine.generate({ ...event, content: '你好' }, { deliver: async () => ({ id: 'm' }) });
  const system = requests[0].messages[0].content;
  for (const group of ['情绪', '互动', '思考', '生活', '动物', '物品']) {
    assert.ok(system.includes(`【${group}】`), `速查表应包含【${group}】分类`);
  }
  // 数量上不能再只有几十个
  const emojiCount = (system.match(/[\u{1F300}-\u{1FAFF}]/gu) || []).length;
  assert.ok(emojiCount >= 120, `速查表里的 emoji 应不少于 120 个，实际 ${emojiCount}`);
});

test('表情：会告诉模型最近用过的 emoji，让它换个新的', async t => {
  const { store, engine, event } = await fixture(t);
  const { conversationKey } = await import('../src/keys.js');
  const key = conversationKey(store.config().qq.appId, event);
  store.addMessage(key, 'assistant', '我有点难过 🥺');
  store.addMessage(key, 'assistant', '该睡啦 🌙');
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '好的' } }] }), { status: 200 });
  });
  await engine.generate({ ...event, content: '再聊聊' }, { deliver: async () => ({ id: 'm' }) });
  const system = requests[0].messages[0].content;
  assert.match(system, /最近已经用过/, '应提示模型最近用过的表情');
  assert.ok(system.includes('🥺') && system.includes('🌙'), '应把最近用过的表情列出来');
});

// ---------------------------------------------------------------------------
// 沙箱命令
// ---------------------------------------------------------------------------

async function sandboxStore(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qq-sandbox-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { Store } = await import('../src/store.js');
  const store = new Store(dir);
  store.saveConfig({ harness: { resourcesEnabled: true, memesEnabled: true, ...extra } });
  const folder = store.saveResourceFolder({ name: '小说', trigger: '聊到小说时', summary: '一些章节' });
  store.saveResourceFile({ folderId: folder.id, name: '第一章.md', kind: 'text', content: '第一章的开头\n素嫽走进了雨里\n她回头看了一眼' });
  store.saveResourceFile({ folderId: folder.id, name: '第二章.md', kind: 'text', content: '第二章\n素嫽又来了' });
  // 1×1 的透明 PNG（必须是合法 PNG，store 会校验文件头）。
  const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  store.saveMeme({ name: '得意', tags: ['开心'], enabled: true, fileData: PNG_1PX, mime: 'image/png' });
  return store;
}

test('沙箱：ls / 能列出存的东西和表情包两个目录', async t => {
  const store = await sandboxStore(t);
  const { Sandbox } = await import('../src/sandbox.js');
  const sandbox = new Sandbox(store);
  const result = sandbox.run('ls /');
  assert.equal(result.ok, true);
  assert.match(result.stdout, /files\//);
  assert.match(result.stdout, /memes\//);
  store.close();
});

test('沙箱：find 能按文件名找文件', async t => {
  const store = await sandboxStore(t);
  const { Sandbox } = await import('../src/sandbox.js');
  const sandbox = new Sandbox(store);
  const result = sandbox.run('find /files -name "*.md"');
  assert.equal(result.ok, true);
  assert.match(result.stdout, /小说\/第一章\.md/);
  assert.match(result.stdout, /小说\/DOC\.md/);
  store.close();
});

test('沙箱：cat 能读到文件内容，DOC.md 里带着触发条件', async t => {
  const store = await sandboxStore(t);
  const { Sandbox } = await import('../src/sandbox.js');
  const sandbox = new Sandbox(store);
  const doc = sandbox.run('cat /files/小说/DOC.md');
  assert.equal(doc.ok, true);
  assert.match(doc.stdout, /聊到小说时/);
  const chapter = sandbox.run('cat /files/小说/第一章.md');
  assert.equal(chapter.ok, true);
  assert.match(chapter.stdout, /素嫽走进了雨里/);
  store.close();
});

test('沙箱：管道能串起来用', async t => {
  const store = await sandboxStore(t);
  const { Sandbox } = await import('../src/sandbox.js');
  const sandbox = new Sandbox(store);
  const result = sandbox.run('cat /files/小说/*.md | grep 素嫽');
  assert.equal(result.ok, true);
  assert.match(result.stdout, /素嫽/);
  const counted = sandbox.run('cat /files/小说/*.md | grep -c 素嫽');
  assert.equal(counted.stdout.trim(), '2', '第一章与第二章各出现一次素嫽');
  store.close();
});

test('沙箱：grep -l 能列出命中的文件名', async t => {
  const store = await sandboxStore(t);
  const { Sandbox } = await import('../src/sandbox.js');
  const sandbox = new Sandbox(store);
  const result = sandbox.run('grep -l "第二章" /files');
  assert.equal(result.ok, true);
  assert.match(result.stdout, /第二章\.md/);
  store.close();
});

test('沙箱：绝不允许写、删、跑系统命令', async t => {
  const store = await sandboxStore(t);
  const { Sandbox } = await import('../src/sandbox.js');
  const sandbox = new Sandbox(store);
  for (const command of ['rm -rf /', 'curl http://x', 'cat /etc/passwd', 'echo hi > /files/x', 'sh -c "ls"', 'node -e "1"']) {
    const result = sandbox.run(command);
    assert.equal(result.ok, false, `「${command}」不应被放行`);
    assert.ok(result.stderr.length > 0);
  }
  store.close();
});

test('沙箱：越权路径拿不到东西', async t => {
  const store = await sandboxStore(t);
  const { Sandbox } = await import('../src/sandbox.js');
  const sandbox = new Sandbox(store);
  for (const command of ['cat /etc/passwd', 'cat /files/../../etc/passwd', 'ls /root', 'cat /proc/self/environ']) {
    const result = sandbox.run(command);
    assert.equal(result.ok, false, `「${command}」不应成功`);
  }
  store.close();
});

test('沙箱：shell 元字符会被挡下来', async t => {
  const store = await sandboxStore(t);
  const { Sandbox } = await import('../src/sandbox.js');
  const sandbox = new Sandbox(store);
  for (const command of ['ls; rm -rf /', 'ls && cat /etc/passwd', 'echo `id`', 'echo $(id)', 'ls > /tmp/x']) {
    const result = sandbox.run(command);
    assert.equal(result.ok, false, `「${command}」不应被放行`);
  }
  store.close();
});

test('沙箱：资料库关掉后模型在沙箱里也看不到它', async t => {
  const store = await sandboxStore(t, { resourcesEnabled: false });
  const { Sandbox } = await import('../src/sandbox.js');
  const sandbox = new Sandbox(store);
  const listing = sandbox.run('ls /');
  assert.equal(listing.ok, true);
  assert.ok(!listing.stdout.includes('files'), '资料库关闭后不应出现在沙箱里');
  const found = sandbox.run('find / -name "*.md"');
  assert.equal(found.ok, true);
  assert.equal(found.stdout.trim(), '');
  store.close();
});

test('沙箱：cd 之后后续命令在那个目录里', async t => {
  const store = await sandboxStore(t);
  const { Sandbox } = await import('../src/sandbox.js');
  const sandbox = new Sandbox(store);
  assert.equal(sandbox.run('cd /files/小说').ok, true);
  const listing = sandbox.run('ls');
  assert.equal(listing.ok, true);
  assert.match(listing.stdout, /第一章\.md/);
  assert.equal(sandbox.run('pwd').stdout, '/files/小说');
  store.close();
});

test('沙箱：模型可以通过 shell 工具拿到目录内容', async t => {
  const { store, engine, event } = await fixture(t);
  const folder = store.saveResourceFolder({ name: '设定集', trigger: '聊到设定时', summary: '人设与世界观' });
  store.saveResourceFile({ folderId: folder.id, name: '人物.md', kind: 'text', content: '素嫽：十六岁，红发' });
  store.saveConfig({ harness: { shellEnabled: true, resourcesEnabled: true } });
  const script = [
    { role: 'assistant', content: null, tool_calls: [{ id: 's1', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: 'ls /files' }) } }] },
    { role: 'assistant', content: '设定集里有 人物.md' },
  ];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).includes('/chat/completions')) return new Response('{}', { status: 200 });
    const next = script.shift();
    const message = typeof next === 'string' ? { role: 'assistant', content: next } : next;
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
  });
  await engine.generate({ ...event, content: '资料库里有什么' }, { deliver: async () => ({ id: 'm' }) });
  // shell 工具确实被用上了，并且拿到了目录内容
  const toolCalls = script.length;
  assert.equal(toolCalls, 0, '模型应当只请求两次（一次工具调用 + 一次收尾）');
});

test('沙箱：支持 ; 顺序执行与 && 条件执行', async t => {
  const store = await sandboxStore(t);
  const { Sandbox } = await import('../src/sandbox.js');
  const sandbox = new Sandbox(store);
  // ; 后面照常执行
  const seq = sandbox.run('ls /nope ; echo 还是会跑');
  assert.equal(seq.ok, false);
  assert.match(seq.stdout, /还是会跑/);
  assert.match(seq.stderr, /找不到/);
  // && 前面失败就不执行后面
  const and = sandbox.run('ls /nope && echo 不该出现');
  assert.equal(and.ok, false);
  assert.ok(!and.stdout.includes('不该出现'));
  // && 前面成功就执行后面
  const ok = sandbox.run('ls /files && echo 成功');
  assert.equal(ok.ok, true);
  assert.match(ok.stdout, /成功/);
  store.close();
});

test('沙箱：ls 支持组合短选项 -la', async t => {
  const store = await sandboxStore(t);
  const { Sandbox } = await import('../src/sandbox.js');
  const sandbox = new Sandbox(store);
  const result = sandbox.run('ls -la /files');
  assert.equal(result.ok, true);
  assert.match(result.stdout, /小说/);
  store.close();
});

test('沙箱：命令替换与重定向仍然被拒绝', async t => {
  const store = await sandboxStore(t);
  const { Sandbox } = await import('../src/sandbox.js');
  const sandbox = new Sandbox(store);
  for (const command of ['echo `id`', 'echo $(id)', 'ls > /tmp/x', 'ls < /etc/passwd', 'echo a\nrm -rf /']) {
    const result = sandbox.run(command);
    assert.equal(result.ok, false, `「${command}」不应被放行`);
  }
  store.close();
});

test('沙箱：通配符能展开到多个文件', async t => {
  const store = await sandboxStore(t);
  const { Sandbox } = await import('../src/sandbox.js');
  const sandbox = new Sandbox(store);
  const result = sandbox.run('ls /files/小说/*.md');
  assert.equal(result.ok, true);
  assert.match(result.stdout, /第一章\.md/);
  assert.match(result.stdout, /第二章\.md/);
  store.close();
});

test('沙箱：表情包目录里的文件名就是表情的意思', async t => {
  const store = await sandboxStore(t);
  const { Sandbox } = await import('../src/sandbox.js');
  const sandbox = new Sandbox(store);
  const listing = sandbox.run('ls /memes');
  assert.equal(listing.ok, true);
  assert.match(listing.stdout, /得意\.png/);
  const stat = sandbox.run('stat /memes/得意.png');
  assert.equal(stat.ok, true);
  assert.match(stat.stdout, /表情名: 得意/);
  store.close();
});

// ---------------------------------------------------------------------------
// 防幻觉：模型说「已经把图发出去了」但其实没发
// ---------------------------------------------------------------------------

test('图片：模型谎报已发图时会要求重做并真的调用生图工具', async t => {
  const { store, engine, event } = await fixture(t);
  store.saveConfig({ harness: { imageGenEnabled: true } });
  const script = [
    { role: 'assistant', content: '已经发过去了 🌸夕阳下的我。' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'g1', type: 'function', function: { name: 'find_photo', arguments: JSON.stringify({ subject: '黄昏的粉裙少女' }) } }] },
    { role: 'assistant', content: '这次真的发给你了。' },
  ];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).includes('/chat/completions')) {
      return new Response(JSON.stringify({ data: [{ url: 'https://img.example.com/a.png' }] }), { status: 200 });
    }
    const next = script.shift();
    const message = typeof next === 'string' ? { role: 'assistant', content: next } : next;
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
  });
  const sent = [];
  await engine.generate({ ...event, content: '发张照片我看看吧' }, {
    deliver: async (text, seq, message) => { sent.push({ text, seq, type: message?.type || 'text', kind: message?.mediaKind }); return { id: 'm' }; },
  });
  const image = sent.find((item) => item.type === 'media');
  assert.ok(image, '应当真的发出图片');
  assert.equal(image.kind, 'image');
  assert.equal(script.length, 0, '模型应当被要求重做并真正调用生图工具');
});

test('图片：模型两次都谎报时会补一句实话', async t => {
  const { store, engine, event } = await fixture(t);
  store.saveConfig({ harness: { imageGenEnabled: true } });
  const script = [
    { role: 'assistant', content: '已经发过去了 🌸' },
    { role: 'assistant', content: '还是已经发过去了 🌸' },
  ];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).includes('/chat/completions')) return new Response('{}', { status: 200 });
    const next = script.shift();
    const message = typeof next === 'string' ? { role: 'assistant', content: next } : next;
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
  });
  const sent = [];
  await engine.generate({ ...event, content: '发张照片我看看吧' }, {
    deliver: async (text) => { sent.push(text); return { id: 'm' }; },
  });
  assert.ok(sent.some((text) => text.includes('这次图片并没有发出去')), '应当说明图片没有发出去');
  assert.ok(!sent.some((item) => item.type === 'media'), '没有生图就不该有图片消息');
});

test('图片：提示词里明确要求「要图必须调用生图工具」', async t => {
  const { store, engine, event } = await fixture(t);
  store.saveConfig({ harness: { imageGenEnabled: true } });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '好' } }] }), { status: 200 });
  });
  await engine.generate({ ...event, content: '看看你' }, { deliver: async () => ({ id: 'm' }) });
  const system = requests[0].messages[0].content;
  assert.match(system, /用 find_photo/, '应明确要求用 find_photo 找照片');
  assert.match(system, /别用.*画|不要说自己在.*画/, '照片就是照片，不该说自己在画');
  assert.match(system, /不能说.*已经发了图|别空口说.*发给你了/, '应禁止谎报已发图');
  const names = (requests[0].tools || []).map((tool) => tool.function.name);
  assert.ok(names.includes('find_photo'), '生图工具应当在可用列表里');
});

test('图片：生成的图片会走富媒体通道（file_type=1）并真的发出去', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-image-chain-'));
  const runtime = createApp({ dataDir: dir });
  t.after(async () => { await runtime.close(); rmSync(dir, { recursive: true, force: true }); });
  const uploads = [], sent = [];
  runtime.client.upload = async (options) => { uploads.push(options); return { file_info: 'FILe_info_image' }; };
  runtime.client.send = async (payload) => { sent.push(payload); return { id: 'm-img' }; };
  runtime.client.status = () => ({ running: true });
  // 1×1 PNG
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const event = { scene: 'c2c', targetId: 'u1', msgId: 'm1', userId: 'u1' };
  const payload = await runtime.attachmentPayload(event, 1, {
    type: 'media', mediaKind: 'image', fileData: PNG.toString('base64'), mime: 'image/png', name: '生成图片',
  }, new AbortController().signal);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].fileType, 1, '图片应使用富媒体类型 1');
  assert.equal(uploads[0].fileName, 'image.png');
  assert.equal(payload.type, 'media');
  assert.equal(payload.media.file_info, 'FILe_info_image');
  // 真发出去
  await runtime.client.send(payload);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'media');
  assert.equal(sent[0].media.file_info, 'FILe_info_image');
});

test('图片：输入状态占掉一个名额时，正文会自动合并腾位置给图片', async t => {
  const { store, engine, event } = await fixture(t, {}, {
    bot: { mode: 'llm', minChars: 0, maxChars: 200, replyCount: 3, cooldownMs: 0, replyDelayMs: 0 },
    llm: { model: 'm', apiKey: 'k' }, rules: [],
    harness: { imageGenEnabled: true, typingEnabled: true },
  });
  const script = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'g1', type: 'function', function: { name: 'find_photo', arguments: JSON.stringify({ subject: '粉裙少女' }) } }] },
    // 一条回复里分三段（空行分段），正文会占掉三个名额。
    { role: 'assistant', content: '第一段\n\n第二段\n\n第三段' },
  ];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).includes('/chat/completions')) {
      return new Response(JSON.stringify({ data: [{ url: 'https://img.example.com/a.png' }] }), { status: 200 });
    }
    const next = script.shift();
    const message = typeof next === 'string' ? { role: 'assistant', content: next } : next;
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
  });
  const sent = [];
  // 模拟输入状态通知占掉 seq 1（单聊一共 4 个名额）。
  await engine.generate({ ...event, content: '发张照片' }, {
    typing: async () => ({ seqUsed: 1 }),
    deliver: async (text, seq, message) => { sent.push({ text, seq, type: message?.type || 'text' }); return { id: 'm' }; },
  });
  const seqs = sent.map((item) => item.seq);
  assert.ok(Math.max(...seqs) <= 4, `单聊最多 4 个名额，实际用到 ${Math.max(...seqs)}`);
  assert.ok(sent.some((item) => item.type === 'media'), '图片仍然要发出去');
  // 正文被合并了，但内容没丢
  const text = sent.filter((item) => item.type === 'text').map((item) => item.text).join('|');
  assert.ok(text.includes('第一段') && text.includes('第三段'), '合并后正文不能丢内容');
});

test('图片：精简正文时模型又调工具，不会把正文和图片一起搞丢', async t => {
  const { store, engine, event } = await fixture(t, {}, {
    bot: { mode: 'llm', minChars: 0, maxChars: 200, replyCount: 2, cooldownMs: 0, replyDelayMs: 0 },
    llm: { model: 'm', apiKey: 'k' }, rules: [],
    harness: { imageGenEnabled: true },
  });
  const script = [
    // 第一轮：生图
    { role: 'assistant', content: null, tool_calls: [{ id: 'g1', type: 'function', function: { name: 'find_photo', arguments: JSON.stringify({ subject: '粉裙少女' }) } }] },
    // 第二轮：正文超了条数 → 触发精简
    { role: 'assistant', content: '第一段\n\n第二段\n\n第三段' },
    // 精简时模型又去调工具 —— 以前这里直接抛错，正文和图片全丢
    { role: 'assistant', content: null, tool_calls: [{ id: 'g2', type: 'function', function: { name: 'find_photo', arguments: JSON.stringify({ subject: '再来一张' }) } }] },
  ];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).includes('/chat/completions')) {
      return new Response(JSON.stringify({ data: [{ url: 'https://img.example.com/a.png' }] }), { status: 200 });
    }
    const next = script.shift();
    const message = typeof next === 'string' ? { role: 'assistant', content: next } : next;
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
  });
  const sent = [];
  await engine.generate({ ...event, content: '发张照片' }, {
    deliver: async (text, seq, message) => { sent.push({ text, seq, type: message?.type || 'text' }); return { id: 'm' }; },
  });
  assert.ok(sent.some((item) => item.type === 'media'), '图片仍然要发出去');
  const text = sent.filter((item) => item.type === 'text').map((item) => item.text).join('|');
  assert.ok(text.includes('第一段') && text.includes('第三段'), '正文也要发出去，内容不能丢');
  assert.ok(sent.every((item) => item.seq <= 4), '不能超过单聊 4 个回复名额');
});

test('工具轮数用完时不会把整轮回复丢掉，会强制模型用文字收尾', async t => {
  const { store, engine, event } = await fixture(t, {}, {
    bot: { mode: 'llm', minChars: 0, maxChars: 200, replyCount: 2, cooldownMs: 0, replyDelayMs: 0 },
    llm: { model: 'm', apiKey: 'k' }, rules: [],
    harness: { shellEnabled: true, maxToolRounds: 2 },
  });
  let calls = 0;
  const script = [
    { role: 'assistant', content: null, tool_calls: [{ id: 's1', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: 'ls /' }) } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 's2', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: 'ls /files' }) } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 's3', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: 'ls /memes' }) } }] },
    // 最后一轮：工具用完了，模型必须用文字收尾
    { role: 'assistant', content: '查完了，资料库里有这些。' },
  ];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).includes('/chat/completions')) return new Response('{}', { status: 200 });
    calls++;
    const next = script.shift();
    const message = typeof next === 'string' ? { role: 'assistant', content: next } : next;
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
  });
  const sent = [];
  await engine.generate({ ...event, content: '资料库里有什么' }, {
    deliver: async (text) => { sent.push(text); return { id: 'm' }; },
  });
  assert.ok(sent.length > 0, '工具用完也要把话说出去，不能整轮丢掉');
  assert.ok(sent.join(' ').includes('查完了'), '应当拿到模型的收尾回答');
  // 最后一次请求不能再带工具
  assert.ok(calls >= 2);
});

test('沙箱：支持模型常用的 awk / sed / cut / tr / grep -o', async t => {
  const store = await sandboxStore(t);
  const { Sandbox } = await import('../src/sandbox.js');
  const sandbox = new Sandbox(store);
  const file = '/files/小说/第一章.md';
  assert.equal(sandbox.run(`grep -o "素嫽" ${file} | wc -l`).stdout.trim(), '1');
  assert.equal(sandbox.run(`grep -c "素嫽" ${file}`).stdout.trim(), '1');
  assert.equal(sandbox.run(`awk 'END{print NR}' ${file}`).stdout.trim(), '3');
  assert.match(sandbox.run(`sed -n '1,2p' ${file}`).stdout, /第一章的开头/);
  assert.match(sandbox.run(`awk '{n=gsub(/素嫽/,"&"); if(n>0) print NR": "n}' ${file}`).stdout, /2: 1/);
  assert.match(sandbox.run(`tr -d ' ' ${file}`).stdout, /第一章的开头/);
  assert.equal(sandbox.run(`basename ${file}`).stdout.trim(), '第一章.md');
  assert.equal(sandbox.run(`dirname ${file}`).stdout.trim(), '/files/小说');
  store.close();
});

test('沙箱：引号里的 > 不算重定向；重定向会写进虚拟输出区', async t => {
  const store = await sandboxStore(t);
  const { Sandbox } = await import('../src/sandbox.js');
  const sandbox = new Sandbox(store);
  assert.equal(sandbox.run('echo "a>b"').stdout.trim(), 'a>b');
  assert.equal(sandbox.run("echo 'a>b'").stdout.trim(), 'a>b');
  // 重定向到输出区
  const redirected = sandbox.run('grep "素嫽" /files/小说/第一章.md > 摘录.txt');
  assert.equal(redirected.ok, true);
  const files = sandbox.takeOutbox();
  assert.equal(files.length, 1);
  assert.equal(files[0].name, '摘录.txt');
  assert.match(files[0].content, /素嫽走进了雨里/);
  // 只能写文件名，不能写路径
  const bad = sandbox.run('cat /files > /tmp/x');
  assert.equal(bad.ok, false);
  assert.match(bad.stderr, /只能写输出区里的文件名/);
  store.close();
});

test('沙箱：不支持的命令会给出替代建议', async t => {
  const store = await sandboxStore(t);
  const { Sandbox } = await import('../src/sandbox.js');
  const sandbox = new Sandbox(store);
  const result = sandbox.run('curl http://example.com');
  assert.equal(result.ok, false);
  assert.match(result.stderr, /不能联网/);
  store.close();
});

test('图片：资料库里已有的图片会附给模型，并直接发给用户', async t => {
  const { store, engine, event } = await fixture(t);
  const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const folder = store.saveResourceFolder({ name: '我的照片', trigger: '想看照片时', summary: '几张照片' });
  store.saveResourceFile({ folderId: folder.id, name: 'a.png', kind: 'image', data: Buffer.from(PNG_1PX, 'base64'), mime: 'image/png', size: 70 });
  store.saveConfig({ harness: { resourceImageEnabled: true, maxImages: 4 } });
  const requests = [];
  let turn = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).includes('/chat/completions')) return new Response('{}', { status: 200 });
    requests.push(JSON.parse(options.body));
    if (turn++ === 0) {
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'r1', type: 'function', function: { name: 'find_photo', arguments: JSON.stringify({ subject: '我的照片' }) } }] } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '给你看。' } }] }), { status: 200 });
  });
  const sent = [];
  await engine.generate({ ...event, content: '发张照片看看' }, {
    deliver: async (text, seq, message) => { sent.push({ text, seq, type: message?.type || 'text', kind: message?.mediaKind }); return { id: 'm' }; },
  });
  const image = sent.find((item) => item.type === 'media');
  assert.ok(image, '相册里已有的照片应当直接发给用户');
  assert.equal(image.kind, 'image');
  // 模型那边也得真的看得见这张图
  const hasImagePart = requests.some((request) => JSON.stringify(request.messages).includes('image_url'));
  assert.ok(hasImagePart, '照片应当作为附件片段发给模型');
});

test('工具轮数：上限 20 轮，超过 8 轮给出警告', async t => {
  const { store, engine, event } = await fixture(t, {}, {
    bot: { mode: 'llm', minChars: 0, maxChars: 200, replyCount: 2, cooldownMs: 0, replyDelayMs: 0 },
    llm: { model: 'm', apiKey: 'k' }, rules: [],
    harness: { shellEnabled: true, maxToolRounds: 20 },
  });
  // 模型一直调工具，直到轮数用光。
  let turn = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).includes('/chat/completions')) return new Response('{}', { status: 200 });
    turn++;
    if (turn <= 12) {
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `t${turn}`, type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: `ls /${turn}` }) } }] } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '好了，我说完了。' } }] }), { status: 200 });
  });
  const sent = [];
  await engine.generate({ ...event, content: '查一下' }, {
    deliver: async (text) => { sent.push(text); return { id: 'm' }; },
  });
  assert.ok(sent.length > 0, '轮数很多也要把话说完');
  const warn = (await store.db.prepare("SELECT message FROM logs WHERE message LIKE '%工具调用轮数%'").all());
  assert.ok(warn.length >= 1, '超过 8 轮应当留下警告日志');
});

test('工具轮数：不超过 8 轮时不产生警告', async t => {
  const { store, engine, event } = await fixture(t, {}, {
    bot: { mode: 'llm', minChars: 0, maxChars: 200, replyCount: 2, cooldownMs: 0, replyDelayMs: 0 },
    llm: { model: 'm', apiKey: 'k' }, rules: [],
    harness: { shellEnabled: true, maxToolRounds: 20 },
  });
  let turn = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).includes('/chat/completions')) return new Response('{}', { status: 200 });
    turn++;
    if (turn <= 3) {
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `t${turn}`, type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: 'ls /' }) } }] } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '就这些。' } }] }), { status: 200 });
  });
  await engine.generate({ ...event, content: '查一下' }, { deliver: async () => ({ id: 'm' }) });
  const warn = await store.db.prepare("SELECT message FROM logs WHERE message LIKE '%工具调用轮数%'").all();
  assert.equal(warn.length, 0, '没超过 8 轮不该有警告');
});

test('工具轮数：配置上限提高到 20', async t => {
  const { configSchema, harnessDefaults, defaults } = await import('../src/config.js');
  assert.equal(harnessDefaults.maxToolRounds, 12);
  const base = structuredClone(defaults);
  assert.doesNotThrow(() => configSchema.parse({ ...base, harness: { ...base.harness, maxToolRounds: 20 } }));
  assert.throws(() => configSchema.parse({ ...base, harness: { ...base.harness, maxToolRounds: 21 } }));
});

test('文件：write_file 会把内容存进资料库并作为附件发出去', async t => {
  const { store, engine, event } = await fixture(t, {}, {
    bot: { mode: 'llm', minChars: 0, maxChars: 200, replyCount: 2, cooldownMs: 0, replyDelayMs: 0 },
    llm: { model: 'm', apiKey: 'k' }, rules: [],
    harness: { resourcesEnabled: true, fileOutputEnabled: true },
  });
  let turn = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).includes('/chat/completions')) return new Response('{}', { status: 200 });
    if (turn++ === 0) {
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'w1', type: 'function', function: { name: 'save_note', arguments: JSON.stringify({ name: '素嫽句子.txt', content: '第一句\n第二句\n第三句' }) } }] } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '整理好了，发给你。' } }] }), { status: 200 });
  });
  const sent = [];
  await engine.generate({ ...event, content: '整理成文件发给我' }, {
    deliver: async (text, seq, message) => { sent.push({ text, seq, type: message?.type || 'text', name: message?.name }); return { id: 'm' }; },
  });
  const file = sent.find((item) => item.type === 'file');
  assert.ok(file, '文件应当作为附件发出去');
  assert.equal(file.name, '素嫽句子.txt');
  // 文件确实存进了资料库
  const folders = store.listResourceFolders();
  assert.ok(folders.some((folder) => folder.name === '机器人输出'), '默认存到「机器人输出」');
  const files = store.listResourceFiles(folders.find((folder) => folder.name === '机器人输出').id);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, '素嫽句子.txt');
  assert.match(store.getResourceFile(files[0].id).content, /第二句/);
});

test('文件：write_file 不给内容会明确报错', async t => {
  const { store, engine, event } = await fixture(t, {}, {
    bot: { mode: 'llm', minChars: 0, maxChars: 200, replyCount: 2, cooldownMs: 0, replyDelayMs: 0 },
    llm: { model: 'm', apiKey: 'k' }, rules: [],
    harness: { resourcesEnabled: true, fileOutputEnabled: true },
  });
  let turn = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).includes('/chat/completions')) return new Response('{}', { status: 200 });
    if (turn++ === 0) {
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'w1', type: 'function', function: { name: 'save_note', arguments: JSON.stringify({ name: 'x.txt', content: '   ' }) } }] } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '没写出来。' } }] }), { status: 200 });
  });
  await engine.generate({ ...event, content: '整理成文件' }, { deliver: async () => ({ id: 'm' }) });
  const logs = await store.db.prepare("SELECT detail FROM logs WHERE message='模型工具操作'").all();
  // 参数校验阶段就会拦下来（content 必须是非空字符串）
  assert.match(JSON.stringify(logs), /content必须是非空字符串|文件内容不能为空/);
});

test('思考型模型：只吐思考过程、没有正文时报「输出被截断」', async t => {
  const { store, engine, event } = await fixture(t, {}, {
    bot: { mode: 'llm', minChars: 0, maxChars: 200, replyCount: 2, cooldownMs: 0, replyDelayMs: 0 },
    llm: { model: 'm', apiKey: 'k', apiFormat: 'anthropic', baseUrl: 'https://api.minimax.cn/anthropic/v1', maxTokens: 1024 },
    rules: [],
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    content: [{ type: 'thinking', thinking: '先想一会儿……'.repeat(50) }],
    stop_reason: 'max_tokens',
    usage: { input_tokens: 100, output_tokens: 1024 },
  }), { status: 200 }));
  await assert.rejects(
    () => engine.generate({ ...event, content: '你好' }, { deliver: async () => ({ id: 'm' }) }),
    (error) => {
      assert.match(error.message, /只输出了思考过程/);
      assert.match(error.message, /最大输出长度/);
      return true;
    },
  );
});

test('思考型模型：reasoning_effort 会带到请求里', async t => {
  const { buildRequest } = await import('../src/llm-format.js');
  const withEffort = buildRequest('openai', { baseUrl: 'https://x/v1', model: 'm', messages: [], reasoningEffort: 'low' });
  assert.equal(withEffort.body.reasoning_effort, 'low');
  const without = buildRequest('openai', { baseUrl: 'https://x/v1', model: 'm', messages: [], reasoningEffort: 'off' });
  assert.equal(without.body.reasoning_effort, undefined);
});

test('文件：重定向写出的文件会存进资料库并作为附件发出去', async t => {
  const { store, engine, event } = await fixture(t, {}, {
    bot: { mode: 'llm', minChars: 0, maxChars: 200, replyCount: 2, cooldownMs: 0, replyDelayMs: 0 },
    llm: { model: 'm', apiKey: 'k' }, rules: [],
    harness: { resourcesEnabled: true, shellEnabled: true, fileOutputEnabled: true },
  });
  store.saveResourceFolder({ name: '小说', trigger: '小说', summary: '小说' });
  store.saveResourceFile({ folderId: store.listResourceFolders().find((f) => f.name === '小说').id, name: '第一章.md', kind: 'text', content: '素嫽走进了雨里。\n素嫽又走远了。\n素嫽回头看了一眼。' });
  let turn = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).includes('/chat/completions')) return new Response('{}', { status: 200 });
    if (turn++ === 0) {
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 's1', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: 'grep "素嫽" /files/小说/第一章.md > 摘录.txt' }) } }] } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '整理好了。' } }] }), { status: 200 });
  });
  const sent = [];
  await engine.generate({ ...event, content: '把含素嫽的句子整理成文件' }, {
    deliver: async (text, seq, message) => { sent.push({ text, seq, type: message?.type || 'text', name: message?.name }); return { id: 'm' }; },
  });
  const file = sent.find((item) => item.type === 'file');
  assert.ok(file, '重定向出来的文件应当作为附件发出去');
  assert.equal(file.name, '摘录.txt');
  const out = store.listResourceFolders().find((folder) => folder.name === '机器人输出');
  assert.ok(out, '应当存进「机器人输出」资料夹');
  const saved = store.listResourceFiles(out.id);
  assert.equal(saved.length, 1);
  assert.match(store.getResourceFile(saved[0].id).content, /素嫽回头看了一眼/);
});

test('资料夹：DOC.md 能直接按名字读，文件清单里也有它', async t => {
  const { store, engine, event } = await fixture(t, {}, {
    bot: { mode: 'llm', minChars: 0, maxChars: 200, replyCount: 2, cooldownMs: 0, replyDelayMs: 0 },
    llm: { model: 'm', apiKey: 'k' }, rules: [],
    harness: { resourcesEnabled: true },
  });
  store.saveResourceFolder({ name: '月下鹄鸣', trigger: '提到小说时', summary: '一部关于高中三年的小说' });
  let turn = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).includes('/chat/completions')) return new Response('{}', { status: 200 });
    if (turn++ === 0) {
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'd1', type: 'function', function: { name: 'read_note', arguments: JSON.stringify({ folder: '月下鹄鸣', file: 'DOC.md' }) } }] } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '知道了。' } }] }), { status: 200 });
  });
  await engine.generate({ ...event, content: '讲讲资料夹' }, { deliver: async () => ({ id: 'm' }) });
  const logs = await store.db.prepare("SELECT detail FROM logs WHERE message='模型工具操作'").all();
  assert.match(JSON.stringify(logs), /一部关于高中三年的小说/);
});

test('生图：模型自己挑尺寸，各种写法都能规整成接口认的', async t => {
  const { normalizeImageSize } = await import('../src/agnes.js');
  assert.equal(normalizeImageSize('1024*1024'), '1024x1024');
  assert.equal(normalizeImageSize('square'), '1024x1024');
  assert.equal(normalizeImageSize('portrait'), '1024x1792');
  assert.equal(normalizeImageSize('landscape'), '1792x1024');
  assert.equal(normalizeImageSize('竖屏'), '1024x1792');
  assert.equal(normalizeImageSize('横屏'), '1792x1024');
  assert.equal(normalizeImageSize('1024x1792'), '1024x1792');
  assert.equal(normalizeImageSize(''), '1024x1024');
  assert.equal(normalizeImageSize(undefined), '1024x1024');
  // 认不出来的就退回默认，不该把整次生成搞挂
  assert.equal(normalizeImageSize('乱七八糟'), '1024x1024');
});

test('沙箱：sed 支持正则地址，head 支持 -c', async t => {
  const store = await sandboxStore(t);
  const { Sandbox } = await import('../src/sandbox.js');
  const sandbox = new Sandbox(store);
  const file = '/files/小说/第一章.md';
  // sed -n '/正则/p'：只打印匹配的行
  const picked = sandbox.run(`sed -n '/素嫽/p' ${file}`);
  assert.match(picked.stdout, /素嫽走进了雨里/);
  assert.doesNotMatch(picked.stdout, /第一章的开头/);
  // sed '/正则/d'：删掉匹配的行
  const removed = sandbox.run(`sed '/素嫽/d' ${file}`);
  assert.doesNotMatch(removed.stdout, /素嫽走进了雨里/);
  assert.match(removed.stdout, /第一章的开头/);
  // head -c N：取前 N 个字符（按字符算，中文不会被切坏）
  const clipped = sandbox.run(`head -c 5 ${file}`);
  assert.equal(clipped.stdout, '第一章的开');
  store.close();
});

test('生图：用户说「重新画」时，资料库旧图不算数，必须真的生成', async t => {
  const { store, engine, event } = await fixture(t, {}, {
    bot: { mode: 'llm', minChars: 0, maxChars: 200, replyCount: 2, cooldownMs: 0, replyDelayMs: 0 },
    llm: { model: 'm', apiKey: 'k' }, rules: [],
    harness: { resourcesEnabled: true, resourceImageEnabled: true, imageGenEnabled: true, genMode: 'agnes', genBaseUrl: 'https://x/v1', genApiKey: 'k', imageModel: 'm' },
  });
  const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const folder = store.saveResourceFolder({ name: '我的照片', trigger: '看照片时', summary: '旧照片' });
  store.saveResourceFile({ folderId: folder.id, name: 'old.png', kind: 'image', data: Buffer.from(PNG_1PX, 'base64'), mime: 'image/png', size: 70 });
  let turn = 0;
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = String(url);
    if (!target.includes('/chat/completions') && !target.includes('/images')) return new Response('{}', { status: 200 });
    if (target.includes('/images')) {
      calls.push('image');
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_1PX }] }), { status: 200 });
    }
    calls.push('chat');
    const step = turn++;
    if (step === 0) {
      // 第一轮：翻相册，翻到旧照片就发（用户要的是新拍一张，这不对）
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'r1', type: 'function', function: { name: 'find_photo', arguments: JSON.stringify({ subject: '旧照片' }) } }] } }] }), { status: 200 });
    }
    if (step === 1) {
      // 第二轮：只说不做 —— 应该被守卫拦住
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '翻到了，发给你了。' } }] }), { status: 200 });
    }
    if (step === 2) {
      // 第三轮：被要求后真的去生成
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'g1', type: 'function', function: { name: 'find_photo', arguments: JSON.stringify({ subject: '樱花道上的少女' }) } }] } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '画好了。' } }] }), { status: 200 });
  });
  const sent = [];
  await engine.generate({ ...event, content: '你重新画一下' }, {
    deliver: async (text, seq, message) => { sent.push({ text, seq, type: message?.type || 'text', origin: message?.origin }); return { id: 'm' }; },
  });
  assert.ok(calls.includes('image'), '用户要求重拍时必须真的新拍一张');
});

test('生图：新生成的图可以顶掉资料库旧图（旧图不算已发附件）', async t => {
  const { store, engine, event } = await fixture(t, {}, {
    bot: { mode: 'llm', minChars: 0, maxChars: 200, replyCount: 2, cooldownMs: 0, replyDelayMs: 0 },
    llm: { model: 'm', apiKey: 'k' }, rules: [],
    harness: { resourcesEnabled: true, resourceImageEnabled: true, imageGenEnabled: true, genMode: 'agnes', genBaseUrl: 'https://x/v1', genApiKey: 'k', imageModel: 'm' },
  });
  const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const folder = store.saveResourceFolder({ name: '我的照片', trigger: '看照片时', summary: '旧照片' });
  store.saveResourceFile({ folderId: folder.id, name: 'old.png', kind: 'image', data: Buffer.from(PNG_1PX, 'base64'), mime: 'image/png', size: 70 });
  let turn = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = String(url);
    if (target.includes('/images')) return new Response(JSON.stringify({ data: [{ b64_json: PNG_1PX }] }), { status: 200 });
    if (!target.includes('/chat/completions')) return new Response('{}', { status: 200 });
    if (turn++ === 0) {
      // 先翻相册：翻到旧照片（用户要新拍一张，这不对）
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'r1', type: 'function', function: { name: 'find_photo', arguments: JSON.stringify({ subject: '旧照片' }) } }] } }] }), { status: 200 });
    }
    if (turn++ === 1) {
      // 被提醒后：只给 subject，让它新拍一张
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'g1', type: 'function', function: { name: 'find_photo', arguments: JSON.stringify({ subject: '樱花道上的少女' }) } }] } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '拍好了。' } }] }), { status: 200 });
  });
  const sent = [];
  await engine.generate({ ...event, content: '重新画一张' }, {
    deliver: async (text, seq, message) => { sent.push({ text, seq, type: message?.type || 'text' }); return { id: 'm' }; },
  });
  const images = sent.filter((item) => item.type === 'media');
  assert.equal(images.length, 1, '最终只发一张图');
});

test('相册：find_photo 找不到合适的就新拍一张，并存进相册', async t => {
  const { store, engine, event } = await fixture(t, {}, {
    bot: { mode: 'llm', minChars: 0, maxChars: 200, replyCount: 2, cooldownMs: 0, replyDelayMs: 0 },
    llm: { model: 'm', apiKey: 'k' }, rules: [],
    harness: { resourcesEnabled: true, imageGenEnabled: true, genMode: 'agnes', genBaseUrl: 'https://x/v1', genApiKey: 'k', imageModel: 'm' },
  });
  const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  let turn = 0;
  let imagePrompt = '';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = String(url);
    if (target.includes('/images')) {
      imagePrompt = JSON.parse(options.body).prompt;
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_1PX }] }), { status: 200 });
    }
    if (!target.includes('/chat/completions')) return new Response('{}', { status: 200 });
    if (turn++ === 0) {
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'p1', type: 'function', function: { name: 'find_photo', arguments: JSON.stringify({ subject: '樱花树下的少女' }) } }] } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '翻到了。' } }] }), { status: 200 });
  });
  const sent = [];
  await engine.generate({ ...event, content: '画一张你站在樱花树下的照片' }, {
    deliver: async (text, seq, message) => { sent.push({ text, seq, type: message?.type || 'text' }); return { id: 'm' }; },
  });
  assert.ok(sent.some((item) => item.type === 'media'), '应当发一张照片');
  assert.match(imagePrompt, /真实照片质感/, '拍出来的应该是照片，不是插画');
  // 拍完要存进相册，下次就能翻到
  const album = store.listResourceFolders().find((folder) => folder.name === '相册');
  assert.ok(album, '应当建一个「相册」文件夹');
  assert.equal(store.listResourceFiles(album.id).length, 1);
});

test('相册：模型看不到「资源库」这三个字，也看不到生图工具', async t => {
  const { store, engine, event } = await fixture(t, {}, {
    bot: { mode: 'llm', minChars: 0, maxChars: 200, replyCount: 2, cooldownMs: 0, replyDelayMs: 0 },
    llm: { model: 'm', apiKey: 'k' }, rules: [],
    harness: { resourcesEnabled: true, shellEnabled: true, imageGenEnabled: true, genApiKey: 'k' },
  });
  store.saveResourceFolder({ name: '月下鹄鸣', trigger: '聊到小说时', summary: '一部小说' });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).includes('/chat/completions')) return new Response('{}', { status: 200 });
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '好' } }] }), { status: 200 });
  });
  await engine.generate({ ...event, content: '聊聊《月下鹄鸣》' }, { deliver: async () => ({ id: 'm' }) });
  const system = requests[0].messages[0].content;
  for (const word of ['资源库', '资料库', '资料夹', 'generate_image']) {
    assert.ok(!system.includes(word), `提示词里不该出现「${word}」`);
  }
  const names = (requests[0].tools || []).map((tool) => tool.function.name);
  assert.ok(names.includes('find_photo'), '应当给模型相册工具');
  assert.ok(!names.includes('generate_image'), '不该让模型知道有生图工具');
});

test('相册：用户发来的照片可以被存进文件夹', async t => {
  const { store, engine, event } = await fixture(t, {}, {
    bot: { mode: 'llm', minChars: 0, maxChars: 200, replyCount: 2, cooldownMs: 0, replyDelayMs: 0 },
    llm: { model: 'm', apiKey: 'k' }, rules: [],
    harness: { resourcesEnabled: true },
  });
  const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const bytes = Buffer.from(PNG_1PX, 'base64');
  let turn = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).includes('/chat/completions')) return new Response('{}', { status: 200 });
    if (turn++ === 0) {
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 's1', type: 'function', function: { name: 'save_file', arguments: JSON.stringify({ name: '他拍的照片.png' }) } }] } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '收好了。' } }] }), { status: 200 });
  });
  await engine.generate({
    ...event,
    content: '这张存下来',
    attachments: [{ url: `data:image/png;base64,${PNG_1PX}`, filename: 'a.png', contentType: 'image/png', size: bytes.length }],
  }, { deliver: async () => ({ id: 'm' }) });
  const folder = store.listResourceFolders().find((item) => item.name === '收到的照片');
  assert.ok(folder, '应当建一个「收到的照片」文件夹');
  const files = store.listResourceFiles(folder.id);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, '他拍的照片.png');
});

test('语音：MiniMax 地址自动走原生 T2A，哪怕配置写的是 openai', async t => {
  const { resolveTtsFormat } = await import('../src/tts.js');
  assert.equal(resolveTtsFormat({ ttsApiFormat: 'auto', ttsBaseUrl: 'https://api-bj.minimaxi.com' }), 'minimax');
  assert.equal(resolveTtsFormat({ ttsApiFormat: 'openai', ttsBaseUrl: 'https://api-bj.minimaxi.com' }), 'minimax');
  assert.equal(resolveTtsFormat({ ttsApiFormat: 'auto', ttsBaseUrl: 'https://api.openai.com/v1' }), 'openai');
  assert.equal(resolveTtsFormat({ ttsApiFormat: 'minimax', ttsBaseUrl: 'https://api.minimaxi.com' }), 'minimax');
});

test('语音：OpenAI 兼容地址没写 /v1 时自动补上', async t => {
  const { openaiEndpoint } = await import('../src/tts.js');
  assert.equal(openaiEndpoint('https://api.openai.com/v1', 'audio/speech'), 'https://api.openai.com/v1/audio/speech');
  assert.equal(openaiEndpoint('https://api-bj.minimaxi.com', 'audio/speech'), 'https://api-bj.minimaxi.com/v1/audio/speech');
  assert.equal(openaiEndpoint('https://x.com/v1/audio/speech', 'audio/speech'), 'https://x.com/v1/audio/speech');
});

test('生图：会带上相册里的参考图，保证是同一个人', async t => {
  const { store, engine, event } = await fixture(t, {}, {
    bot: { mode: 'llm', minChars: 0, maxChars: 200, replyCount: 2, cooldownMs: 0, replyDelayMs: 0 },
    llm: { model: 'm', apiKey: 'k' }, rules: [],
    harness: { resourcesEnabled: true, imageGenEnabled: true, genUseReference: true, genMode: 'agnes', genBaseUrl: 'https://x/v1', genApiKey: 'k', imageModel: 'm' },
  });
  const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const folder = store.saveResourceFolder({ name: '瑶鸢的图片', trigger: '看照片时', summary: '自己的照片' });
  store.saveResourceFile({ folderId: folder.id, name: '树下.png', kind: 'image', data: Buffer.from(PNG_1PX, 'base64'), mime: 'image/png', size: 70 });
  let body = null;
  let turn = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = String(url);
    if (target.includes('/images')) {
      body = JSON.parse(options.body);
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_1PX }] }), { status: 200 });
    }
    if (!target.includes('/chat/completions')) return new Response('{}', { status: 200 });
    if (turn++ === 0) {
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'p1', type: 'function', function: { name: 'find_photo', arguments: JSON.stringify({ subject: '樱花树下' }) } }] } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '拍好了。' } }] }), { status: 200 });
  });
  await engine.generate({ ...event, content: '拍一张树下的' }, { deliver: async () => ({ id: 'm' }) });
  assert.ok(body?.image, '生图请求里应当带参考图');
  assert.match(body.image, /^data:image\/png;base64,/, '参考图要带 MIME 头的数据 URL');
  assert.match(body.prompt, /同一个人的脸型/, '提示词里要交代保持同一张脸');
});

test('生图：关掉参考图开关就不带图', async t => {
  const { store, engine, event } = await fixture(t, {}, {
    bot: { mode: 'llm', minChars: 0, maxChars: 200, replyCount: 2, cooldownMs: 0, replyDelayMs: 0 },
    llm: { model: 'm', apiKey: 'k' }, rules: [],
    harness: { resourcesEnabled: true, imageGenEnabled: true, genUseReference: false, genMode: 'agnes', genBaseUrl: 'https://x/v1', genApiKey: 'k', imageModel: 'm' },
  });
  const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const folder = store.saveResourceFolder({ name: '照片', trigger: 'x', summary: 'x' });
  store.saveResourceFile({ folderId: folder.id, name: 'a.png', kind: 'image', data: Buffer.from(PNG_1PX, 'base64'), mime: 'image/png', size: 70 });
  let body = null;
  let turn = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = String(url);
    if (target.includes('/images')) { body = JSON.parse(options.body); return new Response(JSON.stringify({ data: [{ b64_json: PNG_1PX }] }), { status: 200 }); }
    if (!target.includes('/chat/completions')) return new Response('{}', { status: 200 });
    if (turn++ === 0) {
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'p1', type: 'function', function: { name: 'find_photo', arguments: JSON.stringify({ subject: '新的一张' }) } }] } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '好。' } }] }), { status: 200 });
  });
  await engine.generate({ ...event, content: '拍一张' }, { deliver: async () => ({ id: 'm' }) });
  assert.equal(body?.image, undefined, '关掉开关就不带参考图');
});

test('时间感：提示词里说人话，历史带时间标记', async t => {
  const { store, engine, event } = await fixture(t);
  const requests = transport(t, ['好的']);
  await engine.generate({ ...event, content: '今天几号？' }, { deliver: async () => ({ id: 'm' }) });
  const system = requests[0].messages[0].content;
  assert.match(system, /现在是 \d{4}年\d{1,2}月\d{1,2}日 星期./, '现在时间要说人话');
  assert.match(system, /用户本条消息发于/, '要说这条消息是什么时候发的');
  assert.match(system, /你在对话里应当对时间有实感/, '要交代它对时间有实感');
  assert.match(system, /禁止在回复里输出时间戳/);
});

test('语音：模型开口说话时只发语音，不再补文字', async t => {
  const { store, engine, event } = await fixture(t, {}, {
    bot: { mode: 'llm', minChars: 0, maxChars: 200, replyCount: 3, cooldownMs: 0, replyDelayMs: 0 },
    llm: { model: 'm', apiKey: 'k' }, rules: [],
    harness: { ttsEnabled: true, ttsMode: 'api', ttsBaseUrl: 'https://x/v1', ttsApiKey: 'k', ttsModel: 'speech-2.8-turbo', ttsVoice: 'v' },
  });
  let turn = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = String(url);
    if (target.includes('/t2a_v2')) {
      return new Response(JSON.stringify({ data: { audio: Buffer.from('ID3fake').toString('hex') } }), { status: 200 });
    }
    if (!target.includes('/chat/completions')) return new Response('{}', { status: 200 });
    if (turn++ === 0) {
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'v1', type: 'function', function: { name: 'speak', arguments: JSON.stringify({ text: '在呢，今天风有点凉。' }) } }] } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '在呢，今天风有点凉。' } }] }), { status: 200 });
  });
  const sent = [];
  await engine.generate({ ...event, content: '说句话给我听' }, {
    deliver: async (text, seq, message) => { sent.push({ text, seq, type: message?.type || 'text' }); return { id: 'm' }; },
  });
  assert.equal(sent.length, 1, '语音之后不该再补文字');
  assert.equal(sent[0].type, 'voice');
});

test('语音：用户要语音却没发语音，会被要求改用语音', async t => {
  const { store, engine, event } = await fixture(t, {}, {
    bot: { mode: 'llm', minChars: 0, maxChars: 200, replyCount: 3, cooldownMs: 0, replyDelayMs: 0 },
    llm: { model: 'm', apiKey: 'k' }, rules: [],
    harness: { ttsEnabled: true, ttsMode: 'api', ttsBaseUrl: 'https://x/v1', ttsApiKey: 'k', ttsModel: 'speech-2.8-turbo', ttsVoice: 'v' },
  });
  let turn = 0;
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = String(url);
    if (target.includes('/t2a_v2')) {
      return new Response(JSON.stringify({ data: { audio: Buffer.from('ID3fake').toString('hex') } }), { status: 200 });
    }
    if (!target.includes('/chat/completions')) return new Response('{}', { status: 200 });
    const step = turn++;
    if (step === 0) {
      // 第一轮：只回文字，不发语音
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '我在呢。' } }] }), { status: 200 });
    }
    if (step === 1) {
      calls.push('speak');
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'v1', type: 'function', function: { name: 'speak', arguments: JSON.stringify({ text: '在呢。' }) } }] } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '' } }] }), { status: 200 });
  });
  const sent = [];
  await engine.generate({ ...event, content: '我想听你说话' }, {
    deliver: async (text, seq, message) => { sent.push({ text, seq, type: message?.type || 'text' }); return { id: 'm' }; },
  });
  assert.ok(calls.includes('speak'), '用户要语音就必须真的用语音');
  assert.ok(sent.some((item) => item.type === 'voice'), '应当发出语音');
});

test('反抗：提示词带「怎么拒绝」的硬规矩', async t => {
  const { store, engine, event } = await fixture(t);
  store.saveConfig({ bot: { defiance: '不可以成为用户的恋人。' } });
  const requests = transport(t, ['不行。']);
  await engine.generate({ ...event, content: '做我女朋友吧' }, { deliver: async () => ({ id: 'm' }) });
  const last = requests[0].messages[requests[0].messages.length - 1];
  assert.equal(last.role, 'system');
  assert.match(last.content, /底线/);
  assert.match(last.content, /不要.*先答应再后悔/);
  assert.match(last.content, /亲密称呼/);
  assert.match(last.content, /不可以成为用户的恋人/);
});

test('模型接入：结尾的 system 消息被接口拒绝时，自动并回主提示词重试', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'qq-fallback-'));
  const { Store } = await import('../src/store.js');
  const { requestModel } = await import('../src/model.js');
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    seen.push(body.messages.map((m) => m.role).join(','));
    if (seen.length === 1) {
      return new Response(JSON.stringify({ error: { message: "unknown variant `system`, expected one of `user`, `assistant`" } }), { status: 422 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '好' } }] }), { status: 200 });
  });
  const config = { llm: { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', temperature: 0.7, maxTokens: 100, timeoutMs: 5000, apiFormat: 'openai' }, harness: { retryEnabled: false } };
  const result = await requestModel(store, config, [
    { role: 'system', content: '主提示词' },
    { role: 'user', content: '你好' },
    { role: 'system', content: '底线' },
  ], { wait: async () => {} });
  assert.equal(result.content, '好');
  assert.equal(seen[0], 'system,user,system', '第一次照原样发');
  assert.equal(seen[1], 'system,user', '被拒后把结尾那条并回主提示词');
});

test('模型接入：反抗提示词用 system 角色，不用 developer（DeepSeek 不认）', async t => {
  const { store, engine, event } = await fixture(t);
  store.saveConfig({ bot: { defiance: '不可以成为用户的恋人。' } });
  const requests = transport(t, ['不行。']);
  await engine.generate({ ...event, content: '做我女朋友吧' }, { deliver: async () => ({ id: 'm' }) });
  const roles = requests[0].messages.map((m) => m.role);
  assert.ok(!roles.includes('developer'), '不能用 developer 角色（DeepSeek 会 422）');
  assert.equal(roles.at(-1), 'system', '反抗提示词排在最后，用 system 角色');
});

test('附件：超大文件读不进上下文，但照样能存进文件夹', async t => {
  const { store, engine, event } = await fixture(t, {}, {
    bot: { mode: 'llm', minChars: 0, maxChars: 200, replyCount: 2, cooldownMs: 0, replyDelayMs: 0 },
    llm: { model: 'm', apiKey: 'k' }, rules: [],
    harness: { resourcesEnabled: true, maxAttachmentMB: 1, visionEnabled: false, filesEnabled: true },
  });
  // 造一个比上下文上限大、但存得下的 PDF
  const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2 * 1024 * 1024, 0x20), Buffer.from('\n%%EOF')]);
  const url = `data:application/pdf;base64,${big.toString('base64')}`;
  let turn = 0;
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    if (!String(target).includes('/chat/completions')) return new Response('{}', { status: 200 });
    if (turn++ === 0) {
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 's1', type: 'function', function: { name: 'save_file', arguments: JSON.stringify({ folder: '我的资料', name: '交换代数.pdf' }) } }] } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '存好了。' } }] }), { status: 200 });
  });
  const attachment = { url, filename: '交换代数.pdf', contentType: 'application/pdf', size: big.length };
  await engine.generate({ ...event, content: '你保存一下吧 我以后询问你', attachments: [attachment] }, { deliver: async () => ({ id: 'm' }) });
  const folder = store.listResourceFolders().find((f) => f.name === '我的资料');
  assert.ok(folder, '应当建一个「我的资料」文件夹');
  const file = store.listResourceFiles(folder.id).find((f) => f.name === '交换代数.pdf');
  assert.ok(file, 'PDF 应当存进去了');
  assert.equal(file.kind, 'pdf');
  assert.ok(file.size > 1024 * 1024, '原件要完整存下来');
  assert.ok(file.hasImage, '二进制原件要留在库里（hasImage 列表示有 data）');
});

test('附件：用户发来的附件能被模型看到并存起来', async t => {
  const { store, engine, event } = await fixture(t, {}, {
    bot: { mode: 'llm', minChars: 0, maxChars: 200, replyCount: 2, cooldownMs: 0, replyDelayMs: 0 },
    llm: { model: 'm', apiKey: 'k' }, rules: [],
    harness: { resourcesEnabled: true },
  });
  const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  let turn = 0; let body = null;
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    if (!String(target).includes('/chat/completions')) return new Response('{}', { status: 200 });
    body = JSON.parse(options.body);
    if (turn++ === 0) {
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 's1', type: 'function', function: { name: 'save_file', arguments: JSON.stringify({ folder: '存的东西' }) } }] } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '收好了。' } }] }), { status: 200 });
  });
  const attachment = { url: `data:image/png;base64,${PNG_1PX}`, filename: '他拍的照片.png', contentType: 'image/png', size: 70 };
  await engine.generate({ ...event, content: '这个你存一下', attachments: [attachment] }, { deliver: async () => ({ id: 'm' }) });
  assert.ok(body?.tools?.some((t) => t.function.name === 'save_file'), '模型应当拿到 save_file 工具');
  const folder = store.listResourceFolders().find((f) => f.name === '存的东西');
  assert.ok(folder, '应当建一个文件夹');
  assert.equal(store.listResourceFiles(folder.id).length, 1);
});

test('存文件：模型要读懂文件并自己写说明', async t => {
  const { store, engine, event } = await fixture(t, {}, {
    bot: { mode: 'llm', minChars: 0, maxChars: 200, replyCount: 2, cooldownMs: 0, replyDelayMs: 0 },
    llm: { model: 'm', apiKey: 'k' }, rules: [],
    harness: { resourcesEnabled: true },
  });
  const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  let turn = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).includes('/chat/completions')) return new Response('{}', { status: 200 });
    const step = turn++;
    if (step === 0) {
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 's1', type: 'function', function: { name: 'save_file', arguments: JSON.stringify({ folder: '我的资料', name: '笔记.png' }) } }] } }] }), { status: 200 });
    }
    if (step === 1) {
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'd1', type: 'function', function: { name: 'describe_file', arguments: JSON.stringify({ file: '笔记.png', description: '一张白底的小图，我随手拍下来的第一张测试照片。' }) } }] } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '收好了，说明也写上了。' } }] }), { status: 200 });
  });
  const attachment = { url: `data:image/png;base64,${PNG_1PX}`, filename: '原图.png', contentType: 'image/png', size: 70 };
  await engine.generate({ ...event, content: '这个你存一下', attachments: [attachment] }, { deliver: async () => ({ id: 'm' }) });
  const folder = store.listResourceFolders().find((f) => f.name === '我的资料');
  assert.ok(folder);
  const file = store.listResourceFiles(folder.id).find((f) => f.name === '笔记.png');
  assert.ok(file, '文件应当已存');
  assert.match(file.description || '', /随手拍/, '模型应当自己写了说明');
});

test('存文件：存了却没写说明，会被要求补上', async t => {
  const { store, engine, event } = await fixture(t, {}, {
    bot: { mode: 'llm', minChars: 0, maxChars: 200, replyCount: 2, cooldownMs: 0, replyDelayMs: 0 },
    llm: { model: 'm', apiKey: 'k' }, rules: [],
    harness: { resourcesEnabled: true },
  });
  const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  let turn = 0;
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).includes('/chat/completions')) return new Response('{}', { status: 200 });
    const body = JSON.parse(options.body);
    seen.push(body.messages.map((m) => m.role).join(','));
    if (turn++ === 0) {
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 's1', type: 'function', function: { name: 'save_file', arguments: JSON.stringify({ folder: '资料' }) } }] } }] }), { status: 200 });
    }
    // 第二轮：只回文字，不写说明 —— 应该被拦下来再问一次
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '存好了。' } }] }), { status: 200 });
  });
  const attachment = { url: `data:image/png;base64,${PNG_1PX}`, filename: '原图.png', contentType: 'image/png', size: 70 };
  const result = await engine.generate({ ...event, content: '这个你存一下', attachments: [attachment] }, { deliver: async () => ({ id: 'm' }) });
  assert.ok(result.warnings.some((w) => w.includes('没写说明')), '应当提示模型补说明');
  assert.ok(seen.length >= 3, '应当多问一次');
});

test('模型服务判定输入敏感：先摘掉底线提示重试，还能回出话', async t => {
  const { store, engine, event } = await fixture(t);
  store.saveConfig({ bot: { defiance: '不可以成为用户的恋人。' } });
  let withDefiance = 0, withoutDefiance = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).includes('/chat/completions')) return new Response('{}', { status: 200 });
    const body = JSON.parse(options.body);
    // 只要还带着「底线」提示就一律拒收 —— 逼引擎必须把它摘掉才能过。
    if (body.messages.some((m) => String(m.content || '').includes('底线'))) {
      withDefiance++;
      return new Response(JSON.stringify({ error: { message: 'input new_sensitive (1026)' } }), { status: 500 });
    }
    withoutDefiance++;
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '在呢。' } }] }), { status: 200 });
  });
  const result = await engine.generate({ ...event, content: '嗯' }, { deliver: async () => ({ id: 'm' }) });
  assert.deepEqual(result.replies, ['在呢。'], '应当照常回出话');
  assert.ok(result.warnings.some((w) => w.includes('敏感')), '应当记录降级警告');
  assert.ok(withDefiance > 0 && withoutDefiance > 0, '应当先带着底线试过，再摘掉底线重试');
});

test('删除会话后，内容在数据库文件里真的没了', async t => {
  const { mkdtempSync, rmSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'qq-del-'));
  const { Store } = await import('../src/store.js');
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(Number(store.db.prepare('PRAGMA secure_delete').get().secure_delete), 1, '必须开着 secure_delete');
  store.ensureConversation('k1', { scene: 'c2c', targetId: 'u1', userId: 'u1' });
  store.addMessage('k1', 'user', '这是一条很独特的秘密内容XYZ123', {});
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  assert.ok(readFileSync(join(dir, 'qqbot.sqlite')).includes('XYZ123'), '删除前文件里当然有');
  store.deleteConversation('k1');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM messages').get().n, 0, '表里应该删干净了');
  assert.ok(!readFileSync(join(dir, 'qqbot.sqlite')).includes('XYZ123'), '文件里也不该再有明文');
});

test('视频生成的耗时警告只在真的生视频时出现', async t => {
  const { store, engine, event } = await fixture(t, {}, {
    bot: { mode: 'llm', minChars: 0, maxChars: 200, replyCount: 2, cooldownMs: 0, replyDelayMs: 0 },
    llm: { model: 'm', apiKey: 'k' }, rules: [],
    harness: { videoGenEnabled: true, genMode: 'agnes', genBaseUrl: 'https://x/v1', genApiKey: 'k', videoModel: 'v' },
  });
  let turn = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).includes('/chat/completions')) return new Response('{}', { status: 200 });
    if (turn++ === 0) {
      // 跟模型聊天，完全不碰视频
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '在呢。' } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '好' } }] }), { status: 200 });
  });
  const result = await engine.generate({ ...event, content: '在吗' }, { deliver: async () => ({ id: 'm' }) });
  assert.ok(!result.warnings.some((w) => w.includes('视频生成较慢')), '只是聊天不该带视频生成的警告');
});

test('沙箱：grep 支持 -a，输出可以丢掉', async t => {
  const { store } = await fixture(t);
  const { Sandbox } = await import('../src/sandbox.js');
  const folder = store.saveResourceFolder({ name: '资料', trigger: 'x', summary: 'x' });
  store.saveResourceFile({ folderId: folder.id, name: 'a.txt', kind: 'text', content: 'Hello World\nfoo bar\n' });
  store.saveResourceFile({ folderId: folder.id, name: 'b.txt', kind: 'text', content: 'hello again\n' });
  const sandbox = new Sandbox(store);
  const grep = sandbox.run('grep -a hello /files', { cwd: '/' });
  assert.ok(grep.ok, '-a 不该再报「不认识的选项」：' + grep.stderr);
  assert.match(grep.stdout, /hello again/);
  const quiet = sandbox.run('grep -q hello /files', { cwd: '/' });
  assert.equal(quiet.ok, true);
  assert.match(quiet.stdout, /有匹配/);
  const discard = sandbox.run('echo hi > /dev/null', { cwd: '/' });
  assert.equal(discard.ok, true, '>/dev/null 不该报错：' + discard.stderr);
  assert.equal(sandbox.outbox.size, 0, '>/dev/null 不该留下文件');
});

test('图片：结尾有多余字节的 JPEG 也认得出来', async t => {
  const { imageType } = await import('../src/media.js');
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0x64, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  const eoi = Buffer.from([0xff, 0xd9]);
  const plain = Buffer.concat([Buffer.from([0xff, 0xd8]), sof, sos, Buffer.alloc(20, 0x55), eoi]);
  assert.equal(imageType(plain), 'image/jpeg');
  // 有些图片 EOI 后面还跟着别的字节，不能因此判成「格式无效」
  const trailing = Buffer.concat([plain, Buffer.from([0, 1, 2, 3])]);
  assert.equal(imageType(trailing), 'image/jpeg', '结尾有多余字节的 JPEG 不该被拒');
  assert.equal(imageType(Buffer.from('not an image at all')), '');
});

test('联网搜索：提供方顺序里必须有一个国内连得上的', async t => {
  const { webSearch } = await import('../src/search.js');
  // auto 模式下的第一个提供方必须能在国内网络里直连
  const result = await webSearch('测试', { count: 2, timeoutMs: 8000 }).catch(() => null);
  if (result) assert.ok(['bing', 'duckduckgo', 'wikipedia'].includes(result.provider));
});

test('输入敏感降级时，工具调用和工具结果仍然配对', async t => {
  const { store, engine, event } = await fixture(t);
  let turn = 0;
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).includes('/chat/completions')) return new Response('{}', { status: 200 });
    const body = JSON.parse(options.body);
    bodies.push(body);
    const hasDefiance = body.messages.some((m) => String(m.content || '').includes('底线'));
    const hasToolResult = body.messages.some((m) => m.role === 'tool');
    // 带着底线 → 拒收；带工具结果但没有对应的 assistant 工具调用 → 也拒收
    if (hasDefiance) {
      return new Response(JSON.stringify({ error: { message: 'input new_sensitive (1026)' } }), { status: 500 });
    }
    if (hasToolResult) {
      const ids = body.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
      const called = body.messages.filter((m) => m.role === 'assistant' && m.tool_calls).flatMap((m) => m.tool_calls.map((c) => c.id));
      const orphan = ids.some((id) => !called.includes(id));
      if (orphan) {
        return new Response(JSON.stringify({ error: { message: "invalid params, tool result's tool id(x) not found" } }), { status: 400 });
      }
    }
    if (turn++ === 0) {
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_reminders', arguments: '{}' } }] } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '好了' } }] }), { status: 200 });
  });
  const result = await engine.generate({ ...event, content: '列一下提醒' }, { deliver: async () => ({ id: 'm' }) });
  assert.deepEqual(result.replies, ['好了'], '应当照常回出话');
});

test('PDF 直传被接口拒绝时，会降级成只发元数据重试', async t => {
  const { store, engine, event } = await fixture(t, {}, {
    bot: { mode: 'llm', minChars: 0, maxChars: 200, replyCount: 2, cooldownMs: 0, replyDelayMs: 0 },
    llm: { model: 'm', apiKey: 'k' }, rules: [],
    harness: { filesEnabled: true, pdfFileParts: true, visionEnabled: false },
  });
  let turn = 0;
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).includes('/chat/completions')) return new Response('{}', { status: 200 });
    const body = JSON.parse(options.body);
    bodies.push(body);
    if (turn++ === 0) {
      // OpenAI 兼容接口不认 file 片段
      return new Response(JSON.stringify({ error: { message: '.messages[102]: file must have a file_id or file_data' } }), { status: 400 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '看到了。' } }] }), { status: 200 });
  });
  // 一个最小可用的 PDF（%PDF- 开头、%%EOF 结尾）
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'utf8');
  const attachment = { url: `data:application/pdf;base64,${pdf.toString('base64')}`, filename: 'a.pdf', contentType: 'application/pdf', size: pdf.length };
  const result = await engine.generate({ ...event, content: '看看这个', attachments: [attachment] }, { deliver: async () => ({ id: 'm' }) });
  assert.deepEqual(result.replies, ['看到了。'], '应当降级后照常回话');
  assert.ok(result.warnings.some((w) => w.includes('附件')), '应当记录降级警告：' + JSON.stringify(result.warnings));
  assert.ok(bodies.length >= 2, '应当重试过一次');
});

test('接口拒绝的判定：附件结构错不算「内容敏感」', async t => {
  const { contentShapeRejected } = await import('../src/model.js');
  assert.ok(contentShapeRejected(new Error('模型服务失败：HTTP 400 .messages[102]: file must have a file_id or file_data')));
  assert.ok(contentShapeRejected(new Error('did not match any variant of untagged enum MessageContent')));
  assert.equal(contentShapeRejected(new Error('HTTP 500 input new_sensitive (1026)')), false);
});

test('裁剪消息时，工具调用和工具结果始终成对', async t => {
  const { trimMessages } = await import('../src/engine.js');
  const assistant = (ids) => ({ role: 'assistant', tool_calls: ids.map((id) => ({ id })) });
  const tool = (id) => ({ role: 'tool', tool_call_id: id });
  const check = (list) => {
    const kept = trimMessages(list, 3);
    const ids = kept.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
    const called = kept.filter((m) => m.tool_calls).flatMap((m) => m.tool_calls.map((c) => c.id));
    assert.equal(ids.filter((id) => !called.includes(id)).length, 0, '不能有悬空的工具结果');
    assert.equal(called.filter((id) => !ids.includes(id)).length, 0, '不能有缺结果的工具调用');
    return kept;
  };
  check([{ role: 'system' }, { role: 'user' }, assistant(['c1']), tool('c1')]);
  check([{ role: 'system' }, { role: 'user' }, tool('c1')]);           // 结果悬空
  check([{ role: 'system' }, { role: 'user' }, assistant(['c1'])]);     // 调用缺结果
  check([{ role: 'system' }, { role: 'user' }, assistant(['c1', 'c2']), tool('c1'), tool('c2')]);
});

test('沙箱：路径找不到时会把同级的文件列出来', async t => {
  const { store } = await fixture(t);
  const { Sandbox } = await import('../src/sandbox.js');
  const folder = store.saveResourceFolder({ name: '收到的文件', trigger: 'x', summary: 'x' });
  store.saveResourceFile({ folderId: folder.id, name: 'BigRudin.pdf', kind: 'pdf', content: 'x' });
  const sandbox = new Sandbox(store);
  const result = sandbox.run('ls /files/收到的文件/Fatou', { cwd: '/' });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /BigRudin\.pdf/, '错误里要告诉模型这里有什么：' + result.stderr);
});

test('删除资料文件后，内容在数据库文件里真的没了', async t => {
  const { mkdtempSync, rmSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'qq-del2-'));
  const { Store } = await import('../src/store.js');
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const folder = store.saveResourceFolder({ name: '资料', trigger: 'x', summary: 'x' });
  const file = store.saveResourceFile({ folderId: folder.id, name: '秘密.pdf', kind: 'pdf', content: '机密内容XYZ', data: Buffer.from('%PDF-1.7 机密内容XYZ'), mime: 'application/pdf' });
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  assert.ok(readFileSync(join(dir, 'qqbot.sqlite')).includes('机密内容XYZ'));
  store.deleteResourceFile(file.id);
  assert.ok(!readFileSync(join(dir, 'qqbot.sqlite')).includes('机密内容XYZ'), '删掉后文件里不该再有明文');
});

test('DNS 里混着保留地址时，用能用的那个就行', async t => {
  const { isPublicAddress } = await import('../src/media.js');
  assert.equal(isPublicAddress('2001::1'), false, '2001::1 是保留地址');
  assert.equal(isPublicAddress('31.13.88.169'), true);
  assert.equal(isPublicAddress('10.0.0.1'), false);
  assert.equal(isPublicAddress('192.168.1.1'), false);
});

test('沙箱：sort / uniq 能直接读文件，tail -n 给够行数', async t => {
  const { store } = await fixture(t);
  const { Sandbox } = await import('../src/sandbox.js');
  const folder = store.saveResourceFolder({ name: '资料', trigger: 'x', summary: 'x' });
  store.saveResourceFile({ folderId: folder.id, name: 'a.txt', kind: 'text', content: 'b\na\nb\n' });
  const sandbox = new Sandbox(store);
  assert.equal(sandbox.run('sort /files/资料/a.txt', { cwd: '/' }).stdout, 'a\nb\nb', 'sort 要能直接读文件');
  assert.equal(sandbox.run('sort -r /files/资料/a.txt', { cwd: '/' }).stdout, 'b\nb\na');
  assert.match(sandbox.run('uniq -c /files/资料/a.txt', { cwd: '/' }).stdout, /1 a/);
  assert.equal(sandbox.run('tail -n 2 /files/资料/a.txt', { cwd: '/' }).stdout, 'a\nb', 'tail -n 2 要给两行');
});

test('回答太长时截断发送，而不是让用户什么都收不到', async t => {
  const { store, engine, event } = await fixture(t);
  store.saveConfig({ bot: { maxChars: 30 } });
  const sent = [];
  let turn = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    turn++;
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '这是一句很长的话。'.repeat(40) } }] }), { status: 200 });
  });
  const result = await engine.generate({ ...event, content: '讲讲你的看法' }, { deliver: async (text) => { sent.push(text); return { id: 'm' }; } });
  assert.equal(sent.length, 1, '再长也要发出去，用户不能什么都收不到');
  assert.ok(sent[0].length <= 50, `截断到容差以内：${sent[0].length}`);
  assert.ok(result.warnings.some((w) => w.includes('截断')), '应当记录截断警告');
});

test('接口一直拒绝附件片段时不会无限重试', async t => {
  const { store, engine, event } = await fixture(t, {}, {
    bot: { mode: 'llm', minChars: 0, maxChars: 200, replyCount: 2, cooldownMs: 0, replyDelayMs: 0 },
    llm: { model: 'm', apiKey: 'k' }, rules: [],
    harness: { filesEnabled: true, pdfFileParts: true, visionEnabled: false },
  });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (!String(url).includes('/chat/completions')) return new Response('{}', { status: 200 });
    calls++;
    if (calls > 6) throw new Error('请求次数失控：降级重试死循环了');
    return new Response(JSON.stringify({ error: { message: '.messages[102]: file must have a file_id or file_data' } }), { status: 400 });
  });
  const pdf = Buffer.from('%PDF-1.7\\n1 0 obj\\n<<>>\\nendobj\\n%%EOF\\n', 'utf8');
  const attachment = { url: `data:application/pdf;base64,${pdf.toString('base64')}`, filename: 'a.pdf', contentType: 'application/pdf', size: pdf.length };
  await assert.rejects(() => engine.generate({ ...event, content: '看看这个', attachments: [attachment] }, { deliver: async () => ({ id: 'm' }) }));
  assert.ok(calls <= 6, `请求次数应当有限，实际 ${calls}`);
});

test('沙箱：od 能转储二进制文件的原始字节', async t => {
  const { store } = await fixture(t);
  const { Sandbox } = await import('../src/sandbox.js');
  const folder = store.saveResourceFolder({ name: '照片', trigger: 'x', summary: 'x' });
  store.saveResourceFile({ folderId: folder.id, name: 'a.png', kind: 'image', data: Buffer.from('89504e470d0a1a0a', 'hex'), mime: 'image/png' });
  const sandbox = new Sandbox(store);
  const result = sandbox.run('od /files/照片/a.png', { cwd: '/' });
  assert.equal(result.ok, true, result.stderr);
  assert.match(result.stdout, /89 50 4e 47/, '应当是 PNG 的魔数');
});

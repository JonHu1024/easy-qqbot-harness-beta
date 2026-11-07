import WebSocket from 'ws';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { normalizeAttachments } from './media.js';
import { facesToText } from './emoji.js';
export { apiCatalog } from './catalog.js';

const API_HOST = 'https://api.bot.qq.com';
const SANDBOX_HOST = 'https://sandbox.api.sgroup.qq.com';
const RESPONSE_LIMIT = 4 * 1024 * 1024;
const WEBHOOK_LIMIT = 1024 * 1024;
const FILE_LIMIT = 8 * 1024 * 1024;
const FATAL_CLOSE = new Set([4001, 4002, 4003, 4004, 4005, 4010, 4011, 4012, 4013, 4014, 4914, 4915]);
// 首次连接最多重试几次；连上之后的断线重连是无限次的（除非命中致命错误）。
const MAX_START_ATTEMPTS = 4;
// 打开 QQBOT_TRACE=1 可以把网关协议细节写进日志，排查断连时用。
const TRACE = process.env.QQBOT_TRACE === '1';
// 这些业务码表示凭据或权限有问题，重试没有意义。
const AUTH_ERROR_CODES = new Set([100007, 100016, 10004, 11253]);
const CLOSE_MESSAGES = {
  4001: '无效的网关操作码', 4002: '无效的网关数据', 4003: '网关未通过鉴权',
  4004: '网关鉴权失败，请检查 AppID 和 AppSecret', 4005: '重复网关鉴权',
  4006: '会话失效，重新登录', 4007: '消息序号失效，重新登录', 4008: '网关频率受限',
  4009: '连接过期，恢复会话', 4010: '无效的分片配置', 4011: '频道数量超出单连接限制',
  4012: '无效的协议版本', 4013: '无效的事件订阅值', 4014: '事件订阅无权限，请调整 Intents',
  4914: '机器人已下架，仅能连接沙箱', 4915: '机器人已封禁',
};

function failure(message, status = 400, code, traceId) {
  const error = new Error(message);
  error.status = status;
  if (code !== undefined) error.code = code;
  if (traceId) error.traceId = traceId;
  return error;
}

function segment(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw failure(`${label}不能为空或过长`);
  return encodeURIComponent(value);
}

function scenePath(scene, targetId) {
  const id = segment(targetId, '目标 ID');
  if (scene === 'c2c') return `/v2/users/${id}`;
  if (scene === 'group') return `/v2/groups/${id}`;
  if (scene === 'channel') return `/channels/${id}`;
  if (scene === 'dm') return `/dms/${id}`;
  throw failure('消息场景必须为 c2c、group、channel 或 dm');
}

function header(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name) || '';
  const key = Object.keys(headers || {}).find(key => key.toLowerCase() === name.toLowerCase());
  const value = headers?.[key];
  return typeof value === 'string' ? value : '';
}

function signingKey(secret) {
  if (typeof secret !== 'string' || !secret) throw failure('请先配置 AppSecret');
  const bytes = Buffer.from(secret, 'utf8');
  const seed = Buffer.allocUnsafe(32);
  for (let offset = 0; offset < seed.length; offset += bytes.length) bytes.copy(seed, offset, 0, Math.min(bytes.length, seed.length - offset));
  return createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
}

const REFERENCE_TEXT_LIMIT = 64000;
function boundedString(value, limit = 512) {
  return typeof value === 'string' && value.length <= limit ? value : '';
}

function messageIndexes(scene) {
  const values = {};
  if (!Array.isArray(scene?.ext)) return values;
  for (const entry of scene.ext.slice(0, 64)) {
    if (typeof entry !== 'string' || entry.length > 1024) continue;
    const separator = entry.indexOf('=');
    const key = entry.slice(0, separator);
    if (separator > 0 && (key === 'msg_idx' || key === 'ref_msg_idx')) {
      const value = boundedString(entry.slice(separator + 1));
      if (value && !values[key]) values[key] = value;
    }
  }
  return values;
}

function referenceBody(value) {
  const result = { attachments: normalizeAttachments(value.attachments) };
  if (typeof value.content === 'string') result.content = value.content.slice(0, REFERENCE_TEXT_LIMIT);
  const authorId = boundedString(value.authorId || value.author?.user_openid || value.author?.member_openid || value.author?.id);
  if (authorId) result.authorId = authorId;
  return result;
}

// Official MsgElement is recursive. Walk at most 128 nodes / 6 levels and
// select only the requested ref_msg_idx, never other elements as instructions.
function inlineReference(elements, refIndex) {
  if (!refIndex || !Array.isArray(elements)) return null;
  const queue = elements.slice(0, 128).map(value => ({ value, depth: 0 }));
  const seen = new Set();
  for (let cursor = 0; cursor < queue.length && cursor < 128; cursor++) {
    const { value, depth } = queue[cursor];
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (boundedString(value.msg_idx) === refIndex) return referenceBody(value);
    if (depth < 5 && Array.isArray(value.msg_elements)) {
      for (const child of value.msg_elements.slice(0, 128 - queue.length)) queue.push({ value: child, depth: depth + 1 });
    }
  }
  return null;
}

export function normalizeEvent(payload) {
  if (!payload || payload.op !== 0 || !payload.d || typeof payload.d !== 'object') return null;
  const d = payload.d;
  if (d.author?.bot === true) return null;
  let scene;
  let targetId;
  let userId;
  switch (payload.t) {
    case 'C2C_MESSAGE_CREATE':
      scene = 'c2c';
      userId = d.author?.user_openid || d.author?.id;
      targetId = userId;
      break;
    case 'GROUP_AT_MESSAGE_CREATE':
    case 'GROUP_MESSAGE_CREATE':
      scene = 'group';
      userId = d.author?.member_openid || d.author?.id;
      targetId = d.group_openid;
      break;
    case 'AT_MESSAGE_CREATE':
    case 'MESSAGE_CREATE':
      scene = 'channel';
      userId = d.author?.id;
      targetId = d.channel_id;
      break;
    case 'DIRECT_MESSAGE_CREATE':
      scene = 'dm';
      userId = d.author?.id;
      targetId = d.guild_id;
      break;
    default:
      return null;
  }
  if (!targetId || !userId || !d.id) return null;
  let content = typeof d.content === 'string' ? d.content : '';
  if (payload.t === 'AT_MESSAGE_CREATE' || payload.t === 'GROUP_AT_MESSAGE_CREATE') content = content.replace(/^\s*<@!?[^>]+>\s*/, '');
  // QQ 原生表情以 <faceType=..,faceId=..,ext=base64> 形式下发；转成可读 emoji/名称，
  // 避免把 base64 标记塞进模型上下文，也避免模型照抄标记回发。
  content = facesToText(content);
  const indexes = messageIndexes(d.message_scene);
  const messageId = boundedString(d.message_reference?.message_id);
  const refIndex = indexes.ref_msg_idx;
  let reference;
  if (messageId || refIndex || d.message_type === 103) {
    const body = inlineReference(d.msg_elements, refIndex);
    reference = { ...(messageId ? { messageId } : {}), ...(refIndex ? { refIndex } : {}),
      ...(body || {}), source: body && (body.content || body.attachments.length) ? 'event' : 'unavailable' };
  }
  return {
    scene, targetId: String(targetId), userId: String(userId), content: content.trim(),
    msgId: String(d.id), eventId: payload.id ? String(payload.id) : '',
    timestamp: d.timestamp || '', attachments: normalizeAttachments(d.attachments),
    senderName: boundedString(d.member?.nick || d.author?.username, 256),
    messageIndex: indexes.msg_idx || '', ...(reference ? { reference } : {}),
  };
}

export class QQClient {
  constructor({ getConfig, log = () => {}, onEvent = () => {} }) {
    if (typeof getConfig !== 'function') throw new TypeError('getConfig 必须是函数');
    this.getConfig = getConfig;
    this.log = log;
    this.onEvent = onEvent;
    this.running = false;
    this.state = 'stopped';
    this.lastError = '';
    this.identity = null;
    this.lastEventAt = null;
    this._transport = null;
    this._generation = 0;
    this._tokenVersion = 0;
    this._token = null;
    this._tokenFlight = null;
    this._startPromise = null;
    this._controller = null;
    this._ws = null;
    this._heartbeat = null;
    this._watchdog = null;
    this._reconnect = null;
    this._sessionId = null;
    this._seq = null;
    this._attempts = 0;
    this._recentCloses = [];
  }

  _qq() {
    const config = this.getConfig();
    return config.qq || config;
  }

  status() {
    return {
      running: this.running, state: this.state, lastError: this.lastError,
      identity: this.identity, transport: this._transport || this._qq().transport || 'websocket', lastEventAt: this.lastEventAt,
    };
  }

  invalidate() {
    this._tokenVersion++;
    this._token = null;
    this._tokenFlight = null;
  }

  _safe(message) {
    let text = String(message || 'QQ 请求失败');
    for (const value of [this._qq().appSecret, this._token?.value]) {
      if (value) text = text.split(value).join('[已隐藏]');
    }
    return text.replace(/QQBot\s+[^\s"']+/gi, 'QQBot [已隐藏]')
      .replace(/((?:access_token|clientSecret|appSecret|authorization)\s*[=:]\s*)[^\s,}]+/gi, '$1[已隐藏]').slice(0, 500);
  }

  _record(error) {
    this.lastError = this._safe(error.message);
    this.log('error', this.lastError, { code: error.code, status: error.status, traceId: error.traceId });
  }

  async _fetch(url, { method = 'GET', headers, body, timeoutMs = 20000, signal, rawResponse = false } = {}) {
    const lifecycle = this.running ? this._controller?.signal : null;
    const signals = [AbortSignal.timeout(timeoutMs), lifecycle, signal].filter(Boolean);
    try {
      const response = await fetch(url, { method, headers, body, signal: AbortSignal.any(signals), redirect: 'error' });
      const size = Number(response.headers.get('content-length'));
      if (size > RESPONSE_LIMIT) {
        await response.body?.cancel();
        throw failure('QQ 响应超过 4MB 限制', 502);
      }
      const chunks = [];
      let total = 0;
      if (response.body) {
        for await (const chunk of response.body) {
          total += chunk.length;
          if (total > RESPONSE_LIMIT) throw failure('QQ 响应超过 4MB 限制', 502);
          chunks.push(chunk);
        }
      }
      const text = Buffer.concat(chunks, total).toString('utf8');
      const traceId = response.headers.get('x-tps-trace-id') || response.headers.get('x-trace-id');
      if (rawResponse) {
        if (!response.ok) throw failure(`分片上传失败（HTTP ${response.status}）`, 502, response.status);
        return {};
      }
      let data = {};
      if (text.trim()) {
        try { data = JSON.parse(text); }
        catch { throw failure(`QQ 返回非 JSON 响应（HTTP ${response.status}）`, 502, response.status, traceId); }
      }
      const code = [data?.code, data?.err_code].find(value => value !== undefined && value !== null && value !== '' && Number(value) !== 0);
      if (!response.ok || code !== undefined) {
        const message = this._safe(data?.message || data?.msg || data?.err_msg || `QQ API HTTP ${response.status}`);
        throw failure(message, response.ok ? 502 : response.status, code, traceId || data?.trace_id);
      }
      return data;
    } catch (error) {
      if (error.status) throw error;
      if (signals.some(signal => signal.aborted)) throw failure(lifecycle?.aborted || signal?.aborted ? '操作已取消' : 'QQ 请求超时', lifecycle?.aborted || signal?.aborted ? 499 : 504);
      throw failure('无法连接 QQ 服务，请检查网络、代理和服务状态', 502);
    }
  }

  async _accessToken() {
    const { appId, appSecret } = this._qq();
    if (!appId || !appSecret) throw failure('请先填写 QQ AppID 和 AppSecret');
    const key = `${appId}\0${appSecret}`;
    if (this._token?.key === key && Date.now() < this._token.expiresAt) return this._token.value;
    if (this._tokenFlight?.key === key) return this._tokenFlight.promise;
    const version = this._tokenVersion;
    const flight = { key };
    flight.promise = (async () => {
      const data = await this._fetch(`${API_HOST}/app/getAppAccessToken`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, clientSecret: appSecret }),
      });
      const expires = Number(data.expires_in);
      if (typeof data.access_token !== 'string' || !data.access_token || !Number.isFinite(expires) || expires <= 0) throw failure('QQ 凭证响应缺少有效 access_token 或 expires_in', 502);
      if (version === this._tokenVersion) this._token = { key, value: data.access_token, expiresAt: Date.now() + (expires - Math.min(60, expires * 0.1)) * 1000 };
      return data.access_token;
    })();
    this._tokenFlight = flight;
    try { return await flight.promise; }
    finally { if (this._tokenFlight === flight) this._tokenFlight = null; }
  }

  async request(method, path, body) {
    if (typeof method !== 'string' || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) throw failure('不支持的 HTTP 方法');
    method = method.toUpperCase();
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\#\u0000-\u0020]/.test(path) || path.length > 4096) throw failure('API 路径必须是 QQ 相对路径，例如 /users/@me');
    if (method === 'GET' && body !== undefined && body !== null) throw failure('GET 参数请填写在路径的查询字符串中，不支持请求体');
    const origin = this._qq().sandbox ? SANDBOX_HOST : API_HOST;
    const url = new URL(path, origin);
    if (url.origin !== origin || url.username || url.password) throw failure('只允许请求固定 QQ API 域名');
    const token = await this._accessToken();
    let serialized;
    if (body !== undefined && body !== null) {
      try { serialized = JSON.stringify(body); }
      catch { throw failure('请求体必须是可序列化 JSON'); }
      if (Buffer.byteLength(serialized) > 12 * 1024 * 1024) throw failure('QQ 请求体超过 12MB 限制', 413);
    }
    try {
      return await this._fetch(url, {
        method, headers: { Authorization: `QQBot ${token}`, 'X-Union-Appid': String(this._qq().appId), 'Content-Type': 'application/json' }, body: serialized,
      });
    } catch (error) {
      error.message = this._safe(error.message).split(token).join('[已隐藏]');
      if (error.status === 401) this.invalidate();
      throw error;
    }
  }

  async resolveReference(event, store) {
    if (!event?.reference) return { ...event };
    const reference = { ...event.reference };
    const enriched = { ...event, reference };
    if (reference.source === 'event' && (reference.content || reference.attachments?.length)) return enriched;
    const appId = String(this._qq().appId || '');
    const local = appId && (reference.messageId || reference.refIndex) && typeof store?.findReferencedMessage === 'function'
      ? await store.findReferencedMessage({ appId, scene: event.scene, targetId: event.targetId,
        userId: event.userId, messageId: reference.messageId, refIndex: reference.refIndex })
      : null;
    if (local) {
      const body = referenceBody(local);
      if (body.content || body.attachments.length) {
        enriched.reference = { ...reference, ...body, source: 'local' };
        return enriched;
      }
    }
    // QQ's documented SDK get_message is channel-only; there is no documented
    // v2 user/group lookup. DM guild_id is not a channel_id either.
    // https://bot.q.qq.com/wiki/develop/pythonsdk/api/message/get_message.html
    if (event.scene === 'channel' && reference.messageId) {
      try {
        const data = await this.request('GET', `/channels/${segment(event.targetId, '频道 ID')}/messages/${segment(reference.messageId, '引用消息 ID')}`);
        const message = data?.message || data;
        if (String(message?.id || '') === reference.messageId && String(message?.channel_id || '') === event.targetId) {
          const body = referenceBody(message);
          if (body.content || body.attachments.length) {
            enriched.reference = { ...reference, ...body, source: 'api' };
            return enriched;
          }
        }
      } catch {
        // Missing read permission, expired/deleted message or network failure:
        // retain an explicit unavailable state, never invent quoted content.
      }
    }
    enriched.reference = { ...reference, source: 'unavailable' };
    delete enriched.reference.content;
    delete enriched.reference.attachments;
    delete enriched.reference.authorId;
    return enriched;
  }

  // 用户资料：QQ 官方只在「群成员」与「频道成员」接口里返回昵称，
  // 单聊（c2c）官方没有提供任何查询用户昵称的接口 —— 只能拿到 user_openid。
  // https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_members_member_openid.get.html
  async memberProfile(scene, targetId, userId) {
    if (!targetId || !userId) return null;
    if (scene === 'group') {
      const data = await this.request('GET', `/v2/groups/${segment(targetId, '群 OpenID')}/members/${segment(userId, '成员 OpenID')}`);
      const member = data?.member || data || {};
      return {
        name: boundedString(member.username, 64),
        role: boundedString(member.member_role, 32),
        avatar: boundedString(member.avatar, 512),
        joinedAt: boundedString(member.joined_at, 64),
        source: 'api',
      };
    }
    if (scene === 'channel') {
      const data = await this.request('GET', `/channels/${segment(targetId, '频道 ID')}/members/${segment(userId, '用户 ID')}`);
      const member = data?.member || data || {};
      return {
        name: boundedString(member.nick || member.username, 64),
        role: boundedString(member.role_id ? String(member.role_id) : '', 32),
        avatar: boundedString(member.avatar, 512),
        source: 'api',
      };
    }
    return null;
  }

  // 群资料：官方接口返回群名，缺失时让控制台也能显示「群聊 3E5D…」而不是一串代码。
  async groupProfile(targetId) {
    if (!targetId) return null;
    const data = await this.request('GET', `/v2/groups/${segment(targetId, '群 OpenID')}/info`);
    const group = data?.group || data || {};
    return {
      name: boundedString(group.group_name || group.name, 64),
      memberCount: Number.isFinite(group.member_count) ? group.member_count : null,
      source: 'api',
    };
  }

  async start() {
    if (this._startPromise) return this._startPromise;
    if (this.running) return this.status();
    const qq = this._qq();
    if (!qq.appId || !qq.appSecret) throw failure('请先填写 QQ AppID 和 AppSecret');
    if (!['websocket', 'webhook'].includes(qq.transport || 'websocket')) throw failure('不支持的接入方式');
    const generation = ++this._generation;
    this._controller = new AbortController();
    this._transport = qq.transport || 'websocket';
    this.running = true;
    this.state = 'connecting';
    this.lastError = '';
    this.identity = null;
    this._sessionId = null;
    this._seq = null;
    this._attempts = 0;
    const promise = (async () => {
      try {
        const identity = await this.request('GET', '/users/@me');
        if (!this._active(generation)) throw failure('启动已取消', 499);
        this.identity = identity;
        if (this._transport === 'webhook') {
          this.state = 'listening';
          this.log('info', 'Webhook 接入已启动，等待平台推送（需配置公网 HTTPS 回调）');
        } else await this._connect(generation, MAX_START_ATTEMPTS);
        return this.status();
      } catch (error) {
        if (this._active(generation)) {
          this._record(error);
          this.running = false;
          this.state = 'error';
          this._generation++;
          this._controller.abort();
          this._clearConnection();
        }
        throw error;
      }
    })();
    this._startPromise = promise;
    try { return await promise; }
    finally { if (this._startPromise === promise) this._startPromise = null; }
  }

  async stop() {
    this.running = false;
    this._generation++;
    this._controller?.abort();
    this._startPromise = null;
    this._clearConnection();
    this._sessionId = null;
    this._seq = null;
    this.state = 'stopped';
    this.lastError = '';
    return this.status();
  }

  _active(generation, ws) {
    return this.running && this._generation === generation && (!ws || this._ws === ws);
  }

  _clearConnection() {
    clearInterval(this._heartbeat);
    clearInterval(this._watchdog);
    clearTimeout(this._reconnect);
    this._heartbeat = null;
    this._watchdog = null;
    this._reconnect = null;
    const ws = this._ws;
    this._ws = null;
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.terminate();
  }

  async _connect(generation, maxAttempts = Infinity) {
    // 首次连接与断线重连都走这里：内部循环重试，单次失败不会让机器人直接掉线。
    for (;;) {
      if (!this._active(generation)) throw failure('连接已取消', 499);
      try {
        await this._connectOnce(generation);
        return;
      } catch (error) {
        if (!this._active(generation)) throw error;
        if (error.status === 401 || error.status === 403 || AUTH_ERROR_CODES.has(Number(error.code))) error.fatal = true;
        if (error.fatal) throw error;
        this._attempts++;
        if (this._attempts >= maxAttempts) throw error;
        const delay = this._backoff();
        this.state = 'reconnecting';
        this.lastError = `${error.message}（${Math.round(delay / 1000)} 秒后重试）`;
        this.log('warn', `QQ 网关连接失败，${delay}ms 后重试`, { attempt: this._attempts, error: error.message });
        await this._sleep(delay, generation);
      }
    }
  }

  _backoff(minimum = 0) {
    const base = Math.min(30000, 1000 * 2 ** Math.min(this._attempts, 5));
    return Math.max(minimum, base) + Math.floor(Math.random() * 500);
  }

  _sleep(ms, generation) {
    const lifecycle = this._controller?.signal;
    return new Promise((resolve, reject) => {
      if (!lifecycle || lifecycle.aborted) return reject(failure('连接已取消', 499));
      const onAbort = () => { clearTimeout(timer); reject(failure('连接已取消', 499)); };
      const timer = setTimeout(() => { lifecycle.removeEventListener('abort', onAbort); resolve(); }, ms);
      lifecycle.addEventListener('abort', onAbort, { once: true });
    });
  }

  async _connectOnce(generation) {
    const gateway = await this.request('GET', '/gateway');
    if (!this._active(generation)) throw failure('连接已取消', 499);
    let address;
    try { address = new URL(gateway.url); } catch { throw failure('QQ 网关返回无效地址', 502); }
    if (address.protocol !== 'wss:' || !address.hostname.endsWith('.qq.com') || address.username || address.password) throw failure('QQ 网关地址不安全', 502);
    const token = await this._accessToken();
    if (!this._active(generation)) throw failure('连接已取消', 499);
    const ws = new WebSocket(address, { handshakeTimeout: 20000, maxPayload: RESPONSE_LIMIT, followRedirects: false });
    this._ws = ws;
    this.state = this._sessionId ? 'resuming' : 'connecting';
    let helloSeen = false;
    let queue = Promise.resolve();
    const lifecycle = this._controller.signal;
    return new Promise((resolve, reject) => {
      let settled = false;
      let interval = 30000;
      let lastAckAt = Date.now();
      let lastActivityAt = Date.now();
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        lifecycle.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve();
      };
      const cancel = () => { finish(failure('连接已取消', 499)); ws.terminate(); };
      const deadline = setTimeout(() => {
        finish(failure('QQ 网关登录超时，请检查接入权限和网络', 504));
        ws.terminate();
      }, 25000);
      lifecycle.addEventListener('abort', cancel, { once: true });
      const send = payload => {
        if (this._active(generation, ws) && ws.readyState === WebSocket.OPEN) {
          if (TRACE) this.log('info', `[trace] 发送 op=${payload.op}`, { op: payload.op });
          ws.send(JSON.stringify(payload));
        } else if (TRACE) this.log('info', `[trace] 发送被跳过 op=${payload.op} readyState=${ws.readyState}`, { op: payload.op });
      };
      const stopTimers = () => {
        clearInterval(this._heartbeat); this._heartbeat = null;
        clearInterval(this._watchdog); this._watchdog = null;
      };
      // 心跳：客户端发 op=1，平台回 op=11 作为应答。
      // 平台也可能主动发 op=1 要求我们回应 —— 那种情况平台不会再回 op=11，
      // 旧实现把它记成“心跳未应答”，于是每隔一个周期就误判掉线并主动断开。
      // 现在改为按“最后一次应答距今多久”判断，并留两个周期的宽限。
      const startTimers = () => {
        stopTimers();
        this._heartbeat = setInterval(() => {
          if (!this._active(generation, ws)) return;
          const now = Date.now();
          if (now - lastAckAt > interval * 2 + 5000) {
            this.lastError = 'QQ 网关心跳长时间没有应答，正在重连';
            this.log('warn', this.lastError, { silentMs: now - lastAckAt });
            try { ws.terminate(); } catch { /* 已经断开 */ }
            return;
          }
          send({ op: 1, d: this._seq });
        }, interval);
        // 看门狗：连接可能变成“半开”（网络中断但 TCP 没有立刻断开），
        // 表现是长时间收不到任何数据；此时主动断开并重连。
        this._watchdog = setInterval(() => {
          if (!this._active(generation, ws)) return;
          const silent = Date.now() - lastActivityAt;
          if (silent > Math.max(interval * 3, 60000)) {
            this.lastError = `QQ 网关已 ${Math.round(silent / 1000)} 秒没有数据，正在重连`;
            this.log('warn', this.lastError, { silentMs: silent });
            try { ws.terminate(); } catch { /* 已经断开 */ }
          }
        }, Math.max(15000, Math.floor(interval / 2)));
      };
      ws.on('message', bytes => {
        if (!this._active(generation, ws)) return;
        lastActivityAt = Date.now();
        let payload;
        try { payload = JSON.parse(bytes.toString('utf8')); }
        catch { finish(failure('QQ 网关返回无效 JSON', 502)); ws.terminate(); return; }
        if (TRACE) this.log('info', `[trace] 收到 op=${payload.op}${payload.t ? ' t=' + payload.t : ''}${payload.s !== undefined ? ' s=' + payload.s : ''}`, { op: payload.op, t: payload.t });
        if (payload.op === 11) { lastAckAt = Date.now(); return; }
        // 平台要求心跳：直接回应即可，绝不能改写“应答状态”，否则会误判掉线。
        if (payload.op === 1) { send({ op: 1, d: this._seq }); return; }
        if (payload.op === 10) {
          if (helloSeen) return;
          helloSeen = true;
          const value = Number(payload.d?.heartbeat_interval);
          if (!Number.isFinite(value) || value < 1000 || value > 300000) { finish(failure('无效的 QQ 网关心跳周期', 502)); ws.terminate(); return; }
          interval = value;
          lastAckAt = Date.now();
          startTimers();
          send({ op: 1, d: this._seq });
          if (this._sessionId) send({ op: 6, d: { token: `QQBot ${token}`, session_id: this._sessionId, seq: this._seq } });
          else send({ op: 2, d: { token: `QQBot ${token}`, intents: this._qq().intents ?? 33554432, shard: [0, 1], properties: { $os: process.platform, $browser: 'qqbot-web', $device: 'qqbot-web' } } });
          return;
        }
        if (payload.op === 7 || payload.op === 9) {
          if (payload.op === 9 && payload.d !== true) { this._sessionId = null; this._seq = null; }
          this.lastError = payload.op === 9 ? 'QQ 网关会话无效，正在重新登录' : 'QQ 网关要求重新连接';
          ws.terminate();
          return;
        }
        if (payload.op !== 0) return;
        // 先推进消息序号：即使后面的事件处理出错，恢复会话时也要用正确的 seq。
        if (Number.isInteger(payload.s)) this._seq = payload.s;
        queue = queue.then(async () => {
          if (!this._active(generation, ws)) return;
          if (payload.t === 'READY') {
            if (typeof payload.d?.session_id !== 'string' || !payload.d.session_id) throw failure('QQ 登录响应缺少 session_id', 502);
            this._sessionId = payload.d.session_id;
            this.identity = payload.d.user || this.identity;
            this.state = 'connected';
            this.lastError = '';
            this._attempts = 0;
            this.log('info', 'QQ WebSocket 已连接');
            finish();
          } else if (payload.t === 'RESUMED') {
            this.state = 'connected';
            this.lastError = '';
            this._attempts = 0;
            this.log('info', 'QQ WebSocket 会话已恢复');
            finish();
          } else {
            this.lastEventAt = new Date().toISOString();
            const author = payload.d?.author;
            if (!author?.bot && (!this.identity?.id || String(author?.id || author?.user_openid || author?.member_openid || '') !== String(this.identity.id))) await this.onEvent(payload);
          }
        }).catch(error => {
          // 单个事件处理失败不能拖垮整条连接：只记录日志，连接继续使用。
          if (!this._active(generation, ws)) return;
          this._record(error);
        });
      });
      ws.on('error', () => {
        if (!this._active(generation, ws)) return;
        const error = failure('QQ WebSocket 连接失败，请检查网络和接入权限', 502);
        this._record(error);
        finish(error);
      });
      ws.on('close', code => {
        clearTimeout(deadline);
        stopTimers();
        if (TRACE) this.log('info', `[trace] socket close code=${code} active=${this._active(generation, ws)} wsIsCurrent=${this._ws === ws}`, { code });
        if (!this._active(generation, ws)) { finish(failure('连接已取消', 499)); return; }
        this._ws = null;
        const error = failure(CLOSE_MESSAGES[code] || `QQ 网关连接断开（${code}）`, 502, code);
        if (FATAL_CLOSE.has(code)) {
          error.fatal = true;
          this._record(error);
          this.running = false;
          this.state = 'error';
          this._generation++;
          this._controller.abort();
          finish(error);
          return;
        }
        if ([4006, 4007, 4009].includes(code) || (code >= 4900 && code <= 4913)) { this._sessionId = null; this._seq = null; }
        this.lastError = error.message;
        // 非致命断开也要留痕：没有关闭码就永远查不出断联原因。
        // 4009 = 会话过期，这是平台每隔一段时间就会来的正常轮换，会自动重连并恢复。
        // 别把它当故障刷 warn；其它断开码才需要留意。
        const expected=code===4009;
        this.log(expected ? 'info' : 'warn', `QQ 网关连接断开：${CLOSE_MESSAGES[code] || `连接断开（${code}）`}`,
          { code, reason: error.message, attempts: this._attempts });
        // 短时间内反复断开，最常见的原因是本机有第二个实例在用同一个 AppID：
        // 网关收到新的 identify 后会让旧会话失效，两个实例就会互相踢下线。
        this._recentCloses.push(Date.now());
        this._recentCloses = this._recentCloses.filter(time => Date.now() - time < 120000);
        if (this._recentCloses.length >= 3) {
          this.log('error', 'QQ 网关在 2 分钟内断开 3 次以上：很可能有另一个实例在用同一个 AppID 连接，'
            + '两个实例会互相踢掉对方的会话。请确认只运行了一个机器人进程（控制台也会用锁文件拦截第二个实例）。',
            { closes: this._recentCloses.length });
          this._recentCloses = [];
        }
        if (!settled) { finish(error); return; }
        // 已经连上过：保持运行，稍后自动重连。
        this.state = 'reconnecting';
        this._scheduleReconnect(generation, code === 4008 ? 10000 : 0);
      });
    });
  }

  _scheduleReconnect(generation, minimum = 0) {
    if (!this._active(generation) || this._reconnect) return;
    this.state = 'reconnecting';
    const delay = this._backoff(minimum);
    this._reconnect = setTimeout(async () => {
      this._reconnect = null;
      if (!this._active(generation)) return;
      try { await this._connect(generation); }
      catch (error) {
        if (!this._active(generation)) return;
        this._record(error);
        if (error.fatal || error.status === 401 || error.status === 403) {
          this.running = false;
          this.state = 'error';
          this._generation++;
          this._controller.abort();
          this._clearConnection();
        } else this._scheduleReconnect(generation);
      }
    }, delay);
  }

  async send({ scene, targetId, msgId, eventId, seq = 1, content, type = 'text', markdown, keyboard, media, card, reference, isWakeup, inputNotify, extra = {} }) {
    const path = `${scenePath(scene, targetId)}/messages`;
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw failure('extra 必须是 JSON 对象');
    const body = { ...extra };
    const types = { text: 0, markdown: 2, button: 2, buttons: 2, keyboard: 2, media: 7, input: 6, inputNotify: 6, input_notify: 6, card: 8 };
    const msgType = typeof type === 'number' ? type : types[type];
    if (![0, 2, 6, 7, 8].includes(msgType)) throw failure('消息类型必须为 text、markdown、button、media、input 或 card');
    const v2 = scene === 'c2c' || scene === 'group';
    if (body.msg_type !== undefined && body.msg_type !== msgType) throw failure('extra.msg_type 与所选消息类型不一致');
    if (v2) body.msg_type = msgType;
    else if (body.msg_type !== undefined) throw failure('频道和频道私信不使用 msg_type');
    for (const [key, value] of Object.entries({ msg_id: msgId, event_id: eventId, content, markdown, keyboard, media, card, message_reference: reference, is_wakeup: isWakeup, input_notify: inputNotify })) {
      if (value !== undefined && value !== null && value !== '') body[key] = value;
    }
    if (v2) body.msg_seq = extra.msg_seq ?? seq;
    const passive = [body.msg_id, body.event_id, body.is_wakeup === true].filter(Boolean).length;
    if (passive > 1) throw failure('msg_id、event_id、is_wakeup 不能同时使用');
    if (body.is_wakeup !== undefined && typeof body.is_wakeup !== 'boolean') throw failure('is_wakeup 必须是布尔值');
    if (body.is_wakeup !== undefined && scene !== 'c2c') throw failure('互动召回消息仅支持 QQ 单聊');
    if (v2 && (!Number.isInteger(body.msg_seq) || body.msg_seq < 1 || body.msg_seq > (scene === 'c2c' ? 4 : 5))) throw failure(`消息序号必须是 1–${scene === 'c2c' ? 4 : 5} 的整数`);
    if (msgType === 2) {
      if (!body.markdown && typeof content === 'string' && content.trim()) { body.markdown = { content }; delete body.content; }
      if (!body.markdown || typeof body.markdown !== 'object' || Array.isArray(body.markdown)) throw failure('Markdown 或按钮消息需要 markdown 对象');
      if (body.content || body.ark) throw failure('Markdown 消息不能同时包含 content 或 ark');
      if (body.media || body.input_notify) throw failure('Markdown 消息不能同时包含 media 或 input_notify');
    } else if (body.markdown) throw failure('markdown 字段只能用于 Markdown 或按钮消息');
    if (msgType === 7) {
      if (!v2) throw failure('频道图片请用 text 类型的 extra.image；media.file_info 仅支持 QQ 单聊和群聊');
      if (!body.media || typeof body.media.file_info !== 'string' || !body.media.file_info) throw failure('富媒体消息需要 media.file_info，请先上传');
      if (body.input_notify) throw failure('富媒体消息不能包含 input_notify');
    } else if (body.media) throw failure('media 字段只能用于富媒体消息');
    if (msgType === 6) {
      if (scene !== 'c2c') throw failure('输入状态通知仅支持 QQ 单聊');
      if (!body.input_notify || body.input_notify.input_type !== 1 || !Number.isInteger(body.input_notify.input_second) || body.input_notify.input_second < 1 || body.input_notify.input_second > 60) throw failure('input_notify 需要 input_type=1，input_second 为 1–60 的整数');
      if (body.content || body.keyboard || body.ark || body.message_reference) throw failure('输入状态通知不能包含消息内容、键盘或引用');
    } else if (body.input_notify) throw failure('input_notify 只能用于 input 类型');
    if (msgType === 8) {
      // 图文卡片：msg_type=8，必须带 card 对象，url/pic_url 必须是 HTTPS。
      if (!body.card || typeof body.card !== 'object' || Array.isArray(body.card)) throw failure('图文卡片需要 card 对象');
      const card = body.card;
      const text = card.content && typeof card.content === 'object' ? card.content : card;
      if (!text.title || !text.description || !text.url) throw failure('图文卡片需要 title、description、url');
      if (typeof text.title !== 'string' || text.title.length > 50) throw failure('图文卡片标题最多50字符');
      if (typeof text.description !== 'string' || text.description.length > 200) throw failure('图文卡片描述最多200字符');
      if (typeof text.url !== 'string' || !/^https:\/\/\S+$/i.test(text.url)) throw failure('图文卡片的 url 必须是 HTTPS 地址');
      if (text.pic_url !== undefined && (typeof text.pic_url !== 'string' || !/^https:\/\/\S+$/i.test(text.pic_url))) throw failure('图文卡片的 pic_url 必须是 HTTPS 地址');
      if (body.content || body.markdown || body.media) throw failure('图文卡片不能同时包含 content、markdown 或 media');
    } else if (body.card) throw failure('card 字段只能用于图文卡片消息');
    if (msgType === 0 && !body.content && !(scene === 'channel' || scene === 'dm') && !body.keyboard) throw failure('文本消息内容不能为空');
    if (!v2 && !body.content && !body.markdown && !body.image && !body.embed && !body.ark) throw failure('频道消息至少需要文本、Markdown、图片、embed 或 ark');
    if (body.keyboard && (typeof body.keyboard !== 'object' || Array.isArray(body.keyboard) || (body.keyboard.id && body.keyboard.content))) throw failure('keyboard 必须是对象，id 与 content 二选一');
    if (body.message_reference && (typeof body.message_reference.message_id !== 'string' || !body.message_reference.message_id)) throw failure('引用回复需要 message_reference.message_id');
    return this.request('POST', path, body);
  }

  async upload({ scene, targetId, url, fileType = 1, fileData, fileName, maxBytes = FILE_LIMIT }) {
    const path = scenePath(scene, targetId);
    if (!['c2c', 'group'].includes(scene)) throw failure('文件上传只支持 QQ 单聊和群聊；频道图片可用 extra.image URL');
    if (!Number.isInteger(fileType) || fileType < 1 || fileType > 4) throw failure('fileType 必须为 1 图片、2 视频、3 语音或 4 文件');
    if (Boolean(url) === Boolean(fileData)) throw failure('url 和 fileData 必须且只能填写一个');
    if (url) {
      let address;
      try { address = new URL(url); } catch { throw failure('媒体 URL 无效'); }
      if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) throw failure('媒体 URL 必须为 HTTP 或 HTTPS');
      return this.request('POST', `${path}/files`, { file_type: fileType, url, srv_send_msg: false });
    }
    if (typeof fileData !== 'string') throw failure('fileData 必须是 Base64 字符串');
    const limit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, 64 * 1024 * 1024) : FILE_LIMIT;
    const label = limit >= 1024 * 1024 ? `${Math.round(limit / 1024 / 1024)}MB` : `${limit}字节`;
    const encoded = fileData.replace(/^data:[^;,]+;base64,/, '');
    if (!encoded || encoded.length > Math.ceil(limit / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw failure(`Base64 文件无效或超过 ${label} 限制`, 413);
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > limit) throw failure(`文件为空或超过 ${label} 限制`, 413);
    const name = fileName || ['','image.png','video.mp4','audio.silk','file.bin'][fileType];
    if (typeof name !== 'string' || name.length > 255 || /[/\\\u0000-\u001f]/.test(name)) throw failure('文件名无效或超过255字符');
    const hash = (algorithm, data) => createHash(algorithm).update(data).digest('hex');
    const prepared = await this.request('POST', `${path}/upload_prepare`, {
      file_type: fileType, file_size: String(bytes.length), file_name: name,
      md5: hash('md5', bytes), sha1: hash('sha1', bytes), md5_10m: hash('md5', bytes.subarray(0, 10002432)),
    });
    if (!prepared.upload_id || !Array.isArray(prepared.parts)) throw failure('QQ 预上传响应缺少 upload_id 或 parts', 502);
    const defaultBlock = Number(prepared.block_size);
    // QQ 的 part.index 实测从 1 开始（不是数组下标），因此按返回的 index 排序后逐个上传，
    // 只校验递增与大小合法，不再要求 index 等于循环下标。
    const parts = [...prepared.parts].sort((a,b) => Number(a.index) - Number(b.index));
    let offset = 0, previousIndex = -Infinity;
    for (const part of parts) {
      const index = Number(part.index);
      const block = Number(part.block_size ?? defaultBlock);
      if (!Number.isSafeInteger(index) || index <= previousIndex || !Number.isSafeInteger(block) || block <= 0 || offset >= bytes.length) throw failure('QQ 返回无效的上传分片信息', 502);
      previousIndex = index;
      const size = Math.min(block,bytes.length-offset);
      let destination;
      try { destination = new URL(part.presigned_url); } catch { throw failure('QQ 返回无效的分片上传地址', 502); }
      if (destination.protocol !== 'https:' || destination.username || destination.password || !/(?:^|\.)(?:myqcloud\.com|qcloud\.com|qq\.com)$/.test(destination.hostname)) throw failure('QQ 返回非可信 HTTPS 分片上传地址', 502);
      const chunk = bytes.subarray(offset, offset + size);
      await this._fetch(destination, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: chunk, timeoutMs: 60000, rawResponse: true });
      await this.request('POST', `${path}/upload_part_finish`, { upload_id: prepared.upload_id, part_index: part.index, block_size: String(chunk.length), md5: hash('md5', chunk) });
      offset += size;
    }
    if (parts.length && offset !== bytes.length) throw failure('QQ 返回的分片总大小与文件不一致', 502);
    if (!parts.length && bytes.length) throw failure('QQ 未返回任何上传分片，无法上传该文件', 502);
    return this.request('POST', `${path}/files`, { file_type: fileType, file_name: name, upload_id: prepared.upload_id, srv_send_msg: false });
  }

  async recall({ scene, targetId, messageId }) {
    const path = `${scenePath(scene, targetId)}/messages/${segment(messageId, '消息 ID')}`;
    return this.request('DELETE', path);
  }

  handleWebhook(raw, headers) {
    if (!Buffer.isBuffer(raw) || raw.length > WEBHOOK_LIMIT) throw failure('Webhook 请求体无效或超过 1MB 限制', 413);
    const qq = this._qq();
    if (!qq.appId || !qq.appSecret) throw failure('QQ 凭证未配置', 503);
    if (header(headers, 'X-Bot-Appid') !== String(qq.appId)) throw failure('Webhook AppID 不匹配', 401);
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { throw failure('Webhook JSON 无效'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw failure('Webhook 数据结构无效');
    const key = signingKey(qq.appSecret);
    const signature = header(headers, 'X-Signature-Ed25519');
    const timestamp = header(headers, 'X-Signature-Timestamp');
    // 官方 op=13 地址验证不携带签名头；只有该挑战可以走此分支。
    if (payload.op === 13 && !signature && !timestamp) {
      if (typeof payload.d?.plain_token !== 'string' || !payload.d.plain_token || payload.d.plain_token.length > 4096 || typeof payload.d.event_ts !== 'string' || !/^\d{10,13}$/.test(payload.d.event_ts)) throw failure('Webhook 地址验证参数无效');
      return { body: { plain_token: payload.d.plain_token, signature: sign(null, Buffer.from(payload.d.event_ts + payload.d.plain_token), key).toString('hex') } };
    }
    if (!/^[a-fA-F0-9]{128}$/.test(signature) || !/^\d{10}$/.test(timestamp)) throw failure('Webhook 缺少有效签名或时间戳', 401);
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw failure('Webhook 签名时间戳已过期', 401);
    if (!verify(null, Buffer.concat([Buffer.from(timestamp), raw]), createPublicKey(key), Buffer.from(signature, 'hex'))) throw failure('Webhook 签名验证失败', 401);
    if (payload.op === 13) {
      if (typeof payload.d?.plain_token !== 'string' || typeof payload.d?.event_ts !== 'string' || payload.d.plain_token.length > 4096) throw failure('Webhook 地址验证参数无效');
      return { body: { plain_token: payload.d.plain_token, signature: sign(null, Buffer.from(payload.d.event_ts + payload.d.plain_token), key).toString('hex') } };
    }
    if (payload.op !== 0 || !payload.d || typeof payload.t !== 'string') throw failure('不支持的 Webhook 事件');
    this.lastEventAt = new Date().toISOString();
    const author = payload.d?.author;
    const self = author?.bot || (this.identity?.id && String(author?.id || author?.user_openid || author?.member_openid || '') === String(this.identity.id));
    return { body: { op: 12 }, ...(self ? {} : { event: payload }) };
  }
}

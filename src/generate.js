// 生图 / 生视频的多种接入方式。
//
// 用户的需求很实际：不同的服务接入方式完全不同，硬编码一种必然不够用。
// 这里提供三种适配器，用同一套调用约定（配置项 genMode）切换：
//
//   agnes  —— 内置技能（默认）。Agnes 自家的图片 / 视频接口，含异步任务轮询。
//   openai —— OpenAI 兼容接口。图片走 {地址}/images/generations，视频走 {地址}/videos/generations。
//   custom —— 自定义 HTTP。地址、方法、请求体模板、结果取值路径全部由用户填写，
//             适合 Replicate / 硅基流动 / 豆包 / 即梦 这类各自为政的服务。
//
// 三种方式都只发 HTTP 请求，不引入任何第三方依赖，也不会把密钥写进错误信息。
import { setTimeout as delay } from 'node:timers/promises';
import {
  generateImage as agnesImage, generateVideo as agnesVideo, listModels, normalizeImageSize, normalizeReference,
} from './agnes.js';

export { listModels };

const DEFAULT_BASE_URL = 'https://apihub.agnes-ai.com/v1';
const MAX_BYTES = 4 * 1024 * 1024;

const brief = (message, max = 200) => String(message ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const redact = (message, secret) => secret ? String(message).split(secret).join('***') : message;

function requireApiKey(apiKey, label = '生成模型') {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) throw new Error(`未配置${label} API Key`);
  return key;
}

function endpoint(baseUrl, suffix) {
  const base = typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl.trim() : DEFAULT_BASE_URL;
  const url = new URL(`${base.replace(/\/+$/, '')}${suffix}`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('生成接口地址必须使用 HTTP/HTTPS');
  return url;
}

async function readLimited(response, maxBytes, signal) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { try { await reader.cancel(); } catch {} throw new Error('生成接口响应超过大小限制'); }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

function errorText(data) {
  const raw = data?.error ?? data?.message ?? data?.detail;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (raw && typeof raw === 'object') {
    const nested = raw.message ?? raw.msg ?? raw.error;
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
  }
  return '';
}

// 网络层面的偶发失败（连接超时、连接重置）值得重试；
// 业务错误（4xx、模型不存在）重试没有意义。
const RETRYABLE_NETWORK = /^(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_)/;

async function withNetworkRetry(fn, { signal, attempts = 3, baseMs = 900 } = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    signal?.throwIfAborted();
    try { return await fn(); }
    catch (error) {
      last = error;
      const code = String(error?.code || error?.cause?.code || '');
      if (attempt === attempts || !RETRYABLE_NETWORK.test(code)) throw error;
      try { await delay(baseMs * attempt, undefined, { signal }); }
      catch { throw signal?.reason || error; }
    }
  }
  throw last;
}

async function requestJSON(url, { apiKey, signal, timeoutMs, body, headers = {} }) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const active = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: active,
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (timeout.aborted) throw new Error('生成接口请求超时');
    const code = String(error?.cause?.code || error?.code || '');
    const wrapped = new Error(`生成接口网络请求失败：${redact(brief(code || error?.message || '未知错误'), apiKey)}`);
    // 带上原始错误码，外层才能判断这一类网络抖动值不值得重试。
    wrapped.code = code;
    throw wrapped;
  }
  const raw = await readLimited(response, MAX_BYTES, signal);
  let data = null;
  try { if (raw) data = JSON.parse(raw); } catch {
    if (response.ok) throw new Error(`生成接口返回非 JSON 响应（HTTP ${response.status}）`);
  }
  if (!response.ok) {
    const detail = redact(errorText(data), apiKey);
    throw new Error(`生成接口失败：HTTP ${response.status}${detail ? ' ' + detail : ''}`.trim());
  }
  if (!data || typeof data !== 'object') throw new Error('生成接口返回空响应');
  return data;
}

// 从响应里按路径取值，支持 data.0.url / output.video_url / images.0 这种写法。
export function pickPath(data, path) {
  const steps = String(path || '').split('.').map(step => step.trim()).filter(Boolean);
  if (!steps.length) return undefined;
  let current = data;
  for (const step of steps) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(step);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (typeof current === 'object') {
      current = current[step];
    } else return undefined;
  }
  return current;
}

const PNG_MAGIC = Buffer.from('89504e470d0a1a0a', 'hex');
const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4' };

function mimeFromUrl(url) {
  try { return MIME_BY_EXT[new URL(url).pathname.split('.').pop().toLowerCase()] || 'image/png'; } catch { return 'image/png'; }
}

function mimeFromBase64(base64) {
  const head = Buffer.from(base64.slice(0, 64).replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';
  if (head.length > 2 && head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
  if (head.length >= 12 && head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString())) return 'image/gif';
  return 'image/png';
}

// 结果归一化：三种接入方式最后都收敛成 {kind, url|base64, mime}。
function normalizeResult(kind, raw, notes) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) throw new Error('生成接口没有返回可用结果');
  if (/^https?:\/\//i.test(value)) {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('生成接口返回的地址无效');
    return { kind, url: parsed.href, mime: kind === 'video' ? 'video/mp4' : mimeFromUrl(parsed.href), notes };
  }
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(value) && value.length >= 24) {
    const clean = value.replace(/\s+/g, '');
    return { kind, base64: clean, mime: kind === 'video' ? 'video/mp4' : mimeFromBase64(clean), notes };
  }
  throw new Error('生成接口返回的结果既不是地址也不是 Base64 数据');
}

// ---------------------------------------------------------------------------
// OpenAI 兼容适配器
// ---------------------------------------------------------------------------

async function openaiImage({ prompt, size, model, apiKey, baseUrl, signal, timeoutMs = 180000, reference }) {
  const key = requireApiKey(apiKey);
  // OpenAI 兼容的图生图走 /images/edits（multipart），纯文生图才走 /images/generations。
  const ref = normalizeReference(reference);
  if (ref) {
    const editUrl = endpoint(baseUrl, '/images/edits');
    const form = new FormData();
    form.append('model', model || 'gpt-image-1');
    form.append('prompt', prompt);
    form.append('size', size || '1024x1024');
    form.append('n', '1');
    const raw = Buffer.from(ref.split(',')[1] || '', 'base64');
    form.append('image', new Blob([raw], { type: ref.slice(5, ref.indexOf(';')) || 'image/png' }), 'reference.png');
    const response = await fetch(editUrl, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form, signal, redirect: 'error' });
    const rawText = await response.text();
    if (!response.ok) throw new Error(`生成接口失败：HTTP ${response.status} ${rawText.slice(0, 200)}`);
    return openaiImageResult(JSON.parse(rawText), editUrl);
  }
  const url = endpoint(baseUrl, '/images/generations');
  const data = await withNetworkRetry(() => requestJSON(url, {
    apiKey: key, signal, timeoutMs,
    body: { model: model || 'gpt-image-1', prompt, size: size || '1024x1024', n: 1 },
  }), { signal });
  return openaiImageResult(data, url);
}

function openaiImageResult(data, url) {
  const item = Array.isArray(data.data) ? data.data[0] : null;
  if (!item) throw new Error('生成接口未返回图片数据');
  const notes = [];
  if (typeof item.url === 'string' && item.url.trim()) return normalizeResult('image', item.url, notes);
  if (typeof item.b64_json === 'string' && item.b64_json.trim()) {
    notes.push('图片以 Base64 形式返回');
    return normalizeResult('image', item.b64_json, notes);
  }
  throw new Error('生成接口未返回图片 URL 或 Base64 数据');
}

async function openaiVideo({ prompt, duration, model, apiKey, baseUrl, signal, pollMs = 5000, maxWaitMs = 600000 }) {
  const key = requireApiKey(apiKey);
  const seconds = Number(duration) > 0 ? Number(duration) : 5;
  const submit = endpoint(baseUrl, '/videos/generations');
  const notes = [];
  let submitted;
  try {
    submitted = await requestJSON(submit, {
      apiKey: key, signal, timeoutMs: 60000,
      body: { model: model || 'sora-2', prompt, seconds: String(seconds) },
    });
  } catch (error) {
    // 部分服务把视频挂在 /videos 上而不是 /videos/generations。
    if (/HTTP 404/.test(error.message)) {
      const alt = endpoint(baseUrl, '/videos');
      submitted = await requestJSON(alt, { apiKey: key, signal, timeoutMs: 60000, body: { model: model || 'sora-2', prompt, seconds: String(seconds) } });
      notes.push('该服务的视频提交地址是 /videos，已自动改用');
    } else throw error;
  }
  const taskId = pickPath(submitted, 'id') || pickPath(submitted, 'task_id') || pickPath(submitted, 'data.id');
  if (!taskId) {
    // 有些服务直接同步返回视频地址。
    const direct = pickPath(submitted, 'data.0.url') || pickPath(submitted, 'output.url') || pickPath(submitted, 'url');
    if (direct) return normalizeResult('video', direct, notes);
    throw new Error('视频任务已提交但未返回任务 ID');
  }
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`视频生成超时（已等待约 ${Math.round(maxWaitMs / 1000)} 秒），任务 ID：${taskId}`);
    try { await delay(Math.min(pollMs, remaining), undefined, { signal }); } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw error;
    }
    signal?.throwIfAborted();
    const status = await requestJSON(endpoint(baseUrl, `/videos/generations/${encodeURIComponent(taskId)}`), { apiKey: key, signal, timeoutMs: 60000 })
      .catch(async () => requestJSON(endpoint(baseUrl, `/videos/${encodeURIComponent(taskId)}`), { apiKey: key, signal, timeoutMs: 60000 }));
    const state = String(pickPath(status, 'status') || pickPath(status, 'state') || '').toLowerCase();
    if (['completed', 'succeeded', 'success'].includes(state)) {
      const url = pickPath(status, 'output.url') || pickPath(status, 'data.0.url') || pickPath(status, 'url')
        || pickPath(status, 'output.video_url') || pickPath(status, 'video_url');
      if (!url) throw new Error(`视频任务已完成但未返回视频地址（任务 ID：${taskId}）`);
      return normalizeResult('video', url, notes);
    }
    if (['failed', 'error', 'canceled', 'cancelled'].includes(state)) {
      throw new Error(`视频生成失败（${state}）（任务 ID：${taskId}）`);
    }
  }
}

// ---------------------------------------------------------------------------
// 自定义 HTTP 适配器
// ---------------------------------------------------------------------------

function fillTemplate(template, values) {
  return String(template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
    const value = values[key];
    return value === undefined || value === null ? match : String(value);
  });
}

async function customRequest({ kind, prompt, size, duration, model, apiKey, baseUrl, custom, signal, timeoutMs = 180000, reference }) {
  const config = custom || {};
  if (!String(config.url || '').trim()) throw new Error('自定义生成方式需要填写完整的请求地址');
  const values = { prompt, size: size || '', duration: duration || '', model: model || '', image: reference || '' };
  const url = fillTemplate(config.url, values);
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('自定义生成地址无效'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('自定义生成地址必须使用 HTTP/HTTPS');
  const method = String(config.method || 'POST').toUpperCase();
  let headers = {};
  if (String(config.headers || '').trim()) {
    try {
      const parsedHeaders = JSON.parse(config.headers);
      if (!parsedHeaders || typeof parsedHeaders !== 'object' || Array.isArray(parsedHeaders)) throw new Error('自定义请求头必须是 JSON 对象');
      headers = parsedHeaders;
    } catch (error) {
      throw new Error(`自定义请求头不是有效 JSON：${error.message}`);
    }
  }
  let body;
  if (method !== 'GET' && String(config.body || '').trim()) {
    const raw = fillTemplate(config.body, values);
    try { body = JSON.parse(raw); }
    catch { throw new Error('自定义请求体模板不是有效 JSON（请检查引号与占位符）'); }
  }
  const key = apiKey ? String(apiKey).trim() : '';
  const data = await requestJSON(parsed, { apiKey: key, signal, timeoutMs, body, headers });
  const result = pickPath(data, config.path || 'data.0.url');
  if (result === undefined || result === null || result === '') {
    throw new Error(`按路径「${config.path || 'data.0.url'}」没有从响应里取到结果，请检查「结果取值路径」`);
  }
  const notes = ['使用自定义生成方式'];
  return normalizeResult(kind, result, notes);
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

function resolveMode(config) {
  const mode = config?.genMode || 'agnes';
  return ['agnes', 'openai', 'custom'].includes(mode) ? mode : 'agnes';
}

export async function generateImage({ prompt, size, model, apiKey, baseUrl, mode, custom, signal, reference } = {}) {
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (!text) throw new Error('生图提示词不能为空');
  const kind = resolveMode({ genMode: mode });
  // 自定义方式由用户自己的模板决定尺寸，不动它。
  if (kind !== 'custom') size = normalizeImageSize(size);
  if (kind === 'openai') return openaiImage({ prompt: text, size, model, apiKey, baseUrl, signal, reference });
  if (kind === 'custom') return customRequest({ kind: 'image', prompt: text, size, model, apiKey, baseUrl, custom, signal, reference });
  return agnesImage({ prompt: text, size, model, apiKey: requireApiKey(apiKey, 'Agnes'), baseUrl, signal, reference });
}

export async function generateVideo({ prompt, duration, model, apiKey, baseUrl, mode, custom, signal } = {}) {
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (!text) throw new Error('生视频提示词不能为空');
  const kind = resolveMode({ genMode: mode });
  if (kind === 'openai') return openaiVideo({ prompt: text, duration, model, apiKey, baseUrl, signal });
  if (kind === 'custom') return customRequest({ kind: 'video', prompt: text, duration, model, apiKey, baseUrl, custom, signal });
  return agnesVideo({ prompt: text, duration, model, apiKey: requireApiKey(apiKey, 'Agnes'), baseUrl, signal });
}

// 「测试连接」：用最小代价验证配置通不通。
export async function testGeneration({ kind = 'image', mode, apiKey, baseUrl, custom, model, signal } = {}) {
  const started = Date.now();
  if (kind === 'video') {
    const result = await generateVideo({ prompt: '一只猫', duration: 1, model, apiKey, baseUrl, mode, custom, signal });
    return { ok: true, kind: 'video', latencyMs: Date.now() - started, hasUrl: Boolean(result.url), notes: result.notes || [] };
  }
  const result = await generateImage({ prompt: '一只猫', size: '1024x1024', model, apiKey, baseUrl, mode, custom, signal });
  return { ok: true, kind: 'image', latencyMs: Date.now() - started, hasUrl: Boolean(result.url), notes: result.notes || [] };
}

// Agnes AI 生图 / 生视频客户端：纯 fetch + 内置模块，无第三方依赖。
// 任何错误信息都不会包含 apiKey；未配置密钥时直接抛出明确错误。
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_BASE_URL = 'https://apihub.agnes-ai.com/v1';
const DEFAULT_IMAGE_MODEL = 'agnes-image-2.1-flash';
const DEFAULT_VIDEO_MODEL = 'agnes-video-2.5-flash';
const DEFAULT_VIDEO_WIDTH = 1152;
const DEFAULT_VIDEO_FRAME_RATE = 24;
// Agnes 要求 num_frames 满足 8n+1 且 <=441；据此把秒数换算成帧数（5 秒 @24fps = 121 帧）。
function framesForSeconds(seconds, frameRate = DEFAULT_VIDEO_FRAME_RATE) {
  const target = Math.max(1, Math.round(seconds * frameRate));
  const frames = 8 * Math.round((target - 1) / 8) + 1;
  return Math.min(441, Math.max(9, frames));
}
const IMAGE_SIZES = ['1024x1024', '1024x768', '1792x1024', '1024x1792'];
// 模型自己挑尺寸时爱写这些写法，统一规整成接口认的几种。
const SIZE_ALIASES = {
  'square':'1024x1024', '1024*1024':'1024x1024', '1:1':'1024x1024', 'ratio_1_1':'1024x1024',
  'landscape':'1792x1024', 'wide':'1792x1024', 'horizontal':'1792x1024', '3:2':'1792x1024',
  'portrait':'1024x1792', 'tall':'1024x1792', 'vertical':'1024x1792', '2:3':'1024x1792',
  '1024*768':'1024x768', '4:3':'1024x768', '768*1024':'1024x768',
};
// 参考图：只接受 data URL（Agnes 的图生图接口要求带 MIME 头）。
export function normalizeReference(reference) {
  if (!reference) return '';
  if (typeof reference === 'string') {
    const text = reference.trim();
    return /^data:image\/[a-z0-9.+-]+;base64,/i.test(text) ? text : '';
  }
  if (typeof reference === 'object' && reference.bytes?.length) {
    const mime = reference.mime || 'image/png';
    return `data:${mime};base64,${Buffer.from(reference.bytes).toString('base64')}`;
  }
  return '';
}

export function normalizeImageSize(value) {
  if (value === undefined || value === null || value === '') return '1024x1024';
  const text = String(value).trim().toLowerCase().replace(/\s+/g, '');
  if (IMAGE_SIZES.includes(text)) return text;
  const alias = SIZE_ALIASES[text];
  if (alias) return alias;
  // 「竖屏」「横屏」这类说法也认一下
  if (/竖|portrait|tall|vertical/.test(text)) return '1024x1792';
  if (/横|landscape|wide|horizontal/.test(text)) return '1792x1024';
  if (/方|square/.test(text)) return '1024x1024';
  return '1024x1024';
}
const MAX_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60000;
const DONE = new Set(['completed', 'succeeded', 'success']);
const FAILED = new Set(['failed', 'error', 'canceled', 'cancelled']);

const brief = (message, max = 200) => String(message ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const redact = (message, secret) => secret ? String(message).split(secret).join('***') : String(message);

function requireApiKey(apiKey) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) throw new Error('未配置生成模型 API Key，请先填写 Agnes API Key');
  return key;
}

// 该网关在模型名不可用（未开通 / 名称过时）时返回 503/404 且只说 no available channel，
// 这里在失败后best-effort查一次模型清单，把可用名称告诉用户与模型，避免反复瞎试。
const MODEL_HINT = /no available channel|model not found|model_not_found|invalid model|unknown model|does not exist|not supported/i;
export async function listModels({ apiKey, baseUrl, signal, timeoutMs = 15000 } = {}) {
  const key = requireApiKey(apiKey);
  const data = await requestJSON(endpoint(baseUrl, '/models'), { apiKey: key, signal, timeoutMs });
  const raw = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  const models = raw.map(entry => typeof entry === 'string' ? entry : entry?.id ?? entry?.name ?? entry?.model).filter(id => typeof id === 'string' && id.trim()).map(id => id.trim());
  return { models, image: models.filter(id => /image/i.test(id)), video: models.filter(id => /video/i.test(id)), text: models.filter(id => !/image|video/i.test(id)) };
}
async function withModelHint(error, { apiKey, baseUrl, signal, kind }) {
  if (!MODEL_HINT.test(error.message)) return error;
  try {
    const available = await listModels({ apiKey, baseUrl, signal });
    const relevant = kind === 'video' ? available.video : available.image;
    const hint = relevant.length
      ? `；当前 Key 可用的${kind === 'video' ? '视频' : '图片'}模型：${relevant.join('、')}，请在 Harness 里改成其中之一`
      : `；当前 Key 未列出任何${kind === 'video' ? '视频' : '图片'}模型，请确认 Agnes 账号权限`;
    error.message += hint;
  } catch { /* 查询失败就保留原始错误，不掩盖真实原因 */ }
  return error;
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

async function requestJSON(url, { apiKey, signal, timeoutMs, body } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const active = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: active,
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
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
    if (response.status === 404) {
      throw new Error(`生成接口失败：HTTP 404 —— 该地址不提供生成接口。请在「人格与回复」的 Harness 区域填写正确的「生成接口地址」和「生成 API Key」（Agnes 为 https://apihub.agnes-ai.com/v1），或关闭生图/生视频。${detail ? ' 详情：' + detail : ''}`);
    }
    throw new Error(`生成接口失败：HTTP ${response.status} ${detail}`.trim());
  }
  if (!data || typeof data !== 'object') throw new Error('生成接口返回空响应');
  return data;
}

// 依次检查响应顶层与常见的嵌套容器，取第一个非空字符串字段。
function searchContainers(data) {
  return [data, data?.data, Array.isArray(data?.data) ? data.data[0] : null, data?.output, data?.result, data?.task]
    .filter(value => value && typeof value === 'object' && !Array.isArray(value));
}

function firstString(data, keys) {
  for (const container of searchContainers(data)) {
    for (const key of keys) {
      const value = container[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return '';
}

const taskIdOf = data => firstString(data, ['id', 'task_id', 'taskId', 'video_id', 'videoId']);
const videoUrlOf = data => {
  const metadata = data && typeof data.metadata === 'object' ? data.metadata : null;
  const result = data && typeof data.result === 'object' ? data.result : null;
  for (const candidate of [metadata?.url, data?.video_url, data?.url, data?.output_url, result?.video_url]) {
    if (typeof candidate === 'string' && /^https?:\/\//.test(candidate)) return candidate;
  }
  return firstString(data, ['url', 'video_url', 'videoUrl']) || '';
};

const PNG_MAGIC = Buffer.from('89504e470d0a1a0a', 'hex');
const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

function mimeFromUrl(url) {
  try { return MIME_BY_EXT[new URL(url).pathname.split('.').pop().toLowerCase()] || 'image/png'; } catch { return 'image/png'; }
}

function mimeFromBase64(base64) {
  const head = Buffer.from(base64.slice(0, 64).replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';
  if (head.length > 2 && head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
  if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.toString('ascii', 0, 6))) return 'image/gif';
  return 'image/png';
}

export async function generateImage({ prompt, size, model, apiKey, baseUrl, signal, timeoutMs = 180000, reference } = {}) {
  const key = requireApiKey(apiKey);
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (!text) throw new Error('生图提示词不能为空');
  const imageSize = normalizeImageSize(size);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('生图超时时间无效');
  const name = typeof model === 'string' && model.trim() ? model.trim() : DEFAULT_IMAGE_MODEL;
  const url = endpoint(baseUrl, '/images/generations');
  signal?.throwIfAborted();
  // response_format 必须放在 extra_body 内，这是 Agnes 官方已知的接口陷阱。
  // 参考图走 image 字段（data URL），有参考图时就是图生图，脸才认得出来。
  const body = { model: name, prompt: text, size: imageSize, extra_body: { response_format: 'url' } };
  const ref = normalizeReference(reference);
  if (ref) body.image = ref;
  let data;
  try {
    data = await withNetworkRetry(
      () => requestJSON(url, { apiKey: key, signal, timeoutMs, body }),
      { signal },
    );
  } catch (error) {
    throw await withModelHint(error, { apiKey: key, baseUrl, signal, kind: 'image' });
  }
  const item = Array.isArray(data.data) ? data.data[0] : null;
  if (!item || typeof item !== 'object') throw new Error('生成接口未返回图片数据');
  const notes = [];
  if (typeof item.url === 'string' && item.url.trim()) {
    const imageUrl = item.url.trim();
    const parsed = new URL(imageUrl, url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('生成接口返回的图片地址无效');
    return { kind: 'image', url: parsed.href, mime: mimeFromUrl(parsed.href), notes };
  }
  if (typeof item.b64_json === 'string' && item.b64_json.trim()) {
    const base64 = item.b64_json.trim();
    notes.push('图片以 Base64 形式返回');
    return { kind: 'image', base64, mime: mimeFromBase64(base64), notes };
  }
  throw new Error('生成接口未返回图片 URL 或 Base64 数据');
}

export async function generateVideo({ prompt, duration, model, apiKey, baseUrl, signal, pollMs = 5000, maxWaitMs = 600000 } = {}) {
  const key = requireApiKey(apiKey);
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (!text) throw new Error('生视频提示词不能为空');
  if (!Number.isFinite(pollMs) || pollMs < 1) throw new Error('视频轮询间隔无效');
  if (!Number.isFinite(maxWaitMs) || maxWaitMs < 1) throw new Error('视频最长等待时间无效');
  const name = typeof model === 'string' && model.trim() ? model.trim() : DEFAULT_VIDEO_MODEL;
  // 网关要求 mode（实测缺省会返回 HTTP 400 mode is required），并用 num_frames/frame_rate 表达时长。
  const seconds = duration === undefined || duration === null || duration === '' ? 5 : Number(duration);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) throw new Error('视频时长必须是 1-60 之间的整数秒');
  const frameRate = DEFAULT_VIDEO_FRAME_RATE;
  const body = {
    model: name, prompt: text, mode: 'text2video', width: DEFAULT_VIDEO_WIDTH,
    num_frames: framesForSeconds(seconds, frameRate), frame_rate: frameRate,
  };
  const submitUrl = endpoint(baseUrl, '/video/generations');
  const notes = [];
  // 部分分发网关按路由做字段白名单（实测会返回 “X is a forbidden field”），
  // 这里按提示逐个剔除该字段后重试，避免把网关差异写死成猜测。
  signal?.throwIfAborted();
  let submitted;
  for (let attempt = 0; ; attempt++) {
    try {
      submitted = await requestJSON(submitUrl, { apiKey: key, signal, timeoutMs: REQUEST_TIMEOUT_MS, body });
      break;
    } catch (error) {
      const forbidden = /(?:^|[\s"'(])([A-Za-z_][A-Za-z0-9_]*)\s+is a forbidden field/.exec(error.message);
      if (forbidden && Object.hasOwn(body, forbidden[1]) && attempt < 4) {
        notes.push(`网关不接受字段 ${forbidden[1]}，已自动省略重试`);
        delete body[forbidden[1]];
        continue;
      }
      throw await withModelHint(error, { apiKey: key, baseUrl, signal, kind: 'video' });
    }
  }
  const taskId = taskIdOf(submitted);
  if (!taskId) throw new Error('视频任务已提交但未返回任务 ID');
  const statusPaths = [`/video/generations/${encodeURIComponent(taskId)}`, `/videos/${encodeURIComponent(taskId)}`];
  const deadline = Date.now() + maxWaitMs;
  let statusIndex = 0;
  for (;;) {
    signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const error = new Error(`视频生成超时（已等待约 ${Math.round(maxWaitMs / 1000)} 秒），任务 ID：${taskId}，可稍后用该 ID 重试`);
      error.taskId = taskId;
      throw error;
    }
    try { await delay(Math.min(pollMs, remaining), undefined, { signal }); } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw error;
    }
    signal?.throwIfAborted();
    let data;
    try {
      data = await requestJSON(endpoint(baseUrl, statusPaths[statusIndex]), { apiKey: key, signal, timeoutMs: REQUEST_TIMEOUT_MS });
    } catch (error) {
      if (/HTTP 404/.test(error.message) && statusIndex < statusPaths.length - 1) {
        statusIndex++;
        notes.push(`状态接口 ${statusPaths[statusIndex - 1]} 不可用，改用 ${statusPaths[statusIndex]}`);
        continue;
      }
      throw error;
    }
    const state = firstString(data, ['status', 'state']).toLowerCase();
    if (DONE.has(state)) {
      const videoUrl = videoUrlOf(data);
      if (!videoUrl) {
        const error = new Error(`视频任务已完成但未返回视频地址（任务 ID：${taskId}）`);
        error.taskId = taskId;
        throw error;
      }
      const parsed = new URL(videoUrl, endpoint(baseUrl, statusPaths[statusIndex]));
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('生成接口返回的视频地址无效');
      return { kind: 'video', url: parsed.href, status: 'completed', taskId, notes };
    }
    if (FAILED.has(state)) {
      const detail = redact(errorText(data), key);
      throw new Error(`视频生成失败（${state || 'unknown'}）${detail ? `：${detail}` : ''}（任务 ID：${taskId}）`);
    }
    if (!state && !notes.length) notes.push('视频任务未返回状态，已继续轮询');
  }
}

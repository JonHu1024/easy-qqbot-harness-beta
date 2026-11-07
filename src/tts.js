// 语音合成（TTS）接入。
//
// 两条路子，取决于用户手头有什么：
//
//   api     —— 走 HTTP 合成接口。又分两种：
//               · openai 兼容：POST {地址}/audio/speech，body {model,input,voice,response_format,speed}
//               · 自定义模板：地址、方法、请求体、结果取值路径全部自己填
//   windows —— 直接调用 Windows 自带的语音合成（PowerShell + System.Speech / SAPI）。
//               不联网、不花钱、延迟只有几百毫秒，是本机部署最省事的方案。
//
// 输出统一收敛成 { bytes, mime, ext }。
// QQ 的语音消息（file_type=3）接受 silk / mp3 / wav / ogg，其中 wav 最省事（不依赖 ffmpeg）。
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

const MIME_BY_EXT = {
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', silk: 'audio/silk', pcm: 'audio/L16',
};

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const trim = (value, max) => String(value ?? '').trim().slice(0, max);
const redact = (message, secret) => (secret ? String(message).split(secret).join('***') : String(message));

function detectFormat(bytes, contentType = '') {
  const head = Buffer.from(bytes).subarray(0, 16);
  if (head.length >= 3 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return 'mp3';       // ID3
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'mp3';                   // MPEG frame
  if (head.length >= 4 && head.toString('ascii', 0, 4) === 'OggS') return 'ogg';
  if (head.length >= 4 && head.toString('ascii', 0, 4) === 'fLaC') return 'flac';
  if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WAVE') return 'wav';
  if (head.length >= 4 && head[0] === 0x02 && head.toString('ascii', 1, 8) === 'SILK_V3') return 'silk';
  const type = String(contentType).toLowerCase();
  if (type.includes('mpeg')) return 'mp3';
  if (type.includes('wav')) return 'wav';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('silk')) return 'silk';
  if (type.includes('flac')) return 'flac';
  return '';
}

// 粗略估算时长：只用于在界面上告诉用户「这条语音大概多长」，不参与任何协议判断。
function estimateDuration(bytes, ext) {
  const size = Buffer.byteLength(bytes);
  if (ext === 'wav') {
    // 16kHz / 16bit / 单声道 = 32000 字节每秒
    return Math.max(0.1, Math.round((size - 44) / 32000 * 10) / 10);
  }
  if (ext === 'mp3') return Math.max(0.1, Math.round(size / 16000 * 10) / 10);
  if (ext === 'ogg') return Math.max(0.1, Math.round(size / 8000 * 10) / 10);
  return null;
}

// 服务端返回的音频可能是 Base64、十六进制，或者直接是地址。
// 自动识别：先按十六进制解，再按 Base64 解，哪个能解出已知文件头就用哪个。
const AUDIO_MAGIC = [
  { ext: 'mp3', test: (b) => b.length >= 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33 },
  { ext: 'mp3', test: (b) => b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0 },
  { ext: 'ogg', test: (b) => b.length >= 4 && b.toString('ascii', 0, 4) === 'OggS' },
  { ext: 'wav', test: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE' },
  { ext: 'flac', test: (b) => b.length >= 4 && b.toString('ascii', 0, 4) === 'fLaC' },
  { ext: 'silk', test: (b) => b.length >= 12 && b[0] === 0x02 && b.toString('ascii', 1, 8) === 'SILK_V3' },
  { ext: 'silk', test: (b) => b.length >= 2 && b[0] === 0x02 },
];
function magicOf(bytes) {
  return AUDIO_MAGIC.find((rule) => rule.test(bytes))?.ext || '';
}
function decodeAudioPayload(value) {
  const clean = String(value || '').trim();
  if (!clean) throw new Error('语音接口没有返回音频数据');
  if (/^https?:\/\//i.test(clean)) return { kind: 'url', value: clean };
  const compact = clean.replace(/\s+/g, '');
  const isHex = /^[0-9a-fA-F]+$/.test(compact) && compact.length % 2 === 0 && compact.length >= 32;
  if (isHex) {
    const bytes = Buffer.from(compact, 'hex');
    if (magicOf(bytes)) return { kind: 'bytes', bytes };
  }
  const stripped = compact.replace(/^data:[^;,]+;base64,/, '');
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(stripped) && stripped.length >= 16) {
    const bytes = Buffer.from(stripped, 'base64');
    if (bytes.length && (magicOf(bytes) || !isHex)) return { kind: 'bytes', bytes };
  }
  if (isHex) return { kind: 'bytes', bytes: Buffer.from(compact, 'hex') };
  throw new Error('按路径取到的音频既不是地址，也不是可识别的 Base64 / 十六进制数据');
}

function normalizeAudio(bytes, contentType, { sourceExt = '' } = {}) {
  const data = Buffer.from(bytes);
  if (!data.length) throw new Error('语音接口没有返回音频数据');
  if (data.length > MAX_AUDIO_BYTES) throw new Error(`音频超过 ${MAX_AUDIO_BYTES / 1024 / 1024}MB 限制`);
  const ext = detectFormat(data, contentType) || sourceExt || 'wav';
  return { bytes: data, ext, mime: MIME_BY_EXT[ext] || 'application/octet-stream' };
}

// ---------------------------------------------------------------------------
// API 合成
// ---------------------------------------------------------------------------

function fillTemplate(template, values) {
  return String(template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
    const value = values[key];
    return value === undefined || value === null ? match : String(value);
  });
}

// 从响应里按路径取值，支持 data.0.url / output.audio_url / audio 数组下标。
export function pickPath(data, path) {
  const steps = String(path || '').split('.').map((step) => step.trim()).filter(Boolean);
  if (!steps.length) return undefined;
  let current = data;
  for (const step of steps) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(step);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (typeof current === 'object') current = current[step];
    else return undefined;
  }
  return current;
}

// OpenAI 兼容的语音地址：厂商给的地址五花八门，有的带 /v1 有的不带。
//   https://api.openai.com/v1        → /v1/audio/speech
//   https://api-bj.minimaxi.com      → /v1/audio/speech
//   https://x.com/v1/audio/speech    → 原样
export function openaiEndpoint(baseUrl, endpoint) {
  const clean = (trim(baseUrl) || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const path = `/${endpoint}`;
  if (new RegExp(`${path}$`, 'i').test(clean)) return clean;
  if (/\/v\d+$/i.test(clean)) return `${clean}${path}`;
  return `${clean}/v1${path}`;
}

async function openaiSpeech({ text, voice, speed, model, apiKey, baseUrl, signal, timeoutMs = 120000 }) {
  const key = trim(apiKey);
  if (!key) throw new Error('未配置语音接口 API Key');
  const url = new URL(openaiEndpoint(baseUrl, 'audio/speech'));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('语音接口地址必须使用 HTTP/HTTPS');
  const timeout = AbortSignal.timeout(timeoutMs);
  const active = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST', redirect: 'error', signal: active,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({
        model: trim(model) || 'tts-1',
        input: text,
        voice: trim(voice) || 'alloy',
        response_format: 'mp3',
        speed: Number(speed) || 1,
      }),
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (timeout.aborted) throw new Error('语音接口请求超时');
    throw new Error(`语音接口网络请求失败：${redact(trim(error?.cause?.code || error?.code || error?.message || '未知错误', 120), key)}`);
  }
  if (!response.ok) {
    let detail = '';
    try { detail = trim((await response.text()).slice(0, 300)); } catch { /* ignore */ }
    // MiniMax 没有 OpenAI 兼容的语音接口（实测三个域名全是 404），这个报错最容易让人摸不着头脑。
    if (response.status === 404 && /minimax/i.test(String(baseUrl || ''))) {
      throw new Error('语音接口 404：MiniMax 没有 OpenAI 兼容的 /audio/speech 接口，请把「接口协议」改成「MiniMax T2A」或「自动判断」');
    }
    throw new Error(`语音接口失败：HTTP ${response.status}${detail ? ' ' + redact(detail, key) : ''}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return normalizeAudio(bytes, response.headers.get('content-type') || '');
}

async function customSpeech({ text, voice, speed, model, apiKey, baseUrl, custom, signal, timeoutMs = 120000 }) {
  // 配置里的字段叫 ttsCustom*，这里映射成内部统一的命名。
  const config = {
    url: custom?.ttsCustomUrl, method: custom?.ttsCustomMethod,
    body: custom?.ttsCustomBody, path: custom?.ttsCustomPath, headers: custom?.ttsCustomHeaders,
  };
  if (!trim(config.url)) throw new Error('自定义语音方式需要填写完整的请求地址');
  const values = { text, voice: trim(voice), speed: String(speed ?? ''), model: trim(model) };
  const target = fillTemplate(config.url, values);
  let url;
  try { url = new URL(target); } catch { throw new Error('自定义语音地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('自定义语音地址必须使用 HTTP/HTTPS');
  const method = String(config.method || 'POST').toUpperCase();
  let headers = {};
  if (trim(config.headers)) {
    try {
      const parsed = JSON.parse(config.headers);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('自定义请求头必须是 JSON 对象');
      headers = parsed;
    } catch (error) { throw new Error(`自定义请求头不是有效 JSON：${error.message}`); }
  }
  let body;
  if (method !== 'GET' && trim(config.body)) {
    try { body = JSON.parse(fillTemplate(config.body, values)); }
    catch { throw new Error('自定义请求体模板不是有效 JSON（请检查引号与占位符）'); }
  }
  const key = trim(apiKey);
  const timeout = AbortSignal.timeout(timeoutMs);
  const active = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    response = await fetch(url, {
      method, redirect: 'error', signal: active,
      headers: {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        Accept: 'audio/*, application/json;q=0.8',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (timeout.aborted) throw new Error('语音接口请求超时');
    throw new Error(`语音接口网络请求失败：${redact(trim(error?.cause?.code || error?.code || error?.message || '未知错误', 120), key)}`);
  }
  if (!response.ok) {
    let detail = '';
    try { detail = trim((await response.text()).slice(0, 300)); } catch { /* ignore */ }
    throw new Error(`语音接口失败：HTTP ${response.status}${detail ? ' ' + redact(detail, key) : ''}`);
  }
  const contentType = response.headers.get('content-type') || '';
  const buffer = Buffer.from(await response.arrayBuffer());
  // 二进制音频直接用；JSON 响应则按取值路径取地址或 Base64。
  if (/json/i.test(contentType) || buffer.subarray(0, 1).toString() === '{') {
    let data = null;
    try { data = JSON.parse(buffer.toString('utf8')); } catch { throw new Error('语音接口返回的内容既不是音频也不是 JSON'); }
    const path = trim(config.path) || 'data.0.url';
    const picked = pickPath(data, path);
    if (picked === undefined || picked === null || picked === '') {
      throw new Error(`按路径「${path}」没有从响应里取到音频，请检查「结果取值路径」`);
    }
    const decoded = decodeAudioPayload(picked);
    if (decoded.kind === 'url') {
      const remote = await fetch(decoded.value, { signal: active });
      if (!remote.ok) throw new Error(`下载语音文件失败：HTTP ${remote.status}`);
      return normalizeAudio(Buffer.from(await remote.arrayBuffer()), remote.headers.get('content-type') || '');
    }
    return normalizeAudio(decoded.bytes, '');
  }
  return normalizeAudio(buffer, contentType);
}

// ---------------------------------------------------------------------------
// MiniMax 语音合成
// ---------------------------------------------------------------------------
// MiniMax 的 T2A 接口和 OpenAI 的 /audio/speech 完全不是一回事：
//   · 地址是 {站点}/v1/t2a_v2
//   · 请求体是 model / text / voice_setting / audio_setting 这一套
//   · 响应里的 data.audio 是**十六进制**编码的音频（也可以让它返回临时地址）
//   · 失败时依然返回 HTTP 200，错误藏在 base_resp.status_code 里
// 这几处都和通用实现不一样，所以单独写一份。

const MINIMAX_ERRORS = {
  1000: '未知错误',
  1001: '请求超时',
  1002: '触发频率限制，请稍后再试',
  1004: '鉴权失败：API Key 不正确或已失效',
  1039: '触发 TPM 速率限制，请稍后再试',
  1042: '无效字符超过 10%，请检查要朗读的文本',
  2013: '参数不合法：请检查模型名称、音色 ID 与要朗读的文本',
};

// MiniMax 的接口地址有几种常见写法，这里全部兼容：
//   https://api.minimax.cn            → 站点根地址
//   https://api.minimax.cn/v1         → 填到 /v1
//   https://api.minimax.cn/v1/t2a_v2  → 直接填了完整接口
function minimaxEndpoint(baseUrl, endpoint) {
  const raw = trim(baseUrl) || 'https://api.minimax.cn';
  const clean = raw.replace(/\/+$/, '');
  const path = `/${endpoint}`;
  if (new RegExp(`${path}$`, 'i').test(clean)) return clean;
  if (/\/v1$/i.test(clean)) return `${clean}${path}`;
  return `${clean}/v1${path}`;
}

async function minimaxSpeech({ text, voice, speed, model, apiKey, baseUrl, volume, pitch, signal, timeoutMs = 120000 }) {
  const key = trim(apiKey);
  if (!key) throw new Error('未配置语音接口 API Key');
  const url = new URL(minimaxEndpoint(baseUrl, 't2a_v2'));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('语音接口地址必须使用 HTTP/HTTPS');
  const body = {
    model: trim(model) || 'speech-2.8-hd',
    text,
    stream: false,
    language_boost: 'auto',
    output_format: 'hex',
    voice_setting: {
      voice_id: trim(voice) || 'male-qn-qingse',
      speed: Math.max(0.5, Math.min(2, Number(speed) || 1)),
      vol: Math.max(0.1, Math.min(10, Number(volume) || 1)),
      pitch: Math.max(-12, Math.min(12, Number(pitch) || 0)),
    },
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
  };
  const timeout = AbortSignal.timeout(timeoutMs);
  const active = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST', redirect: 'error', signal: active,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (timeout.aborted) throw new Error('语音接口请求超时');
    throw new Error(`语音接口网络请求失败：${redact(trim(error?.cause?.code || error?.code || error?.message || '未知错误', 120), key)}`);
  }
  const raw = await response.text();
  let data = null;
  try { data = JSON.parse(raw); } catch {
    if (!response.ok) throw new Error(`语音接口失败：HTTP ${response.status}`);
    throw new Error('语音接口返回的不是 JSON');
  }
  // MiniMax 出错时也返回 HTTP 200，错误在 base_resp 里。
  const code = Number(data?.base_resp?.status_code);
  if (Number.isFinite(code) && code !== 0) {
    // 已知错误码用中文解释；没见过的就原样带出服务端的话。
    const detail = MINIMAX_ERRORS[code] || trim(data?.base_resp?.status_msg, 200) || `错误码 ${code}`;
    throw new Error(`语音接口失败（${code}）：${redact(detail, key)}`);
  }
  if (!response.ok) {
    throw new Error(`语音接口失败：HTTP ${response.status}${trim(data?.message, 120) ? ' ' + trim(data?.message, 120) : ''}`);
  }
  const payload = data?.data?.audio;
  if (!payload) {
    const trace = trim(data?.trace_id, 60);
    throw new Error(`语音接口没有返回音频${trace ? `（trace_id: ${trace}）` : ''}`);
  }
  const decoded = decodeAudioPayload(payload);
  if (decoded.kind === 'url') {
    const remote = await fetch(decoded.value, { signal: active });
    if (!remote.ok) throw new Error(`下载语音文件失败：HTTP ${remote.status}`);
    return normalizeAudio(Buffer.from(await remote.arrayBuffer()), remote.headers.get('content-type') || '');
  }
  return normalizeAudio(decoded.bytes, '', { sourceExt: 'mp3' });
}

// 列出账号下的音色（系统音色 + 克隆音色 + 文本生成音色）。
export async function listServiceVoices({ apiKey, baseUrl, signal } = {}) {
  const key = trim(apiKey);
  if (!key) return { ok: false, voices: [], error: '未配置语音接口 API Key' };
  const url = new URL(minimaxEndpoint(baseUrl, 'get_voice'));
  const timeout = AbortSignal.timeout(30000);
  const active = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetch(url, {
      method: 'POST', redirect: 'error', signal: active,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice_type: 'all' }),
    });
    const data = await response.json();
    const code = Number(data?.base_resp?.status_code);
    if (!response.ok || (Number.isFinite(code) && code !== 0)) {
      const message = trim(data?.base_resp?.status_msg, 200) || `HTTP ${response.status}`;
      return { ok: false, voices: [], error: `读取音色失败：${redact(message, key)}` };
    }
    const groups = [
      ['系统音色', data?.system_voice],
      ['克隆音色', data?.voice_cloning],
      ['生成音色', data?.voice_generation],
    ];
    const voices = [];
    for (const [group, list] of groups) {
      for (const item of Array.isArray(list) ? list : []) {
        if (!item?.voice_id) continue;
        voices.push({ id: item.voice_id, name: item.voice_name || item.voice_id, group, description: Array.isArray(item.description) ? item.description[0] || '' : '' });
      }
    }
    return { ok: true, voices };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    return { ok: false, voices: [], error: `读取音色失败：${redact(trim(error?.message, 200), key)}` };
  }
}

// ---------------------------------------------------------------------------
// Windows 系统语音（SAPI）
// ---------------------------------------------------------------------------

function powershellCommand() {
  if (process.platform !== 'win32') return null;
  // Windows PowerShell 5.1 自带 System.Speech；pwsh 是后备（部分精简系统只有它）。
  for (const candidate of ['powershell.exe', 'pwsh.exe']) {
    try {
      const { stdout } = execFileSyncWhich(candidate);
      return candidate;
    } catch { /* 试下一个 */ }
  }
  return null;
}

// 同步探测可执行文件是否存在；只在本机跑一次，失败就当没有。
function execFileSyncWhich(command) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], { encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0) throw new Error('not found');
  return result.stdout;
}

const POWERSHELL_SCRIPT = `$ErrorActionPreference = 'Stop'
$cfg = Get-Content -LiteralPath $env:QQBOT_TTS_CONFIG -Raw -Encoding UTF8 | ConvertFrom-Json
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  # 音色名写错时不致命：退回系统默认音色，比整条命令失败要好。
  if ($cfg.voice) {
    try { $synth.SelectVoice([string]$cfg.voice) }
    catch { Write-Output ('voice-fallback: ' + $_.Exception.Message) }
  }
  $synth.Rate = [int]$cfg.rate
  $synth.Volume = [int]$cfg.volume
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo -ArgumentList 16000, ([System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen), ([System.Speech.AudioFormat.AudioChannel]::Mono)
  $synth.SetOutputToWaveFile([string]$cfg.output, $format)
  $synth.Speak([string]$cfg.text)
  $synth.SetOutputToNull()
} finally {
  $synth.Dispose()
}
`;

// 没指定音色时，优先挑一个中文音色（系统默认音色多半是英文，念中文会很怪）。
const CHINESE_CULTURES = ['zh-cn', 'zh-tw', 'zh-hk', 'zh-sg', 'zh'];
async function preferredWindowsVoice(shell) {
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name } }
finally { $synth.Dispose() }`;
  try {
    const { stdout } = await run(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    });
    const voices = String(stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const [name, culture] = line.split('|');
      return { name, culture: (culture || '').toLowerCase() };
    });
    return voices.find((voice) => CHINESE_CULTURES.includes(voice.culture))?.name || '';
  } catch { return ''; }
}

async function windowsSpeech({ text, voice, rate, volume, timeoutMs = 60000 }) {
  if (process.platform !== 'win32') {
    throw new Error(`Windows 系统语音只能在 Windows 上使用；当前系统是 ${process.platform}。请改用「API 接口」方式接入语音。`);
  }
  const shell = powershellCommand();
  if (!shell) throw new Error('没有找到 PowerShell（powershell.exe / pwsh.exe），无法调用 Windows 系统语音');
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-tts-'));
  const configPath = join(dir, 'tts.json');
  const outputPath = join(dir, 'tts.wav');
  try {
    // 没指定音色就挑一个中文音色，避免用英文音色念中文。
    const chosen = trim(voice) || await preferredWindowsVoice(shell);
    // 用 JSON 配置文件传参：中文、引号、换行都不用做转义，也不会有注入问题。
    writeFileSync(configPath, JSON.stringify({
      text, voice: chosen, rate: Math.max(-10, Math.min(10, Number(rate) || 0)), volume: Math.max(0, Math.min(100, Number(volume) ?? 100)),
      output: outputPath,
    }), 'utf8');
    await run(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POWERSHELL_SCRIPT], {
      timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, QQBOT_TTS_CONFIG: configPath },
    });
    if (!existsSync(outputPath)) throw new Error('Windows 语音合成没有生成音频文件');
    const bytes = readFileSync(outputPath);
    return normalizeAudio(bytes, 'audio/wav', { sourceExt: 'wav' });
  } catch (error) {
    const stderr = String(error?.stderr || '').trim();
    const message = stderr.split(/\r?\n/).filter(Boolean).slice(-2).join(' ') || error?.message || '未知错误';
    throw new Error(`Windows 语音合成失败：${trim(message, 300)}`);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// 列出系统里已安装的语音（用于界面上让用户直接选）。
export async function listWindowsVoices() {
  if (process.platform !== 'win32') {
    return { ok: false, platform: process.platform, voices: [], error: `Windows 系统语音只能在 Windows 上使用；当前系统是 ${process.platform}` };
  }
  const shell = powershellCommand();
  if (!shell) return { ok: false, platform: process.platform, voices: [], error: '没有找到 PowerShell（powershell.exe / pwsh.exe）' };
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name } }
finally { $synth.Dispose() }`;
  try {
    const { stdout } = await run(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    });
    const voices = String(stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const [name, culture] = line.split('|');
      return { name, culture: culture || '' };
    });
    return { ok: true, platform: process.platform, voices };
  } catch (error) {
    return { ok: false, platform: process.platform, voices: [], error: trim(error?.message || '读取系统语音失败', 200) };
  }
}

// ---------------------------------------------------------------------------
// 格式转换（需要 ffmpeg；没有就退回 wav，QQ 一样能收）
// ---------------------------------------------------------------------------

let ffmpegChecked = null;
async function hasFfmpeg() {
  if (ffmpegChecked !== null) return ffmpegChecked;
  try {
    await run(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { timeout: 5000, windowsHide: true });
    ffmpegChecked = true;
  } catch { ffmpegChecked = false; }
  return ffmpegChecked;
}

async function convertFormat(audio, target) {
  if (!target || target === 'auto') return audio;
  if (target === audio.ext) return audio;
  if (target === 'silk') {
    throw new Error('输出 SILK 需要带 silk 编码器的 ffmpeg；本机没找到可用编码器，请改用 mp3 / wav / ogg（QQ 同样支持）');
  }
  if (!(await hasFfmpeg())) {
    if (target === 'wav') return audio;   // 已经是 wav 就不必转换
    throw new Error(`输出 ${target} 需要 ffmpeg，本机没有安装；可以直接选 wav（QQ 支持）`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-tts-'));
  const input = join(dir, `in.${audio.ext}`);
  const output = join(dir, `out.${target}`);
  try {
    writeFileSync(input, audio.bytes);
    const codec = target === 'mp3' ? 'libmp3lame' : target === 'ogg' ? 'libvorbis' : target === 'wav' ? 'pcm_s16le' : target;
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-ac', '1', '-ar', '16000'];
    if (target === 'mp3') args.push('-b:a', '64k');
    args.push('-c:a', codec, output);
    await run('ffmpeg', args, { timeout: 60000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    if (!existsSync(output)) throw new Error(`ffmpeg 转换到 ${target} 没有产出文件`);
    const bytes = readFileSync(output);
    return { bytes, ext: target, mime: MIME_BY_EXT[target] || 'application/octet-stream' };
  } catch (error) {
    const message = trim(error?.stderr || error?.message || '未知错误', 200);
    throw new Error(`音频格式转换失败：${message}`);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/**
 * 合成一段语音。
 * @returns {{bytes: Buffer, mime: string, ext: string, durationSec: number|null, source: string}}
 */
// 语音接口格式：auto 时按地址判断。
// MiniMax 根本没有 OpenAI 兼容的 /audio/speech（实测三个域名全是 404），
// 所以只要地址里带 minimax，就必须走它原生的 T2A 接口。
export function resolveTtsFormat(config = {}) {
  const declared = config.ttsApiFormat || 'auto';
  const url = String(config.ttsBaseUrl || '').toLowerCase();
  const isMinimax = url.includes('minimax');
  // MiniMax 根本没有 OpenAI 兼容的 /audio/speech（三个域名实测全是 404），
  // 所以只要地址是 MiniMax 的，就必须走它原生的 T2A 接口 —— 哪怕配置里写的是 openai。
  if (isMinimax) return 'minimax';
  if (declared !== 'auto') return declared;
  return 'openai';
}

export async function synthesize(config = {}, { text, signal } = {}) {
  const content = String(text ?? '').trim();
  if (!content) throw new Error('要合成的文本不能为空');
  const mode = config.ttsMode || 'off';
  if (mode === 'off') throw new Error('语音合成未启用：请在「语音」栏目里选择接入方式');
  if (!config.ttsEnabled) throw new Error('语音合成开关处于关闭状态');

  let audio;
  let source;
  if (mode === 'windows') {
    audio = await windowsSpeech({
      text: content, voice: config.ttsWindowsVoice, rate: config.ttsWindowsRate, volume: config.ttsWindowsVolume, signal,
    });
    source = 'windows';
  } else if (mode === 'api') {
    const format = resolveTtsFormat(config);
    if (format === 'custom') {
      audio = await customSpeech({
        text: content, voice: config.ttsVoice, speed: config.ttsSpeed, model: config.ttsModel,
        apiKey: config.ttsApiKey, baseUrl: config.ttsBaseUrl, custom: config, signal,
      });
    } else if (format === 'minimax') {
      audio = await minimaxSpeech({
        text: content, voice: config.ttsVoice, speed: config.ttsSpeed, model: config.ttsModel,
        apiKey: config.ttsApiKey, baseUrl: config.ttsBaseUrl,
        volume: config.ttsVolume, pitch: config.ttsPitch, signal,
      });
    } else {
      audio = await openaiSpeech({
        text: content, voice: config.ttsVoice, speed: config.ttsSpeed, model: config.ttsModel,
        apiKey: config.ttsApiKey, baseUrl: config.ttsBaseUrl, signal,
      });
    }
    source = 'api';
  } else {
    throw new Error(`未知的语音接入方式：${mode}`);
  }

  const wanted = config.ttsFormat || 'auto';
  let final = audio;
  if (wanted !== 'auto' && wanted !== audio.ext) {
    final = await convertFormat(audio, wanted);
  } else if (wanted === 'auto' && audio.ext === 'wav' && (await hasFfmpeg())) {
    // wav 太大，能转就转成 mp3。
    try { final = await convertFormat(audio, 'mp3'); } catch { final = audio; }
  }
  return {
    bytes: final.bytes,
    mime: final.mime,
    ext: final.ext,
    durationSec: estimateDuration(final.bytes, final.ext),
    source,
  };
}

// 「测试语音」：合成一小段，报出实际格式与大小。
export async function testSpeech(config = {}, { signal } = {}) {
  const started = Date.now();
  const audio = await synthesize(config, { text: '你好，这是语音合成的连通性测试。', signal });
  return {
    ok: true,
    latencyMs: Date.now() - started,
    format: audio.ext,
    mime: audio.mime,
    bytes: audio.bytes.length,
    durationSec: audio.durationSec,
    source: audio.source,
  };
}

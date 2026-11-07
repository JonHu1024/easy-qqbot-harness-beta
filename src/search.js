// 免费联网搜索与网页读取：只使用 Node 内置能力与 fetch，无第三方依赖。
// 所有提供方主机硬编码在白名单内，查询参数一律经 URLSearchParams 编码。
import { downloadMedia } from './media.js';

const DDG_HTML = 'https://html.duckduckgo.com/html/';
const DDG_API = 'https://api.duckduckgo.com/';
const WIKI_API = 'https://zh.wikipedia.org/w/api.php';
const PROVIDER_HOSTS = new Set(['html.duckduckgo.com', 'api.duckduckgo.com', 'zh.wikipedia.org', 'www.bing.com', 'cn.bing.com']);
const BING_HTML = 'https://cn.bing.com/search';
// 顺序：duckduckgo → bing → 维基百科。
// 实测下来 DuckDuckGo 的中文结果最准（天气、新闻都能查到）；
// bing 连得上但中文结果常常跑偏；维基百科在国内基本连不上（超时）。
const PROVIDERS = ['duckduckgo', 'bing', 'wikipedia'];
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_RESULTS = 10;
const DEFAULT_RESULTS = 5;
const READ_TYPES = new Set(['text/html', 'text/plain', 'application/json']);
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', shy: '\u00ad',
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', middot: '\u00b7',
  laquo: '\u00ab', raquo: '\u00bb', ldquo: '\u201c', rdquo: '\u201d', lsquo: '\u2018', rsquo: '\u2019',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', deg: '\u00b0', times: '\u00d7', divide: '\u00f7',
  bull: '\u2022', sect: '\u00a7', para: '\u00b6', euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2',
};

function decodeEntities(input) {
  return String(input).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]{1,31});/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return match;
      try { return String.fromCodePoint(code); } catch { return match; }
    }
    return NAMED[body.toLowerCase()] ?? match;
  });
}

// 去标签 → 解码实体 → 压缩空白，用于结果片段与标题。
function plainText(fragment) {
  return decodeEntities(String(fragment).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

const brief = (message, max = 160) => String(message ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const mimeOf = value => String(value || '').split(';')[0].trim().toLowerCase();

function ensureHost(url) {
  const host = new URL(url).hostname;
  if (!PROVIDER_HOSTS.has(host)) throw new Error(`不允许访问的搜索主机：${host}`);
}

// 读取响应体并在超过上限时立即中止，避免下载超大页面。
async function readBody(response, maxBytes, signal) {
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
      if (size > maxBytes) { try { await reader.cancel(); } catch {} throw new Error('响应超过大小限制'); }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

async function getText(url, { signal, timeoutMs, method = 'GET' } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const active = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  let target = url;
  // 搜索站点经常 302 到同族的另一个域名（cn.bing.com → www.bing.com）。
  // 一律拒绝重定向的话这些源就用不了了；改成「手动跟一跳，但目标主机必须在白名单里」。
  for (let hop = 0; hop < 3; hop++) {
    try {
      response = await fetch(target, {
        method, redirect: 'manual', signal: active,
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6' },
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (timeout.aborted) throw new Error(`请求超时（${timeoutMs}ms）`);
      throw new Error(`网络请求失败：${brief(error?.cause?.code || error?.code || error?.message || '未知错误')}`);
    }
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get('location');
    if (!location) throw new Error('重定向没有目标地址');
    let next;
    try { next = new URL(location, target); } catch { throw new Error('重定向目标地址无效'); }
    ensureHost(next);            // 白名单之外的主机一律不去
    try { await response.body?.cancel(); } catch { /* ignore */ }
    target = next;
  }
  if (response.status >= 300 && response.status < 400) throw new Error('重定向次数过多');
  if (!response.ok) {
    try { await response.body?.cancel(); } catch {}
    throw new Error(`HTTP ${response.status}`);
  }
  return { status: response.status, text: await readBody(response, MAX_BYTES, signal) };
}

// DuckDuckGo 结果链接常为 //duckduckgo.com/l/?uddg=<编码后的真实地址>。
function resultUrl(href) {
  if (typeof href !== 'string' || !href) return '';
  const value = decodeEntities(href).trim();
  let url;
  try { url = new URL(value.startsWith('//') ? `https:${value}` : value, DDG_HTML); } catch { return ''; }
  if (url.hostname === 'duckduckgo.com' && url.pathname.startsWith('/l/')) {
    const target = url.searchParams.get('uddg');
    if (!target) return '';
    try { url = new URL(target); } catch { return ''; }
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
}

export function parseDuckDuckGo(html) {
  const anchors = [...String(html).matchAll(/<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*>[\s\S]*?<\/a>/gi)];
  const snippets = [...String(html).matchAll(/<(?:a|div|span)\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>[\s\S]*?<\/(?:a|div|span)>/gi)];
  const results = [];
  for (let index = 0; index < anchors.length; index++) {
    const tag = anchors[index][0];
    const url = resultUrl(/\bhref="([^"]*)"/i.exec(tag)?.[1]);
    const title = plainText(tag);
    if (!url || !title) continue;
    const start = anchors[index].index;
    const end = index + 1 < anchors.length ? anchors[index + 1].index : String(html).length;
    const snippet = snippets.find(item => item.index > start && item.index < end);
    results.push({ title, url, snippet: snippet ? plainText(snippet[0]) : '' });
  }
  return results;
}

export function parseInstantAnswer(data) {
  const out = [];
  const push = (title, url, snippet) => {
    const text = plainText(title);
    if (!text || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
    out.push({ title: text, url, snippet: plainText(snippet || '') });
  };
  push(data?.Heading || data?.AbstractSource || 'DuckDuckGo', data?.AbstractURL, data?.AbstractText);
  push(data?.Definition || data?.Heading || 'DuckDuckGo', data?.DefinitionURL, data?.Definition);
  const walk = topics => {
    for (const topic of Array.isArray(topics) ? topics : []) {
      if (Array.isArray(topic?.Topics)) walk(topic.Topics);
      else push(topic?.Text, topic?.FirstURL, '');
    }
  };
  walk(data?.RelatedTopics);
  const seen = new Set();
  return out.filter(item => !seen.has(item.url) && seen.add(item.url));
}

async function duckduckgo(query, limit, { signal, timeoutMs, notes }) {
  let results = [];
  try {
    const htmlUrl = new URL(DDG_HTML);
    htmlUrl.searchParams.set('q', query);
    ensureHost(htmlUrl);
    const { status, text } = await getText(htmlUrl, { signal, timeoutMs });
    results = parseDuckDuckGo(text).slice(0, limit);
    if (!results.length) notes.push(status === 202 ? 'DuckDuckGo HTML 接口触发风控（HTTP 202），改用 Instant Answer 补充' : 'DuckDuckGo HTML 接口未返回结果，改用 Instant Answer 补充');
  } catch (error) {
    if (signal?.aborted) throw error;
    notes.push(`DuckDuckGo HTML 接口失败：${brief(error.message)}`);
  }
  if (results.length) return results;
  const apiUrl = new URL(DDG_API);
  apiUrl.searchParams.set('q', query);
  apiUrl.searchParams.set('format', 'json');
  apiUrl.searchParams.set('no_html', '1');
  apiUrl.searchParams.set('no_redirect', '1');
  ensureHost(apiUrl);
  const { text } = await getText(apiUrl, { signal, timeoutMs });
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('DuckDuckGo Instant Answer 返回非 JSON 响应'); }
  return parseInstantAnswer(data).slice(0, limit);
}

async function wikipedia(query, limit, { signal, timeoutMs }) {
  const url = new URL(WIKI_API);
  url.searchParams.set('action', 'query');
  url.searchParams.set('list', 'search');
  url.searchParams.set('srsearch', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('utf8', '1');
  url.searchParams.set('srlimit', String(limit));
  ensureHost(url);
  const { text } = await getText(url, { signal, timeoutMs });
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('维基百科返回非 JSON 响应'); }
  if (data?.error) throw new Error(`维基百科接口错误：${brief(data.error.info || data.error.code || '未知错误')}`);
  const list = Array.isArray(data?.query?.search) ? data.query.search : [];
  return list.slice(0, limit).map(item => {
    const title = plainText(item?.title);
    return {
      title,
      url: title ? `https://zh.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}` : '',
      snippet: plainText(item?.snippet),
    };
  }).filter(item => item.title && item.url);
}

// 解析 Bing 的结果页：每个 <li class="b_algo"> 是一条结果。
function parseBing(html, limit) {
  const results = [];
  for (const block of String(html).split('class="b_algo"').slice(1)) {
    const link = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const url = decodeEntities(link[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    const title = plainText(link[2]);
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    results.push({ title, url, snippet: snippet ? plainText(snippet[1]) : '' });
    if (results.length >= limit) break;
  }
  return results;
}

async function bing(query, limit, { signal, timeoutMs }) {
  const url = new URL(BING_HTML);
  url.searchParams.set('q', query);
  url.searchParams.set('setlang', 'zh-CN');
  url.searchParams.set('count', String(Math.max(10, limit)));
  ensureHost(url);
  const { text } = await getText(url, { signal, timeoutMs });
  return parseBing(text, limit);
}

const runProvider = (name, query, limit, options) => {
  if (name === 'wikipedia') return wikipedia(query, limit, options);
  if (name === 'bing') return bing(query, limit, options);
  return duckduckgo(query, limit, options);
};

// provider='auto' 时按 duckduckgo → wikipedia 顺序逐个尝试，某个提供方失败或无结果才换下一个。
export async function webSearch(query, { count = DEFAULT_RESULTS, provider = 'auto', signal, timeoutMs = 15000 } = {}) {
  const text = typeof query === 'string' ? query.trim() : '';
  if (!text) throw new Error('搜索关键词不能为空');
  if (text.length > 500) throw new Error('搜索关键词过长');
  if (!PROVIDERS.includes(provider) && provider !== 'auto') throw new Error(`不支持的搜索提供方：${provider}`);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('搜索超时时间无效');
  const notes = [];
  let limit = Number.isFinite(count) ? Math.trunc(count) : DEFAULT_RESULTS;
  if (limit < 1) limit = 1;
  if (limit > MAX_RESULTS) { limit = MAX_RESULTS; notes.push(`结果数量已限制为 ${MAX_RESULTS}`); }
  signal?.throwIfAborted();
  const order = provider === 'auto' ? PROVIDERS : [provider];
  let last = order[0];
  for (const name of order) {
    last = name;
    try {
      // 自动模式下单个源别等太久：第一个源连不上时，尽快换下一个，
      // 否则用户要干等十几秒才拿到结果。
      const perProvider = provider === 'auto' ? Math.min(timeoutMs, 9000) : timeoutMs;
      const results = await runProvider(name, text, limit, { signal, timeoutMs: perProvider, notes });
      if (results.length) return { results, provider: name, notes };
      notes.push(`${name} 未返回可用结果`);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      notes.push(`${name} 搜索失败：${brief(error.message)}`);
    }
  }
  return { results: [], provider: last, notes };
}

function formatJson(raw) {
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw.trim(); }
}

// 剥离 script/style/head 等节点后提取可读正文，并保留段落换行。
export function htmlToText(html) {
  const stripped = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|iframe)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?(?:<\/svg\s*>|$)/gi, ' ')
    .replace(/<head\b[^>]*>[\s\S]*?(?:<\/head\s*>|$)/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|main|aside|nav|li|ul|ol|h[1-6]|tr|table|blockquote|pre|figure)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(stripped)
    .split('\n')
    .map(line => line.replace(/[ \t\f\v\u00a0]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

export function extractTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html));
  return match ? plainText(match[1]) : '';
}

// 读取公网网页正文。download 默认复用 media.js 的 downloadMedia（DNS 固定、拒绝重定向、限大小）。
export async function readUrl(url, { maxChars = 20000, signal, download = downloadMedia } = {}) {
  const notes = [];
  if (typeof url !== 'string' || !url.trim()) throw new Error('网页地址不能为空');
  if (!Number.isFinite(maxChars) || maxChars < 1) throw new Error('正文长度上限无效');
  let target;
  try { target = new URL(url.trim()); } catch { throw new Error('网页地址格式无效'); }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('只允许 http/https 网页地址');
  target.hash = '';
  signal?.throwIfAborted();
  let bytes, contentType;
  try {
    ({ bytes, contentType } = await download(target.href, { signal, label: '网址' }));
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new Error(`网页读取失败：${brief(error?.message || '未知错误')}`);
  }
  const type = mimeOf(contentType);
  if (!READ_TYPES.has(type)) throw new Error(`不支持的内容类型：${type || '未知'}（仅支持 HTML、纯文本与 JSON）`);
  const raw = new TextDecoder('utf-8').decode(bytes);
  let title = '';
  let text;
  if (type === 'application/json') {
    text = formatJson(raw);
  } else if (type === 'text/plain') {
    text = raw.replace(/\r\n?/g, '\n').replace(/[ \t\f\v\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  } else {
    title = extractTitle(raw);
    text = htmlToText(raw);
  }
  if (text.length > maxChars) { text = text.slice(0, maxChars); notes.push(`正文已截断至 ${maxChars} 字符`); }
  if (!text) notes.push('未提取到正文内容');
  return { url: target.href, title, text, notes };
}

// Local PDF text extraction using only Node built-ins (no dependencies).
// Strategy: linear scan for `N G obj` definitions (robust fallback that does not
// trust xref offsets), expand Type/ObjStm object streams, then walk the page tree
// and decode content streams (FlateDecode only) extracting BT/ET text operators.
// ToUnicode CMaps (bfchar/bfrange) map CID codes to Unicode; unmapped CIDs are
// skipped rather than emitted as garbage. Never fabricates content: ok=false
// means no usable text could be recovered (scanned/encrypted/broken).
import { inflateSync, inflateRawSync } from 'node:zlib';

const MAX_OBJECTS = 200000;

// ---------------------------------------------------------------------------
// tiny PDF object parser (operates on a latin1 string; char index == byte index)
// ---------------------------------------------------------------------------

const isWs = c => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
const isDelim = c => isWs(c) || c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e
  || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;

function skipWs(s, i) {
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (isWs(c)) i++;
    else if (c === 0x25) { while (i < n && s.charCodeAt(i) !== 0x0a && s.charCodeAt(i) !== 0x0d) i++; }
    else break;
  }
  return i;
}

function parseNumber(s, i) {
  let j = i;
  const c = s.charCodeAt(j);
  if (c === 0x2b || c === 0x2d) j++;
  while (j < s.length) {
    const cc = s.charCodeAt(j);
    if ((cc >= 0x30 && cc <= 0x39) || cc === 0x2e) j++;
    else break;
  }
  if (j === i) return { value: null, pos: i + 1 };
  const num = Number(s.slice(i, j));
  return { value: Number.isFinite(num) ? num : 0, pos: j };
}

function parseNumberOrRef(s, i) {
  const first = parseNumber(s, i);
  if (typeof first.value !== 'number' || !Number.isInteger(first.value)) return first;
  const p = skipWs(s, first.pos);
  const second = parseNumber(s, p);
  if (typeof second.value === 'number' && Number.isInteger(second.value)) {
    const q = skipWs(s, second.pos);
    if (s[q] === 'R') return { value: { ref: [first.value, second.value] }, pos: q + 1 };
  }
  return first;
}

function parseLiteral(s, i) {
  const bytes = [];
  let depth = 1;
  i++;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 0x5c) { // backslash escape
      if (i + 1 >= s.length) { i++; break; }
      const nc = s.charCodeAt(i + 1);
      if (nc === 0x6e) { bytes.push(0x0a); i += 2; }
      else if (nc === 0x72) { bytes.push(0x0d); i += 2; }
      else if (nc === 0x74) { bytes.push(0x09); i += 2; }
      else if (nc === 0x62) { bytes.push(0x08); i += 2; }
      else if (nc === 0x66) { bytes.push(0x0c); i += 2; }
      else if (nc >= 0x30 && nc <= 0x37) { // \ddd octal (1..3 digits)
        let oct = '';
        let k = i + 1;
        while (k < s.length && oct.length < 3) {
          const oc = s.charCodeAt(k);
          if (oc < 0x30 || oc > 0x37) break;
          oct += s[k];
          k++;
        }
        bytes.push(parseInt(oct, 8) & 0xff);
        i = k;
      } else if (nc === 0x0a) i += 2; // line continuation
      else if (nc === 0x0d) { i += 2; if (s[i] === '\n') i++; }
      else { bytes.push(nc & 0xff); i += 2; }
      continue;
    }
    if (c === 0x28) { depth++; bytes.push(c); i++; continue; }
    if (c === 0x29) { depth--; i++; if (depth === 0) break; bytes.push(c); continue; }
    bytes.push(c & 0xff);
    i++;
  }
  return { value: Uint8Array.from(bytes), pos: i };
}

function parseHex(s, i) {
  let hex = '';
  i++;
  while (i < s.length && s[i] !== '>') {
    const ch = s[i];
    if ((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F')) hex += ch;
    i++;
  }
  if (i < s.length && s[i] === '>') i++;
  if (hex.length % 2) hex += '0';
  const bytes = new Uint8Array(hex.length / 2);
  for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(hex.substr(k * 2, 2), 16);
  return { value: bytes, pos: i };
}

function parseArray(s, i) {
  const arr = [];
  i++;
  while (i < s.length) {
    i = skipWs(s, i);
    if (i >= s.length) break;
    if (s[i] === ']') { i++; break; }
    const r = parseValue(s, i);
    arr.push(r.value);
    i = r.pos;
  }
  return { value: arr, pos: i };
}

function parseDict(s, i) {
  const map = new Map();
  i += 2;
  while (i < s.length) {
    i = skipWs(s, i);
    if (i >= s.length) break;
    if (s[i] === '>' && s[i + 1] === '>') { i += 2; break; }
    if (s[i] === '/') {
      const key = parseValue(s, i);
      i = key.pos;
      i = skipWs(s, i);
      let val;
      try { val = parseValue(s, i); } catch { val = { value: null, pos: i + 1 }; }
      map.set(key.value, val.value);
      i = val.pos;
    } else { // malformed entry: advance one token
      let j = i;
      while (j < s.length && !isDelim(s.charCodeAt(j))) j++;
      i = j > i ? j : i + 1;
    }
  }
  return { value: map, pos: i };
}

function parseValue(s, i) {
  i = skipWs(s, i);
  if (i >= s.length) return { value: null, pos: i };
  const c = s.charCodeAt(i);
  if (c === 0x2f) { // /Name
    let j = i + 1;
    while (j < s.length && !isDelim(s.charCodeAt(j))) j++;
    const name = s.slice(i + 1, j).replace(/#([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    return { value: name, pos: j };
  }
  if (c === 0x28) return parseLiteral(s, i);
  if (c === 0x3c) return s[i + 1] === '<' ? parseDict(s, i) : parseHex(s, i);
  if (c === 0x5b) return parseArray(s, i);
  if (c === 0x2b || c === 0x2d || c === 0x2e || (c >= 0x30 && c <= 0x39)) return parseNumberOrRef(s, i);
  let j = i;
  while (j < s.length && !isDelim(s.charCodeAt(j))) j++;
  const word = s.slice(i, j);
  if (word === 'true') return { value: true, pos: j };
  if (word === 'false') return { value: false, pos: j };
  if (word === 'null') return { value: null, pos: j };
  return { value: word || null, pos: j > i ? j : i + 1 };
}

// ---------------------------------------------------------------------------
// object scanning + stream decoding
// ---------------------------------------------------------------------------

function scanObjects(buf, text, note) {
  const objs = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  let guard = 0;
  while ((m = re.exec(text)) && objs.size < MAX_OBJECTS && guard++ < MAX_OBJECTS * 4) {
    const num = Number(m[1]);
    const gen = Number(m[2]);
    const pos = m.index + m[0].length;
    let parsed;
    try { parsed = parseValue(text, pos); } catch { parsed = null; }
    if (!parsed || !(parsed.value instanceof Map)) { re.lastIndex = pos; continue; }
    const dict = parsed.value;
    let stream = null;
    const p = skipWs(text, parsed.pos);
    if (text.startsWith('stream', p)) {
      let sp = p + 6;
      if (text[sp] === '\r') sp++;
      if (text[sp] === '\n') sp++;
      const len = dict.get('Length');
      if (typeof len === 'number' && len >= 0 && sp + len <= buf.length) {
        stream = buf.subarray(sp, sp + len);
        const after = skipWs(text, sp + len);
        re.lastIndex = text.startsWith('endstream', after) ? after + 9 : sp + len;
      } else {
        const end = text.indexOf('endstream', sp);
        stream = buf.subarray(sp, end === -1 ? buf.length : end);
        re.lastIndex = end === -1 ? buf.length : end + 9;
      }
    } else {
      re.lastIndex = parsed.pos;
    }
    objs.set(num, { num, gen, value: dict, stream });
  }
  if (objs.size === 0) note('未找到任何 PDF 对象（文件可能已损坏或不是 PDF）');
  return objs;
}

function streamFilters(objs, entry) {
  const f = resolveValue(objs, entry.value.get('Filter'));
  if (f === null || f === undefined) return [];
  return Array.isArray(f) ? f : [f];
}

function decodeStream(objs, entry, note) {
  if (!entry || !entry.stream) return null;
  let data = Buffer.from(entry.stream);
  for (const f of streamFilters(objs, entry)) {
    if (f === 'FlateDecode' || f === 'Fl') {
      let out = null;
      try { out = inflateSync(data); } catch { /* try raw below */ }
      if (!out) { try { out = inflateRawSync(data); } catch { out = null; } }
      if (!out) { note('FlateDecode 解压失败，已跳过该流'); return null; }
      data = out;
    } else {
      note(`不支持的流过滤器 /${f}（仅支持 FlateDecode），已跳过该流`);
      return null;
    }
  }
  return data;
}

function expandObjectStreams(objs, note) {
  for (const entry of [...objs.values()]) {
    if (!(entry.value instanceof Map) || entry.value.get('Type') !== 'ObjStm' || !entry.stream) continue;
    const data = decodeStream(objs, entry, note);
    if (!data) continue;
    const s = data.toString('latin1');
    let p = skipWs(s, 0);
    const count = parseValue(s, p);
    if (typeof count.value !== 'number') continue;
    p = count.pos;
    const pairs = [];
    for (let k = 0; k < count.value; k++) {
      const a = parseValue(s, p); p = a.pos;
      const b = parseValue(s, p); p = b.pos;
      pairs.push([a.value, b.value]);
    }
    const base = skipWs(s, p);
    for (const [num, off] of pairs) {
      if (typeof num !== 'number' || typeof off !== 'number') continue;
      const r = parseValue(s, base + off);
      if (r && r.value !== null && r.value !== undefined) objs.set(num, { num, gen: 0, value: r.value, stream: null });
    }
  }
}

const resolveValue = (objs, v, depth = 0) => {
  if (depth > 40) return null;
  if (v && typeof v === 'object' && Array.isArray(v.ref)) {
    const e = objs.get(v.ref[0]);
    return e ? resolveValue(objs, e.value, depth + 1) : null;
  }
  return v;
};

// ---------------------------------------------------------------------------
// ToUnicode CMap
// ---------------------------------------------------------------------------

function hexToUtf16be(hex) {
  if (!hex) return '';
  const b = Buffer.from(hex, 'hex');
  let s = '';
  for (let k = 0; k + 1 < b.length; k += 2) s += String.fromCharCode((b[k] << 8) | b[k + 1]);
  if (b.length % 2) s += String.fromCharCode(b[b.length - 1]);
  return s;
}

function incrementHex(hex, delta) {
  const b = Buffer.from(hex, 'hex');
  if (b.length >= 2) {
    let unit = (((b[b.length - 2] << 8) | b[b.length - 1]) + delta) & 0xffff;
    b[b.length - 2] = unit >> 8;
    b[b.length - 1] = unit & 0xff;
  }
  return b.toString('hex');
}

function parseToUnicode(data) {
  let s = (Buffer.isBuffer(data) ? data : Buffer.from(data)).toString('latin1');
  s = s.replace(/%.*$/gm, '');
  const map = new Map();
  for (const block of s.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
      map.set(parseInt(pair[1], 16), hexToUtf16be(pair[2]));
    }
  }
  for (const block of s.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (m[3][0] === '[') {
        const items = [...m[3].matchAll(/<([0-9A-Fa-f]*)>/g)].map(x => x[1]);
        for (let k = 0; k <= hi - lo && k < items.length; k++) map.set(lo + k, hexToUtf16be(items[k]));
      } else {
        const base = m[3].slice(1, -1);
        for (let code = lo; code <= hi; code++) map.set(code, hexToUtf16be(incrementHex(base, code - lo)));
      }
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// fonts
// ---------------------------------------------------------------------------

function utf16be(bytes) {
  let s = '';
  for (let k = 0; k + 1 < bytes.length; k += 2) s += String.fromCharCode((bytes[k] << 8) | bytes[k + 1]);
  return s;
}

// WinAnsiEncoding: bytes 0x80-0x9f differ from Latin-1.
const CP1252_HIGH = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020,
  0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152,
  0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022,
  0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
  0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

function decodeSimple(bytes, font) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return utf16be(bytes.subarray(2));
  let s = '';
  for (const b of bytes) {
    if (b < 0x80 || b >= 0xa0) s += String.fromCharCode(b);
    else if (CP1252_HIGH[b]) s += String.fromCharCode(CP1252_HIGH[b]);
    // undefined 0x81/0x8d/0x8f/0x90/0x9d are dropped rather than emitted as garbage
  }
  return s;
}

function describeFont(entry, objs, note, caches) {
  if (entry.num !== undefined && caches.has(entry.num)) return caches.get(entry.num);
  const dict = entry.value;
  let desc;
  if (dict.get('Subtype') === 'Type0') {
    let map = null;
    const tuRef = dict.get('ToUnicode');
    if (tuRef && tuRef.ref) {
      const tuEntry = objs.get(tuRef.ref[0]);
      const data = tuEntry ? decodeStream(objs, tuEntry, note) : null;
      if (data) {
        const parsed = parseToUnicode(data);
        if (parsed.size) map = parsed;
      }
    }
    if (!map) note('CID/Type0 字体缺少可用的 ToUnicode CMap，相关文本已跳过');
    desc = { cid: true, map };
  } else {
    desc = { cid: false };
  }
  if (entry.num !== undefined) caches.set(entry.num, desc);
  return desc;
}

function buildFonts(pageEntry, objs, note, caches) {
  const fonts = new Map();
  const resOf = e => {
    const r = resolveValue(objs, e.value.get('Resources'));
    return r instanceof Map ? r : null;
  };
  let res = resOf(pageEntry);
  if (!res) {
    for (const e of objs.values()) {
      if (e.value instanceof Map && e.value.get('Type') === 'Pages') {
        const r = resOf(e);
        if (r) { res = r; break; }
      }
    }
  }
  if (!res) return fonts;
  const fontDict = resolveValue(objs, res.get('Font'));
  if (!(fontDict instanceof Map)) return fonts;
  for (const [name, ref] of fontDict) {
    const e = ref && ref.ref ? objs.get(ref.ref[0]) : null;
    if (!e || !(e.value instanceof Map)) continue;
    fonts.set(name, describeFont(e, objs, note, caches));
  }
  return fonts;
}

function decodeShow(bytes, font, note) {
  if (!bytes || !bytes.length) return '';
  if (font && font.cid) {
    if (!font.map) return '';
    let out = '';
    let unmapped = 0;
    for (let k = 0; k + 1 < bytes.length; k += 2) {
      const code = (bytes[k] << 8) | bytes[k + 1];
      const mapped = font.map.get(code);
      if (mapped !== undefined) out += mapped;
      else unmapped++;
    }
    if (bytes.length % 2) unmapped++;
    if (unmapped) note(`有 ${unmapped} 个 CID 未在 ToUnicode 中映射，已跳过`);
    return out;
  }
  return decodeSimple(bytes, font);
}

// ---------------------------------------------------------------------------
// content stream text extraction
// ---------------------------------------------------------------------------

function contentToText(s, fonts, note) {
  let out = '';
  let stack = [];
  let font = null;
  let inText = !/\bBT\b/.test(s); // tolerate streams that omit BT/ET
  const newline = () => { if (out && !out.endsWith('\n')) out += '\n'; };
  const emit = t => { if (t && inText) out += t; };
  const show = str => { const t = decodeShow(str, font, note); if (t) emit(t); };

  let i = 0;
  const n = s.length;
  while (i < n) {
    i = skipWs(s, i);
    if (i >= n) break;
    const c = s.charCodeAt(i);
    if (c === 0x27 || c === 0x22) { // ' / " : move to next line, then show string
      newline();
      show(stack[stack.length - 1]);
      stack = [];
      i++;
      continue;
    }
    if ((c === 0x3c && s[i + 1] === '<') || c === 0x5b || c === 0x28 || c === 0x2f
      || c === 0x3c || c === 0x2b || c === 0x2d || c === 0x2e || (c >= 0x30 && c <= 0x39)) {
      let r;
      try { r = parseValue(s, i); } catch { i++; continue; }
      stack.push(r.value);
      i = r.pos;
      continue;
    }
    let j = i;
    while (j < n) {
      const cc = s.charCodeAt(j);
      if (isDelim(cc) || cc === 0x27 || cc === 0x22) break;
      j++;
    }
    const word = s.slice(i, j);
    i = j > i ? j : i + 1;
    if (!word) continue;
    switch (word) {
      case 'BT': inText = true; break;
      case 'ET': newline(); inText = false; break;
      case 'Tf': {
        const name = stack[stack.length - 2];
        font = typeof name === 'string' ? fonts.get(name) || null : null;
        break;
      }
      case 'Tj': show(stack[stack.length - 1]); break;
      case 'TJ': {
        const arr = stack[stack.length - 1];
        if (Array.isArray(arr)) {
          for (const el of arr) {
            if (el instanceof Uint8Array) show(el);
            else if (typeof el === 'number' && el <= -150) emit(' ');
          }
        }
        break;
      }
      case 'Td':
      case 'TD': {
        const ty = stack[stack.length - 1];
        if (typeof ty === 'number' && Math.abs(ty) > 0.5) newline();
        break;
      }
      case 'T*':
      case 'Tm': newline(); break;
      default: break;
    }
    stack = [];
  }
  return out;
}

// ---------------------------------------------------------------------------
// page tree
// ---------------------------------------------------------------------------

function orderedPages(objs) {
  const pages = [];
  const seen = new Set();
  const isType = (e, t) => e && e.value instanceof Map && e.value.get('Type') === t;
  const catalog = [...objs.values()].find(e => isType(e, 'Catalog'));
  const visit = entry => {
    if (!entry || seen.has(entry)) return;
    seen.add(entry);
    if (isType(entry, 'Page')) { pages.push(entry); return; }
    const kids = resolveValue(objs, entry.value.get('Kids'));
    if (Array.isArray(kids)) {
      for (const k of kids) {
        const num = k && k.ref ? k.ref[0] : null;
        if (num != null) visit(objs.get(num));
      }
    }
  };
  const rootRef = catalog && catalog.value.get('Pages');
  if (rootRef && rootRef.ref) visit(objs.get(rootRef.ref[0]));
  if (pages.length) return pages;
  return [...objs.entries()].filter(([, e]) => isType(e, 'Page')).sort((a, b) => a[0] - b[0]).map(([, e]) => e);
}

function contentEntries(pageEntry, objs) {
  const c = pageEntry.value.get('Contents');
  const list = Array.isArray(c) ? c : (c ? [c] : []);
  const out = [];
  for (const item of list) {
    const num = item && item.ref ? item.ref[0] : null;
    if (num == null) continue;
    const e = objs.get(num);
    if (e && e.stream) out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (typeof input === 'string') return Buffer.from(input, 'base64');
  return null;
}

function normalize(text) {
  let s = text.replace(/\r\n?/g, '\n');
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  s = s.replace(/[ \t\u00a0\u2000-\u200a\u202f\u205f]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  const lines = [];
  for (const line of s.split('\n')) {
    if (line && lines.length && lines[lines.length - 1] === line) continue;
    lines.push(line);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function extractPdfText(input, { maxChars = 200000, maxStreams = 400, signal } = {}) {
  const notes = [];
  const seenNotes = new Set();
  const note = msg => { if (msg && !seenNotes.has(msg)) { seenNotes.add(msg); notes.push(msg); } };
  const fail = (message, pages = 0) => { if (message) note(message); return { ok: false, text: '', pages, notes }; };
  const checkAbort = () => {
    if (signal && signal.aborted) {
      const err = new Error('PDF 文本提取已取消');
      err.name = 'AbortError';
      throw err;
    }
  };
  const limit = Math.max(0, Math.floor(Number(maxChars)) || 0);
  const streamLimit = Math.max(0, Math.floor(Number(maxStreams)) || 0);

  try {
    checkAbort();
    const buf = toBuffer(input);
    if (!buf || buf.length === 0) return fail('输入为空，无法提取文本');
    if (!buf.subarray(0, 1024).toString('latin1').includes('%PDF-')) {
      return fail('不是有效的 PDF（缺少 %PDF- 文件头）');
    }
    const text = buf.toString('latin1');
    if (/\/Encrypt[\s\d]/.test(text) || /\/Encrypt\s*<</.test(text)) {
      return fail('文档已加密 (/Encrypt)，无法提取文本');
    }

    const objs = scanObjects(buf, text, note);
    if (objs.size === 0) return { ok: false, text: '', pages: 0, notes };
    expandObjectStreams(objs, note);

    const caches = new Map();
    let out = '';
    let truncated = false;
    let streams = 0;
    let pages = 0;
    const pagesList = orderedPages(objs);

    if (pagesList.length) {
      pages = pagesList.length;
      outer: for (const pageEntry of pagesList) {
        checkAbort();
        const fonts = buildFonts(pageEntry, objs, note, caches);
        for (const ce of contentEntries(pageEntry, objs)) {
          if (streams >= streamLimit) { note(`内容流数量超过上限 maxStreams=${streamLimit}，已停止`); break outer; }
          streams++;
          const data = decodeStream(objs, ce, note);
          if (!data) continue;
          const piece = contentToText(data.toString('latin1'), fonts, note);
          if (piece) out += (out && !out.endsWith('\n') ? '\n' : '') + piece;
          if (out.length > limit) { out = out.slice(0, limit); truncated = true; break outer; }
        }
      }
    } else {
      for (const entry of objs.values()) {
        checkAbort();
        if (!entry.stream || (entry.value instanceof Map && entry.value.get('Type'))) continue;
        if (streams >= streamLimit) { note(`内容流数量超过上限 maxStreams=${streamLimit}，已停止`); break; }
        streams++;
        const data = decodeStream(objs, entry, note);
        if (!data) continue;
        const s = data.toString('latin1');
        if (!/\bBT\b/.test(s) && !/\bTj\b/.test(s) && !/\bTJ\b/.test(s)) continue;
        const piece = contentToText(s, new Map(), note);
        if (piece) out += (out && !out.endsWith('\n') ? '\n' : '') + piece;
        if (out.length > limit) { out = out.slice(0, limit); truncated = true; break; }
      }
      pages = streams;
    }

    let finalText = normalize(out);
    if (finalText.length > limit) { finalText = finalText.slice(0, limit); truncated = true; }
    if (truncated) note(`提取文本超过 maxChars=${limit}，已截断`);
    if (streams === 0) note('未找到可解析的内容流');

    const ok = /[\p{L}\p{N}]/u.test(finalText);
    if (!ok) note('未提取到可用文本（可能是扫描版/图片型 PDF、字体编码缺失或内容为空）');
    return { ok, text: finalText, pages, notes };
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    note(`解析 PDF 时出错：${err && err.message ? err.message : String(err)}`);
    return { ok: false, text: '', pages: 0, notes };
  }
}

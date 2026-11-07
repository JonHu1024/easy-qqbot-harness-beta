// 从 SQLite 文件的空闲页里把被删掉的 messages 记录捞回来。
//
// 背景：删掉一条 conversations 记录时，messages 因为外键级联被一起删了，
// 但 SQLite 只是把页放回 freelist —— 内容还留在文件里。这里把那些页扫一遍，
// 认出符合 messages 表结构的行，再插回去。
//
// 用法：node scripts/recover-messages.mjs [--dry]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
// 只认命令行里给的路径；argv[0] 是 node 本体，别把 node 二进制当数据库扫了。
const dbPath = resolve(args.find((a) => !a.startsWith('-')) || 'data/qqbot.sqlite');
// WAL 里可能还有没并进主文件的内容，先 checkpoint，扫出来的主文件才是完整的。
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* 别的进程占着就算了 */ }
  db.close();
}
const buf = readFileSync(dbPath);
const PAGE = 4096;
const pageCount = Math.floor(buf.length / PAGE);

// SQLite 的 varint：大端 7 位一组，第一字节贡献的是**高位**那组。
// （第一字节若没有续位，就直接是整个值。）
function varint(buf, offset) {
  let i = offset;
  const first = buf[i++];
  if (first === undefined) return [0, i];
  if (!(first & 0x80)) return [Number(first), i];
  let value = BigInt(first & 0x7f);
  for (;;) {
    const byte = buf[i++];
    if (byte === undefined) break;
    value = (value << 7n) | BigInt(byte & 0x7f);
    if (!(byte & 0x80)) break;
  }
  return [Number(value), i];
}

function serialLen(type) {
  if (type > 1e6) return 0;
  if (type <= 4) return type;
  if (type === 5) return 6;
  if (type === 6 || type === 7) return 8;
  if (type === 8 || type === 9) return 0;
  if (type >= 12 && type % 2 === 0) return (type - 12) / 2;
  return (type - 13) / 2;
}

function decodeValue(buf, offset, type) {
  if (type === 0) return null;
  if (type >= 1 && type <= 6) {
    const size = serialLen(type);
    let value = 0n;
    for (let i = 0; i < size; i++) value = (value << 8n) | BigInt(buf[offset + i]);
    const signed = type === 1 ? BigInt.asIntN(8, value) : type === 2 ? BigInt.asIntN(16, value)
      : type === 3 ? BigInt.asIntN(24, value) : type === 4 ? BigInt.asIntN(32, value)
      : type === 5 ? BigInt.asIntN(48, value) : BigInt.asIntN(64, value);
    return Number(signed);
  }
  if (type === 7) {
    const value = buf.readDoubleBE(offset);
    return value;
  }
  if (type === 8) return 0;
  if (type === 9) return 1;
  if (type >= 12) return buf.subarray(offset, offset + serialLen(type)).toString('utf8');
  return null;
}

// 一条记录里所有列的 serial type
function parseRecord(payload) {
  const [rawHeader, pos] = varint(payload, 0);
  const headerSize = Number.isFinite(rawHeader) ? rawHeader : 0;
  // 垃圾数据给出的 headerSize 可能大得离谱，挡住，否则这里会死循环
  if (headerSize > payload.length || headerSize < 1) return { types: [], values: [] };
  const types = [];
  let p = pos;
  while (p < headerSize && p < payload.length) {
    const [type, next] = varint(payload, p);
    types.push(type);
    p = next;
  }
  const values = [];
  let d = headerSize;
  for (const type of types) {
    const len = serialLen(type);
    values.push(decodeValue(payload, d, type));
    d += len;
  }
  return { types, values };
}

function readOverflow(localPayload, overflowPage) {
  const parts = [localPayload];
  let page = overflowPage;
  const seen = new Set();
  while (page && !seen.has(page)) {
    seen.add(page);
    const base = (page - 1) * PAGE;
    if (base < 0 || base + PAGE > buf.length) break;
    const next = buf.readUInt32BE(base);
    const size = buf.readUInt32BE(base + 4);
    const take = Math.min(size, PAGE - 8);
    parts.push(buf.subarray(base + 8, base + 8 + take));
    page = next;
  }
  return Buffer.concat(parts);
}

const ROLES = new Set(['user', 'assistant', 'system', 'tool']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const HEXKEY = /^[0-9a-f]{64}$/;
const found = new Map();

for (let pageNo = 1; pageNo <= pageCount; pageNo++) {
  const base = (pageNo - 1) * PAGE;
  const type = buf[base];
  if (type !== 0x0d) continue; // 只看表 b-tree 的叶子页
  const cellCount = buf.readUInt16BE(base + 3);
  // 叶子页的页头固定 8 字节。之前用「cell 内容区起点的低字节是不是 0」来判断，
  // 很多页会把指针数组读错位置，就一条都找不到了。
  const pointerBase = base + 8;
  for (let c = 0; c < cellCount; c++) {
    const cellOffset = pointerBase + c * 2;
    if (cellOffset + 2 > base + PAGE) continue;
    const cell = base + buf.readUInt16BE(cellOffset);
    if (cell + 4 > buf.length) continue;
    try {
      const [payloadSize, afterSize] = varint(buf, cell);
      const [rowid, payloadStart] = varint(buf, afterSize);
      // 本地负载最多到本页末尾；超出的部分在溢出页里。
      const localSize = Math.min(payloadSize, PAGE - (payloadStart - base));
      let payload = buf.subarray(payloadStart, payloadStart + localSize);
      if (payloadSize > localSize) {
        const overflow = buf.readUInt32BE(payloadStart + localSize);
        payload = readOverflow(payload, overflow);
      }
      if (payload.length > 8 * 1024 * 1024) continue;
      const { types, values } = parseRecord(payload);
      // 垃圾数据会给出离谱的 serial type，先挡掉，别让它去分配巨大的 buffer
      if (types.some((t) => t > 1e6)) continue;
      // messages 表：id INTEGER PRIMARY KEY, key TEXT, role TEXT, content TEXT, createdAt TEXT, meta TEXT
      if (process.env.RECOVER_DEBUG && found.size < 3) {
        console.log('  调试 cell: rowid=', rowid, 'types=', types.join(','), 'values=', JSON.stringify(values).slice(0, 200));
      }
      if (types.length < 5) continue;
      const [idValue, key, role, content, createdAt, meta] = values;
      if (typeof key !== 'string' || !HEXKEY.test(key)) continue;
      if (typeof role !== 'string' || !ROLES.has(role)) continue;
      if (typeof createdAt !== 'string' || !ISO.test(createdAt)) continue;
      if (typeof content !== 'string') continue;
      const id = idValue === null ? rowid : idValue;
      if (!Number.isInteger(id) || id <= 0) continue;
      const record = { id, key, role, content, createdAt, meta: typeof meta === 'string' ? meta : '{}' };
      const previous = found.get(id);
      if (!previous || previous.content.length < record.content.length) found.set(id, record);
    } catch { /* 这页不是我们要的，跳过 */ }
  }
}

console.log(`扫了 ${pageCount} 页，捞到 ${found.size} 条像样的消息记录`);

// 和现存的表比一比：哪些 id 是表里没有的，就是要恢复的。
const { Store } = await import('../src/store.js');
const store = new Store(resolve('data'));
const liveKeys = new Set(store.db.prepare('SELECT key FROM conversations').all().map((r) => r.key));
const liveIds = new Set(store.db.prepare('SELECT id FROM messages').all().map((r) => Number(r.id)));
const missing = [...found.values()].filter((m) => !liveIds.has(m.id)).sort((a, b) => a.id - b.id);
const byKey = {};
for (const m of missing) (byKey[m.key] ||= []).push(m);
console.log(`其中 ${missing.length} 条在表里已经没了，可以恢复`);
for (const [key, list] of Object.entries(byKey)) {
  console.log(`  会话 ${key.slice(0, 12)}…：${list.length} 条（${list[0].createdAt.slice(0, 19)} → ${list[list.length - 1].createdAt.slice(0, 19)}）`
    + `${liveKeys.has(key) ? '（会话还在，只是消息没了）' : '（会话也没了）'}`);
}

if (dryRun || !missing.length) {
  console.log(dryRun ? '\n（--dry：只看不动）' : '\n没有需要恢复的东西');
  store.close();
  process.exit(0);
}

// 恢复：把会话行也补回来
const insertConv = store.db.prepare('INSERT OR IGNORE INTO conversations(key,scene,targetId,userId,lastAt,facts) VALUES(?,?,?,?,?,?)');
const insertMsg = store.db.prepare('INSERT OR IGNORE INTO messages(id,key,role,content,createdAt,meta) VALUES(?,?,?,?,?,?)');
let restored = 0;
for (const [key, list] of Object.entries(byKey)) {
  const sample = list.find((m) => m.role === 'user') || list[0];
  // 会话的 targetId 从 meta 里找
  let targetId = '', userId = '', scene = 'c2c', lastAt = list[list.length - 1].createdAt;
  for (const m of list) {
    try {
      const meta = JSON.parse(m.meta || '{}');
      if (meta.targetId) targetId = meta.targetId;
      if (meta.userId) userId = meta.userId;
      if (meta.scene) scene = meta.scene;
      if (m.createdAt > lastAt) lastAt = m.createdAt;
    } catch { /* meta 坏了就跳过 */ }
  }
  insertConv.run(key, scene, targetId || sample.key.slice(0, 8), userId || '', lastAt, '');
  for (const m of list) {
    const info = insertMsg.run(m.id, m.key, m.role, m.content, m.createdAt, m.meta);
    restored += info.changes;
  }
}
console.log(`\n✅ 恢复了 ${restored} 条消息，${Object.keys(byKey).length} 个会话`);
store.close();

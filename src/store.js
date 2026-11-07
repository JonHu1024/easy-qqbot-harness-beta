import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv, createHash, randomUUID } from 'node:crypto';
import { defaults, harnessDefaults, configSchema, mergeConfig } from './config.js';
import { conversationKey } from './keys.js';

// 已经从配置里去掉、但老库里可能还存着的键。
// 配置是严格 schema，多一个键就会拒绝启动 —— 所以读配置时先清掉。
const REMOVED_HARNESS_KEYS = ['imageSize'];

export class Store {
  constructor(dir) {
    mkdirSync(dir, {recursive:true,mode:0o700});
    chmodSync(dir,0o700);
    const keyPath = join(dir,'master.key');
    if (!existsSync(keyPath)) writeFileSync(keyPath,randomBytes(32),{mode:0o600,flag:'wx'});
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error('master.key 必须为32字节；不要删除它，否则无法解密已有凭据');
    chmodSync(keyPath,0o600);
    this.db = new DatabaseSync(join(dir,'qqbot.sqlite'));
    chmodSync(join(dir,'qqbot.sqlite'),0o600);
    // secure_delete：删掉的行会把内容**原地清零**，而不是只把页丢进空闲区。
    // 不开这个的话，删掉的消息在文件里还留着明文，能被 grep 出来 —— 那不叫删除。
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (key TEXT PRIMARY KEY, scene TEXT NOT NULL, targetId TEXT NOT NULL, userId TEXT NOT NULL, lastAt TEXT NOT NULL, facts TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL REFERENCES conversations(key) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, createdAt TEXT NOT NULL, meta TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_key ON messages(key,id);
      CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, message TEXT NOT NULL, detail TEXT, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, appId TEXT NOT NULL, ownerKey TEXT NOT NULL, nextAt INTEGER NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_due ON tasks(appId,status,nextAt);
      CREATE TABLE IF NOT EXISTS long_replies (key TEXT PRIMARY KEY, lastAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memes (id TEXT PRIMARY KEY, name TEXT NOT NULL, tags TEXT NOT NULL, enabled INTEGER NOT NULL, url TEXT NOT NULL, mime TEXT NOT NULL, data BLOB);
      CREATE TABLE IF NOT EXISTS resources (id TEXT PRIMARY KEY, name TEXT NOT NULL, tags TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, chars INTEGER NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      -- 资料库：新模型是「文件夹 + DOC.md」。每个文件夹说明何时该读它、里面大概有什么，
      -- 具体文件放在 resource_files 里，由模型按需读取。
      CREATE TABLE IF NOT EXISTS resource_folders (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, trigger TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS resource_files (
        id TEXT PRIMARY KEY, folderId TEXT NOT NULL REFERENCES resource_folders(id) ON DELETE CASCADE,
        name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text', content TEXT NOT NULL DEFAULT '',
        mime TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0, data BLOB,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS resource_files_folder ON resource_files(folderId);
      CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY AUTOINCREMENT, createdAt TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 1, promptTokens INTEGER NOT NULL DEFAULT 0, completionTokens INTEGER NOT NULL DEFAULT 0, counted INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS usage_day ON usage(day,kind);
      CREATE TABLE IF NOT EXISTS profiles (key TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', avatar TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', updatedAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS profiles_updated ON profiles(updatedAt);
    `);
    this._migrate();
    const row = this.db.prepare('SELECT json FROM settings WHERE id=1').get();
    this.current = row ? this.decodeConfig(JSON.parse(row.json)) : structuredClone(defaults);
  }
  _migrate() {
    // 老库升级：资源库新增图片/文件字段，profiles 表在上面的 CREATE IF NOT EXISTS 里建。
    const columns = new Set(this.db.prepare('PRAGMA table_info(resources)').all().map(row => row.name));
    const additions = [
      ['data', 'BLOB'],
      ['mime', "TEXT NOT NULL DEFAULT ''"],
      ['size', 'INTEGER NOT NULL DEFAULT 0'],
      ['note', "TEXT NOT NULL DEFAULT ''"],
    ];
    for (const [name, spec] of additions) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE resources ADD COLUMN ${name} ${spec}`);
    }
    // 文件说明：模型存文件时自己写的，用来告诉以后的自己「这是什么东西」。
    const files = new Set(this.db.prepare('PRAGMA table_info(resource_files)').all().map(row => row.name));
    if (!files.has('description')) this.db.exec("ALTER TABLE resource_files ADD COLUMN description TEXT NOT NULL DEFAULT ''");
    // 会话可以自定义显示名，方便把「一串 OpenID」变成人能认出来的 session。
    const convo = new Set(this.db.prepare('PRAGMA table_info(conversations)').all().map(row => row.name));
    if (!convo.has('label')) this.db.exec("ALTER TABLE conversations ADD COLUMN label TEXT NOT NULL DEFAULT ''");
    // 旧版平铺资源 → 迁移进一个默认文件夹，避免升级后资料丢失。
    const legacy = this.db.prepare('SELECT COUNT(*) AS n FROM resources').get()?.n || 0;
    const folders = this.db.prepare('SELECT COUNT(*) AS n FROM resource_folders').get()?.n || 0;
    if (legacy > 0 && folders === 0) {
      const now = new Date().toISOString();
      const folderId = randomUUID();
      this.db.prepare('INSERT INTO resource_folders(id,name,trigger,summary,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
        .run(folderId, '旧版资料', '用户提到旧版资源库里保存的内容时', '从旧版平铺资源库迁移而来，可在此文件夹内整理。', now, now);
      const rows = this.db.prepare('SELECT * FROM resources').all();
      for (const row of rows) {
        const hasImage = row.data && row.data.length;
        this.db.prepare('INSERT INTO resource_files(id,folderId,name,kind,content,mime,size,data,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(randomUUID(), folderId, row.name, hasImage ? 'image' : (row.kind === 'pdf' ? 'pdf' : 'text'),
            row.content || '', hasImage ? (row.mime || 'image/png') : '', hasImage ? row.data.length : 0,
            hasImage ? row.data : null, row.createdAt || now, row.updatedAt || now);
      }
    }
  }
  // ---- 用户 / 会话资料（昵称），用于把 OpenID 显示成人话 ----
  getProfile(key) {
    const row = this.db.prepare('SELECT * FROM profiles WHERE key=?').get(key);
    return row ? { ...row } : null;
  }
  saveProfile(key, profile) {
    const now = Date.now();
    const existing = this.getProfile(key) || {};
    const pick = (value, fallback) => value === undefined ? (fallback || '') : value;
    this.db.prepare(`INSERT INTO profiles(key,name,avatar,role,source,updatedAt) VALUES(?,?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET name=excluded.name,avatar=excluded.avatar,role=excluded.role,source=excluded.source,updatedAt=excluded.updatedAt`)
      .run(key, String(pick(profile?.name, existing.name) || '').slice(0, 128),
        String(pick(profile?.avatar, existing.avatar) || '').slice(0, 1024),
        String(pick(profile?.role, existing.role) || '').slice(0, 64),
        String(pick(profile?.source, existing.source) || '').slice(0, 40),
        Number.isFinite(profile?.updatedAt) ? profile.updatedAt : now);
    return this.getProfile(key);
  }
  listProfiles() { return this.db.prepare('SELECT * FROM profiles ORDER BY updatedAt DESC').all(); }
  clearProfile(key) { this.db.prepare('DELETE FROM profiles WHERE key=?').run(key); }
  encrypt(value) {
    if (!value) return '';
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm',this.key,iv);
    const body = Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
    return ['enc',iv.toString('base64'),cipher.getAuthTag().toString('base64'),body.toString('base64')].join(':');
  }
  decrypt(value) {
    if (!value) return '';
    const [prefix,iv,tag,body] = value.split(':');
    if (prefix !== 'enc') throw new Error('配置凭据格式不正确');
    const cipher = createDecipheriv('aes-256-gcm',this.key,Buffer.from(iv,'base64'));
    cipher.setAuthTag(Buffer.from(tag,'base64'));
    return Buffer.concat([cipher.update(Buffer.from(body,'base64')),cipher.final()]).toString('utf8');
  }
  decodeConfig(c) {
    // 老配置升级：先把默认值铺底，再覆盖已保存的值。
    // 这样新增字段（首次回复延迟、合并窗口、昵称缓存……）在旧数据库上也能正常启动。
    c.qq = { ...defaults.qq, ...(c.qq || {}) };
    c.bot = { ...defaults.bot, ...(c.bot || {}) };
    c.llm = { ...defaults.llm, ...(c.llm || {}) };
    c.harness = { ...harnessDefaults, ...(c.harness || {}) };
    c.commands = Array.isArray(c.commands) ? c.commands : [];
    c.rules = Array.isArray(c.rules) ? c.rules : [];
    c.qq.appSecret = this.decrypt(c.qq.appSecret);
    c.llm.apiKey = this.decrypt(c.llm.apiKey);
    c.harness = {...harnessDefaults,...c.harness};
    c.harness.genApiKey = this.decrypt(c.harness.genApiKey);
    c.harness.ttsApiKey = this.decrypt(c.harness.ttsApiKey);
    c.harness = {...harnessDefaults,...c.harness};
    // 已经移除的配置项（严格 schema 会因为多出来的键直接拒绝启动）。
    for (const key of REMOVED_HARNESS_KEYS) delete c.harness[key];
    return configSchema.parse(c);
  }
  config() { return structuredClone(this.current); }
  saveConfig(patch) {
    const c = mergeConfig(this.current,patch), encoded = structuredClone(c);
    encoded.qq.appSecret = this.encrypt(c.qq.appSecret);
    encoded.llm.apiKey = this.encrypt(c.llm.apiKey);
    encoded.harness.genApiKey = this.encrypt(c.harness.genApiKey);
    encoded.harness.ttsApiKey = this.encrypt(c.harness.ttsApiKey);
    this.db.prepare('INSERT INTO settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(JSON.stringify(encoded));
    this.current = c;
    return this.publicConfig();
  }
  publicConfig() {
    const c = this.config();
    c.qq.hasAppSecret = !!c.qq.appSecret; c.qq.appSecret = '';
    c.llm.hasApiKey = !!c.llm.apiKey; c.llm.apiKey = '';
    c.harness.hasGenApiKey = !!c.harness.genApiKey; c.harness.genApiKey = '';
    c.harness.hasTtsApiKey = !!c.harness.ttsApiKey; c.harness.ttsApiKey = '';
    return c;
  }
  redact(value) {
    let s = typeof value === 'string' ? value : JSON.stringify(value);
    for (const secret of [this.current.qq.appSecret,this.current.llm.apiKey]) if (secret) s = s.split(secret).join('[REDACTED]');
    return s.replace(/(QQBot|Bearer)\s+[^\s"',}]+/gi,'$1 [REDACTED]').slice(0,16000);
  }
  log(level,message,detail) {
    this.db.prepare('INSERT INTO logs(level,message,detail,createdAt) VALUES(?,?,?,?)').run(level,this.redact(message),detail === undefined ? null : this.redact(detail),new Date().toISOString());
    this.db.exec('DELETE FROM logs WHERE id < (SELECT COALESCE(MAX(id),0)-2000 FROM logs)');
  }
  logs(after=0) { return this.db.prepare('SELECT * FROM (SELECT * FROM logs WHERE id>? ORDER BY id DESC LIMIT 200) ORDER BY id').all(after); }
  clearLogs() { this.db.exec('DELETE FROM logs'); }
  ensureConversation(key,meta={}) {
    this.db.prepare('INSERT INTO conversations(key,scene,targetId,userId,lastAt) VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET lastAt=excluded.lastAt').run(key,meta.scene || 'preview',meta.targetId || '',meta.userId || '',new Date().toISOString());
  }
  listConversations() { return this.db.prepare('SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.key=c.key) AS count FROM conversations c ORDER BY lastAt DESC LIMIT 500').all(); }
  history(key,limit=200) { return this.db.prepare('SELECT * FROM (SELECT * FROM messages WHERE key=? ORDER BY id DESC LIMIT ?) ORDER BY id').all(key,limit).map(m => ({...m,meta:JSON.parse(m.meta)})); }
  addMessage(key,role,content,meta={}) {
    this.ensureConversation(key,meta);
    this.db.prepare('INSERT INTO messages(key,role,content,createdAt,meta) VALUES(?,?,?,?,?)').run(key,role,content,new Date().toISOString(),JSON.stringify(meta));
    this.db.prepare('DELETE FROM messages WHERE key=? AND id NOT IN (SELECT id FROM messages WHERE key=? ORDER BY id DESC LIMIT 500)').run(key,key);
  }
  facts(key) { return this.db.prepare('SELECT facts FROM conversations WHERE key=?').get(key)?.facts || ''; }
  // 长期记忆按“整体重写”维护：写入前统一清洗，避免逐条追加造成重复堆积。
  static normalizeFacts(text,max=8000) {
    const lines=[];
    const seen=new Set();
    for (const raw of String(text ?? '').split(/\r?\n/)) {
      const line=raw.replace(/\s+/g,' ').replace(/^[-*·]\s*/,'').trim();
      if (!line) continue;
      const key=line.replace(/[。．.,，;；:：!！?？"'“”‘’()（）\[\]【】]/g,'').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      lines.push(line);
    }
    let joined=lines.join('\n');
    if (Array.from(joined).length>max) joined=Array.from(joined).slice(0,max).join('');
    return joined;
  }
  saveFacts(key,text,meta={}) {
    this.ensureConversation(key,meta);
    const value=Store.normalizeFacts(text);
    this.db.prepare('UPDATE conversations SET facts=? WHERE key=?').run(value,key);
    return value;
  }
  // 会话显示名：让用户能把「3FDDA2…759D」改成自己认得的名字。
  setConversationLabel(key,label) {
    const value=String(label??'').trim().slice(0,60);
    return this.db.prepare('UPDATE conversations SET label=? WHERE key=?').run(value,key).changes>0;
  }
  // ---- 资料库：文件夹 + DOC.md ----
  // 每个文件夹有「触发内容」（什么时候该读它）和「内容概述」（里面大概有什么），
  // Harness 只负责在命中触发条件时提示模型，由模型自己决定要不要读、读哪几个文件。
  listResourceFolders() {
    const folders = this.db.prepare('SELECT * FROM resource_folders ORDER BY updatedAt DESC').all();
    const counts = this.db.prepare('SELECT folderId, COUNT(*) AS n FROM resource_files GROUP BY folderId').all();
    const map = new Map(counts.map(row => [row.folderId, row.n]));
    return folders.map(folder => ({ ...folder, fileCount: map.get(folder.id) || 0 }));
  }
  getResourceFolder(id) {
    const row = this.db.prepare('SELECT * FROM resource_folders WHERE id=?').get(id);
    return row ? { ...row } : null;
  }
  // 模型看到的是资料夹名称，按名称查更符合直觉。
  getResourceFolderByName(name) {
    const value = String(name || '').trim();
    if (!value) return null;
    const row = this.db.prepare('SELECT * FROM resource_folders WHERE name=? OR id=?').get(value, value);
    return row ? { ...row } : null;
  }
  saveResourceFolder({ id, name, trigger = '', summary = '' }) {
    if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('资料夹名称必须是 1～80 字符');
    const now = new Date().toISOString();
    const existing = id ? this.getResourceFolder(id) : null;
    if (id && !existing) throw new Error('资料夹不存在');
    const fid = existing?.id || randomUUID();
    this.db.prepare(`INSERT INTO resource_folders(id,name,trigger,summary,createdAt,updatedAt) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,trigger=excluded.trigger,summary=excluded.summary,updatedAt=excluded.updatedAt`)
      .run(fid, name.trim(), String(trigger || '').slice(0, 4000), String(summary || '').slice(0, 4000), existing?.createdAt || now, now);
    return this.getResourceFolder(fid);
  }
  deleteResourceFolder(id) {
    const changed=this.db.prepare('DELETE FROM resource_folders WHERE id=?').run(id).changes > 0;
    // 外键级联把里面的文件也删了，一并 checkpoint。
    if (changed) this.checkpoint();
    return changed;
  }

  listResourceFiles(folderId) {
    // 不取 content 正文：目录只需要知道「有哪些文件、多长」。
    return this.db.prepare('SELECT id,folderId,name,kind,LENGTH(content) AS chars,mime,size,description,createdAt,updatedAt,(data IS NOT NULL) AS hasImage FROM resource_files WHERE folderId=? ORDER BY name').all(folderId)
      .map(row => ({ ...row, hasImage: !!row.hasImage }));
  }
  getResourceFile(id) {
    const row = this.db.prepare('SELECT * FROM resource_files WHERE id=?').get(id);
    return row ? { ...row } : null;
  }
  // 取任意二进制附件（PDF 等）。
  getResourceFileData(id) {
    const row = this.db.prepare('SELECT data,mime FROM resource_files WHERE id=? AND data IS NOT NULL').get(id);
    return row ? { bytes: Buffer.from(row.data), mime: row.mime || '' } : null;
  }
  getResourceFileImage(id) {
    const row = this.db.prepare("SELECT data,mime FROM resource_files WHERE id=? AND data IS NOT NULL AND mime LIKE 'image/%'").get(id);
    if (!row) return null;
    return { bytes: Buffer.from(row.data), mime: row.mime || 'application/octet-stream' };
  }
  saveResourceFile({ id, folderId, name, kind = 'text', content = '', data = null, mime = '', size = 0, description = '' }) {
    if (!this.getResourceFolder(folderId)) throw new Error('资料夹不存在');
    if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new Error('文件名称必须是 1～200 字符');
    const text = String(content ?? '').replace(/\r\n/g, '\n').slice(0, 400000);
    // 二进制（图片、PDF、任何文件）都原样存着，不只存图片。
    const hasBinary = Buffer.isBuffer(data) && data.length > 0;
    if (!text.trim() && !hasBinary) throw new Error('文件内容不能为空');
    const now = new Date().toISOString(), existing = id ? this.getResourceFile(id) : null;
    if (id && !existing) throw new Error('文件不存在');
    const fid = existing?.id || randomUUID();
    const desc = String(description ?? existing?.description ?? '').slice(0, 2000);
    this.db.prepare(`INSERT INTO resource_files(id,folderId,name,kind,content,mime,size,data,description,createdAt,updatedAt)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,content=excluded.content,
        mime=excluded.mime,size=excluded.size,data=excluded.data,description=excluded.description,updatedAt=excluded.updatedAt`)
      .run(fid, folderId, name.trim(), String(kind).slice(0, 20), text, String(mime || '').slice(0, 120),
        hasBinary ? data.length : Number(size) || 0, hasBinary ? data : null, desc, existing?.createdAt || now, now);
    return this.getResourceFile(fid);
  }
  // 只更新说明，不碰正文和原件。
  setResourceFileDescription(id, description) {
    const text=String(description ?? '').slice(0, 2000);
    const changed=this.db.prepare('UPDATE resource_files SET description=?, updatedAt=? WHERE id=?').run(text, new Date().toISOString(), id).changes > 0;
    if (!changed) throw new Error('文件不存在');
    // 图片的替代文字就存在 content 里，一并更新（不动 data）。
    const file=this.getResourceFile(id);
    if (file && file.kind==='image' && !String(file.content||'').trim()) {
      this.db.prepare('UPDATE resource_files SET content=? WHERE id=?').run(text, id);
    }
    return this.getResourceFile(id);
  }
  deleteResourceFile(id) {
    const changed=this.db.prepare('DELETE FROM resource_files WHERE id=?').run(id).changes > 0;
    // secure_delete 会在 WAL 里把内容清零，但不 checkpoint 的话主文件里旧内容还在，
    // grep 还能搜到。立刻 checkpoint 才算真删掉。
    if (changed) { try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ } }
    return changed;
  }
  // 删干净：secure_delete 负责把内容清零，VACUUM 负责把空间还给文件。
  vacuum() { try { this.db.exec('VACUUM'); return true; } catch { return false; } }
  // 把 WAL 里的内容落到主文件：不然删掉的东西在主文件里还能被 grep 到。
  checkpoint() { try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); return true; } catch { return false; } }

  // 资料目录：给模型看的「有什么、在什么情况下值得读」。
  resourceCatalog() {
    const folders = this.listResourceFolders();
    return folders.map(folder => ({
      id: folder.id,
      name: folder.name,
      trigger: folder.trigger || '',
      summary: folder.summary || '',
      fileCount: folder.fileCount,
      files: this.listResourceFiles(folder.id).map(file => ({ id: file.id, name: file.name, kind: file.kind, chars: file.chars, description: file.description, updatedAt: file.updatedAt })),
    }));
  }
  // 命中触发条件的资料夹：Harness 只给提示，是否真的读由模型判断。
  matchResourceFolders(query, limit = 3) {
    const needle = String(query || '').trim().toLowerCase();
    const catalog = this.resourceCatalog();
    if (!needle) return catalog.slice(0, limit);
    // 中文没有空格，用「二元字组」做相似度（与 Lucene 的 CJK 分析思路一致）：
    // 把查询切成相邻两字的组合，看有多少个出现在资料夹的名称 / 触发条件 / 概述里。
    const grams = [];
    const clean = needle.replace(/[\s,，、。;；:：!！?？的了呢吗啊]/g, '');
    for (let index = 0; index < clean.length - 1; index++) grams.push(clean.slice(index, index + 2));
    const scored = [];
    for (const folder of catalog) {
      let hits = 0;
      for (const text of [folder.name, folder.trigger, folder.summary]) {
        const value = String(text || '').toLowerCase();
        if (!value) continue;
        if (value.includes(clean)) { hits += grams.length; continue; }
        for (const gram of grams) if (value.includes(gram)) hits++;
      }
      for (const file of folder.files) {
        const value = String(file.name || '').toLowerCase();
        if (value && value.includes(clean)) hits += 2;
      }
      if (hits >= 2) scored.push({ ...folder, score: hits });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, Math.min(10, limit))).map(({ score, ...folder }) => folder);
  }

  recordUsage({kind,name,promptTokens=0,completionTokens=0,counted=1,at=new Date()}) {
    const iso=at.toISOString(), day=iso.slice(0,10);
    this.db.prepare('INSERT INTO usage(createdAt,day,kind,name,requests,promptTokens,completionTokens,counted) VALUES(?,?,?,?,1,?,?,?)')
      .run(iso,day,kind,String(name||'').slice(0,120),Math.max(0,Math.floor(promptTokens)||0),Math.max(0,Math.floor(completionTokens)||0),counted?1:0);
    this.db.exec('DELETE FROM usage WHERE id < (SELECT COALESCE(MAX(id),0)-50000 FROM usage)');
  }
  usageSummary() {
    const rows=this.db.prepare('SELECT day,kind,name,SUM(requests) AS requests,SUM(promptTokens) AS promptTokens,SUM(completionTokens) AS completionTokens,SUM(counted) AS counted FROM usage GROUP BY day,kind,name').all();
    const buckets={today:{},month:{},all:{}};
    const byModel=new Map(), daily=new Map();
    const dayOf=iso=>new Date(iso).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});
    const today=dayOf(new Date().toISOString()), month=today.slice(0,7);
    const blank=()=>({requests:0,promptTokens:0,completionTokens:0,totalTokens:0,toolCalls:0,images:0,videos:0,searches:0,readUrls:0});
    let unknownUsage=0;
    const add=(target,row)=>{
      const tokens=row.promptTokens+row.completionTokens;
      target.requests+=row.requests;target.promptTokens+=row.promptTokens;target.completionTokens+=row.completionTokens;target.totalTokens+=tokens;
      if (row.kind!=='model') target.toolCalls+=row.requests;
      if (row.kind==='image') target.images+=row.requests;
      if (row.kind==='video') target.videos+=row.requests;
      if (row.kind==='search') target.searches+=row.requests;
      if (row.kind==='read_url') target.readUrls+=row.requests;
    };
    for (const bucket of Object.values(buckets)) for (const key of ['requests','promptTokens','completionTokens','totalTokens','toolCalls','images','videos','searches','readUrls']) bucket[key]=undefined;
    for (const key of Object.keys(buckets)) buckets[key]=blank();
    for (const row of rows) {
      add(buckets.all,row);
      if (row.day.startsWith(month)) add(buckets.month,row);
      if (row.day===today) add(buckets.today,row);
      if (row.kind==='model') {
        const entry=byModel.get(row.name) || {model:row.name,requests:0,totalTokens:0};
        entry.requests+=row.requests;entry.totalTokens+=row.promptTokens+row.completionTokens;
        byModel.set(row.name,entry);
        unknownUsage+=row.requests-row.counted;
      }
    }
    const dailyRows=this.db.prepare("SELECT day,SUM(requests) AS requests,SUM(promptTokens+completionTokens) AS totalTokens FROM usage WHERE day>=? GROUP BY day ORDER BY day").all(new Date(Date.now()-13*86400000).toISOString().slice(0,10));
    return {
      today:buckets.today, month:buckets.month, all:buckets.all,
      byModel:[...byModel.values()].sort((a,b)=>b.totalTokens-a.totalTokens).slice(0,20),
      daily:dailyRows.map(row=>({day:row.day,requests:row.requests,totalTokens:row.totalTokens})),
      unknownUsage:Math.max(0,unknownUsage), timezone:'Asia/Shanghai',
    };
  }
  clearUsage() { this.db.exec('DELETE FROM usage'); }
  clearMemory(key) { this.db.prepare('DELETE FROM messages WHERE key=?').run(key); this.db.prepare("UPDATE conversations SET facts='' WHERE key=?").run(key); }
  deleteConversation(key) {
    this.db.prepare('DELETE FROM conversations WHERE key=?').run(key);
    // 日志里存着消息预览和会话 key —— 会话删了，这些也跟着删，
    // 否则「删掉的内容」还能在数据库里被搜到，那就不是删除。
    try {
      const rows=this.db.prepare('SELECT id,detail FROM logs').all();
      const doomed=rows.filter(row=>String(row.detail||'').includes(key)).map(row=>row.id);
      if (doomed.length) {
        const remove=this.db.prepare('DELETE FROM logs WHERE id=?');
        for (const id of doomed) remove.run(id);
      }
    } catch { /* 日志表读不到就算了，不影响删除本身 */ }
    // secure_delete 负责把内容清零，但清零后的页还在 WAL 里，
    // 不 checkpoint 的话主文件里旧内容还在 —— 立刻 checkpoint，才算真删干净。
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* 别的进程占着就算了 */ }
  }
  prune(days) {
    const cutoff = new Date(Date.now()-days*86400000).toISOString();
    this.db.prepare('DELETE FROM conversations WHERE lastAt<?').run(cutoff);
    this.db.prepare('DELETE FROM messages WHERE createdAt<?').run(cutoff);
    this.db.prepare('DELETE FROM events WHERE createdAt<?').run(Date.now()-86400000);
  }
  claimEvent(id) { return this.db.prepare('INSERT OR IGNORE INTO events(id,createdAt) VALUES(?,?)').run(id,Date.now()).changes > 0; }
  appendFact(key,fact,meta={}) {
    if (typeof fact!=='string' || !fact.trim() || Array.from(fact).length>8000) throw new Error('事实必须为1～8000字符');
    const clean=fact.trim(), current=this.facts(key);
    if (('\n'+current+'\n').includes('\n'+clean+'\n')) return {saved:false,facts:current};
    const next=[current,clean].filter(Boolean).join('\n');
    if (Array.from(next).length>8000) throw new Error('长期事实已超过8000字符，请先整理记忆');
    this.saveFacts(key,next,meta);
    return {saved:true,facts:next};
  }
  canLongReply(key,minutes,now=Date.now()) {
    const row=this.db.prepare('SELECT lastAt FROM long_replies WHERE key=?').get(key);
    const nextAt=row ? row.lastAt+minutes*60000 : 0;
    return {allowed:now>=nextAt,...(nextAt ? {nextAt:new Date(nextAt).toISOString()} : {})};
  }
  claimLongReply(key,minutes,now=Date.now()) {
    return this.db.prepare('INSERT INTO long_replies VALUES(?,?) ON CONFLICT(key) DO UPDATE SET lastAt=excluded.lastAt WHERE long_replies.lastAt<=?').run(key,now,now-minutes*60000).changes>0;
  }
  findReferencedMessage({appId,scene,targetId,userId,messageId,refIndex}) {
    if (!appId && appId!=='') return null;
    const key=conversationKey(appId,{scene,targetId,userId});
    const row=this.db.prepare(`SELECT * FROM messages WHERE key=? AND
      ((?<>'' AND (json_extract(meta,'$.msgId')=? OR json_extract(meta,'$.sentMessageId')=?)) OR
       (?<>'' AND (json_extract(meta,'$.messageIndex')=? OR json_extract(meta,'$.sentRefIndex')=?)))
      ORDER BY id DESC LIMIT 1`).get(key,messageId || '',messageId || '',messageId || '',refIndex || '',refIndex || '',refIndex || '');
    if (!row) return null;
    const meta=JSON.parse(row.meta);
    return {content:row.content,attachments:meta.attachments || [],authorId:row.role==='assistant'?'bot':userId,messageId:meta.sentMessageId || meta.msgId,refIndex:meta.sentRefIndex || meta.messageIndex};
  }
  listTasks(appId) {
    const rows=appId===undefined ? this.db.prepare('SELECT json FROM tasks ORDER BY nextAt,id').all() : this.db.prepare('SELECT json FROM tasks WHERE appId=? ORDER BY nextAt,id').all(appId);
    return rows.map(row=>JSON.parse(row.json));
  }
  getTask(id) { const row=this.db.prepare('SELECT json FROM tasks WHERE id=?').get(id); return row ? JSON.parse(row.json) : null; }
  saveTask(task) {
    this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET nextAt=excluded.nextAt,status=excluded.status,json=excluded.json').run(task.id,task.appId,task.key,task.nextAt,task.status,JSON.stringify(task));
    return task;
  }
  claimTask(id,now) {
    return this.db.prepare("UPDATE tasks SET status='running',json=json_set(json,'$.status','running') WHERE id=? AND status='pending' AND nextAt<=?").run(id,now).changes>0;
  }
  deleteTask(id) { return this.db.prepare('DELETE FROM tasks WHERE id=?').run(id).changes>0; }
  pruneFinishedTasks(cutoffIso) {
    return this.db.prepare(`DELETE FROM tasks WHERE status IN ('done','failed','cancelled')
      AND COALESCE(json_extract(json,'$.lastRunAt'), json_extract(json,'$.createdAt')) < ?`).run(cutoffIso).changes;
  }
  listMemes() {
    return this.db.prepare('SELECT id,name,tags,enabled,url,mime FROM memes ORDER BY rowid').all().map(m=>({...m,tags:JSON.parse(m.tags),enabled:!!m.enabled}));
  }
  getMeme(id) {
    const m=this.db.prepare('SELECT * FROM memes WHERE id=?').get(id);
    return m ? {...m,tags:JSON.parse(m.tags),enabled:!!m.enabled,fileData:m.data ? Buffer.from(m.data).toString('base64') : undefined,data:undefined} : null;
  }
  saveMeme(input) {
    if (input.url && input.fileData) throw new Error('表情包URL与图片数据不能同时填写');
    const existing=input.id ? this.getMeme(input.id) : null;
    if (input.id && !existing) throw new Error('表情包不存在');
    const replacement=!!input.url || !!input.fileData;
    const {name,tags=[],enabled=true,url='',mime='',fileData} = {...existing,...input,...(!replacement && existing ? {url:existing.url,fileData:existing.fileData,mime:existing.mime} : replacement && input.url ? {fileData:undefined} : replacement ? {url:''} : {})};
    if (typeof name!=='string' || !name.trim() || name.length>80 || !Array.isArray(tags) || tags.length>20 || tags.some(t=>typeof t!=='string' || t.length>40) || typeof enabled!=='boolean') throw new Error('表情名称、标签或开关无效');
    if (!existing && this.listMemes().length>=50) throw new Error('最多保存50个表情包，请先删除不需要的条目');
    if (!!url===!!fileData) throw new Error('表情包URL与图片数据必须且只能填写一种');
    let data=null;
    if (url) {
      const u=new URL(url);
      if (u.protocol!=='https:' || u.username || u.password || url.length>4000) throw new Error('表情包地址必须为不含凭据的HTTPS URL');
    } else {
      if (!['image/png','image/jpeg','image/gif','image/webp'].includes(mime) || typeof fileData!=='string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(fileData)) throw new Error('图片类型或Base64数据无效');
      data=Buffer.from(fileData,'base64');
      if (!data.length || data.length>2*1024*1024) throw new Error('表情图片必须为1字节～2MB');
      const valid=mime==='image/png' ? data.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) :
        mime==='image/jpeg' ? data[0]===255 && data[1]===216 && data[2]===255 :
        mime==='image/gif' ? /^GIF8[79]a$/.test(data.subarray(0,6).toString()) :
        data.subarray(0,4).toString()==='RIFF' && data.subarray(8,12).toString()==='WEBP';
      if (!valid) throw new Error('图片内容与声明的格式不一致');
    }
    const id=existing?.id || randomUUID();
    this.db.prepare('INSERT INTO memes VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,tags=excluded.tags,enabled=excluded.enabled,url=excluded.url,mime=excluded.mime,data=excluded.data').run(id,name.trim(),JSON.stringify(tags),enabled?1:0,url,mime,data);
    return this.listMemes().find(m=>m.id===id);
  }
  deleteMeme(id) { return this.db.prepare('DELETE FROM memes WHERE id=?').run(id).changes>0; }
  close() { this.db.close(); }
}

import express from 'express';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import fs from 'node:fs';
import { Store } from './store.js';
import { Engine, conversationKey } from './engine.js';
import { mergeConfig } from './config.js';
import { QQClient, normalizeEvent, apiCatalog } from './qq.js';
import { Scheduler } from './scheduler.js';
import { MessageBatcher, mergeEvents } from './batcher.js';
import { ProfileService, shortId, SCENE_LABEL } from './profiles.js';
import { testGeneration } from './generate.js';
import { synthesize, listWindowsVoices, listServiceVoices } from './tts.js';
import { tuneNetwork } from './net.js';
import { requestModel } from './model.js';
import { prepareInput, validateAttachments, downloadMedia } from './media.js';
import { stripStrayTimestamps } from './text.js';
import { extractPdfText } from './pdf.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)),'..');
function requiredString(v,label,max=200) {
  if (typeof v!=='string' || !v.trim() || v.length>max) throw Object.assign(new Error(`${label} 必须是1～${max}字符`),{status:400});
  return v.trim();
}
export function createApp({dataDir=process.env.QQBOT_DATA_DIR || join(root,'data'),host=process.env.HOST || '127.0.0.1',password=process.env.QQBOT_ADMIN_PASSWORD || '',publicOrigin=process.env.QQBOT_PUBLIC_ORIGIN || '',clientFactory}={}) {
  tuneNetwork();
  const local = ['127.0.0.1','localhost','::1'].includes(host);
  const remoteOrigin = publicOrigin && !['localhost','127.0.0.1','[::1]'].includes(new URL(publicOrigin).hostname);
  if ((!local || remoteOrigin) && password.length<12) throw new Error('非本地访问必须设置至少12字符 QQBOT_ADMIN_PASSWORD；建议通过 HTTPS 反向代理访问');
  if (publicOrigin && !['http:','https:'].includes(new URL(publicOrigin).protocol)) throw new Error('QQBOT_PUBLIC_ORIGIN 必须为 HTTP/HTTPS 源地址');
  const store = new Store(dataDir), app = express();
  const stats = {received:0,sent:0,errors:0}, startedAt = Date.now();
  const log = (level,message,detail) => store.log(level,message,detail);
  let pending = 0, closed = false, botController = new AbortController();
  const previewController = new AbortController(), jobs = new Set();
  const client = clientFactory ? clientFactory({getConfig:()=>store.config(),log,onEvent:acceptEvent}) : new QQClient({getConfig:()=>store.config(),log,onEvent:acceptEvent});
  const scheduler = new Scheduler(store,{
    getConfig:()=>store.config(), log,
    canRun:task=>task.scene==='preview' || client.status().running && ['connected','listening'].includes(client.status().state),
    send:async task=>{
      if (task.scene==='preview') {
        store.addMessage(task.key,'assistant',task.content,{appId:task.appId,scene:task.scene,targetId:task.targetId,userId:task.userId,taskId:task.id});
        return;
      }
      if (!engine.permitted(task)) throw Object.assign(new Error('任务目标或用户被当前访问控制限制'),{status:403});
      if (!client.status().running || store.config().qq.appId!==task.appId) throw new Error('机器人未运行或身份已变化');
      const sent=await client.send({scene:task.scene,targetId:task.targetId,content:task.content});
      stats.sent++;
      if (store.config().bot.memoryEnabled) store.addMessage(task.key,'assistant',task.content,{...task,sentMessageId:sent.id,sentRefIndex:sent.ext_info?.ref_idx});
    },
  });
  const engine = new Engine(store,{scheduler,prepareInput:(event,{signal}={})=>prepareInput(event,store.config(),{signal}),listMemes:()=>store.listMemes()});
  const profiles = new ProfileService(store,{client,log});
  // 合并器：收到消息先等一会儿，把连续多条消息合成一次回答。
  const batcher = new MessageBatcher({
    // 每次排程都读最新配置：改了「首次回复延迟 / 合并窗口」立刻生效，无需重启。
    resolveTiming: () => { const b = store.config().bot; return { delayMs: b.firstReplyDelayMs, windowMs: b.mergeWindowMs }; },
    onFlush:(events,meta)=>{ handleBatch(events,meta); },
  });
  // 合并键：同一会话 + 同一发送者。群里不同的人各答各的，避免张冠李戴。
  const batchKey = event => `${event.scene}|${event.targetId}|${event.userId}`;
  const isCommand = content => /^\/[^\s]+/.test(String(content||'').trim());
  function status() { return {...client.status(),stats:{...stats},uptime:Math.floor((Date.now()-startedAt)/1000),
    pendingBatches: batcher.size, pendingMessages: batcher.pending}; }
  const IMAGE_EXT={'image/jpeg':'jpg','image/gif':'gif','image/webp':'webp','image/png':'png','video/mp4':'mp4'};
  const RESOURCE_IMAGE_TYPES=['image/png','image/jpeg','image/gif','image/webp'];
  // 存文件的上限：和「附件存进文件夹」的上限一致（20MB）。
  const RESOURCE_MAX_BYTES=20*1024*1024;
  // 资料夹里的文件：文本直接存文本，PDF 提取文字层，图片存本体并保留一段说明。
  async function buildResourceFile(folderId,file,{note=''}={}) {
    const name=String(file?.name||'').trim().slice(0,200) || '未命名';
    const declared=String(file?.contentType||'').split(';')[0].trim().toLowerCase();
    if (typeof file?.data!=='string' || !file.data.trim()) throw new Error('文件内容为空');
    const bytes=Buffer.from(String(file.data).replace(/^data:[^;,]+;base64,/,''),'base64');
    if (!bytes.length) throw new Error('文件内容为空');
    if (bytes.length>RESOURCE_MAX_BYTES) throw new Error(`文件超过 ${Math.round(RESOURCE_MAX_BYTES/1024/1024)}MB 限制`);
    const looksImage=declared.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(name);
    if (looksImage) {
      const mime=RESOURCE_IMAGE_TYPES.includes(declared) ? declared : guessImageMime(bytes,name);
      if (!mime) throw new Error('只支持 PNG / JPEG / GIF / WebP 图片');
      const alt=String(note||'').trim() || `图片：${name.replace(/\.[^.]+$/,'')}`;
      return store.saveResourceFile({folderId,name,kind:'image',content:alt,data:bytes,mime,size:bytes.length});
    }
    if (/\.pdf$/i.test(name) || declared==='application/pdf') {
      // 原件照存（以后还能提取/下载），正文顺手提取一份，提取不出来也照样收下。
      const extracted=await extractPdfText(bytes,{maxChars:200000});
      const note=extracted.ok ? '' : `（正文没能提取出来：${extracted.notes.slice(0,2).join('；')||'可能是扫描件或加密文件'}）`;
      return store.saveResourceFile({
        folderId,name,kind:'pdf',
        content:extracted.ok ? extracted.text : note,
        data:bytes,mime:'application/pdf',size:bytes.length,
      });
    }
    if (/\.(txt|md|markdown|csv|json|log|tsv|yaml|yml|ini|conf)$/i.test(name) || /^text\//.test(declared) || declared==='application/json') {
      let text;
      try { text=new TextDecoder('utf-8',{fatal:true}).decode(bytes); }
      catch { throw new Error('文件不是 UTF-8 文本，请另存为 UTF-8 后再上传'); }
      return store.saveResourceFile({folderId,name,kind:'text',content:text});
    }
    throw new Error('只支持文本 / Markdown / CSV / JSON / PDF / 图片作为资料');
  }
  function guessImageMime(bytes,name) {
    if (bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) return 'image/png';
    if (bytes[0]===255&&bytes[1]===216&&bytes[2]===255) return 'image/jpeg';
    if (/^GIF8[79]a$/.test(bytes.subarray(0,6).toString())) return 'image/gif';
    if (bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP') return 'image/webp';
    if (/\.png$/i.test(name)) return 'image/png';
    if (/\.jpe?g$/i.test(name)) return 'image/jpeg';
    if (/\.gif$/i.test(name)) return 'image/gif';
    if (/\.webp$/i.test(name)) return 'image/webp';
    return '';
  }
  // 生成结果与表情包都优先由我们自己下载后按分片上传：
  // 让 QQ 去抓第三方链接容易出现 “富媒体文件上传超时”(850027)，实测本机下载 0.7 秒即可完成。
  const MEDIA_MAX_BYTES=48*1024*1024;
  const AUDIO_EXT={'audio/mpeg':'mp3','audio/mp3':'mp3','audio/wav':'wav','audio/x-wav':'wav','audio/wave':'wav','audio/ogg':'ogg','audio/silk':'silk','audio/l16':'pcm','audio/x-pcm':'pcm'};
  // 普通文件按扩展名给个像样的类型，QQ 那边会按这个决定怎么展示。
  const FILE_EXT={'text/plain':'txt','text/markdown':'md','text/csv':'csv','application/json':'json','application/pdf':'pdf','application/zip':'zip'};
  const sanitizeFileName=(name,fallback)=>{
    const clean=String(name||'').replace(/[\\/\u0000-\u001f]/g,'_').replace(/^\.+/,'_').slice(0,120);
    return clean||fallback;
  };
  async function attachmentPayload(event,seq,message,signal) {
    const v2=['c2c','group'].includes(event.scene);
    const isVideo=message.type==='media' && message.mediaKind==='video';
    const isVoice=message.type==='voice';
    const isFile=message.type==='file';
    let fileData, url, mime, name;
    if (message.type==='meme') {
      const meme=store.getMeme(message.memeId);
      if (!meme?.enabled) throw new Error('选中的表情包不存在或已停用');
      ({fileData,url,mime}=meme);name=meme.id;
    } else if (isFile) {
      // 文件保留自己的名字与后缀，用户下载下来才认得出是什么。
      ({fileData,url,mime}=message);
      name=sanitizeFileName(message.name,'file.txt');
      if (!/\.[A-Za-z0-9]{1,8}$/.test(name)) name=`${name}.${FILE_EXT[mime]||'txt'}`;
    } else {
      // 上传文件名用 ASCII，避免各家网关对非 ASCII 文件名的处理差异。
      ({fileData,url,mime}=message);name=isVoice?'voice':isVideo?'video':'image';
    }
    const cap=isVideo ? MEDIA_MAX_BYTES : isFile ? 8*1024*1024 : 20*1024*1024;
    if (!fileData && url) {
      try {
        const result=await downloadMedia(url,{maxBytes:cap,signal});
        const ok=isVideo ? result.contentType.startsWith('video/')
          : isVoice ? result.contentType.startsWith('audio/')
          : ['image/png','image/jpeg','image/gif','image/webp'].includes(result.contentType);
        if (!ok) throw new Error(`下载到的内容类型不受支持：${result.contentType || '未知'}`);
        fileData=result.bytes.toString('base64');mime=result.contentType;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        log('warn','自行下载媒体失败，改为让 QQ 抓取原链接',{url,error:error.message});
      }
    }
    if (signal.aborted) throw new Error('机器人已停止，取消发送');
    if (v2) {
      // QQ 富媒体类型：1 图片、2 视频、3 语音、4 文件。
      const fileType=isFile?4:isVoice?3:isVideo?2:1;
      const ext=isFile ? '' : isVoice ? (AUDIO_EXT[mime] || 'wav') : (IMAGE_EXT[mime] || (isVideo?'mp4':'png'));
      const fileName=isFile ? name : `${name}.${ext}`;
      const uploaded=fileData
        ? await client.upload({scene:event.scene,targetId:event.targetId,fileType,fileData,fileName,maxBytes:cap})
        : await client.upload({scene:event.scene,targetId:event.targetId,fileType,url});
      return {scene:event.scene,targetId:event.targetId,msgId:event.msgId,seq,type:'media',media:{file_info:uploaded.file_info}};
    }
    if (!url) throw new Error('QQ 频道/私信只能发送公网图片 URL，本地或 Base64 图片无法直接发送');
    return {scene:event.scene,targetId:event.targetId,msgId:event.msgId,seq,type:'text',extra:{image:url}};
  }
  async function sendReply(event,content,seq,message,signal) {
    if (signal.aborted || !client.status().running) throw new Error('机器人已停止，取消发送');
    let payload={scene:event.scene,targetId:event.targetId,msgId:event.msgId,seq,content};
    if (message && message.type!=='text') payload=await attachmentPayload(event,seq,message,signal);
    if (signal.aborted || !client.status().running) throw new Error('机器人已停止，取消发送');
    const sent=await client.send(payload);
    stats.sent++;log('info','已回复QQ消息',{scene:event.scene,targetId:event.targetId,messageId:sent.id,seq,type:message?.type==='media' ? message.mediaKind : message?.type || 'text'});
    return {sentMessageId:sent.id,sentRefIndex:sent.ext_info?.ref_idx};
  }
  function acceptEvent(payload) {
    if (closed || !client.status().running) return;
    if (pending>=1000) { stats.errors++; log('error','事件队列已满，请降低负载'); throw Object.assign(new Error('事件队列已满'),{status:503}); }
    const event = normalizeEvent(payload), appId = store.config().qq.appId, signal = botController.signal;
    const id = payload.id || (event?.msgId ? `${payload.t}:${event.scene}:${event.targetId}:${event.msgId}` : null);
    if (id && !store.claimEvent(`${appId}:${id}`)) return;
    stats.received++;
    if (event) {
      // 消息进入合并器：先按配置等一小会儿，这期间同一会话的新消息会并入同一次回答。
      const key = batchKey(event);
      const urgent = isCommand(event.content);
      batcher.push(key, event, { urgent });
      return;
    }
    pending++;
    const job = Promise.resolve().then(async()=>{
      if (closed || signal.aborted || !client.status().running || store.config().qq.appId!==appId) return;
      log('info',`收到平台事件：${payload.t || payload.op}`);
      await handlePlatformEvent(payload);
    }).catch(e=>{if (!signal.aborted) {stats.errors++;log('error',e.message,{code:e.code,traceId:e.traceId});}}).finally(()=>{pending--;jobs.delete(job);});
    jobs.add(job);
  }

  // 官方事件里除消息之外、值得自动处理的那几类。
  async function handlePlatformEvent(payload) {
    const c = store.config(), welcome = c.bot.welcome;
    if (c.bot.enabled && welcome && ['FRIEND_ADD','GROUP_ADD_ROBOT'].includes(payload.t)) {
      const scene = payload.t==='FRIEND_ADD'?'c2c':'group', targetId = payload.d?.user_openid || payload.d?.group_openid;
      if (targetId && payload.id && engine.permitted({userId:payload.d?.user_openid || payload.d?.op_member_openid || '',targetId})) {
        await client.send({scene,targetId,eventId:payload.id,content:engine.template(welcome,{userId:targetId})}); stats.sent++;
      }
      return;
    }
    // 入群申请：官方接口是 POST /v2/groups/{group_openid}/approval_join_request/{member_openid}
    if (payload.t === 'GROUP_JOIN_REQUEST' && c.harness.autoApproveJoin) {
      const groupOpenid = payload.d?.group_openid, memberOpenid = payload.d?.member_openid || payload.d?.user_openid;
      const requestId = payload.d?.join_request_id || payload.d?.id;
      if (groupOpenid && memberOpenid && requestId) {
        await client.request('POST', `/v2/groups/${encodeURIComponent(groupOpenid)}/approval_join_request/${encodeURIComponent(memberOpenid)}`,
          {op:'approve', join_request_id:String(requestId)});
        log('info','已自动通过入群申请',{groupOpenid,memberOpenid});
      }
      return;
    }
    // 好友被删除：清掉这个单聊的长期记忆，避免下次加回来还残留旧资料。
    if (payload.t === 'FRIEND_DEL') {
      const userOpenid = payload.d?.user_openid || payload.d?.id;
      if (userOpenid) {
        const key = conversationKey(c.qq.appId, {scene:'c2c', targetId:userOpenid, userId:userOpenid});
        store.clearMemory(key);
        log('info','好友已删除，已清除该单聊的会话记忆',{key});
      }
      return;
    }
    // 互动事件：官方要求用 PUT /interactions/{interaction_id} 回应，body 为 {"code":0}。
    if (payload.t === 'INTERACTION_CREATE') {
      const interactionId = payload.d?.id || payload.id;
      if (interactionId) {
        try { await client.request('PUT', `/interactions/${encodeURIComponent(interactionId)}`, {code:0}); log('info','已回应互动事件',{interactionId}); }
        catch (error) { log('warn','回应互动事件失败',{error:error.message}); }
      }
      return;
    }
    if (payload.t === 'GROUP_MEMBER_ADD' || payload.t === 'GROUP_MEMBER_REMOVE') {
      log('info',`群成员${payload.t==='GROUP_MEMBER_ADD'?'加入':'退出'}`,{group:payload.d?.group_openid,member:payload.d?.member_openid});
      return;
    }
    if (payload.t === 'SUBSCRIBE_MESSAGE_STATUS') {
      log('info','订阅消息授权状态变更',{detail:payload.d?.status || ''});
    }
  }

  // 处理一批（可能已合并多条）消息
  async function handleBatch(events, meta) {
    const merged = mergeEvents(events);
    if (!merged) return;
    const signal = botController.signal;
    const appId = store.config().qq.appId;
    pending++;
    const job = Promise.resolve().then(async()=>{
      if (closed || signal.aborted || !client.status().running) return;
      let enriched = merged;
      // 解析昵称：控制台与模型上下文都用昵称，不再是一串 OpenID。
      if (store.config().harness.profileLookup) {
        try {
          const profile = await profiles.resolveUser(appId, merged);
          if (profile?.name) enriched = { ...enriched, senderName: profile.name };
          const target = await profiles.resolveTarget(appId, merged);
          if (target?.name) enriched = { ...enriched, targetName: target.name };
        } catch (error) {
          log('warn','解析用户昵称失败',{error:error.message});
        }
      }
      if (enriched.mergedCount > 1) log('info',`合并了 ${enriched.mergedCount} 条消息后统一回复`,{key:enriched.key||'',scene:enriched.scene});
      const resolved=await client.resolveReference(enriched,store);
      const result=await engine.generate(resolved,{
        signal,
        deliver:(content,seq,message)=>sendReply(resolved,content,seq,message,signal),
        typing:async()=>{
          if (resolved.scene!=='c2c' || signal.aborted || !client.status().running) return 0;
          try {
            await client.send({scene:'c2c',targetId:resolved.targetId,msgId:resolved.msgId,seq:1,type:'input',inputNotify:{input_type:1,input_second:60}});
            stats.sent++;return {seqUsed:1};
          } catch(e) { log('warn','输入状态通知发送失败，继续普通回复',{code:e.code});return 0; }
        },
      });
      for (const warning of result.warnings) log('warn',warning);
    }).catch(e=>{if (!signal.aborted) {stats.errors++;log('error',e.message,{code:e.code,traceId:e.traceId});}}).finally(()=>{pending--;jobs.delete(job);});
    jobs.add(job);
  }
  app.disable('x-powered-by');
  app.use((req,res,next)=>{
    res.set({'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
    next();
  });
  app.post('/qq/webhook',express.raw({type:()=>true,limit:'2mb'}),(req,res,next)=>{
    try {
      const result = client.handleWebhook(req.body,req.headers);
      if (result.event && client.status().running) acceptEvent(result.event);
      res.json(result.body);
    } catch(e) { next(e); }
  });
  // 戳一戳入口注册在会话中间件之前，因此自己解析会话 Cookie。
  const sessionOf=req=>{
    const sid=/(?:^|;\s*)qqbot_session=([a-f0-9]{64})(?:;|$)/.exec(req.get('cookie')||'')?.[1];
    const found=sid?sessions.get(sid):null;
    return found && found.expires>Date.now() ? found : null;
  };
  // 戳一戳：官方开放平台没有戳一戳事件（只存在于 OneBot/NapCat 等第三方协议），
  // 因此提供统一入口：第三方桥接用 x-poke-token 头转发，控制台按钮用管理会话触发。
  app.post('/qq/poke',express.json({limit:'64kb'}),async(req,res)=>{
    const expected=process.env.QQBOT_POKE_TOKEN||'';
    const provided=req.get('x-poke-token')||req.body?.token||'';
    const byToken=Boolean(expected) && provided.length>0 && provided===expected;
    const session=sessionOf(req);
    const bySession=Boolean(session?.authenticated) && req.get('X-CSRF-Token')===session.csrfToken;
    if (!byToken && !bySession) return res.status(401).json({error:'戳一戳入口需要 QQBOT_POKE_TOKEN（请求头 x-poke-token）或控制台会话'});
    const {scene,targetId,userId=''}=req.body||{};
    if (!['c2c','group','channel','dm'].includes(scene)) return res.status(400).json({error:'scene 必须是 c2c / group / channel / dm'});
    if (typeof targetId!=='string' || !targetId.trim()) return res.status(400).json({error:'缺少 targetId（群/单聊 openid）'});
    if (!store.config().harness.pokeEnabled) return res.status(409).json({error:'戳一戳功能已关闭（harness.pokeEnabled）'});
    if (!client.status().running) return res.status(409).json({error:'机器人未运行，请先启动'});
    const event={scene,targetId:targetId.trim(),userId:String(userId||'').trim(),content:'',poke:true,timestamp:new Date().toISOString()};
    try {
      const result=await engine.generate(event,{deliver:(content,seq)=>sendReply(event,content,seq,{type:'text',content},botController.signal)});
      for (const warning of result.warnings) log('warn',warning);
      log('info','已响应戳一戳',{scene,targetId:event.targetId,replies:result.replies.length});
      res.json({ok:true,replies:result.replies,warnings:result.warnings});
    } catch (error) {
      log('error','戳一戳响应失败',{scene,error:error.message});
      res.status(502).json({error:error.message});
    }
  });
  app.use(express.json({limit:'30mb'}));
  app.use('/api',(req,res,next)=>{
    if (['POST','PUT','PATCH'].includes(req.method)) {
      if (req.body === undefined) req.body = {};
      if (!req.body || typeof req.body!=='object' || Array.isArray(req.body)) return res.status(400).json({error:'请求体必须为JSON对象'});
    }
    next();
  });
  const sessions = new Map(), loginAttempts = new Map();
  const salt = randomBytes(16), passwordHash = password ? scryptSync(password,salt,32) : null;
  const origin = req=> publicOrigin ? new URL(publicOrigin).origin : `${req.protocol}://${req.get('host')}`;
  function newSession(req,res,authenticated=!password) {
    const id=randomBytes(32).toString('hex'), s={csrfToken:randomBytes(32).toString('hex'),authenticated,expires:Date.now()+43200000};
    if (sessions.size>=1000) for (const [key,value] of sessions) if (value.expires<Date.now() || !value.authenticated) sessions.delete(key);
    if (sessions.size>=1000) throw Object.assign(new Error('管理会话过多'),{status:429});
    sessions.set(id,s);
    res.cookie('qqbot_session',id,{httpOnly:true,sameSite:'strict',secure:origin(req).startsWith('https:'),maxAge:43200000,path:'/'});
    req.sessionId=id; return s;
  }
  app.use('/api',(req,res,next)=>{
    res.set('Cache-Control','no-store');
    try {
      const hostname = new URL(`http://${req.get('host')}`).hostname;
      if (publicOrigin ? req.get('host')!==new URL(publicOrigin).host : local && !['localhost','127.0.0.1','[::1]'].includes(hostname)) return res.status(403).json({error:'不允许的 Host；远程代理请配置 QQBOT_PUBLIC_ORIGIN'});
      if (req.get('origin') && req.get('origin')!==origin(req)) return res.status(403).json({error:'禁止跨站管理请求'});
      const sid = /(?:^|;\s*)qqbot_session=([a-f0-9]{64})(?:;|$)/.exec(req.get('cookie') || '')?.[1];
      let session=sessions.get(sid);
      if (session?.expires<Date.now()) {sessions.delete(sid); session=null;}
      req.sessionId=sid;
      req.session=session || newSession(req,res);
      if (req.path==='/session' || req.path==='/login') return next();
      if (!req.session.authenticated) return res.status(401).json({error:'请先登录管理控制台'});
      if (!['GET','HEAD'].includes(req.method) && req.get('X-CSRF-Token')!==req.session.csrfToken) return res.status(403).json({error:'CSRF令牌无效，请刷新页面'});
      next();
    } catch(e) {next(e);}
  });
  app.get('/api/session',(req,res)=>res.json({csrfToken:req.session.csrfToken,authRequired:!!password,authenticated:req.session.authenticated}));
  app.post('/api/login',(req,res)=>{
    const now=Date.now(), key=req.socket.remoteAddress, previous=loginAttempts.get(key);
    const attempt=previous && previous.until>now ? previous : {count:0,until:now+60000};
    loginAttempts.set(key,attempt);
    if (++attempt.count>10) return res.status(429).json({error:'登录尝试过多，请一分钟后重试'});
    if (password && (typeof req.body.password!=='string' || req.body.password.length>1000 || !timingSafeEqual(scryptSync(req.body.password,salt,32),passwordHash))) return res.status(401).json({error:'管理密码错误'});
    sessions.delete(req.sessionId);
    const session=newSession(req,res,true);
    res.json({csrfToken:session.csrfToken,authRequired:!!password,authenticated:true});
  });
  app.post('/api/logout',(req,res)=>{sessions.delete(req.sessionId);res.clearCookie('qqbot_session');res.json({ok:true});});
  app.get('/api/config',(req,res)=>res.json(store.publicConfig()));
  // 版本号：控制台侧边栏显示，也方便别人一眼看出跑的是哪一版。
  app.get('/api/version',(req,res)=>{
    try {
      const pkg=JSON.parse(fs.readFileSync(join(root,'package.json'),'utf8'));
      res.json({version:pkg.version,name:pkg.name,license:pkg.license||'',node:process.version});
    } catch (error) { res.json({version:'unknown',error:error.message}); }
  });
  // publicConfig() 会附带 hasAppSecret 这类「是否已保存密钥」的标记字段，
  // 它们只是给界面看的，不能写回配置（schema 是 strict 的）。
  const CONFIG_MARKERS = [['qq','hasAppSecret'],['llm','hasApiKey'],['harness','hasGenApiKey'],['harness','hasTtsApiKey']];
  function stripMarkers(body) {
    const clean = { ...body };
    for (const [section, key] of CONFIG_MARKERS) {
      if (!clean[section] || typeof clean[section] !== 'object') continue;
      const copy = { ...clean[section] };
      delete copy[key];
      clean[section] = copy;
    }
    return clean;
  }
  app.put('/api/config',(req,res)=>{
    const body=stripMarkers(req.body||{});
    const current=store.config(), candidate=mergeConfig(current,body);
    if (JSON.stringify(candidate.qq)!==JSON.stringify(current.qq) && (client.status().running || pending)) return res.status(409).json({error:'修改QQ接入配置前请停止机器人，并等待正在处理的消息结束'});
    res.json(store.saveConfig(body)); client.invalidate(); store.prune(candidate.bot.memoryDays);
    batcher.configure({delayMs:candidate.bot.firstReplyDelayMs, windowMs:candidate.bot.mergeWindowMs});
    log('info','已保存配置');
  });
  app.get('/api/status',(req,res)=>res.json(status()));
  app.post('/api/bot/start',async(req,res)=>{if (botController.signal.aborted) botController=new AbortController();await client.start();log('info','机器人启动');res.json(status());});
  app.post('/api/bot/stop',async(req,res)=>{botController.abort();await client.stop();log('info','机器人停止');res.json(status());});
  app.post('/api/bot/check',async(req,res)=>res.json({ok:true,identity:await client.request('GET','/users/@me')}));
  app.get('/api/conversations',(req,res)=>{
    store.prune(store.config().bot.memoryDays);
    const appId=store.config().qq.appId;
    // 把 OpenID 换成昵称：单聊显示用户昵称，群聊显示群名，接口不可用时退回短 ID。
    res.json(store.listConversations().map(row=>{
      const userName=profiles.cachedName(appId,'user',row.scene,row.targetId,row.userId);
      const targetName=profiles.cachedName(appId,'target',row.scene,row.targetId);
      const sceneLabel=SCENE_LABEL[row.scene] || row.scene;
      const who=row.scene==='group' ? (targetName || `群 ${shortId(row.targetId)}`) : (userName || shortId(row.userId));
      // 用户自己起的名字优先级最高。
      const displayName=row.label || who;
      return {...row, sceneLabel, userName, targetName, displayName,
        userLabel: row.label || userName || shortId(row.userId), targetLabel: targetName || shortId(row.targetId)};
    }));
  });
  app.get('/api/conversations/:key',(req,res)=>res.json({messages:store.history(req.params.key).map(m=>m.role==='assistant' ? {...m,content:stripStrayTimestamps(m.content)} : m),facts:store.facts(req.params.key)}));
  app.put('/api/conversations/:key',(req,res)=>{
    if (!store.listConversations().some(c=>c.key===req.params.key)) return res.status(404).json({error:'会话不存在'});
    if (typeof req.body.facts!=='string' || Array.from(req.body.facts).length>8000) return res.status(400).json({error:'记忆必须为不超过8000字符的文本'});
    store.saveFacts(req.params.key,req.body.facts);res.json({ok:true});
  });
  app.delete('/api/conversations/:key',(req,res)=>{
    // 删会话是不可逆的，留一条日志，免得以后查不到「怎么没了」。
    const entry=store.listConversations().find(c=>c.key===req.params.key);
    store.deleteConversation(req.params.key);
    // secure_delete 把内容清零了；VACUUM 把空间还给文件系统，文件里就真的没有了。
    store.vacuum?.();
    try { store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
    log('warn','控制台删除了会话',{key:req.params.key,scene:entry?.scene,targetId:entry?.targetId,count:entry?.count});
    res.json({ok:true});
  });
  app.post('/api/conversations/:key/consolidate',async(req,res)=>{
    const entry=store.listConversations().find(c=>c.key===req.params.key);
    if (!entry) return res.status(404).json({error:'会话不存在'});
    if (!store.facts(req.params.key).trim()) return res.status(400).json({error:'该会话没有长期记忆可整理'});
    const result=await engine.consolidateMemory({scene:entry.scene,targetId:entry.targetId,userId:entry.userId},{signal:previewController.signal});
    log('info','已整理长期记忆',{key:req.params.key,before:result.before,after:result.after});
    res.json(result);
  });
  // ---- 资料库：文件夹 + DOC.md ----
  app.get('/api/resources',(req,res)=>res.json(store.listResourceFolders()));
  app.post('/api/resources',(req,res)=>{
    try {
      const input=req.body||{};
      const folder=store.saveResourceFolder({id:input.id,name:input.name,trigger:input.trigger,summary:input.summary});
      res.json(folder);
    } catch (error) { throw Object.assign(error,{status:error.status||400}); }
  });
  app.get('/api/resources/:id',(req,res)=>{
    const folder=store.getResourceFolder(req.params.id);
    if (!folder) return res.status(404).json({error:'资料夹不存在'});
    res.json({...folder,files:store.listResourceFiles(folder.id)});
  });
  app.delete('/api/resources/:id',(req,res)=>{
    if(!store.deleteResourceFolder(req.params.id)) return res.status(404).json({error:'资料夹不存在'});
    store.checkpoint();
    res.json({ok:true});
  });
  // 往资料夹里加文件（一次可以多个）。
  app.post('/api/resources/:id/files',async(req,res)=>{
    try {
      const folder=store.getResourceFolder(req.params.id);
      if (!folder) return res.status(404).json({error:'资料夹不存在'});
      const input=req.body||{};
      const files=Array.isArray(input.files)?input.files.slice(0,50):[];
      if (!files.length) return res.status(400).json({error:'没有可用的文件'});
      const saved=[],errors=[];
      for (const file of files) {
        try { saved.push(await buildResourceFile(folder.id,file,{note:input.note})); }
        catch (error) { errors.push(`${file?.name||'文件'}：${error.message}`); }
      }
      if (!saved.length) return res.status(400).json({error:errors.join('；')||'没有可用的文件',errors});
      res.json({saved,count:saved.length,errors});
    } catch (error) { throw Object.assign(error,{status:error.status||400}); }
  });
  app.get('/api/resources/:id/files/:fileId',(req,res)=>{
    const file=store.getResourceFile(req.params.fileId);
    if (!file || file.folderId!==req.params.id) return res.status(404).json({error:'文件不存在'});
    res.json(file);
  });
  app.delete('/api/resources/:id/files/:fileId',(req,res)=>{
    if(!store.deleteResourceFile(req.params.fileId)) return res.status(404).json({error:'文件不存在'});
    res.json({ok:true});
  });
  // 图片预览：走同源接口，不暴露第三方地址。
  app.get('/api/resources/:id/files/:fileId/image',(req,res)=>{
    const image=store.getResourceFileImage(req.params.fileId);
    if (!image) return res.status(404).json({error:'该文件没有图片'});
    if (!image.mime.startsWith('image/')) return res.status(400).json({error:'该文件不是图片'});
    res.type(image.mime).send(image.bytes);
  });
  // 会话重命名：让用户能自己给 session 起个认得的名字。
  app.patch('/api/conversations/:key',(req,res)=>{
    if (!store.listConversations().some(c=>c.key===req.params.key)) return res.status(404).json({error:'会话不存在'});
    if (typeof req.body?.label!=='string' || req.body.label.length>60) return res.status(400).json({error:'会话名称最多60字符'});
    store.setConversationLabel(req.params.key,req.body.label);
    res.json({ok:true});
  });
  // ---- 用户昵称 ----
  app.get('/api/profiles',(req,res)=>res.json(store.listProfiles()));
  // 手动刷新昵称：重新向 QQ 官方接口查询并覆盖缓存。
  app.post('/api/profiles/refresh',async(req,res)=>{
    const appId=store.config().qq.appId;
    const body=req.body||{};
    const scene=String(body.scene||'group'), targetId=String(body.targetId||''), userId=String(body.userId||'');
    if (!targetId||!userId) return res.status(400).json({error:'缺少 targetId / userId'});
    try {
      const profile=await profiles.resolveUser(appId,{scene,targetId,userId,senderName:''});
      if (!profile) return res.status(404).json({error:'没有查到昵称；单聊场景 QQ 官方不提供该接口'});
      res.json(profile);
    } catch (error) {
      res.status(502).json({error:error.message});
    }
  });
  // ---- 模型测试连接 ----
  // ---- 数据文件都在哪儿 ----
  app.get('/api/storage',(req,res)=>{
    try {
      const dir=resolve(dataDir);
      const entries=[];
      let total=0;
      for (const name of fs.readdirSync(dir)) {
        const full=join(dir,name);
        let size=0, mtime='';
        try { const st=fs.statSync(full); size=st.size; mtime=st.mtime.toISOString(); } catch { /* ignore */ }
        total+=size;
        entries.push({name,size,mtime,path:full});
      }
      entries.sort((a,b)=>b.size-a.size);
      // 数据库里各表占多少行
      const tables=store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row=>row.name);
      const counts={};
      for (const table of tables) {
        try { counts[table]=store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n; } catch { counts[table]=null; }
      }
      res.json({
        dataDir:dir,
        entries,
        totalBytes:total,
        dbPath:join(dir,'qqbot.sqlite'),
        env:'QQBOT_DATA_DIR',
        counts,
        note:'所有数据（配置、会话、消息、资料库、表情包、提醒、日志、用量）都在这个目录里；备份直接复制整个目录即可。',
      });
    } catch (error) {
      res.status(500).json({error:error.message});
    }
  });
  app.post('/api/models/test',async(req,res)=>{
    const body=req.body||{}, kind=body.kind==='image'||body.kind==='video'?body.kind:'chat';
    const c=store.config();
    try {
      if (kind==='chat') {
        const started=Date.now();
        if (!c.llm.model?.trim()) throw new Error('请先填写模型名称');
        const reply=await requestModel(store,c,[
          {role:'system',content:'你是一个连通性测试助手，只回复两个字：正常'},
          {role:'user',content:'ping'},
        ],{signal:previewController.signal,wait:async()=>{}});
        const text=typeof reply.content==='string'?reply.content.trim():'';
        const thinkingChars=Number(reply.thinkingChars)||0;
        const notes=[];
        if (thinkingChars>2000) notes.push(`这次思考过程写了约 ${thinkingChars} 字（输出额度容易被吃光）。建议把「推理强度」调低，或改用 OpenAI 兼容接口 ${c.llm.baseUrl.replace(/\/anthropic(\/v\d+)?$/,'/v1')} 试试，通常快好几倍。`);
        if (reply.stopReason==='max_tokens') notes.push('输出被最大输出长度截断了，请把「最大生成 token」调大。');
        return res.json({ok:true,kind,model:c.llm.model,latencyMs:Date.now()-started,reply:text.slice(0,200),thinkingChars,stopReason:reply.stopReason||'',notes});
      }
      const h=c.harness;
      const apiKey=h.genApiKey||c.llm.apiKey;
      const result=await testGeneration({kind,mode:h.genMode,apiKey,baseUrl:h.genBaseUrl,custom:h,
        model:kind==='video'?h.videoModel:h.imageModel,signal:previewController.signal});
      res.json({...result,model:kind==='video'?h.videoModel:h.imageModel,mode:h.genMode});
    } catch (error) {
      res.status(502).json({ok:false,kind,error:error.message});
    }
  });
  // ---- 语音合成 ----
  // 系统已安装的音色（仅 Windows 可用）。
  app.get('/api/tts/voices',async(req,res)=>{
    try { res.json(await listWindowsVoices()); }
    catch (error) { res.status(502).json({ok:false,voices:[],error:error.message}); }
  });
  // 服务商账号下的音色（MiniMax 等）。
  app.post('/api/tts/service-voices',async(req,res)=>{
    try {
      const c=store.config();
      const result=await listServiceVoices({apiKey:c.harness.ttsApiKey,baseUrl:c.harness.ttsBaseUrl,signal:previewController.signal});
      res.json(result);
    } catch (error) {
      res.status(502).json({ok:false,voices:[],error:error.message});
    }
  });
  // 合成一段语音但不发送，用来验证配置。
  app.post('/api/tts/preview',async(req,res)=>{
    try {
      const c=store.config();
      const text=String(req.body?.text||'你好，这是语音合成的连通性测试。').slice(0,200);
      const audio=await synthesize(c.harness,{text,signal:previewController.signal});
      res.json({ok:true,format:audio.ext,mime:audio.mime,bytes:audio.bytes.length,durationSec:audio.durationSec,source:audio.source});
    } catch (error) {
      res.status(502).json({ok:false,error:error.message});
    }
  });
  app.get('/api/usage',(req,res)=>res.json(store.usageSummary()));
  app.delete('/api/usage',(req,res)=>{store.clearUsage();res.json({ok:true});});
  app.post('/api/chat',async(req,res)=>{
    let attachments;
    try {attachments=validateAttachments(req.body.attachments ?? [],store.config());} catch(e) {throw Object.assign(e,{status:400});}
    const content=req.body.content===undefined ? '' : req.body.content;
    if (typeof content!=='string' || content.length>12000 || !content.trim() && !attachments.length) return res.status(400).json({error:'请填写消息或添加附件；文字最多12000字符'});
    if (req.body.longReply!==undefined && typeof req.body.longReply!=='boolean') return res.status(400).json({error:'longReply必须是布尔值'});
    const userId=requiredString(req.body.userId || 'tester','用户ID'),targetId=requiredString(req.body.targetId || 'local','会话ID');
    const result=await engine.generate({scene:'preview',targetId,userId,content,attachments,longReply:!!req.body.longReply},{preview:true,signal:previewController.signal});
    res.json(result);
  });
  app.get('/api/logs',(req,res)=>res.json(store.logs(Math.max(0,Number(req.query.after) || 0))));
  app.delete('/api/logs',(req,res)=>{store.clearLogs();store.checkpoint();res.json({ok:true});});
  function running(req,res,next) { if (!client.status().running) return res.status(409).json({error:'请先启动机器人；本操作会访问真实QQ接口'});next(); }
  app.post('/api/messages/send',running,async(req,res)=>{const data=await client.send(req.body);stats.sent++;log('info','手动发送消息',{scene:req.body.scene,targetId:req.body.targetId,messageId:data.id});res.json(data);});
  app.post('/api/messages/upload',running,async(req,res)=>res.json(await client.upload(req.body)));
  app.post('/api/messages/recall',running,async(req,res)=>res.json(await client.recall(req.body)));
  app.get('/api/platform/catalog',(req,res)=>res.json(apiCatalog));
  app.post('/api/platform/request',running,async(req,res)=>res.json(await client.request(req.body.method,req.body.path,req.body.body)));
  app.get('/api/export',(req,res)=>res.attachment('qqbot-config.json').json(store.publicConfig()));
  app.get('/api/tasks',(req,res)=>res.json(scheduler.list()));
  app.post('/api/tasks',(req,res)=>{
    const {scene,targetId,userId='',...input}=req.body,appId=store.config().qq.appId;
    const event={scene,targetId,userId};
    const owner={appId,...event,key:conversationKey(appId,event)};
    res.json(scheduler.create(input,owner));
  });
  app.patch('/api/tasks/:id',(req,res)=>res.json(scheduler.update(req.params.id,req.body)));
  app.post('/api/tasks/:id/run',(req,res)=>res.json(scheduler.runNow(req.params.id)));
  app.delete('/api/tasks/:id',(req,res)=>{if (!scheduler.remove(req.params.id)) return res.status(404).json({error:'任务不存在'});res.json({ok:true});});
  app.get('/api/memes',(req,res)=>res.json(store.listMemes()));
  app.post('/api/memes',(req,res)=>{
    try {res.json(store.saveMeme(req.body));} catch(e) {throw Object.assign(e,{status:400});}
  });
  app.delete('/api/memes/:id',(req,res)=>{if (!store.deleteMeme(req.params.id)) return res.status(404).json({error:'表情包不存在'});store.checkpoint();res.json({ok:true});});
  app.get('/api/memes/:id/image',async(req,res)=>{
    const meme=store.getMeme(req.params.id);
    if (!meme) return res.status(404).json({error:'表情包不存在'});
    const result=meme.fileData ? {bytes:Buffer.from(meme.fileData,'base64'),contentType:meme.mime} : await downloadMedia(meme.url,{maxBytes:2*1024*1024,signal:previewController.signal});
    if (!['image/png','image/jpeg','image/gif','image/webp'].includes(result.contentType)) return res.status(400).json({error:'该地址没有返回受支持的图片'});
    res.type(result.contentType).send(result.bytes);
  });
  app.use(express.static(join(root,'public'),{etag:true,index:'index.html'}));
  app.use('/api',(req,res)=>res.status(404).json({error:'管理接口不存在'}));
  app.use((err,req,res,next)=>{
    const validation=err.name==='ZodError';
    const code=validation || err.type==='entity.parse.failed' ? 400 : Number.isInteger(err.status) && err.status>=400 && err.status<=599 ? err.status : 502;
    const message=validation ? err.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('；') : err.type==='entity.parse.failed' ? '请求体不是有效JSON' : err.message;
    if (req.path!=='/qq/webhook') log('error',message,{code:err.code,traceId:err.traceId});
    res.status(code).json({error:store.redact(message),...(err.code!==undefined ? {code:err.code} : {}),...(err.traceId ? {traceId:err.traceId} : {})});
  });
  store.prune(store.config().bot.memoryDays);
  scheduler.prune();
  const timer=setInterval(()=>{store.prune(store.config().bot.memoryDays);scheduler.prune();for (const [key,s] of sessions) if (s.expires<Date.now()) sessions.delete(key);for (const [key,a] of loginAttempts) if (a.until<Date.now()) loginAttempts.delete(key);},3600000); timer.unref();
  scheduler.start();
  async function drain() { while (jobs.size) await Promise.all([...jobs]); }
  return {app,store,engine,client,scheduler,profiles,batcher,status,acceptEvent,drain,attachmentPayload,close:async()=>{closed=true;batcher.clear();botController.abort();previewController.abort();clearInterval(timer);await client.stop();await scheduler.close();await drain();store.close();}};
}

if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const { main } = await import('./cli.js');
  const result = await main(['serve']);
  process.exitCode = result.exitCode;
}

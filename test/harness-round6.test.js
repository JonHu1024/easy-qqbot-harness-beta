import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Engine, conversationKey } from '../src/engine.js';
import { createApp } from '../src/server.js';

function fixture(t,options={},config={}) {
  const dir=mkdtempSync(join(tmpdir(),'qq-r6-')),store=new Store(dir);
  t.after(()=>{ store.close(); rmSync(dir,{recursive:true,force:true}); });
  store.saveConfig({bot:{mode:'llm',minChars:0,maxChars:200,replyCount:2,cooldownMs:0,replyDelayMs:0},llm:{model:'m',apiKey:'k'},rules:[],...config});
  const engine=new Engine(store,{wait:async()=>{},random:()=>0,...options});
  return {dir,store,engine,event:{scene:'c2c',targetId:'u1',userId:'u1',content:'问题',msgId:'m1'}};
}
const json=value=>new Response(JSON.stringify(value),{status:200});
// 部分用例会 mock 全局 fetch；服务端用例先恢复真实实现，避免串味。
const REAL_FETCH=globalThis.fetch;
function transport(t,script) {
  const requests=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if (!String(url).includes('/chat/completions')) return json({ok:true});
    requests.push(JSON.parse(options.body));
    const next=script.shift();
    assert.ok(next!==undefined,'Unexpected model request');
    if (typeof next==='string') return json({choices:[{message:{role:'assistant',content:next}}]});
    return json({choices:[{message:next}]});
  });
  return requests;
}

test('群聊记忆按群合并：同群不同用户共用会话，单聊仍按用户区分',t=>{
  const appId='123';
  const alice={scene:'group',targetId:'g1',userId:'alice'};
  const bob={scene:'group',targetId:'g1',userId:'bob'};
  const carol={scene:'group',targetId:'g2',userId:'alice'};
  assert.equal(conversationKey(appId,alice),conversationKey(appId,bob),'同群应共用同一会话');
  assert.notEqual(conversationKey(appId,alice),conversationKey(appId,carol),'不同群应分开');
  assert.notEqual(conversationKey(appId,alice),conversationKey(appId,{scene:'c2c',targetId:'alice',userId:'alice'}),'单聊按用户区分');
  assert.notEqual(conversationKey(appId,{scene:'c2c',targetId:'u1',userId:'u1'}),conversationKey(appId,{scene:'c2c',targetId:'u2',userId:'u2'}));
});
test('群聊里不同用户的事实写进同一份群记忆',async t=>{
  const {store,engine}=fixture(t);
  transport(t,['好的','好的']);
  const alice={scene:'group',targetId:'g1',userId:'alice',content:'我喜欢猫',msgId:'m1'};
  const bob={scene:'group',targetId:'g1',userId:'bob',content:'我喜欢狗',msgId:'m2'};
  await engine.generate(alice);await engine.generate(bob);
  const convs=store.listConversations();
  assert.equal(convs.length,1,'群里只应有一个会话');
  assert.equal(convs[0].scene,'group');
  const key=convs[0].key;
  const messages=store.history(key).filter(m=>m.role==='user').map(m=>m.content);
  assert.ok(messages.some(text=>text.includes('我喜欢猫'))&&messages.some(text=>text.includes('我喜欢狗')),JSON.stringify(messages));
});
test('资料库：文件夹可增删查，按触发条件命中',t=>{
  const {store}=fixture(t);
  const folder=store.saveResourceFolder({name:'人设设定',trigger:'用户问瑶鸢的性格或说话风格时',summary:'瑶鸢的人设与口癖'});
  assert.equal(folder.name,'人设设定');
  store.saveResourceFile({folderId:folder.id,name:'瑶鸢.md',kind:'text',content:'瑶鸢喜欢用简短中文回复，讨厌连续追问。'});
  assert.equal(store.listResourceFolders().length,1);
  assert.equal(store.listResourceFolders()[0].fileCount,1);
  const hits=store.matchResourceFolders('人设',3);
  assert.equal(hits[0].id,folder.id);
  assert.ok(hits[0].summary.includes('人设'));
  assert.equal(store.matchResourceFolders('完全无关的词xyz',3).length,0);
  assert.equal(store.deleteResourceFolder(folder.id),true);
  assert.equal(store.listResourceFolders().length,0);
});
test('用户消息命中资料夹时给出提示，模型自己决定要不要读',async t=>{
  const {store,engine,event}=fixture(t);
  const folder=store.saveResourceFolder({name:'说话风格',trigger:'用户问说话风格时',summary:'瑶鸢说话简短、偏文艺'});
  store.saveResourceFile({folderId:folder.id,name:'风格.md',kind:'text',content:'瑶鸢说话简短、偏文艺，讨厌连发问号。'});
  const requests=transport(t,['好的，我知道怎么说了']);
  await engine.generate({...event,content:'你说话是什么风格？'});
  const body=JSON.stringify(requests[0].messages);
  assert.ok(body.includes('说话风格'),'应提示你想起一些可能相关的东西');
  assert.ok(body.includes('用户问说话风格时'),'应带上触发条件');
  assert.ok(!body.includes('讨厌连发问号'),'不应把文件正文直接塞进上下文');
  // 模型可以自己列目录、再读文件。
  const toolTurn=(name,args,id='c1')=>({role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
  const toolRequests=transport(t,[toolTurn('list_notes',{},'r1'),toolTurn('read_note',{folder:'说话风格',file:'风格.md'},'r2'),'找到了']);
  const result=await engine.generate({...event,msgId:'m2',content:'查一下资料'});
  const listAction=result.actions.find(a=>a.name==='list_notes');
  assert.equal(listAction.ok,true);
  assert.ok(JSON.stringify(listAction.result).includes('说话风格'));
  const readAction=result.actions.find(a=>a.name==='read_note');
  assert.equal(readAction.ok,true);
  assert.ok(JSON.stringify(readAction.result).includes('讨厌连发问号'));
  assert.ok(toolRequests.length>=3);
});
test('提示词包含 emoji 速查表，并说明群记忆共享',async t=>{
  const {engine,event}=fixture(t);
  const requests=transport(t,['😊']);
  await engine.generate({...event,scene:'group',targetId:'g1',userId:'u1'});
  const system=requests[0].messages[0].content;
  assert.match(system,/emoji/);
  assert.match(system,/【情绪】/,'应给出按情绪分类的 emoji 速查表');
  assert.match(system,/😊/,'速查表里应有可直接抄的 Unicode emoji');
  assert.match(system,/群内共享/);
});
test('戳一戳会得到一句回应并写入会话记忆',async t=>{
  const {store,engine}=fixture(t);
  const requests=transport(t,['怎么啦😄']);
  const result=await engine.generate({scene:'c2c',targetId:'u1',userId:'u1',content:'',poke:true,msgId:'p1'});
  assert.deepEqual(result.replies,['怎么啦😄']);
  assert.match(JSON.stringify(requests[0].messages),/戳了你/);
  const key=store.listConversations()[0].key;
  assert.ok(store.history(key).some(m=>m.content==='[戳一戳]'),'应记录戳一戳事件');
});
test('戳一戳入口需要令牌或控制台会话',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'qq-r6-poke-'));
  const runtime=createApp({dataDir:dir});
  const web=await new Promise(r=>{const s=runtime.app.listen(0,'127.0.0.1',()=>r(s));});  globalThis.fetch=REAL_FETCH;
  const base=`http://127.0.0.1:${web.address().port}`;
  t.after(async()=>{await new Promise(r=>web.close(r));await runtime.close();rmSync(dir,{recursive:true,force:true});});
  const unauthorized=await fetch(base+'/qq/poke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scene:'c2c',targetId:'u1'})});
  assert.equal(unauthorized.status,401);
  const badScene=await fetch(base+'/qq/poke',{method:'POST',headers:{'Content-Type':'application/json','x-poke-token':'x'},body:JSON.stringify({scene:'unknown',targetId:'u1'})});
  assert.equal(badScene.status,401,'没有配置令牌时一律拒绝');
});
test('配置了 QQBOT_POKE_TOKEN 后，戳一戳入口可被桥接调用',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'qq-r6-poke2-'));
  const previous=process.env.QQBOT_POKE_TOKEN;
  process.env.QQBOT_POKE_TOKEN='bridge-secret';
  t.after(()=>{ if (previous===undefined) delete process.env.QQBOT_POKE_TOKEN; else process.env.QQBOT_POKE_TOKEN=previous; });
  const runtime=createApp({dataDir:dir});
  const web=await new Promise(r=>{const s=runtime.app.listen(0,'127.0.0.1',()=>r(s));});  globalThis.fetch=REAL_FETCH;
  const base=`http://127.0.0.1:${web.address().port}`;
  t.after(async()=>{await new Promise(r=>web.close(r));await runtime.close();rmSync(dir,{recursive:true,force:true});});
  const session=await fetch(base+'/api/session');
  const cookie=session.headers.get('set-cookie').split(';')[0],{csrfToken}=await session.json();
  await fetch(base+'/api/config',{method:'PUT',headers:{Cookie:cookie,'X-CSRF-Token':csrfToken,'Content-Type':'application/json'},body:JSON.stringify({qq:{appId:'1',appSecret:'s'}})});
  // 机器人未运行时应给出明确提示而不是崩溃
  const notRunning=await fetch(base+'/qq/poke',{method:'POST',headers:{'Content-Type':'application/json','x-poke-token':'bridge-secret'},body:JSON.stringify({scene:'c2c',targetId:'u1'})});
  assert.equal(notRunning.status,409);
  assert.match((await notRunning.json()).error,/机器人未运行/);
  const badTarget=await fetch(base+'/qq/poke',{method:'POST',headers:{'Content-Type':'application/json','x-poke-token':'bridge-secret'},body:JSON.stringify({scene:'c2c'})});
  assert.equal(badTarget.status,400);
});
test('资料库 REST：建文件夹、传文件、读文件夹、删除',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'qq-r6-res-'));
  const runtime=createApp({dataDir:dir});
  const web=await new Promise(r=>{const s=runtime.app.listen(0,'127.0.0.1',()=>r(s));});  globalThis.fetch=REAL_FETCH;
  const base=`http://127.0.0.1:${web.address().port}`;
  t.after(async()=>{await new Promise(r=>web.close(r));await runtime.close();rmSync(dir,{recursive:true,force:true});});
  const session=await fetch(base+'/api/session');
  const cookie=session.headers.get('set-cookie').split(';')[0],{csrfToken}=await session.json();
  const api=async(path,method='GET',body)=>{const res=await fetch(base+path,{method,headers:{Cookie:cookie,'X-CSRF-Token':csrfToken,'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});return {status:res.status,data:await res.json()};};
  const folder=await api('/api/resources','POST',{name:'人设设定',trigger:'用户问性格时',summary:'瑶鸢的人设'});
  assert.equal(folder.status,200);
  assert.equal(folder.data.name,'人设设定');
  assert.equal((await api('/api/resources')).data.length,1);
  const uploaded=await api(`/api/resources/${folder.data.id}/files`,'POST',{files:[
    {name:'a.txt',contentType:'text/plain',data:Buffer.from('文件里的内容').toString('base64')},
  ]});
  assert.equal(uploaded.status,200);
  assert.equal(uploaded.data.count,1);
  const detail=await api(`/api/resources/${folder.data.id}`);
  assert.equal(detail.data.files.length,1);
  assert.equal(detail.data.files[0].name,'a.txt');
  const fileContent=await api(`/api/resources/${folder.data.id}/files/${detail.data.files[0].id}`);
  assert.equal(fileContent.data.content,'文件里的内容');
  const bad=await api(`/api/resources/${folder.data.id}/files`,'POST',{files:[{name:'a.exe',contentType:'application/octet-stream',data:Buffer.from('x').toString('base64')}]});
  assert.equal(bad.status,400);
  assert.equal((await api(`/api/resources/${folder.data.id}`,'DELETE')).status,200);
  assert.equal((await api('/api/resources')).data.length,0);
});

test('控制台会话可触发戳一戳（会话中间件之前注册也能鉴权）',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'qq-r6-poke3-'));
  const runtime=createApp({dataDir:dir});
  const web=await new Promise(r=>{const s=runtime.app.listen(0,'127.0.0.1',()=>r(s));});
  const base=`http://127.0.0.1:${web.address().port}`;
  globalThis.fetch=REAL_FETCH;
  t.after(async()=>{await new Promise(r=>web.close(r));await runtime.close();rmSync(dir,{recursive:true,force:true});});
  const session=await fetch(base+'/api/session');
  const cookie=session.headers.get('set-cookie').split(';')[0],{csrfToken}=await session.json();
  const response=await fetch(base+'/qq/poke',{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':csrfToken,'Content-Type':'application/json'},body:JSON.stringify({scene:'c2c',targetId:'u1',userId:'u1'})});
  assert.notEqual(response.status,401,'带有效会话与 CSRF 不应被拒绝');
  assert.equal(response.status,409,'机器人未运行时应提示 409');
});

test('群聊引用回查使用共享会话键（不会因按用户拆分而失效）',t=>{
  const {store}=fixture(t);
  const appId='';
  const alice={scene:'group',targetId:'G1',userId:'alice'};
  const bob={scene:'group',targetId:'G1',userId:'bob'};
  const key=conversationKey(appId,alice);
  store.addMessage(key,'assistant','群里的上一句',{appId,scene:'group',targetId:'G1',userId:'bob',sentMessageId:'ROBOT1.0_x',sentRefIndex:'IDX1'});
  const found=store.findReferencedMessage({appId,...alice,messageId:'ROBOT1.0_x'});
  assert.ok(found,'群聊引用应能查到');
  assert.equal(found.content,'群里的上一句');
});


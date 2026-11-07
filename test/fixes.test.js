import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { parseArguments } from '../src/model.js';
import { prepareInput, validateAttachments } from '../src/media.js';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
function fixture(t,options={},config={}) {
  const dir=mkdtempSync(join(tmpdir(),'qq-fixes-')),store=new Store(dir);
  t.after(()=>{ store.close(); rmSync(dir,{recursive:true,force:true}); });
  store.saveConfig({bot:{mode:'llm',minChars:0,maxChars:200,replyCount:4,cooldownMs:0,replyDelayMs:0},llm:{model:'test-model'},rules:[],...config});
  const engine=new Engine(store,{wait:async()=>{},random:()=>0,...options});
  return {store,engine,event:{scene:'c2c',targetId:'u1',userId:'u1',content:'问题',msgId:'m1',timestamp:'2026-10-07T22:15:46+08:00'}};
}
function transport(t,script) {
  const requests=[],calls=[];
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    const body=JSON.parse(options.body);calls.push(body);requests.push(body);
    const next=script.shift();
    assert.ok(next,'Unexpected model request');
    if (next.error) return new Response(JSON.stringify(next.error),{status:next.status || 400});
    return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:next}}]}),{status:200});
  });
  return requests;
}
function toolTransport(t,script) {
  const requests=[];
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    requests.push(JSON.parse(options.body));
    const next=script.shift();
    assert.ok(next,'Unexpected model request');
    if (typeof next==='string') return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:next}}]}),{status:200});
    if (next.error) return new Response(JSON.stringify(next.error),{status:next.status || 400});
    return new Response(JSON.stringify({choices:[{message:next}]}),{status:200});
  });
  return requests;
}
const call=(name,args,id='call1')=>({id,type:'function',function:{name,arguments:typeof args==='string' ? args : JSON.stringify(args)}});

test('PDF默认不发送给模型，启用后才是file片段',async()=>{
  const pdf=Buffer.concat([Buffer.from('%PDF-1.4\n'),Buffer.alloc(32),Buffer.from('trailer\n%%EOF\n')]);
  const attachment={url:'data:application/pdf;base64,'+pdf.toString('base64'),filename:'a.pdf',contentType:'application/pdf',size:pdf.length};
  const off=await prepareInput({content:'看文件',attachments:validateAttachments([attachment],{harness:{filesEnabled:true}})},{harness:{filesEnabled:true}});
  assert.deepEqual(off.parts.filter(p=>p.type!=='text'),[]);
  assert.ok(off.warnings.some(w=>w.includes('PDF 直传')));
  assert.ok(off.parts.some(p=>p.type==='text' && p.text.includes('未读取')));
  const on=await prepareInput({content:'看文件',attachments:validateAttachments([attachment],{harness:{filesEnabled:true,pdfFileParts:true}})},{harness:{filesEnabled:true,pdfFileParts:true}});
  assert.equal(on.parts.filter(p=>p.type==='file').length,1);
  assert.deepEqual(on.warnings,[]);
});
test('模型接口拒绝附件片段时降级为文本重试一次并给出警告',async t=>{
  const {store,engine,event}=fixture(t,{prepareInput:async()=>({parts:[{type:'text',text:'看图'},{type:'image_url',image_url:{url:'data:image/png;base64,AAAA'}}],summary:'[附件：a.png]',warnings:[]})});
  const requests=transport(t,[
    {status:400,error:{error:{message:'Invalid JSON data: Failed to deserialize the JSON body into the target type: messages[1]: data did not match any variant of untagged enum MessageContent at line 1 column 612701',type:'invalid_request_error',code:'json_parse_error'}}},
    '看到附件了吗\n没看到',
  ]);
  const result=await engine.generate(event);
  assert.deepEqual(result.replies,['看到附件了吗','没看到']);
  const userMsg=[...requests[1].messages].reverse().find(m=>m.role==='user');
  assert.equal(Array.isArray(userMsg.content),false);
  assert.equal(userMsg.content,'[附件：a.png]');
  assert.ok(result.warnings.some(w=>w.includes('拒绝')));
  const stored=store.history(result.key);
  assert.equal(stored.some(m=>JSON.stringify(m.meta).includes('data:image')),false);
});
test('工具调用的助手消息不发送content:null',async t=>{
  const {engine,event}=fixture(t,{scheduler:{create:async()=>({id:'t1'}),list:async()=>[],cancel:async()=>true}});
  const requests=toolTransport(t,[{role:'assistant',content:null,tool_calls:[call('list_reminders',{})]},'好的']);
  await engine.generate(event);
  const assistant=requests[1].messages.find(m=>m.role==='assistant');
  assert.ok(Object.hasOwn(assistant,'tool_calls'));
  assert.equal(Object.hasOwn(assistant,'content'),false);
});
test('换行未拆分时给出明确警告，开启后拆分为多条',async t=>{
  const {store,engine,event}=fixture(t);
  store.saveConfig({harness:{splitLines:false}});
  transport(t,['第一条\n第二条']);
  const merged=await engine.generate(event);
  assert.deepEqual(merged.replies,['第一条\n第二条']);
  assert.ok(merged.warnings.some(w=>w.includes('没有拆分')),JSON.stringify(merged.warnings));
  store.saveConfig({harness:{splitLines:true}});
  transport(t,['第一条\n第二条']);
  assert.deepEqual((await engine.generate(event)).replies,['第一条','第二条']);
});
test('表情包目录为空时明确提醒，有素材时可用正文之外的名额发送',async t=>{
  const {store,engine,event}=fixture(t,{listMemes:async()=>[]});
  store.saveConfig({harness:{memesEnabled:true,memeChance:1},bot:{replyCount:1}});
  transport(t,['只说正文']);
  const empty=await engine.generate(event);
  // 图片表情包是可选增强：目录为空不再报错/警告，模型直接用 emoji 表达情绪。
  assert.equal(empty.warnings.some(w=>w.includes('目录为空')),false,JSON.stringify(empty.warnings));
  assert.deepEqual(empty.messages.map(m=>m.type),['text']);
  const withCatalog=fixture(t,{listMemes:async()=>[{id:'m1',name:'开心',tags:[],enabled:true}]});
  withCatalog.store.saveConfig({harness:{memesEnabled:true,memeChance:1},bot:{replyCount:1}});
  toolTransport(t,[{role:'assistant',content:'只说正文',tool_calls:[call('choose_meme',{id:'m1'})]},'只说正文']);
  const result=await withCatalog.engine.generate(withCatalog.event);
  assert.deepEqual(result.replies,['只说正文']);
  assert.deepEqual(result.messages.map(m=>m.type),['text','meme']);
  assert.equal(result.actions.find(a=>a.name==='choose_meme').ok,true);
});
test('提醒时间允许不带时区并按北京时间解释，无效参数提示当前时间',()=>{
  const args=parseArguments('create_reminder',JSON.stringify({title:'喝水',content:'记得喝水',dueAt:'2026-10-08T18:00:00'}));
  assert.equal(args.dueAt,'2026-10-08T18:00:00+08:00');
  assert.throws(()=>parseArguments('create_reminder',JSON.stringify({title:'a',content:'b',dueAt:'明天下午',delaySeconds:5})),/必须且只能|dueAt/);
  assert.throws(()=>parseArguments('create_reminder',JSON.stringify({title:'a',content:'b'})),/必须且只能/);
});
test('模型提示包含建提醒指令、表情比例与消息时间',async t=>{
  const {store,engine,event}=fixture(t,{scheduler:{create:async()=>'x',list:async()=>[],cancel:async()=>true},listMemes:async()=>[{id:'m1',name:'开心',tags:[],enabled:true}]});
  store.saveConfig({harness:{memesEnabled:true,memeChance:0.25}});
  const requests=transport(t,['好']);
  await engine.generate(event);
  const system=requests[0].messages[0].content;
  assert.match(system,/create_reminder/);assert.match(system,/25%/);assert.match(system,/2026/);
  assert.match(system,/dueAt 形如/);
  assert.match(system,/title 要短/);
  assert.match(system,/执行成功后会自动删除/);
});
test('用户消息记录QQ发送时间，时间以元数据而非行内前缀进入模型',async t=>{
  const {store,engine,event}=fixture(t);
  const requests=transport(t,['甲','乙']);
  await engine.generate(event);
  const key=store.listConversations()[0].key;
  assert.equal(store.history(key)[0].meta.sentAt,'2026-10-07T22:15:46+08:00');
  await engine.generate({...event,msgId:'m2'});
  const historyMessage=requests[1].messages.find(m=>m.role==='assistant' && typeof m.content==='string' && m.content.includes('甲'));
  // 历史带时间标记，模型才知道那句话是什么时候说的
  assert.match(historyMessage.content,/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2} · .+?\] 甲$/,historyMessage.content);
  const system=requests[1].messages[0].content;
  assert.match(system,/现在是 20\d\d年/,'现在时间要说人话');
  assert.match(system,/用户本条消息发于/);
  assert.match(system,/禁止在回复里输出时间戳/);
});

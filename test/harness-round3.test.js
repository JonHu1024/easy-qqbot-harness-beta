import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { Scheduler } from '../src/scheduler.js';
import { normalizeEvent } from '../src/qq.js';

function fixture(t,options={},config={}) {
  const dir=mkdtempSync(join(tmpdir(),'qq-r3-')),store=new Store(dir);
  t.after(()=>{ store.close(); rmSync(dir,{recursive:true,force:true}); });
  store.saveConfig({bot:{mode:'llm',minChars:0,maxChars:200,replyCount:3,cooldownMs:0,replyDelayMs:0},llm:{model:'test-model',apiKey:'sk-test',baseUrl:'https://apihub.agnes-ai.com/v1'},rules:[],...config});
  const engine=new Engine(store,{wait:async()=>{},random:()=>0,...options});
  return {store,engine,event:{scene:'c2c',targetId:'u1',userId:'u1',content:'问题',msgId:'m1',timestamp:'2026-10-07T22:15:46+08:00'}};
}
function model(t,script) {
  const requests=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const target=String(url);
    if (!target.includes('/chat/completions')) return new Response('{}',{status:200});
    requests.push(JSON.parse(options.body));
    const next=script.shift();
    assert.ok(next!==undefined,'Unexpected model request');
    if (typeof next==='string') return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:next}}]}),{status:200});
    return new Response(JSON.stringify({choices:[{message:next}]}),{status:200});
  });
  return requests;
}
const toolTurn=(name,args,id='c1')=>({role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});

test('模型中输出时间戳会被清理，孤立时间戳不会发到QQ',async t=>{
  const {engine,event}=fixture(t);
  model(t,['[2026/10/9 21:06:47] 你好呀\n[2026/10/9 21:06:48] 在忙吗']);
  const result=await engine.generate(event);
  assert.deepEqual(result.replies,['你好呀','在忙吗']);
  const bare=fixture(t);model(t,['[2026/10/9 21:07:00]']);
  await assert.rejects(bare.engine.generate(bare.event),/空行|时间戳/);
});
test('用户明确问时间时保留时间回答',async t=>{
  const {engine,event}=fixture(t);
  model(t,['[2026/10/9 21:07:00]']);
  const result=await engine.generate({...event,content:'现在几点'});
  assert.equal(result.replies.length,1);
});
test('历史带时间标记；模型自己抄的时间前缀会被清掉',async t=>{
  const {store,engine,event}=fixture(t);
  const requests=model(t,['好的','好的','好的']);
  const key=(await engine.generate(event)).key;
  store.addMessage(key,'assistant','[2026/10/9 21:06:47] 上一句被污染的话',{appId:'',scene:'c2c',targetId:'u1',userId:'u1',sentAt:'2026-10-09T13:06:47.000Z'});
  await engine.generate({...event,msgId:'m2'});
  const sent=requests.at(-1).messages.filter(m=>m.role==='assistant');
  assert.ok(sent.length>0);
  // 我们自己加的时间标记是允许的（模型靠它建立时间感），但历史里那句老污染必须被清掉
  const cleaned=sent.find(m=>m.content.includes('上一句被污染的话'));
  assert.ok(cleaned,'应当还能看到那句历史');
  assert.doesNotMatch(cleaned.content,/\[2026\/10\/9 21:06:47\]/,'老的时间污染应当被清掉');
  assert.match(cleaned.content,/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2} · .+?\] 上一句被污染的话$/,JSON.stringify(cleaned.content));
  assert.ok(requests.at(-1).messages.every(m=>typeof m.content!=='string' || !m.content.includes('本次用户消息发送时间')));
});
test('模型输出短代码与残留标记转成Unicode emoji，可关闭',async t=>{
  const {store,engine,event}=fixture(t);
  model(t,['好的[微笑] 给你[咖啡] <faceType=1,faceId="317",ext="eyJ0ZXh0Ijoi6I+c5rGqIn0=">','好的[微笑]']);
  const on=await engine.generate(event);
  assert.equal(on.replies[0],'好的😊 给你☕ 🐶');
  store.saveConfig({harness:{emojiFaces:false}});
  assert.equal((await engine.generate({...event,msgId:'m2'})).replies[0],'好的[微笑]');
});
test('收到的QQ原生表情转成可读文本',()=>{
  const event=normalizeEvent({op:0,id:'e1',t:'C2C_MESSAGE_CREATE',d:{id:'m1',author:{user_openid:'u1'},content:'在想你<faceType=1,faceId="317",ext="eyJ0ZXh0Ijoi6I+c5rGqIn0=">',timestamp:'2026-10-07T22:15:46+08:00'}});
  assert.equal(event.content,'在想你🐶');
  assert.equal(event.content.includes('faceType'),false);
});
test('一次性任务成功后自动清理，关闭开关则保留为done',async t=>{
  const store=new Store(mkdtempSync(join(tmpdir(),'qq-r3-task-')));
  t.after(()=>store.close());
  const owner={appId:'',scene:'preview',targetId:'local',userId:'u',key:'k'};
  let now=Date.now(),sent=0;
  const scheduler=new Scheduler(store,{now:()=>now,send:async()=>{sent++;}});
  const gone=scheduler.create({title:'a',content:'b',delaySeconds:1},owner);
  now+=2000;await scheduler.tick();
  assert.equal(sent,1);
  assert.equal(store.getTask(gone.id),null,'默认开启自动清理时一次性任务应被删除');
  store.saveConfig({harness:{tasksAutoCleanup:false}});
  const kept=scheduler.create({title:'c',content:'d',delaySeconds:1},owner);
  now+=2000;await scheduler.tick();
  assert.equal(store.getTask(kept.id).status,'done','关闭自动清理时应保留为done');
  store.saveConfig({harness:{tasksAutoCleanup:true}});
  const recurring=scheduler.create({title:'e',content:'f',delaySeconds:1,intervalSeconds:60},owner);
  now+=2000;await scheduler.tick();
  assert.equal(store.getTask(recurring.id).status,'pending','周期任务应继续等待下次');
  assert.ok(scheduler.prune(now+99*86400000)>=1,'超过历史保留天数的已完成任务应被清理');
  await scheduler.close();
});
test('生图产生媒体消息，频道视频被明确拦截',async t=>{
  const {store,engine,event}=fixture(t,{}, {harness:{imageGenEnabled:true,videoGenEnabled:true}});
  const modelRequests=[];
  const json=value=>new Response(JSON.stringify(value),{status:200});
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const target=String(url);
    if (target.includes('/images/generations')) return json({data:[{url:'https://cdn.example.com/cat.png'}]});
    if (target.includes('/video/generations/')) return json({status:'completed',url:'https://cdn.example.com/movie.mp4'});
    if (target.includes('/video/generations')) return json({id:'task-1',status:'processing'});
    const body=JSON.parse(options.body);modelRequests.push(body);
    const last=[...body.messages].reverse().find(m=>m.role==='user');
    const raw=last?.content;
    const text=typeof raw==='string' ? raw : Array.isArray(raw) ? raw.map(part=>part.text || '').join(' ') : '';
    const hasTool=body.messages.some(m=>m.role==='tool');
    const wantsVideo=text.includes('视频');
    const message=hasTool ? {role:'assistant',content:'做好了'} : toolTurn(wantsVideo?'generate_video':'find_photo',wantsVideo?{prompt:'一只猫在跑'}:{subject:'一只猫'},'g'+modelRequests.length);
    return json({choices:[{message}]});
  });
  const image=await engine.generate(event);
  const media=image.messages.find(m=>m.type==='media');
  assert.ok(media,JSON.stringify(image.messages));
  assert.equal(media.mediaKind,'image');assert.equal(media.url,'https://cdn.example.com/cat.png');
  assert.equal(image.messages.at(-1),media,'媒体应排在正文之后');
  const channelImage=await engine.generate({...event,msgId:'m2',scene:'channel',targetId:'ch'});
  assert.ok(channelImage.messages.some(m=>m.type==='media'),'频道支持发送公网图片URL');
  assert.equal(channelImage.warnings.some(w=>/频道/.test(w)),false,JSON.stringify(channelImage.warnings));
  const channelVideo=await engine.generate({...event,msgId:'m3',scene:'channel',targetId:'ch',content:'给我个视频'});
  assert.equal(channelVideo.messages.some(m=>m.type==='media'),false,'频道不应发送视频附件');
  assert.ok(channelVideo.warnings.some(w=>/频道/.test(w)),JSON.stringify(channelVideo.warnings));
  store.saveConfig({harness:{imageGenEnabled:false,videoGenEnabled:false}});
  modelRequests.length=0;
  await engine.generate({...event,msgId:'m4'});
  // 关掉生图后：相册工具还在（已有的照片照样能发），但不再有视频工具。
  assert.equal(modelRequests.at(-1).tools.some(tool=>tool.function.name==='find_photo'),true);
  assert.equal(modelRequests.at(-1).tools.some(tool=>tool.function.name==='generate_video'),false);
});
test('搜索工具按开关注册并能返回结果与链接',async t=>{
  const {engine,event}=fixture(t,{}, {harness:{searchEnabled:true,searchResults:3}});
  const seen=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const target=String(url);
    if (target.includes('/chat/completions')) {
      seen.push(JSON.parse(options.body));
      const body=seen.length===1 ? toolTurn('web_search',{query:'qq机器人'},'s1') : '查到一些资料';
      return new Response(JSON.stringify({choices:[{message:typeof body==='string'?{role:'assistant',content:body}:body}]}),{status:200});
    }
    return new Response(`<html><body><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbot.q.qq.com%2Fwiki%2F">QQ 机器人官方文档</a><a class="result__snippet">官方文档</a></body></html>`,{status:200});
  });
  const result=await engine.generate(event);
  assert.ok(seen[0].tools.some(tool=>tool.function.name==='web_search'));
  const action=result.actions.find(a=>a.name==='web_search');
  assert.equal(action.ok,true);
  assert.ok(JSON.stringify(action.result).includes('bot.q.qq.com'),JSON.stringify(action.result));
});

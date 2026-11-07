import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';

function fixture(t,options={},config={}) {
  const dir=mkdtempSync(join(tmpdir(),'qq-r4-')),store=new Store(dir);
  t.after(()=>{ store.close(); rmSync(dir,{recursive:true,force:true}); });
  store.saveConfig({bot:{mode:'llm',minChars:0,maxChars:200,replyCount:2,cooldownMs:0,replyDelayMs:0},llm:{model:'agnes-3.0-flash',apiKey:'sk-test'},rules:[],...config});
  const engine=new Engine(store,{wait:async()=>{},random:()=>0,...options});
  return {dir,store,engine,event:{scene:'c2c',targetId:'u1',userId:'u1',content:'问题',msgId:'m1'}};
}
const json=value=>new Response(JSON.stringify(value),{status:200});
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
const toolTurn=(name,args,id='c1')=>({role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});

test('长期记忆整体重写并自动去重，不再逐条堆积',t=>{
  const {store}=fixture(t);
  const raw=store.saveFacts('k','  用户喜欢猫  \n\n- 用户喜欢猫。\n用户住上海\n用户住上海！\n');
  assert.equal(raw,'用户喜欢猫\n用户住上海');
  store.saveFacts('k','用户喜欢猫\n用户住上海\n用户不吃香菜');
  assert.equal(store.facts('k').split('\n').length,3);
  store.saveFacts('k','用户不吃香菜');
  assert.equal(store.facts('k'),'用户不吃香菜','整体重写应替换而不是追加');
});
test('模型通过 update_memory 整体写回记忆，并被提示禁止追加',async t=>{
  const {store,engine,event}=fixture(t);
  store.saveFacts('not-used','');
  const requests=transport(t,[toolTurn('update_memory',{facts:'用户叫小明\n用户喜欢猫'},'m1'),'记住了']);
  await engine.generate(event);
  const key=store.listConversations()[0].key;
  assert.equal(store.facts(key),'用户叫小明\n用户喜欢猫');
  const system=requests[0].messages[0].content;
  assert.match(system,/update_memory/);
  assert.match(system,/禁止逐条追加/);
  assert.equal(requests[0].tools.some(tool=>tool.function.name==='remember_fact'),false,'旧的追加式工具应已移除');
});
test('/整理 让模型合并重复记忆并写回精简结果',async t=>{
  const {store,engine,event}=fixture(t);
  store.saveFacts('seed','');
  const requests=transport(t,[toolTurn('update_memory',{facts:'用户喜欢猫\n用户喜欢猫。\n用户住上海'},'m1'),'好的','用户喜欢猫\n用户住上海']);
  await engine.generate(event);
  const key=store.listConversations()[0].key;
  assert.equal(store.facts(key),'用户喜欢猫\n用户住上海','写入时应已去重');
  await engine.generate({...event,msgId:'m2',content:'/整理'});
  const system=requests.at(-1).messages[0].content;
  assert.match(system,/整理/);
  assert.equal(store.facts(key),'用户喜欢猫\n用户住上海');
});
test('模型用量按 usage 记账，缺失 usage 时计入未统计',async t=>{
  const {store,engine,event}=fixture(t);
  t.mock.method(globalThis,'fetch',async()=>json({choices:[{message:{role:'assistant',content:'好'}}],usage:{prompt_tokens:120,completion_tokens:30,total_tokens:150}}));
  await engine.generate(event);
  let summary=store.usageSummary();
  assert.equal(summary.all.requests,1);
  assert.equal(summary.all.totalTokens,150);
  assert.equal(summary.unknownUsage,0);
  assert.equal(summary.byModel[0].model,'agnes-3.0-flash');
  t.mock.method(globalThis,'fetch',async()=>json({choices:[{message:{role:'assistant',content:'好'}}]}));
  await engine.generate({...event,msgId:'m2'});
  summary=store.usageSummary();
  assert.equal(summary.all.requests,2);
  assert.equal(summary.unknownUsage,1,'没有 usage 的请求应单独计数');
  assert.equal(summary.all.totalTokens,150);
});
test('搜索与生图计入工具用量，用量可清空',async t=>{
  const {store,engine,event}=fixture(t,{}, {harness:{searchEnabled:true,imageGenEnabled:true}});
  const requests=transport(t,[toolTurn('web_search',{query:'q'},'s1'),toolTurn('find_photo',{subject:'猫'},'g1'),'好了']);
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const target=String(url);
    if (target.includes('/images/generations')) return json({data:[{url:'https://cdn.example.com/a.png'}]});
    if (target.includes('/chat/completions')) {
      requests.push(JSON.parse(options.body));
      const next=requests.length<=2 ? toolTurn(requests.length===1?'web_search':'find_photo',requests.length===1?{query:'q'}:{subject:'猫'},'t'+requests.length) : {role:'assistant',content:'好了'};
      return json({choices:[{message:next}]});
    }
    return new Response('<html><body><a class="result__a" href="https://example.com/">标题</a><a class="result__snippet">摘要</a></body></html>',{status:200});
  });
  await engine.generate(event);
  const summary=store.usageSummary();
  assert.equal(summary.all.toolCalls,2,JSON.stringify(summary.all));
  assert.equal(summary.all.searches,1);
  assert.equal(summary.all.images,1);
  store.clearUsage();
  assert.equal(store.usageSummary().all.requests,0);
});

test('要发附件时自动合并正文腾出名额，内容不丢',async t=>{
  const {store,engine,event}=fixture(t,{listMemes:async()=>[{id:'m1',name:'开心',tags:[],enabled:true}]}, {harness:{memesEnabled:true,memeChance:1},bot:{mode:'llm',minChars:0,maxChars:200,replyCount:4,cooldownMs:0,replyDelayMs:0}});
  const requests=transport(t,[toolTurn('choose_meme',{id:'m1'},'c1'),'甲\n乙\n丙\n丁']);
  // 模拟输入状态已占用 1 个名额（c2c 上限 4）
  const result=await engine.generate(event,{typing:async()=>({seqUsed:1})});
  const messages=result.messages;
  assert.equal(messages.at(-1).type,'meme','表情包应被发送');
  assert.equal(messages.filter(m=>m.type==='text').length,3,'文字应合并为3条');
  const text=messages.filter(m=>m.type==='text').map(m=>m.content).join('\n');
  for (const piece of ['甲','乙','丙','丁']) assert.ok(text.includes(piece),piece);
  assert.ok(result.warnings.some(w=>w.includes('合并')),JSON.stringify(result.warnings));
  assert.equal(requests.length>=1,true);
});


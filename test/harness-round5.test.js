import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { buildRequest, parseResponse, formatOf, toAnthropicMessages, toAnthropicTools } from '../src/llm-format.js';

function fixture(t,options={},config={}) {
  const dir=mkdtempSync(join(tmpdir(),'qq-r5-')),store=new Store(dir);
  t.after(()=>{ store.close(); rmSync(dir,{recursive:true,force:true}); });
  store.saveConfig({bot:{mode:'llm',minChars:0,maxChars:200,replyCount:2,cooldownMs:0,replyDelayMs:0},llm:{model:'claude-3',apiKey:'sk-ant',baseUrl:'https://api.anthropic.com/v1'},rules:[],...config});
  const engine=new Engine(store,{wait:async()=>{},random:()=>0,...options});
  return {store,engine,event:{scene:'c2c',targetId:'u1',userId:'u1',content:'问题',msgId:'m1'}};
}
const json=value=>new Response(JSON.stringify(value),{status:200});

test('协议自动识别：按地址判断 Anthropic，可手动指定',()=>{
  assert.equal(formatOf({llm:{baseUrl:'https://api.anthropic.com/v1',apiFormat:'auto'}}),'anthropic');
  assert.equal(formatOf({llm:{baseUrl:'https://apihub.agnes-ai.com/v1',apiFormat:'auto'}}),'openai');
  assert.equal(formatOf({llm:{baseUrl:'https://api.deepseek.com/v1',apiFormat:'anthropic'}}),'anthropic');
  assert.equal(formatOf({llm:{baseUrl:'https://api.deepseek.com/v1',apiFormat:'openai'}}),'openai');
});
test('消息转换：system 独立、图文分块、工具调用与工具结果',()=>{
  const {system,messages}=toAnthropicMessages([
    {role:'system',content:'你是助手'},
    {role:'user',content:[{type:'text',text:'看图'},{type:'image_url',image_url:{url:'data:image/png;base64,AAA'}},{type:'file',file:{filename:'a.pdf',file_data:'data:application/pdf;base64,BBB'}}]},
    {role:'assistant',content:'好的',tool_calls:[{id:'tu1',type:'function',function:{name:'remember_fact',arguments:'{"fact":"x"}'}}]},
    {role:'tool',tool_call_id:'tu1',content:'{"ok":true}'},
    {role:'assistant',content:'完成'},
  ]);
  assert.equal(system,'你是助手');
  assert.deepEqual(messages[0].content[0],{type:'text',text:'看图'});
  assert.deepEqual(messages[0].content[1],{type:'image',source:{type:'base64',media_type:'image/png',data:'AAA'}});
  assert.deepEqual(messages[0].content[2],{type:'document',source:{type:'base64',media_type:'application/pdf',data:'BBB'},title:'a.pdf'});
  assert.deepEqual(messages[1].content[0],{type:'text',text:'好的'});
  assert.deepEqual(messages[1].content[1],{type:'tool_use',id:'tu1',name:'remember_fact',input:{fact:'x'}});
  assert.equal(messages[2].role,'user');
  assert.deepEqual(messages[2].content[0],{type:'tool_result',tool_use_id:'tu1',content:'{"ok":true}'});
  assert.equal(messages[3].role,'assistant');
});
test('请求体：Anthropic 走 /messages 与 x-api-key，tool_choice=none 时不带 tools',()=>{
  const tools=[{type:'function',function:{name:'update_memory',description:'记忆',parameters:{type:'object',properties:{facts:{type:'string'}},required:['facts']}}}];
  const request=buildRequest('anthropic',{baseUrl:'https://api.anthropic.com/v1/',apiKey:'sk-ant',model:'claude-3',messages:[{role:'user',content:'hi'}],tools,maxTokens:512,temperature:0.5});
  assert.equal(request.url,'https://api.anthropic.com/v1/messages');
  assert.equal(request.headers['x-api-key'],'sk-ant');
  assert.equal(request.headers['anthropic-version'],'2023-06-01');
  assert.equal(request.body.max_tokens,512);
  assert.equal(request.body.system,undefined);
  assert.deepEqual(request.body.tools,[{name:'update_memory',description:'记忆',input_schema:{type:'object',properties:{facts:{type:'string'}},required:['facts']}}]);
  const none=buildRequest('anthropic',{baseUrl:'https://api.anthropic.com/v1',apiKey:'k',model:'m',messages:[{role:'user',content:'x'}],tools,toolChoice:'none',maxTokens:64});
  assert.equal('tools' in none.body,false,'Anthropic 没有 tool_choice=none，应直接不传 tools');
  const openai=buildRequest('openai',{baseUrl:'https://api.deepseek.com/v1',apiKey:'k',model:'m',messages:[{role:'user',content:'x'}],tools,toolChoice:'none',maxTokens:64});
  assert.equal(openai.url,'https://api.deepseek.com/v1/chat/completions');
  assert.equal(openai.body.tool_choice,'none');
});
test('响应解析：Anthropic 的文本与 tool_use 块、usage 字段',()=>{
  const parsed=parseResponse('anthropic',{content:[{type:'text',text:'好的'},{type:'tool_use',id:'t1',name:'update_memory',input:{facts:'a'}}],usage:{input_tokens:120,output_tokens:30}});
  assert.equal(parsed.content,'好的');
  assert.deepEqual(parsed.tool_calls,[{id:'t1',type:'function',function:{name:'update_memory',arguments:'{"facts":"a"}'}}]);
  assert.equal(parsed.usage.promptTokens,120);
  assert.equal(parsed.usage.completionTokens,30);
  assert.equal(parsed.usage.counted,true);
  const openai=parseResponse('openai',{choices:[{message:{role:'assistant',content:'hi'}}],usage:{prompt_tokens:5,completion_tokens:2,total_tokens:7}});
  assert.equal(openai.content,'hi');
  assert.equal(openai.usage.total,7);
});
test('端到端：Anthropic 协议下模型调用与工具循环都正常',async t=>{
  const {store,engine,event}=fixture(t);
  const requests=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    requests.push({url:String(url),headers:options.headers,body:JSON.parse(options.body)});
    const first=requests.length===1;
    const message=first
      ? {id:'msg_1',role:'assistant',content:[{type:'tool_use',id:'tu1',name:'update_memory',input:{facts:'用户喜欢猫'}}],usage:{input_tokens:100,output_tokens:10}}
      : {id:'msg_2',role:'assistant',content:[{type:'text',text:'记住了'}],usage:{input_tokens:130,output_tokens:4}};
    return json(message);
  });
  const result=await engine.generate(event);
  assert.equal(result.replies[0],'记住了');
  assert.equal(requests[0].url,'https://api.anthropic.com/v1/messages');
  assert.equal(requests[0].headers['x-api-key'],'sk-ant');
  assert.equal(requests[0].headers['anthropic-version'],'2023-06-01');
  assert.equal(requests[0].body.tools[0].name,'update_memory');
  assert.equal(requests[0].body.system.includes('你是助手')||requests[0].body.system.length>0,true);
  assert.equal(requests[1].body.messages.some(m=>Array.isArray(m.content)&&m.content.some(b=>b.type==='tool_result')),true,'工具结果应回填为 tool_result 块');
  const key=store.listConversations()[0].key;
  assert.equal(store.facts(key),'用户喜欢猫');
  const usage=store.usageSummary();
  assert.equal(usage.all.totalTokens,244);
});
test('Anthropic 协议下多模态图片转成 image 块',async t=>{
  const {engine,event}=fixture(t,{prepareInput:async()=>({parts:[{type:'text',text:'看图'},{type:'image_url',image_url:{url:'data:image/png;base64,AAAA'}}],summary:'[附件：a.png]',warnings:[]})},{llm:{model:'claude-3',apiKey:'sk-ant',baseUrl:'https://api.anthropic.com/v1',apiFormat:'anthropic'}});
  const requests=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    requests.push(JSON.parse(options.body));
    return json({id:'m',role:'assistant',content:[{type:'text',text:'看到了'}],usage:{input_tokens:10,output_tokens:2}});
  });
  await engine.generate(event);
  const blocks=[...requests[0].messages].reverse().find(m=>m.role==='user')?.content;
  assert.equal(blocks[0].type,'text');
  assert.equal(blocks[1].type,'image');
  assert.equal(blocks[1].source.media_type,'image/png');
});
test('生成密钥单独保存且公开接口不回显',t=>{
  const {store}=fixture(t);
  store.saveConfig({harness:{genApiKey:'gen-secret-value'}});
  assert.equal(store.config().harness.genApiKey,'gen-secret-value');
  const publicConfig=store.publicConfig();
  assert.equal(publicConfig.harness.genApiKey,'');
  assert.equal(publicConfig.harness.hasGenApiKey,true);
  const dir=store.db.prepare('SELECT json FROM settings WHERE id=1').get().json;
  assert.equal(dir.includes('gen-secret-value'),false,'磁盘上必须是密文');
});
test('生图默认使用 Agnes 地址，不跟随语言模型地址',async t=>{
  const {engine,event}=fixture(t,{}, {llm:{model:'deepseek-chat',apiKey:'ds-key',baseUrl:'https://api.deepseek.com/v1'},harness:{imageGenEnabled:true,genApiKey:'agnes-key'}});
  const seen=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    seen.push({url:String(url),headers:options.headers,body:JSON.parse(options.body)});
    if (String(url).includes('/images/generations')) return json({data:[{url:'https://cdn.example.com/a.png'}]});
    const first=seen.filter(s=>String(s.url).includes('/chat/completions')).length===1;
    const message=first
      ? {role:'assistant',content:null,tool_calls:[{id:'g1',type:'function',function:{name:'find_photo',arguments:JSON.stringify({subject:'猫'})}}]}
      : {role:'assistant',content:'画好了'};
    return json({choices:[{message}]});
  });
  const result=await engine.generate(event);
  const image=seen.find(s=>String(s.url).includes('/images/generations'));
  assert.ok(image,'应调用生图接口');
  assert.equal(image.url,'https://apihub.agnes-ai.com/v1/images/generations');
  assert.equal(image.headers.Authorization||image.headers.authorization,'Bearer agnes-key','应使用独立生成密钥');
  assert.ok(result.messages.some(m=>m.type==='media'));
});
test('生成接口 404 时提示填写生成地址与密钥',async t=>{
  const {generateImage}=await import('../src/agnes.js');
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({error:{message:'Not Found'}}),{status:404}));
  const error=await generateImage({prompt:'x',model:'agnes-image-2.1-flash',apiKey:'k',baseUrl:'https://api.deepseek.com/v1'}).then(()=>null,e=>e);
  assert.match(error.message,/HTTP 404/);
  assert.match(error.message,/生成接口地址/);
  assert.match(error.message,/生成 API Key/);
});

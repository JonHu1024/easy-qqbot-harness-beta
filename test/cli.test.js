import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { Store } from '../src/store.js';
import { createServer } from 'node:http';

function isolated(t) {
  const dir=mkdtempSync(join(tmpdir(),'qq-cli-')),previous=process.env.QQBOT_DATA_DIR;
  process.env.QQBOT_DATA_DIR=dir;
  t.after(()=>{ if (previous===undefined) delete process.env.QQBOT_DATA_DIR; else process.env.QQBOT_DATA_DIR=previous; rmSync(dir,{recursive:true,force:true}); });
  const logs=[],errors=[];
  return { dir, logs, errors, seed:(qq)=>{ const store=new Store(dir); store.saveConfig({qq}); store.close(); },
    log:message=>logs.push(String(message)), error:message=>errors.push(String(message)) };
}
function clientStub(calls,status={running:true,state:'connected',identity:{id:'bot-1',username:'命令行机器人'},transport:'websocket'}) {
  let open=false;
  return { start:async()=>{calls.push('start');open=true;return status;}, stop:async()=>{calls.push('stop');open=false;return {...status,running:false};}, status:()=>({...status,running:open}), request:async()=>({}), invalidate:()=>{}, resolveReference:async event=>event, handleWebhook:()=>({body:{op:12}}) };
}
test('npm run bot 等价命令会启动控制台并立即连接',async t=>{
  const {logs,errors,log,error,seed}=isolated(t),calls=[];
  seed({appId:'cli-app',appSecret:'cli-secret'});
  const result=await main(['start','--no-console'],{clientFactory:()=>clientStub(calls),log,error});
  assert.equal(result.exitCode,0);assert.equal(result.connected,true);assert.deepEqual(calls,['start']);
  assert.ok(logs.some(line=>line.includes('机器人已连接')&&line.includes('命令行机器人')),logs.join('|'));
  assert.deepEqual(errors,[]);
  await result.close();
});
test('serve 不自动连接，--no-connect 同样跳过连接',async t=>{
  const first=isolated(t),firstCalls=[];
  const served=await main(['serve','--no-connect','--port','0'],{clientFactory:()=>clientStub(firstCalls),log:first.log,error:first.error});
  assert.equal(served.exitCode,0);assert.deepEqual(firstCalls,[]);
  assert.ok(first.logs.some(line=>line.startsWith('控制台：http://')));
  await served.close();
  const second=isolated(t),secondCalls=[];
  const started=await main(['start','--no-connect','--port','0'],{clientFactory:()=>clientStub(secondCalls),log:second.log,error:second.error});
  assert.equal(started.exitCode,0);assert.deepEqual(secondCalls,[]);
  await started.close();
});
test('models 命令列出可用模型并标出配置是否可用',async t=>{
  const {logs,log,error,seed}=isolated(t);
  seed({appId:'a',appSecret:'b'});
  const { Store }=await import('../src/store.js');
  const store=new Store(process.env.QQBOT_DATA_DIR);
  store.saveConfig({llm:{apiKey:'sk-cli-test',baseUrl:'https://apihub.example.com/v1'},harness:{imageModel:'agnes-image-2.5-flash',videoModel:'agnes-video-v2.0'}});
  store.close();
  t.mock.method(globalThis,'fetch',async(url)=>{
    assert.ok(String(url).endsWith('/v1/models'),'只应查询模型列表：'+url);
    return new Response(JSON.stringify({data:[{id:'agnes-video-2.5-flash'},{id:'agnes-image-2.5-flash'},{id:'agnes-3.0-flash'}]}),{status:200});
  });
  const result=await main(['models'],{log,error});
  assert.equal(result.exitCode,0);
  const text=logs.join('\n');
  assert.match(text,/视频模型：agnes-video-2.5-flash/);
  assert.match(text,/生视频 agnes-video-v2\.0 ❌/);
  assert.match(text,/生图 agnes-image-2\.5-flash ✅/);
  assert.equal(text.includes('sk-cli-test'),false);
});
test('models 在缺少 Key 时给出可操作提示',async t=>{
  const {errors,log,error}=isolated(t);
  const result=await main(['models'],{log,error});
  assert.equal(result.exitCode,1);
  assert.ok(errors.some(line=>line.includes('API Key')),errors.join('|'));
});
test('开启搜索且存在代理变量时提示 NODE_USE_ENV_PROXY',async t=>{
  const {logs,log,error,seed}=isolated(t);
  seed({appId:'a',appSecret:'b'});
  const previous={proxy:process.env.HTTPS_PROXY,use:process.env.NODE_USE_ENV_PROXY};
  process.env.HTTPS_PROXY='http://127.0.0.1:7897';delete process.env.NODE_USE_ENV_PROXY;
  t.after(()=>{ if (previous.proxy===undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY=previous.proxy;
    if (previous.use===undefined) delete process.env.NODE_USE_ENV_PROXY; else process.env.NODE_USE_ENV_PROXY=previous.use; });
  const { Store }=await import('../src/store.js');
  const store=new Store(process.env.QQBOT_DATA_DIR);store.saveConfig({harness:{searchEnabled:true}});store.close();
  const result=await main(['serve','--no-connect','--port','0'],{log,error});
  assert.equal(result.exitCode,0);
  assert.ok(logs.some(line=>line.includes('NODE_USE_ENV_PROXY')),logs.join('|'));
  await result.close();
});
test('端口被占用时明确报错而不是崩溃',async t=>{
  const {logs,errors,log,error}=isolated(t);
  const blocker=await new Promise(resolve=>{const s=createServer();s.on('request',(_q,r)=>r.end('busy'));s.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(()=>new Promise(r=>blocker.close(r)));
  const busy=blocker.address().port;
  const result=await main(['serve','--no-connect','--port',String(busy)],{log,error});
  assert.equal(result.exitCode,1);
  assert.ok(errors.some(line=>line.includes('监听失败')),errors.join('|'));
  assert.equal(logs.some(line=>line.startsWith('控制台：')),false);
  if (result.close) await result.close();
});
test('缺少凭据时给出可操作提示且退出码为1',async t=>{
  const {errors,log,error}=isolated(t);
  const result=await main(['start','--no-console'],{log,error});
  assert.equal(result.exitCode,1);assert.equal(result.connected,undefined);
  assert.ok(errors.some(line=>line.includes('QQBOT_APP_ID')&&line.includes('无法连接')),errors.join('|'));
  if (result.close) await result.close();
});
test('环境变量凭据会写入本地加密配置',async t=>{
  const {dir,logs,log,error}=isolated(t),previous={id:process.env.QQBOT_APP_ID,secret:process.env.QQBOT_APP_SECRET};
  process.env.QQBOT_APP_ID='1234567890';process.env.QQBOT_APP_SECRET='cli-secret-value';
  t.after(()=>{ for (const [key,value] of [['QQBOT_APP_ID',previous.id],['QQBOT_APP_SECRET',previous.secret]]) if (value===undefined) delete process.env[key]; else process.env[key]=value; });
  const result=await main(['serve','--no-connect','--port','0'],{log,error});
  assert.equal(result.exitCode,0);
  assert.equal(result.runtime.store.config().qq.appId,'1234567890');
  assert.equal(result.runtime.store.config().qq.appSecret,'cli-secret-value');
  assert.equal(result.runtime.store.publicConfig().qq.appSecret,'');
  assert.ok(logs.some(line=>line.includes('环境变量')));
  await result.close();
});
test('只提供其中一个环境变量或未知参数会被拒绝',async t=>{
  const {errors,log,error}=isolated(t);
  const previous=process.env.QQBOT_APP_ID;
  process.env.QQBOT_APP_ID='only-id';
  t.after(()=>{ if (previous===undefined) delete process.env.QQBOT_APP_ID; else process.env.QQBOT_APP_ID=previous; });
  const partial=await main(['start','--no-console'],{log,error});
  assert.equal(partial.exitCode,1);
  assert.ok(errors.some(line=>line.includes('必须同时提供')));
  delete process.env.QQBOT_APP_ID;
  const unknown=await main(['start','--bogus'],{log,error});
  assert.equal(unknown.exitCode,2);
  const odd=await main(['start','--port','abc'],{log,error});
  assert.equal(odd.exitCode,2);
  const impossible=await main(['serve','--no-console'],{log,error});
  assert.equal(impossible.exitCode,2);
});
test('help 显示用法',async t=>{
  const {logs,log,error}=isolated(t);
  const result=await main(['help'],{log,error});
  assert.equal(result.exitCode,0);
  assert.ok(logs.join('\n').includes('npm run bot'));
});

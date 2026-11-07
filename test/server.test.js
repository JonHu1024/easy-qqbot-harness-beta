import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createApp } from '../src/server.js';
import { request as httpRequest } from 'node:http';

async function fixture(t,password='') {
  const base=resolve('.test-data');mkdirSync(base,{recursive:true});const dir=mkdtempSync(join(base,'server-'));
  const runtime=createApp({dataDir:dir,password});
  const server=await new Promise(r=>{const s=runtime.app.listen(0,'127.0.0.1',()=>r(s));});
  const url=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise(r=>server.close(r));await runtime.close();rmSync(dir,{recursive:true,force:true});});
  const session=await fetch(url+'/api/session'), cookie=session.headers.get('set-cookie').split(';')[0], data=await session.json();
  return {runtime,url,cookie,csrf:data.csrfToken};
}
test('管理写请求必须有本会话CSRF令牌，拒绝恶意Origin与Host',async t=>{
  const {url,cookie,csrf}=await fixture(t);
  const request=(headers)=>fetch(url+'/api/config',{method:'PUT',headers:{Cookie:cookie,'Content-Type':'application/json',...headers},body:JSON.stringify({bot:{name:'安全配置'}})});
  assert.equal((await request({})).status,403);
  assert.equal((await request({'X-CSRF-Token':csrf,Origin:'https://evil.example'})).status,403);
  const hostileHostStatus=await new Promise((resolve,reject)=>{
    const req=httpRequest(url+'/api/config',{method:'PUT',headers:{Host:'evil.example',Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'}},res=>{res.resume();resolve(res.statusCode);});
    req.on('error',reject);req.end(JSON.stringify({bot:{name:'恶意配置'}}));
  });
  assert.equal(hostileHostStatus,403);
  assert.equal((await request({'X-CSRF-Token':csrf})).status,200);
  assert.equal((await (await fetch(url+'/api/config',{headers:{Cookie:cookie}})).json()).bot.name,'安全配置');
});
test('密码保护读取、登录后轮换会话，旧会话不能读凭据配置',async t=>{
  const {url,cookie,csrf}=await fixture(t,'strong-local-password');
  assert.equal((await fetch(url+'/api/config',{headers:{Cookie:cookie}})).status,401);
  const login=await fetch(url+'/api/login',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({password:'strong-local-password'})});
  assert.equal(login.status,200);const newCookie=login.headers.get('set-cookie').split(';')[0], data=await login.json();
  assert.notEqual(newCookie,cookie);assert.notEqual(data.csrfToken,csrf);
  assert.equal((await fetch(url+'/api/config',{headers:{Cookie:cookie}})).status,401);
  assert.equal((await fetch(url+'/api/config',{headers:{Cookie:newCookie}})).status,200);
});
test('非本地绑定或公开反向代理地址不得无密码启动',()=>{
  assert.throws(()=>createApp({host:'0.0.0.0',password:''}),/管理密码|PASSWORD/);
  assert.throws(()=>createApp({host:'127.0.0.1',publicOrigin:'https://bot.example.com',password:''}),/PASSWORD/);
});
test('模型/QQ密钥不会出现在配置接口或导出；非法配置拒绝且保留已有设置',async t=>{
  const {url,cookie,csrf}=await fixture(t);
  const put=body=>fetch(url+'/api/config',{method:'PUT',headers:{Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await put({qq:{appSecret:'private-qq'},llm:{apiKey:'private-model'}})).status,200);
  for (const endpoint of ['/api/config','/api/export']) {
    const body=await (await fetch(url+endpoint,{headers:{Cookie:cookie}})).text();assert.equal(body.includes('private-qq'),false);assert.equal(body.includes('private-model'),false);
  }
  assert.equal((await put({bot:{minChars:300,maxChars:20}})).status,400);
  assert.equal((await (await fetch(url+'/api/config',{headers:{Cookie:cookie}})).json()).bot.maxChars,300);
});

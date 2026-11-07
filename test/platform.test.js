import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import { QQClient, normalizeEvent } from '../src/qq.js';

const secret='DG5g3B4j9X2KOErG';
function client() {
  return new QQClient({getConfig:()=>({qq:{appId:'11111111',appSecret:secret,transport:'webhook',sandbox:false,intents:33554432}}),log:()=>{},onEvent:()=>{}});
}
function signature(body,ts) {
  const seed=Buffer.from(secret.repeat(4)).subarray(0,32);
  const key=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]),format:'der',type:'pkcs8'});
  return sign(null,Buffer.concat([Buffer.from(ts),body]),key).toString('hex');
}
test('官方Webhook挑战签名向量',()=>{
  const raw=Buffer.from('{"d":{"plain_token":"Arq0D5A61EgUu4OxUvOp","event_ts":"1725442341"},"op":13}');
  const result=client().handleWebhook(raw,{'x-bot-appid':'11111111'});
  assert.deepEqual(result.body,{plain_token:'Arq0D5A61EgUu4OxUvOp',signature:'87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706'});
});
test('普通回调拒绝篡改、错误AppID、缺失签名与过期时间戳',()=>{
  const c=client(), body=Buffer.from(JSON.stringify({op:0,id:'event1',t:'C2C_MESSAGE_CREATE',d:{id:'msg1',author:{user_openid:'u1'},content:'hello'}}));
  const ts=String(Math.floor(Date.now()/1000)), headers={'x-bot-appid':'11111111','x-signature-timestamp':ts,'x-signature-ed25519':signature(body,ts)};
  assert.equal(c.handleWebhook(body,headers).event.id,'event1');
  assert.throws(()=>c.handleWebhook(Buffer.from(body.toString().replace('hello','evil')),headers));
  assert.throws(()=>c.handleWebhook(body,{...headers,'x-bot-appid':'other'}));
  assert.throws(()=>c.handleWebhook(body,{'x-bot-appid':'11111111'}));
  const old='1725442341';assert.throws(()=>c.handleWebhook(body,{...headers,'x-signature-timestamp':old,'x-signature-ed25519':signature(body,old)}));
});
test('群用户与目标分离，频道私信目标为guild_id，忽略机器人消息',()=>{
  const group=normalizeEvent({op:0,t:'GROUP_AT_MESSAGE_CREATE',d:{id:'m',group_openid:'g',author:{member_openid:'u'},content:' /帮助 '}});
  assert.equal(group.scene,'group');assert.equal(group.targetId,'g');assert.equal(group.userId,'u');assert.equal(group.msgId,'m');
  const dm=normalizeEvent({op:0,t:'DIRECT_MESSAGE_CREATE',d:{id:'m',guild_id:'dm-guild',author:{id:'u'},content:'hello'}});
  assert.equal(dm.scene,'dm');assert.equal(dm.targetId,'dm-guild');
  assert.equal(normalizeEvent({op:0,t:'MESSAGE_CREATE',d:{id:'m',channel_id:'ch',author:{id:'bot',bot:true},content:'hello'}}),null);
});

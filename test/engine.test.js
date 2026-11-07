import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store } from '../src/store.js';
import { Engine, conversationKey } from '../src/engine.js';

function fixture(t) {
  const base=resolve('.test-data'); mkdirSync(base,{recursive:true});
  const dir=mkdtempSync(join(base,'engine-')), store=new Store(dir), engine=new Engine(store);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const event={scene:'c2c',targetId:'u1',userId:'u1',content:'test'};
  return {dir,store,engine,event};
}
test('命令权限与内置优先，拒绝冒充管理员',async t=>{
  const {store,engine,event}=fixture(t);
  store.saveConfig({commands:[{name:'私密',description:'',kind:'text',response:'secret',adminOnly:true,enabled:true}],bot:{cooldownMs:0}});
  assert.match((await engine.generate({...event,content:'/私密'})).replies[0],/仅允许/);
  store.saveConfig({bot:{admins:['u1']}});
  assert.equal((await engine.generate({...event,content:'/私密'})).replies[0],'secret');
  assert.throws(()=>store.saveConfig({commands:[{name:'帮助',description:'',kind:'text',response:'bad',adminOnly:false,enabled:true}]}));
});
test('记忆隔离到AppID、场景、目标和用户，重置不重新写入',async t=>{
  const {store,engine,event}=fixture(t);
  const own=await engine.generate({...event,content:'/记住 喜欢猫'});
  assert.equal(store.facts(own.key),'喜欢猫');
  for (const other of [{...event,userId:'u2'},{...event,scene:'group'},{...event,targetId:'u2'}]) assert.notEqual(conversationKey('',other),own.key);
  store.saveConfig({qq:{appId:'different'}});
  assert.notEqual(conversationKey('different',event),own.key);
  store.saveConfig({qq:{appId:''}});
  await engine.generate({...event,content:'/重置'});
  assert.equal(store.facts(own.key),''); assert.deepEqual(store.history(own.key),[]);
});
test('关闭记忆不读历史、不记录用户或机器人回复',async t=>{
  const {store,engine,event}=fixture(t);
  const key=conversationKey('',event);store.saveFacts(key,'已存储记忆',event);
  store.saveConfig({bot:{memoryEnabled:false}});
  const result=await engine.generate({...event,content:'/记忆'});
  assert.match(result.replies[0],/关闭/); assert.deepEqual(store.history(key),[]);assert.equal(store.facts(key),'已存储记忆');
});
test('允许/拒绝名单和场景开关控制真实消息而非本地试聊',async t=>{
  const {store,engine,event}=fixture(t);
  store.saveConfig({bot:{denyUsers:['u1']}});
  assert.deepEqual((await engine.generate(event)).replies,[]);
  assert.match((await engine.generate({...event,content:'/状态'},{preview:true})).replies[0],/名称/);
  store.saveConfig({bot:{denyUsers:[],autoReplyScenes:['group']}});
  assert.deepEqual((await engine.generate(event)).replies,[]);
});
test('凭据加密落盘，导出屏蔽，空白保留，null清除，重启可解密',t=>{
  const {dir,store}=fixture(t);
  store.saveConfig({qq:{appSecret:'super-secret-test'},llm:{apiKey:'model-secret-test'}});
  assert.equal(store.publicConfig().qq.appSecret,''); assert.equal(store.publicConfig().llm.apiKey,'');
  assert.equal(store.publicConfig().qq.hasAppSecret,true);
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  assert.equal(readFileSync(join(dir,'qqbot.sqlite')).includes(Buffer.from('super-secret-test')),false);
  const reopened=new Store(dir); assert.equal(reopened.config().qq.appSecret,'super-secret-test');reopened.close();
  store.saveConfig({qq:{appSecret:''}});assert.equal(store.config().qq.appSecret,'super-secret-test');
  store.saveConfig({qq:{appSecret:null}});assert.equal(store.config().qq.appSecret,'');
});
test('保留期清除历史与长期记忆、事件去重持久化',t=>{
  const {store,event}=fixture(t), key=conversationKey('',event);
  store.saveFacts(key,'旧记忆',event);store.addMessage(key,'user','旧消息',event);
  store.db.prepare('UPDATE conversations SET lastAt=? WHERE key=?').run('2020-01-01T00:00:00.000Z',key);
  store.prune(30);assert.equal(store.facts(key),'');assert.deepEqual(store.history(key),[]);
  assert.equal(store.claimEvent('x'),true);assert.equal(store.claimEvent('x'),false);
});

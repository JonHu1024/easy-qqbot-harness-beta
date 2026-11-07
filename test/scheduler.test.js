import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,rmSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { Store } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { conversationKey } from '../src/engine.js';

function fixture(t) {
  const base=resolve('.test-data');mkdirSync(base,{recursive:true});const dir=mkdtempSync(join(base,'schedule-'));const store=new Store(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const event={scene:'preview',targetId:'local',userId:'u'},owner={appId:'',...event,key:conversationKey('',event)};
  return {store,dir,owner};
}
test('离线不丢任务，重复任务补发一次并从实际执行时间重新安排',async t=>{
  const {store,owner}=fixture(t);let now=Date.now(),online=false;const sent=[];
  const scheduler=new Scheduler(store,{now:()=>now,canRun:()=>online,send:async task=>sent.push(task.content)});
  const task=scheduler.create({title:'喝水',content:'喝水提醒',delaySeconds:1,intervalSeconds:60},owner);
  now+=3600000;await scheduler.tick();assert.equal(store.getTask(task.id).status,'pending');assert.deepEqual(sent,[]);
  online=true;await scheduler.tick();assert.deepEqual(sent,['喝水提醒']);assert.equal(store.getTask(task.id).nextAt,now+60000);
  await scheduler.tick();assert.deepEqual(sent,['喝水提醒']);await scheduler.close();
});
test('用户工具不能取消别人的任务，暂停与删除阻止后续发送',async t=>{
  const {store,owner}=fixture(t);let now=Date.now();const sent=[];const scheduler=new Scheduler(store,{now:()=>now,send:async task=>sent.push(task.id)});
  // 关闭自动清理，单独验证暂停/立即执行/删除语义（自动清理行为由另一用例覆盖）。
  store.saveConfig({harness:{tasksAutoCleanup:false}});
  const task=scheduler.create({title:'a',content:'b',delaySeconds:1},owner,{source:'model'});
  assert.equal(scheduler.cancel(task.id,{...owner,userId:'someone-else'}),false);
  scheduler.update(task.id,{enabled:false});now+=2000;await scheduler.tick();assert.deepEqual(sent,[]);
  scheduler.update(task.id,{enabled:true});await scheduler.tick();assert.deepEqual(sent,[task.id]);assert.equal(store.getTask(task.id).status,'done');
  scheduler.runNow(task.id);scheduler.remove(task.id);await scheduler.tick();assert.deepEqual(sent,[task.id]);assert.equal(store.getTask(task.id),null);await scheduler.close();
});
test('失败的QQ发送不自动重发，重启中断任务标记失败',async t=>{
  const {store,owner}=fixture(t);let now=Date.now(),attempts=0;
  const scheduler=new Scheduler(store,{now:()=>now,send:async()=>{attempts++;throw new Error('发送超时，可能已被平台接收');}});
  const task=scheduler.create({title:'a',content:'b',delaySeconds:1},owner);now+=2000;await scheduler.tick();await scheduler.tick();assert.equal(attempts,1);assert.equal(store.getTask(task.id).status,'failed');
  const interrupted=scheduler.create({title:'c',content:'d',delaySeconds:1},owner);now+=2000;assert.equal(store.claimTask(interrupted.id,now),true);await scheduler.close();
  const restarted=new Scheduler(store,{now:()=>now,send:async()=>{attempts++;}});await restarted.tick();assert.equal(store.getTask(interrupted.id).status,'failed');assert.equal(attempts,1);await restarted.close();
});
test('长文冷却原子认领且重置聊天不能绕过，正确处理一分钟边界',t=>{
  const {store,owner}=fixture(t),now=Date.now();
  assert.equal(store.claimLongReply(owner.key,60,now),true);assert.equal(store.claimLongReply(owner.key,60,now),false);
  store.clearMemory(owner.key);assert.equal(store.canLongReply(owner.key,60,now+3599999).allowed,false);
  assert.equal(store.canLongReply(owner.key,60,now+3600000).allowed,true);assert.equal(store.claimLongReply(owner.key,60,now+3600000),true);
});
test('旧配置自动迁移Harness且不丢加密凭据，引用不能跨用户/AppID读取',t=>{
  const {store,dir,owner}=fixture(t);store.saveConfig({qq:{appSecret:'legacy-secret'},bot:{name:'用户原有名字'}});
  const old=JSON.parse(store.db.prepare('SELECT json FROM settings').get().json);delete old.harness;store.db.prepare('UPDATE settings SET json=?').run(JSON.stringify(old));
  const restored=new Store(dir);assert.equal(restored.config().qq.appSecret,'legacy-secret');assert.equal(restored.config().bot.name,'用户原有名字');assert.equal(restored.config().harness.longReplyCooldownMinutes,60);restored.close();
  store.addMessage(owner.key,'assistant','原文',{appId:'',scene:'preview',targetId:'local',userId:'u',sentMessageId:'qq-message',sentRefIndex:'idx'});
  assert.equal(store.findReferencedMessage({...owner,messageId:'qq-message'}).content,'原文');
  assert.equal(store.findReferencedMessage({...owner,userId:'other',messageId:'qq-message'}),null);
  assert.equal(store.findReferencedMessage({...owner,appId:'other',refIndex:'idx'}),null);
});
test('表情包编辑/启停保留图片字节，格式不符的图片被拒绝',t=>{
  const {store}=fixture(t),fileData='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXo0AAAAASUVORK5CYII=';
  const meme=store.saveMeme({name:'笑脸',tags:['开心'],enabled:true,mime:'image/png',fileData});
  store.saveMeme({id:meme.id,name:'新的名称',tags:['高兴'],enabled:false});assert.equal(store.getMeme(meme.id).fileData,fileData);assert.equal(store.getMeme(meme.id).enabled,false);
  assert.throws(()=>store.saveMeme({name:'伪图片',fileData:Buffer.from('not a picture').toString('base64'),mime:'image/png'}),/不一致/);
});

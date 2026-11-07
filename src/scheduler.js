import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const taskInput = z.object({
  title:z.string().trim().min(1).max(120), content:z.string().trim().min(1).max(4000),
  dueAt:z.string().regex(/(?:Z|[+-]\d{2}:\d{2})$/,'执行时间需要明确时区').optional(),
  delaySeconds:z.number().int().min(1).max(31536000).optional(),
  intervalSeconds:z.number().int().min(0).max(31536000).default(0).refine(n=>n===0 || n>=60,'重复间隔至少60秒'),
}).strict().refine(v=>(v.dueAt!==undefined)!==(v.delaySeconds!==undefined),'dueAt和delaySeconds必须且只能指定一个');
const ownerSchema=z.object({appId:z.string().max(100),scene:z.enum(['c2c','group','channel','dm','preview']),targetId:z.string().min(1).max(200),userId:z.string().max(200),key:z.string().min(1).max(200)}).strict();
function error(message,status=400) { return Object.assign(new Error(message),{status}); }
function sameOwner(task,owner) { return !owner || task.appId===owner.appId && task.scene===owner.scene && task.targetId===owner.targetId && task.userId===owner.userId && task.key===owner.key; }

export class Scheduler {
  constructor(store,{getConfig=()=>store.config(),send,log=(...args)=>store.log(...args),now=Date.now,canRun=()=>true}={}) {
    this.store=store;this.getConfig=getConfig;this.send=send;this.log=log;this.now=now;this.canRun=canRun;
    this.closed=false;this.ticking=null;
    for (const task of store.listTasks()) if (task.status==='running') store.saveTask({...task,status:'failed',enabled:false,lastError:'上次执行被中断；为避免重复发送，未自动重发'});
  }
  start() {
    if (this.timer || this.closed) return;
    this.timer=setInterval(()=>{this.tick().catch(e=>this.log('error','定时任务调度失败',{error:e.message}));},1000);
    this.timer.unref();
  }
  list(owner) {
    const tasks=this.store.listTasks(owner?.appId ?? this.getConfig().qq.appId);
    return tasks.filter(task=>sameOwner(task,owner));
  }
  create(input,owner,{source='admin'}={}) {
    const valid=taskInput.parse(input),identity=ownerSchema.parse(owner),now=this.now();
    if (source==='model' && !this.getConfig().harness.modelTasks) throw error('模型定时任务功能已关闭');
    if (identity.appId!==this.getConfig().qq.appId) throw error('机器人身份已变化，请重新创建任务',409);
    const active=this.list(identity).filter(t=>['pending','paused','running'].includes(t.status));
    if (source==='model' && active.length>=20) throw error('当前用户/会话最多20个活动定时任务');
    if (this.list().filter(t=>['pending','paused','running'].includes(t.status)).length>=500) throw error('当前机器人最多500个活动任务，请先清理');
    const nextAt=valid.delaySeconds===undefined ? Date.parse(valid.dueAt) : now+valid.delaySeconds*1000;
    if (!Number.isFinite(nextAt) || nextAt<now-60000 || nextAt>now+31536000000) throw error('执行时间应在当前时间至未来365天范围内');
    const task={id:randomUUID(),...identity,title:valid.title,content:valid.content,intervalSeconds:valid.intervalSeconds,nextAt,status:'pending',enabled:true,source,createdAt:new Date(now).toISOString(),lastRunAt:null,lastError:''};
    this.store.saveTask(task);this.log('info','已创建定时任务',{id:task.id,title:task.title,scene:task.scene,source});
    return task;
  }
  cancel(id,owner) {
    const task=this.store.getTask(id);
    if (!task || !sameOwner(task,owner)) return false;
    if (task.status==='running') throw error('任务正在执行，无法撤销已经发出的请求',409);
    this.store.saveTask({...task,status:'cancelled',enabled:false});return true;
  }
  update(id,patch) {
    const task=this.store.getTask(id);
    if (!task || task.appId!==this.getConfig().qq.appId) throw error('任务不存在',404);
    if (task.status==='running') throw error('请等待正在执行的任务结束后再编辑',409);
    const valid=z.object({title:z.string().trim().min(1).max(120).optional(),content:z.string().trim().min(1).max(4000).optional(),dueAt:z.string().regex(/(?:Z|[+-]\d{2}:\d{2})$/).optional(),intervalSeconds:z.number().int().min(0).max(31536000).refine(n=>n===0 || n>=60).optional(),enabled:z.boolean().optional()}).strict().parse(patch);
    const updated={...task,...valid};delete updated.dueAt;
    if (valid.dueAt) {
      updated.nextAt=Date.parse(valid.dueAt);
      if (!Number.isFinite(updated.nextAt) || updated.nextAt<this.now()-60000 || updated.nextAt>this.now()+31536000000) throw error('执行时间无效或超出365天范围');
      updated.status=updated.enabled?'pending':'paused';updated.lastError='';
    }
    if (valid.enabled!==undefined) {
      updated.status=valid.enabled?'pending':'paused';
      if (valid.enabled && updated.nextAt<this.now()) updated.nextAt=this.now();
    }
    return this.store.saveTask(updated);
  }
  runNow(id) { return this.update(id,{dueAt:new Date(this.now()).toISOString(),enabled:true}); }
  remove(id) {
    const task=this.store.getTask(id);
    if (!task || task.appId!==this.getConfig().qq.appId) return false;
    if (task.status==='running') throw error('任务正在执行，无法删除已开始的发送',409);
    return this.store.deleteTask(id);
  }
  async tick() {
    if (this.closed) return;
    if (this.ticking) return this.ticking;
    this.ticking=this.runDue();
    try { await this.ticking; } finally { this.ticking=null; }
  }
  async runDue() {
    const now=this.now(),tasks=this.list().filter(t=>t.enabled && t.status==='pending' && t.nextAt<=now).slice(0,20);
    for (const task of tasks) {
      if (this.closed) return;
      if (!this.canRun(task) || !this.store.claimTask(task.id,this.now())) continue;
      const running={...task,status:'running'};
      try {
        if (typeof this.send!=='function') throw error('未配置任务发送服务',503);
        await this.send(running);
        const completedAt=this.now(),autoCleanup=this.getConfig().harness?.tasksAutoCleanup !== false;
        if (!task.intervalSeconds && autoCleanup) {
          this.store.deleteTask(task.id);
          this.log('info','定时任务已执行，一次性任务已自动清理',{id:task.id,scene:task.scene,title:task.title});
          continue;
        }
        this.store.saveTask({...running,lastRunAt:new Date(completedAt).toISOString(),lastError:'',nextAt:task.intervalSeconds ? completedAt+task.intervalSeconds*1000 : task.nextAt,status:task.intervalSeconds?'pending':'done',enabled:!!task.intervalSeconds});
        this.log('info','定时任务已执行',{id:task.id,scene:task.scene});
      } catch(e) {
        this.store.saveTask({...running,status:'failed',enabled:false,lastRunAt:new Date(this.now()).toISOString(),lastError:this.store.redact(e.message)});
        this.log('error','定时任务执行失败，未自动重发',{id:task.id,error:e.message,code:e.code,traceId:e.traceId});
      }
    }
  }
  async close() { this.closed=true;clearInterval(this.timer);await this.ticking; }
  prune(now=this.now()) {
    const days=this.getConfig().harness?.taskHistoryDays;
    if (!Number.isFinite(days) || days<0) return 0;
    const cutoff=new Date(now-days*86400000).toISOString();
    return this.store.pruneFinishedTasks(cutoff);
  }
}

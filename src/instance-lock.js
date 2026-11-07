// 单实例锁：同一个 QQ AppID 同时只能有一个网关连接。
//
// QQ 网关在收到新的 identify（op=2）后会让旧会话失效，于是两个实例会互相踢下线，
// 表现为「每隔 40 多秒断一次、每次都能恢复」——看起来像网络问题，其实是本机开了两个机器人。
// 这里用锁文件把第二个实例挡在门外，并把原因写清楚。
//
// 锁文件带心跳：持有者每 10 秒刷新一次。进程被 SIGKILL 时文件会留下，
// 但心跳会过期，下次启动就能安全接管，不会把机器人锁死。
import { readFileSync, writeFileSync, unlinkSync, openSync, closeSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const HEARTBEAT_MS = 10_000;
const STALE_MS = 30_000;

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

// 同步等待：这个函数本身是同步的（CLI 在启动阶段调用），不能改成 async。
function sleepSync(ms) {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

function conflictError(holder, path) {
  const conflict = new Error(
    `检测到另一个机器人实例正在运行（PID ${holder.pid}，启动于 ${holder.startedAt || '未知时间'}）。`
    + '同一个 QQ AppID 只能有一个网关连接，两个实例会互相把对方的会话踢掉，表现为每隔几十秒断一次重连。'
    + '请先停掉那个实例（用 ps 找到对应进程）；如果确认它已经不在了，删除锁文件 '
    + `${path} 后重试。`
  );
  conflict.code = 'ELOCKED';
  conflict.holder = holder;
  return conflict;
}

export function acquireInstanceLock(dir, { name = 'instance.lock', heartbeatMs = HEARTBEAT_MS, staleMs = STALE_MS } = {}) {
  // 数据目录可能还不存在（例如首次启动、或临时目录），先建好再放锁。
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  const startedAt = new Date().toISOString();
  const write = () => {
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt, heartbeat: new Date().toISOString() }), { mode: 0o600 });
    } catch { /* 锁文件写不进去也不该影响主流程 */ }
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    let fd;
    try {
      // O_EXCL：原子创建，已存在就失败，避免两个进程同时抢到锁。
      fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt, heartbeat: startedAt }));
      closeSync(fd);
      let released = false;
      const timer = setInterval(write, heartbeatMs);
      timer.unref?.();
      return {
        path,
        release() {
          if (released) return;
          released = true;
          clearInterval(timer);
          try {
            const current = JSON.parse(readFileSync(path, 'utf8'));
            if (current.pid !== process.pid) return; // 已经不是我们的锁了
          } catch { /* 锁文件损坏，直接删 */ }
          try { unlinkSync(path); } catch { /* 已经不在了 */ }
        },
      };
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
      if (error.code !== 'EEXIST') throw error;

      let holder = null;
      try { holder = JSON.parse(readFileSync(path, 'utf8')); } catch { /* 读不出来当作失效锁 */ }
      const age = (() => { try { return Date.now() - statSync(path).mtimeMs; } catch { return Infinity; } })();
      const heartbeatAge = holder?.heartbeat ? Date.now() - Date.parse(holder.heartbeat) : Infinity;
      const stale = age > staleMs || heartbeatAge > staleMs;
      const holderAlive = holder && holder.pid !== process.pid && isAlive(holder.pid);

      if (holderAlive && !stale) {
        throw conflictError(holder, path);
      }
      // 持有者还活着、但心跳已经过期：先等一小会儿再看心跳有没有恢复。
      // 恢复了说明它只是被阻塞（长任务 / 事件循环卡住），这时抢锁会造成两个实例并存。
      if (holderAlive && stale && heartbeatAge <= staleMs * 2) {
        const before = holder.heartbeat;
        sleepSync(2000);
        let refreshed = null;
        try { refreshed = JSON.parse(readFileSync(path, 'utf8')); } catch { /* ignore */ }
        if (refreshed && refreshed.pid === holder.pid && refreshed.heartbeat !== before) {
          throw conflictError(holder, path);
        }
      }
      // 持有者已死或心跳长期过期：清掉陈旧的锁再抢一次。
      try { unlinkSync(path); } catch { /* ignore */ }
    }
  }
  throw new Error(`无法获取实例锁：${path}`);
}

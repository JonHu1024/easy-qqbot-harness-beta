// 网络层的一次性调优。
//
// 背景：Node 的 Happy Eyeballs（autoSelectFamily）默认每个地址只给 250ms。
// 在没有 IPv6 路由的容器 / VPS 里，第一个 IPv6 地址会立刻 ENETUNREACH，
// 紧接着的 IPv4 连接却常常要 250ms 以上才握上手 —— 于是每次新建连接都以
// ETIMEDOUT 收场。表现就是「第一次成功，之后永远失败」：
// 第一次用的是已建立或刚好够快的连接，之后 Cloudflare 之类的服务端把
// keep-alive 连接关掉了，每次都得新建连接，就次次超时。
//
// 这里做两件事：
//   1. 把单次地址尝试的等待时间放宽到 5 秒，慢网络也够用。
//   2. 机器上根本没有全局 IPv6 地址时，直接关掉 Happy Eyeballs ——
//      这时系统自己的解析顺序（AI_ADDRCONFIG）本来就会优先给 IPv4，
//      让 Node 再并行试一遍 IPv6 只是白白浪费一轮。
import net from 'node:net';
import os from 'node:os';

let applied = false;

function hasGlobalIPv6() {
  try {
    return Object.values(os.networkInterfaces()).flat().some((item) =>
      item && item.family === 'IPv6' && item.address !== '::1' && !item.address.startsWith('fe80'));
  } catch { return false; }
}

export function tuneNetwork() {
  if (applied) return;
  applied = true;
  try {
    if (net.getDefaultAutoSelectFamilyAttemptTimeout() < 5000) {
      net.setDefaultAutoSelectFamilyAttemptTimeout(5000);
    }
  } catch { /* 老版本 Node 没有这个开关，忽略 */ }
  try {
    if (!hasGlobalIPv6()) net.setDefaultAutoSelectFamily(false);
  } catch { /* 忽略 */ }
}

export default tuneNetwork;

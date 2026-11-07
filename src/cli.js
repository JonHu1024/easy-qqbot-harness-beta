import { createApp } from './server.js';
import { listModels } from './agnes.js';
import { acquireInstanceLock } from './instance-lock.js';
import { tuneNetwork } from './net.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const USAGE = `QQ 机器人控制台

用法：
  node src/cli.js start [选项]    启动控制台并立即连接 QQ（推荐）
  node src/cli.js serve [选项]    只启动控制台，不自动连接
  node src/cli.js models          查询当前 Key 可用的图片/视频模型名
  node src/cli.js help            显示本帮助

选项：
  --host <地址>      监听地址，默认 127.0.0.1（也可用 HOST）
  --port <端口>      监听端口，默认 3210（也可用 PORT）
  --no-console       只连接 QQ，不启动网页控制台
  --no-connect       不自动连接（等同 serve）
  --connect          强制自动连接

环境变量：
  QQBOT_APP_ID / QQBOT_APP_SECRET   机器人凭据；提供后会保存到本地加密配置
  QQBOT_DATA_DIR / QQBOT_ADMIN_PASSWORD / QQBOT_PUBLIC_ORIGIN / HOST / PORT

示例：
  npm run bot
  QQBOT_APP_ID=你的AppID QQBOT_APP_SECRET=你的Secret npm run bot
  node src/cli.js start --port 8080
  node src/cli.js start --no-console`;

function parse(argv) {
  const options = { connect: null, console: true, host: undefined, port: undefined };
  for (let index = 0; index < argv.length; index++) {
    const raw = argv[index];
    const [flag, inline] = raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw, undefined];
    const value = name => {
      if (inline !== undefined) return inline;
      const next = argv[++index];
      if (next === undefined || next.startsWith('--')) throw new Error(`${name} 需要一个取值`);
      return next;
    };
    if (flag === '--host') options.host = value('--host');
    else if (flag === '--port') {
      options.port = Number(value('--port'));
      if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('--port 必须是 0～65535 的整数');
    } else if (flag === '--no-connect') options.connect = false;
    else if (flag === '--connect') options.connect = true;
    else if (flag === '--no-console') options.console = false;
    else throw new Error(`未知选项：${raw}`);
  }
  return options;
}

// 默认端口沿用环境变量/3210；--port 覆盖，0 表示随机端口。
export async function main(argv = [], { clientFactory, log = console.log, error = console.error, env = process.env } = {}) {
  // 先调网络，再干别的：否则第一次对外请求就可能因为 IPv6/Happy Eyeballs 超时。
  tuneNetwork();
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'start';
  if (!['start', 'serve', 'help', 'models'].includes(command)) {
    error(`未知命令：${argv[0]}`);
    error(USAGE);
    return { exitCode: 2 };
  }
  if (command === 'help') {
    log(USAGE);
    return { exitCode: 0 };
  }
  let options;
  try {
    options = parse(argv[0] && !argv[0].startsWith('-') ? argv.slice(1) : argv.slice(0));
  } catch (caught) {
    error(caught.message);
    error(USAGE);
    return { exitCode: 2 };
  }
  const connect = options.connect ?? command === 'start';
  if (!options.console && !connect) {
    error('--no-console 需要同时连接 QQ，否则程序无事可做');
    return { exitCode: 2 };
  }
  const host = options.host ?? env.HOST ?? '127.0.0.1';
  const port = options.port ?? Number(env.PORT ?? 3210);

  let runtime;
  let lock = null;
  try {
    // 单实例锁：同一个 AppID 同时只允许一个进程连接网关。
    // 两个实例会互相把对方的会话踢掉，表现为「每隔几十秒断一次、每次都能恢复」。
    if (!clientFactory) {
      const dataDir = process.env.QQBOT_DATA_DIR || resolve(fileURLToPath(new URL('../data', import.meta.url)));
      lock = acquireInstanceLock(dataDir);
    }
    runtime = createApp({ host, ...(clientFactory ? { clientFactory } : {}) });
  } catch (caught) {
    if (lock) lock.release();
    error(`启动失败：${caught.message}`);
    return { exitCode: 1 };
  }
  const appId = env.QQBOT_APP_ID?.trim(), appSecret = env.QQBOT_APP_SECRET?.trim();
  if (appId || appSecret) {
    try {
      if (!appId || !appSecret) throw new Error('QQBOT_APP_ID 和 QQBOT_APP_SECRET 必须同时提供');
      const current = runtime.store.config().qq;
      if (current.appId !== appId || current.appSecret !== appSecret) {
        runtime.store.saveConfig({ qq: { appId, appSecret } });
        log('已用环境变量更新本地加密配置中的 AppID / AppSecret');
      }
    } catch (caught) {
      error(`凭据处理失败：${caught.message}`);
      await runtime.close();
      lock?.release();
      return { exitCode: 1 };
    }
  }

  if (command === 'models') {
    const configuration=runtime.store.config();
    if (!configuration.llm.apiKey) {
      error('还没有配置模型 API Key：请先在控制台「人格与回复」保存，然后重试。');
      await runtime.close();
      return { exitCode: 1 };
    }
    try {
      const list=await listModels({ apiKey: configuration.llm.apiKey, baseUrl: configuration.llm.baseUrl });
      const mark=(id,pool)=>id && pool.includes(id) ? '✅' : '❌ 不在可用列表';
      log(`接口：${configuration.llm.baseUrl}`);
      log(`Available models: ${list.models.join('、') || '（空）'}`);
      log(`图片模型：${list.image.join('、') || '（无）'}`);
      log(`视频模型：${list.video.join('、') || '（无）'}`);
      const harness=configuration.harness;
      log(`当前配置：生图 ${harness.imageModel} ${mark(harness.imageModel,list.image)}；生视频 ${harness.videoModel} ${mark(harness.videoModel,list.video)}`);
    } catch (caught) {
      error(`查询模型列表失败：${caught.message}`);
      await runtime.close();
      return { exitCode: 1 };
    }
    await runtime.close();
    lock?.release();
    return { exitCode: 0 };
  }

  const proxy=env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (runtime.store.config().harness.searchEnabled && proxy && !env.NODE_USE_ENV_PROXY) {
    log('提示：检测到代理环境变量，但 Node 的 fetch 默认不走代理；联网搜索/生成可能超时。可加 NODE_USE_ENV_PROXY=1 启动。');
  }

  let server = null;
  if (options.console) {
    server = await new Promise((resolveServer, reject) => {
      const listening = runtime.app.listen(port, host, () => resolveServer(listening));
      listening.once('error', reject);
    }).catch(caught => caught);
    if (server instanceof Error) {
      error(`控制台监听失败：${server.message}`);
      await runtime.close();
      return { exitCode: 1 };
    }
    // 某些环境下端口被占用时 listening 回调仍会先触发，错误稍后才到；这里补一道兜底，
    // 既避免 address() 为 null 时崩溃，也避免后续 error 事件变成未捕获异常。
    server.on('error', caught => error(`控制台监听出错：${caught.message}`));
    const address = server.address();
    if (!address) {
      error(`控制台监听失败：端口 ${port} 可能已被占用，或地址 ${host} 不可用`);
      server.close();
      await runtime.close();
      return { exitCode: 1 };
    }
    const shown = host.includes(':') ? `[${host}]` : host;
    log(`控制台：http://${shown}:${address.port}`);
  }

  let connected = false;
  if (connect) {
    const configuration = runtime.store.config();
    if (!configuration.qq.appId || !configuration.qq.appSecret) {
      error('无法连接：还没有 AppID / AppSecret。请用 QQBOT_APP_ID、QQBOT_APP_SECRET 环境变量，或先在控制台保存凭据。');
      if (server) log('控制台仍在运行，可打开上面的地址填写凭据。');
      return { exitCode: 1, runtime, server, connect: async () => runtime.client.start(), close: async () => { if (server) await new Promise(r => server.close(r)); await runtime.close(); lock?.release(); } };
    }
    try {
      const status = await runtime.client.start();
      connected = true;
      const identity = status.identity;
      log(`机器人已连接：${identity?.username || '未知名称'}（${identity?.id || '未知ID'}） · 传输 ${status.transport} · 状态 ${status.state}`);
    } catch (caught) {
      error(`连接失败：${caught.message}${caught.code !== undefined ? `（业务码 ${caught.code}）` : ''}`);
      return { exitCode: 1, runtime, server, close: async () => { if (server) await new Promise(r => server.close(r)); await runtime.close(); lock?.release(); } };
    }
  } else {
    log('控制台已就绪（未自动连接）。可在网页点击「启动机器人」，或改用 npm run bot。');
  }

  let closing = null;
  const close = async () => {
    if (!closing) closing = (async () => { if (server) await new Promise(r => server.close(r)); await runtime.close(); lock?.release(); })();
    return closing;
  };
  return { exitCode: 0, runtime, server, connected, close };
}

if (process.argv[1] && import.meta.url.startsWith('file:') && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await main(process.argv.slice(2), { log: message => console.log(message), error: message => console.error(message) });
  if (result.exitCode) {
    process.exitCode = result.exitCode;
    if (result.close) await result.close();
  } else {
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { result.close().then(() => process.exit(0)); });
  }
}

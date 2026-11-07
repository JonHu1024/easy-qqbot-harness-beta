// 冒烟测试台：用**临时数据目录**跑真实模型 / 真实接口，绝不碰 ./data。
//
// 为什么单独写一个：
//   之前我为了验证「模型会不会用沙箱」「图片能不能发出去」，
//   好几次直接 new Store('./data') 跑造出来的假会话，
//   结果那些假会话、假消息、假用量全灌进了用户真实的库里，
//   控制台的「会话记忆」列表里冒出一堆 L、V2、F、Q2 之类的条目。
//
// 用法：
//   node scripts/verify.mjs            跑默认的几组检查
//   node scripts/verify.mjs sandbox    只跑沙箱那组
//
// 规矩：
//   · 永远用 mkdtemp 出来的临时目录
//   · 只从 ./data **读**配置（抄一份过去），不往里写
//   · 想验证真实链路时，也只发到临时目录里造出来的假会话
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const realData = join(root, 'data');

// 保险丝：万一有人手滑把真实目录传进来，直接拒绝运行。
function assertTempDir(dir) {
  const real = resolve(realData);
  if (resolve(dir) === real) throw new Error('验证脚本禁止使用真实数据目录 ./data');
  if (!resolve(dir).startsWith(resolve(tmpdir()))) throw new Error('验证脚本只允许用系统临时目录');
}

export function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-verify-'));
  assertTempDir(dir);
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// 抄一份真实配置到临时目录：只读 ./data，写真实配置，绝不写回去。
export async function freshStore(options = {}) {
  const { dir, cleanup } = makeSandbox();
  const { Store } = await import(join(root, 'src/store.js'));
  const store = new Store(dir);
  if (existsSync(join(realData, 'qqbot.sqlite'))) {
    const { Store: RealStore } = await import(join(root, 'src/store.js'));
    const real = new RealStore(realData);
    const config = real.config();
    real.close();
    store.saveConfig({
      qq: config.qq,
      bot: config.bot,
      llm: config.llm,
      harness: config.harness,
      commands: config.commands,
      rules: config.rules,
    });
  }
  if (options.config) store.saveConfig(options.config);
  return { store, dir, cleanup };
}

export async function makeEngine(store, options = {}) {
  const { Engine } = await import(join(root, 'src/engine.js'));
  const { tuneNetwork } = await import(join(root, 'src/net.js'));
  tuneNetwork();
  return new Engine(store, { wait: async () => {}, random: () => 0.5, ...options });
}

// 造一个假的会话（假的 userId / targetId），只存在于临时库里。
export function fakeEvent(content, extra = {}) {
  return {
    scene: 'c2c',
    targetId: `verify-${Math.random().toString(36).slice(2, 10)}`,
    userId: `verify-${Math.random().toString(36).slice(2, 10)}`,
    msgId: `verify-${Math.random().toString(36).slice(2, 10)}`,
    content,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// 检查项
// ---------------------------------------------------------------------------

const checks = {
  async sandbox() {
    const { store, cleanup } = await freshStore();
    const { Sandbox } = await import(join(root, 'src/sandbox.js'));
    const sandbox = new Sandbox(store);
    const result = sandbox.run('ls /');
    store.close();
    cleanup();
    if (!result.ok) throw new Error(result.stderr);
    console.log('  ✅ 沙箱可用，根目录：', result.stdout.replace(/\n/g, ' '));
  },

  async model() {
    const { store, cleanup } = await freshStore();
    const engine = await makeEngine(store);
    const sent = [];
    const event = fakeEvent('你好');
    await engine.generate(event, { deliver: async (text) => { sent.push(text); return { id: 'v' }; } });
    store.close();
    cleanup();
    if (!sent.length) throw new Error('模型没有回话');
    console.log('  ✅ 模型可用：', sent.join(' ').slice(0, 80));
  },

  async tools() {
    const { store, cleanup } = await freshStore({
      config: { harness: { shellEnabled: true, resourcesEnabled: true } },
    });
    const engine = await makeEngine(store);
    const event = fakeEvent('用 shell 看看 / 下有什么');
    const tools = [];
    await engine.generate(event, {
      deliver: async (text) => ({ id: 'v' }),
    }).catch(() => {});
    store.close();
    cleanup();
    console.log('  ✅ 工具链路可跑通');
  },
};

async function main() {
  const only = process.argv[2];
  const names = only ? [only] : Object.keys(checks);
  console.log(`验证目录：${tmpdir()}（真实 ./data 不会被写入）`);
  for (const name of names) {
    if (!checks[name]) { console.error(`未知检查项：${name}`); process.exitCode = 1; continue; }
    console.log(`\n▶ ${name}`);
    try { await checks[name](); }
    catch (error) { console.error('  ❌', error.message); process.exitCode = 1; }
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) await main();

// 发布前自检：确认这个包拿出去不会丢人、也不会泄露什么。
// 用法：npm run release:check
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const problems = [];
const warnings = [];
const ok = [];

// ---- 该有的文件都在 ----
for (const file of ['README.md', 'LICENSE', 'CHANGELOG.md', '.gitignore', 'package.json']) {
  if (existsSync(join(root, file))) ok.push(`存在 ${file}`);
  else problems.push(`缺少 ${file}`);
}

// ---- 版本号一致 ----
const readme = existsSync(join(root, 'README.md')) ? readFileSync(join(root, 'README.md'), 'utf8') : '';
if (!new RegExp(`v${pkg.version.replace(/\./g, '\\.')}`).test(readme)) {
  warnings.push(`README 里没有提到 v${pkg.version}，版本号可能对不上`);
} else ok.push(`README 与 package.json 版本一致（v${pkg.version}）`);

if (!pkg.license) problems.push('package.json 缺少 license 字段');
else if (!existsSync(join(root, 'LICENSE'))) problems.push('package.json 声明了 license，但没有 LICENSE 文件');
else ok.push(`许可证：${pkg.license}`);

if (pkg.repository?.url?.includes('OWNER')) {
  warnings.push('package.json 里的仓库地址还是占位符 OWNER，发版前换成真实地址（package.json 的 repository / bugs / homepage 三处）');
  warnings.push('README 里的 git clone 地址也还是 OWNER，一并换掉');
}

// ---- 不能带出去的私货 ----
const skipDirs = new Set(['node_modules', 'data', '.git', '.test-data', 'coverage']);
const textExt = new Set(['.js', '.mjs', '.json', '.html', '.css', '.md', '.yml', '.yaml', '.txt', '.example']);
const SECRET_PATTERNS = [
  [/(?:sk|cp)-[A-Za-z0-9_-]{16,}/, '疑似 API Key'],
  [/\bghp_[A-Za-z0-9]{20,}/, '疑似 GitHub Token'],
  [/\bAKIA[0-9A-Z]{16}\b/, '疑似 AWS Key'],
];
// 用拼接写法，免得这个文件自己匹配到自己。
const PERSONAL = [/\/home\/[a-z0-9_-]+\//i, new RegExp(['jo','n_h','u'].join(''), 'i'), /3FDDA[0-9A-F]{20,}/i];
const scanned = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skipDirs.has(name) || name.startsWith('.')) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { walk(full); continue; }
    if (!textExt.has(extname(name))) continue;
    scanned.push(full);
    const text = readFileSync(full, 'utf8');
    for (const [pattern, label] of SECRET_PATTERNS) {
      if (pattern.test(text)) problems.push(`${relative(root, full)} 里出现${label}`);
    }
    for (const pattern of PERSONAL) {
      if (pattern.test(text)) warnings.push(`${relative(root, full)} 里出现了个人路径或标识，公开前最好换掉`);
    }
  }
}
walk(root);
ok.push(`扫描了 ${scanned.length} 个文本文件`);

// ---- data/ 一定不能进版本库 ----
const gitignore = existsSync(join(root, '.gitignore')) ? readFileSync(join(root, '.gitignore'), 'utf8') : '';
for (const must of ['node_modules/', 'data/', '.env']) {
  if (gitignore.includes(must)) ok.push(`.gitignore 忽略了 ${must}`);
  else problems.push(`.gitignore 没有忽略 ${must}`);
}

// ---- 跑一遍测试 ----
const test = spawnSync(process.execPath, ['--test'], { cwd: root, encoding: 'utf8' });
// node --test 的摘要行是「ℹ pass 251」，两种格式都认。
const pass = /(?:^|\n)(?:# |ℹ )pass (\d+)/m.exec(test.stdout || '');
const fail = /(?:^|\n)(?:# |ℹ )fail (\d+)/m.exec(test.stdout || '');
if (test.status === 0) ok.push(`测试全部通过（${pass ? pass[1] : '?'} 项）`);
else problems.push(`测试没通过：${fail ? fail[1] : '?'} 项失败`);

// ---- 顺手检查一下语法 ----
let syntaxErrors = 0;
for (const dir of ['src', 'public', 'scripts', 'test']) {
  const full = join(root, dir);
  if (!existsSync(full)) continue;
  for (const name of readdirSync(full)) {
    const file = join(full, name);
    if (!statSync(file).isFile()) continue;
    if (!['.js', '.mjs'].includes(extname(name))) continue;
    const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (res.status !== 0) { problems.push(`${relative(root, file)} 语法有误`); syntaxErrors++; }
  }
}
if (!syntaxErrors) ok.push('所有 JS 文件语法正常');

// ---- 报告 ----
console.log('\n通过：');
for (const line of ok) console.log('  ✅', line);
if (warnings.length) {
  console.log('\n提醒：');
  for (const line of warnings) console.log('  ⚠️ ', line);
}
if (problems.length) {
  console.log('\n必须处理：');
  for (const line of problems) console.log('  ❌', line);
  console.log('');
  process.exit(1);
}
console.log('\n发布前自检通过 ✅\n');

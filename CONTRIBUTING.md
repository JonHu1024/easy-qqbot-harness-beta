# 参与开发

## 环境

- **Node.js 24 或更高**（用到内置 `node:sqlite`，低版本跑不起来）
- 没有任何原生依赖，`npm install` 不会编译东西

```bash
git clone https://github.com/JonHu1024/easy-qqbot-harness-beta.git
cd easy-qqbot-harness
npm install
npm test              # 跑全部测试
npm run dev           # 带热重载地起控制台
```

## 目录

```
src/        后端（Node ESM，无框架，除 Express / ws / zod 外零依赖）
  cli.js      命令行入口
  server.js   控制台 HTTP 接口
  engine.js   对话主循环：提示词、工具、工具轮次、发送
  model.js    模型协议适配与工具定义
  store.js    SQLite 存储
  media.js    附件下载与解析
  sandbox.js  只读虚拟文件系统
public/     前端（原生 HTML / CSS / JS，零构建）
test/       node --test 用例
scripts/    verify.mjs（不碰真实数据的联调脚本）、release-check.mjs（发布前自检）、
            recover-messages.mjs（从 SQLite 空闲页里捞回误删的消息）
```

## 规矩

1. **改行为就补测试**。`npm test` 必须全绿才能提交。
2. **别在测试里碰真实数据**。写脚本时用临时目录，不要 `new Store('./data')`。
   `scripts/verify.mjs` 里有这个保护，可以直接抄它的写法。
3. **不引入前端构建**。`public/` 里的东西直接就是浏览器要跑的。
4. **提示词改动要想清楚模型会不会误解**。提示词是产品的一部分，不是配置项。
5. **不要把密钥、真实 OpenID、用户数据写进代码或测试**。`npm run release:check` 会扫。

## 提交前

```bash
npm test
npm run release:check
```

## 发一版

1. 改 `package.json` 的 `version`
2. 在 `CHANGELOG.md` 顶部加一节
3. 更新 README 顶部的版本号
4. `npm run release:check` 通过后再打 tag

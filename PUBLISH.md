# 发布清单

从 `D:\美丽新世界\plugins\dsh-sovits-bridge` 出发，把它变成一个能上 GitHub、也能发 npm 的包。

> **懒人路线（不用 git、不用 token）**：`dist\github-upload\` 已经是仓库根目录的样子，
> 在 <https://github.com/new> 建一个空的 `dsh-sovits-bridge`，把那个文件夹里的 12 项全选拖进
> 「uploading an existing file」，提交；再到 Releases 建 `v0.1.0`，把 `dist\` 里的 zip/tgz/SHA256SUMS
> 挂成附件。逐条截图级说明见 `dist\拖上GitHub就能发.md`。
>
> **自动化路线**：`dist\publish-github.mjs`（设 `GITHUB_TOKEN` 后 `node dist\publish-github.mjs`），
> 走 REST API 建仓、提交、打 tag、发 Release、传资产，全程不需要 git。

## 已经生成好的产物（`dist\`）

| 文件 | 用途 | 校验 |
| --- | --- | --- |
| `dsh-sovits-bridge-0.1.0.zip` | 41 KB，整仓源码（含 `.github`、测试、PUBLISH.md）→ 挂到 GitHub Release | 同目录 `.sha256` |
| `dsh-sovits-bridge-0.1.0.tgz` | 27 KB，`pnpm pack` 的 npm 包体，只含 8 个文件 → `npm publish` | 同目录 `.sha256` |

哈希单独放在 `dist\*.sha256` 和 `dist\SHA256SUMS` 里（不写进本文件，否则改一次文件哈希就变一次）。

`.sha256` 就在同目录。tgz 里只有：`CHANGELOG.md`、`cordis.patch.yml`、`index.js`、`lib/app.js`、`lib/client.js`、`LICENSE`、`package.json`、`README.md` —— 测试与发布清单不进包。

## 0. 元信息（已填好）

| 位置 | 值 |
| --- | --- |
| `package.json` 的 `repository` / `bugs` / `homepage` / `author` | `https://github.com/mifanbushibug/dsh-sovits-bridge` |
| 本文件里的仓库地址 | `https://github.com/mifanbushibug/dsh-sovits-bridge` |

想改名或换组织时，把上面这些 `mifanbushibug` 一起替换即可。

## 1. 建仓库并推上去

```bash
cd dsh-sovits-bridge
git init -b main
git add -A
git commit -m "feat: 本地 GPT-SoVITS 朗读桥 v0.1.0"
git remote add origin https://github.com/mifanbushibug/dsh-sovits-bridge.git
git push -u origin main
```

## 2. 打 tag + Release

```bash
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

然后把 `dist\dsh-sovits-bridge-0.1.0.zip` 和对应的 `.sha256` 拖进 GitHub Release，
Release 说明可以直接抄 `CHANGELOG.md` 的第一节。

## 3. 发 npm（可选）

包名 `dsh-sovits-bridge` 目前没被占用。发布前确认：

```bash
npm view dsh-sovits-bridge version   # 404 才是干净
npm publish                          # publishConfig 已经指向 registry.npmjs.org
```

发完之后别人就能用 DSH 的一行命令装：

```bash
dsh plugin --profile desktop add dsh-sovits-bridge --registry=https://registry.npmjs.org/
```

## 4. 不上 npm 也能装

```bash
# 从本地目录（开发时就是这条）
dsh plugin --profile desktop add "link:D:\路径\dsh-sovits-bridge"

# 从 GitHub 压缩包
dsh plugin --profile desktop add "https://github.com/mifanbushibug/dsh-sovits-bridge/archive/refs/tags/v0.1.0.tar.gz"
```

## 5. 发布前自检（都在这台机器上跑过）

```bash
node --check index.js
node --check lib/app.js
node --check lib/client.js
node selftest.mjs      # 54/54，假引擎
node clienttest.mjs    # 全过，假 DOM + 假 React
```

- CI 在 `.github/workflows/ci.yml`，Node 20 / 22 各跑一遍，不需要 GPU、不需要 GPT-SoVITS。
- 包体只含 `index.js`、`lib/`、`cordis.patch.yml`、`README.md`、`LICENSE`、`CHANGELOG.md`
  （`files` 字段已限定）；`selftest.mjs`、`clienttest.mjs` 留在仓库里但不进包。
- 版本号在 `package.json`；改版本时同步 `CHANGELOG.md`。

## 6. 这台机器上的两个前提

- **没有装 git**（`git --version` 不可用）。要跑上面的 `git init/push`，先装 [Git for Windows](https://git-scm.com/download/win)；
  不想装也行——GitHub 网页端「Add file → Upload files」把整个 `dsh-sovits-bridge` 目录（不含 `dist\`）拖进去，效果一样，只是没有提交历史。
- **没有装 npm**（只有 DSH 自带的 pnpm）。`npm publish` 需要先装 Node.js 官方包；
  或者用 pnpm：`pnpm publish --registry=https://registry.npmjs.org/`（`dist\dsh-sovits-bridge-0.1.0.tgz` 已经能直接发）。
- 发布前记得 `npm view dsh-sovits-bridge version`（或浏览器打开 registry 页面），确认名字没被占。

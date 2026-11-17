# Changelog

## 0.1.1 — 2026-11-16

跟 DSH 0.2.2-rc.3 对齐，顺手把攒在本地没发出去的两件事一起发了。

### 新增：语种切换

- 面板第二张卡多了「朗读语种」「参考语种」两个下拉（`textLang` / `promptLang`），
  对应 `api_v2` 的 `text_lang` / `prompt_lang`：`auto` 多语种混合 / `zh` / `en` / `ja` / `ko` / `yue`。
- 引擎认得但面板没列出来的 `auto_yue`、`all_zh`、`all_ja`、`all_yue`、`all_ko` 也放行：
  接口传进来会校验白名单，认不出的值直接忽略、不写进设置。
- `/state` 里的 `languages` 由宿主下发（带中文标签），网页半边不再硬编码文案。
- 每个音色各自记 `textLang` / `promptLang`，切音色时一起换回来。
- `cordis.patch.yml` 里补了这两个键的注释，README 补了「换语种」一节。

### 修：英文 / 日文 / 韩文被切坏

- 切句原来只认全角句读（`。！？；…`），一段英文会糊成一整块。现在也按「句点 + 空格」断。
- 过滤碎块的规则从「必须有汉字或字母」放宽成「有字母或数字」：纯英文、纯韩文、纯数字都不会被丢掉。
- `selftest.mjs` 补了中英日韩四组切句断言，以及语种改设置 → 合成时 `text_lang` / `prompt_lang` 真的传下去的断言。

### 兼容性核对（跑在 DSH 0.2.2-rc.3 上）

- 四处契约都还在、签名没变：
  `ctx.webServer.register({ kind: 'prefix', path, handler })`、
  `ctx.sessions.get/list`、`ctx.sessionTitle.get`、
  网页半边的 `ctx.slots.inject(key, () => ctx.slots.register({ name, id, key, order, label }, C))`。
- 三个 slot 仍在：`sidebar.panellist`（list / root）、`main`（keyed / root）、`conversation.chat.assistant-actions`（list / session）。
- 活体实测：`GET /dsh-sovits-bridge/state` → 200 且返回完整 state；随便编的路径 → 404。
- `selftest.mjs` 68/68、`clienttest.mjs` 全过（Node 24）；`engines.node` 仍是 `>=20`。
- 仓库补上了 `.github/workflows/ci.yml`（Node 20 / 22 跑两个自测）和 `.gitignore`。

## 0.1.0 — 2026-11-09

第一个可用版本。

- 宿主半边盯着 DSH 会话，按「整轮说完」取字、切句、排队，串行喂给本机 GPT-SoVITS 的 `api_v2`（默认 `127.0.0.1:9880`）。
- 网页半边：左侧栏「本地朗读」面板（引擎 / 音色 / 朗读 / 输出四块）、每条回复的 `🔊` 按钮、左下角播放条。
- 音色自动配对：`GPT_weights_*` + `SoVITS_weights_*` 按名字归一化配对，再从 `参考文件` 里挑参考音频，并尽量猜出参考文本（同名 txt → `XX 语音录.txt` 按编号 → 文件名本身）。
- 三层可换：换人（权重组合）、换参考音频、改参考文本；改完即时生效。
- 引擎由插件惰性拉起（自己 `runtime\python.exe -I api_v2.py`），只关自己起的进程，不动别人占着的 9880。
- 每次合成可自动落盘到指定目录（默认 `桌面\本地朗读`），面板三处「打开文件夹…」走系统资源管理器。
- 播放走 Web Audio：合成一句要几秒，等音频回来时点击手势已过期，`<audio>` 会被自动播放策略拒掉。
- 静音检测：合成完先量峰值，全零直接报错并提示「关掉 isHalf」——v2ProPlus 在 16 系显卡上开 fp16 会吐长度正常但全零的 wav。

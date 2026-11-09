# dsh-sovits-bridge

把会话里 DSH 的回复，交给你自己电脑上的 **GPT-SoVITS** 念出来。

它和 `dsh-tts-bridge`（那个用 DeepSeek 网页端朗读的）是同一件事的两个版本：
同样的「宿主半边」——盯会话、按整轮取字、切句、排队、可停可重念；
只把发声那半边换成了本机的 `api_v2`（默认 `127.0.0.1:9880`）。

## 安装

```bash
# 从 npm（发布后）
dsh plugin --profile desktop add dsh-sovits-bridge --registry=https://registry.npmjs.org/

# 从本地目录（改了代码想看效果）
dsh plugin --profile desktop add "link:D:\路径\dsh-sovits-bridge"
```

装完**重启一次 DSH**（客户端面板在宿主启动时装配）。卸载：

```bash
dsh plugin --profile desktop remove dsh-sovits-bridge
```

## 和 go-webui.bat 的关系

- `go-webui.bat` 开的是 **WebUI**（浏览器界面，7860 端口），它不提供 `/tts` 接口。
- 这个插件要的是同目录下的 **`api_v2.py`**（9880 端口），会自己用整合包里的 `runtime\python.exe` 把它拉起来，**不用你去点 go-webui**。
- 两个用的是同一份模型文件。真要在 WebUI 里调声音也行，但别同时开——4 GB 显存经不起两份模型。

## 第一次用

1. 左侧栏 **本地朗读**（和「片头视频」同一排），确认「目录」指向整合包根目录（放 `go-webui.bat` 的那一层）。
2. 点「启动引擎」。第一次要加载模型，**30–60 秒**是正常的；下面的日志会动，状态点变绿。
3. 选一个音色 → 点「试听」。出声就成了。
4. 想要自动念：打开「自动朗读」，再勾上要听的会话。
5. 合成出来的 wav 默认存到 **`桌面\本地朗读`**；面板里「输出文件夹」可以改成任何路径，旁边的「打开文件夹…」直接开资源管理器。

回复底下每条消息都有 `🔊`（念这条）/ `⏹`（停）按钮；念过的会出现在「最近念过」里，点一下就重念。
播放条在左下角，右边有「保存」可以把这一句单独存成 wav。

面板里三处「打开文件夹…」：引擎目录、参考音频目录（`参考文件`）、输出目录——都是让宿主调系统资源管理器打开，不走 `file://`。

## 换音色 / 换音频

- **换人**：面板里的音色下拉，来自 `GPT_weights_v2ProPlus` + `SoVITS_weights_v2ProPlus` 的自动配对；改了权重文件点「重新扫描」。
- **换这条嗓子用哪段参考音频**：音色卡下面的「参考音频」下拉，列出 `参考文件` 里所有 wav；选完记得让下面的「参考文本」和这段音频**逐字一致**——不一致会念得很怪。
- 参考文本会自动猜：同名 `.txt` → 目录里的「XX 语音录.txt」按编号（`诺诺 (13).wav` → 第 13 条）→ 文件名本身就是台词的那些目录。猜不出来就留空，引擎会用「不带文本」的模式，音色差一点但能用。
- 选的音色、参考文本、语速都存在 `%USERPROFILE%\.dsh\sovits-bridge.json`，重装不丢；删掉它就回到 `cordis.patch.yml` 的默认值。

## 配置（`cordis.patch.yml` 只是默认值）

| 键 | 意思 |
| --- | --- |
| `dir` | 整合包根目录 |
| `python` | 相对 `dir` 的解释器，默认 `runtime\python.exe` |
| `port` | api_v2 端口，默认 9880 |
| `preset` | 预训练底模，本机是 `v2ProPlus` |
| `device` / `isHalf` | `cuda`/`cpu`、半精度（默认关，见下） |
| `speed` | 语速 0.5–2.0 |
| `autoStart` | 第一次朗读时自动拉起 api_v2 |
| `auto` | 自动朗读（还要在面板里勾会话） |
| `saveAudio` | 每次合成完顺手把 wav 存进 `outDir` |
| `outDir` | 输出目录，默认 `桌面\本地朗读` |

## 「有长度、没声音」＝ 先关 isHalf

v2ProPlus 在 16 系/部分 Turing 卡上开半精度，引擎会认认真真吐一段**长度正常但全是 0** 的 wav
（不是播放问题，wav 本身就是静音）。默认已经关掉 `isHalf`；插件现在也会检查峰值，
遇到全零音频直接报「引擎返回的是静音」，不再让你对着不存在的bug 换播放器。

## 显存不够怎么办

4 GB 卡跑 v2ProPlus 会紧。`device: cuda` 不够就 `device: cpu`（慢，但不会 OOM），
或者给引擎加 `--lowvram`（面板的「目录」下面那行日志能看到它实际用的参数）。
**不要把 `isHalf: true` 当成省显存的常规手段**——在这张卡上它换来的是静音。

## 出问题先看

- 面板上引擎卡的**最后几行日志**——`api_v2` 起不来基本都写在那儿。
- 状态文件：`%USERPROFILE%\.dsh\sovits-bridge.json`。
- 端口被别的 GPT-SoVITS 占着时，插件不会去关人家：面板会显示「已在线」，停止按钮也只关它自己拉起来的那个进程。

## 自测

宿主侧和网页侧都不需要 GPT-SoVITS、不需要浏览器：

```bash
node selftest.mjs     # 54 条断言：假引擎 + 真 HTTP，覆盖切句、合成、缓存、落盘、静音检测、路由校验
node clienttest.mjs   # 假 DOM + 假 React，覆盖三个槽位注册、面板渲染、Web Audio 播放链路
```

CI（`.github/workflows/ci.yml`）在 Node 20/22 上各跑一遍。

## 仓库结构

```
index.js              宿主入口：注册路由 + 2 秒一次的会话扫描
lib/app.js            宿主全部逻辑：扫描 / 切句 / 引擎生命周期 / /tts 转发 / 落盘
lib/client.js         网页半边：左侧栏面板、每条消息的 🔊、左下角播放条（Web Audio）
cordis.patch.yml      默认配置（面板里改的值存在 %USERPROFILE%\.dsh\sovits-bridge.json）
selftest.mjs          宿主自测
clienttest.mjs        网页自测
PUBLISH.md            发 GitHub / npm 的步骤
```

## 卸载

```
dsh plugin --profile desktop remove dsh-sovits-bridge
```

## 为什么用 Web Audio 而不是 `<audio>`

一句台词在本机要 5–10 秒才合成完，等音频到手时，刚才那次点击的「用户手势」早过期了，
`<audio>.play()` 会被 Chromium 的自动播放策略拒掉，而且只留一个 `NotAllowedError` 在 console —— 
表现就是「点了一点声音都没有」。所以：点击的那一刻先 AudioContext.resume() 解锁，
之后拿到 wav 用 decodeAudioData + BufferSource 播放，不再受手势限制。
自动朗读（没有手势）会退回 `<audio>`，有人点过页面时它通常仍能播。

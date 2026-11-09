/**
 * 自测：起一个假引擎（/docs、/set_*_weights、/tts），一份假的权重目录，
 * 然后把宿主当成普通 http 服务跑起来，逐条断言。不碰真的 GPT-SoVITS、不读用户会话。
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createApp, splitText, cleanForSpeech, normalizeName, scanVoices, PREFIX } from './lib/app.js'

let pass = 0
const problems = []
const check = (label, ok, detail = '') => {
  if (ok) {
    pass += 1
    console.log(`ok   ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    problems.push(label)
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sovits-bridge-'))
const mk = (rel, body = 'x') => {
  const full = path.join(root, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, body)
  return full
}

// 两个能配成对的音色，名字故意带训练轮次和【】前缀
const gptA = mk('GPT_weights_v2ProPlus/【GPT2.0】Aoba-e20.ckpt', 'gpt-a')
const sovitsA = mk('SoVITS_weights_v2ProPlus/【GPT2.0】Aoba_e24_s13080.pth', 'sovits-a')
const refA = mk('参考文件/卡拉彼丘 Aoba/【普通】你好呀，今天天气不错。.wav', 'RIFFfake')
const gptB = mk('GPT_weights_v2ProPlus/令_II-e15.ckpt', 'gpt-b')
const sovitsB = mk('SoVITS_weights_v2ProPlus/令_II_e8_s400.pth', 'sovits-b')
const refB = mk('参考文件/卡拉彼丘 令 II/使用模型/令令 (2).wav', 'RIFFfake-longer')
mk('参考文件/卡拉彼丘 令 II/使用模型/令 语音录.txt', '备注：随便写写\n1，第一句台词。\n2，第二句台词在这里。')
// 没有参考音频的那个，应该被配对出来但 ref 为空
const gptC = mk('GPT_weights_v2ProPlus/C-孤独-e5.ckpt', 'gpt-c')
const sovitsC = mk('SoVITS_weights_v2ProPlus/C-孤独_e8_s200.pth', 'sovits-c')

// ---- 纯函数 -------------------------------------------------------------
check('normalize: 【GPT2.0】Aoba-e20 / Aoba_e24_s13080 同名', normalizeName('【GPT2.0】Aoba-e20.ckpt') === normalizeName('【GPT2.0】Aoba_e24_s13080.pth'))
check('normalize: 遐蝶 v3 DPO / v2 同名', normalizeName('遐蝶_v3-e15_DPO.ckpt') === normalizeName('遐蝶_v2_e8_s256.pth'), `${normalizeName('遐蝶_v3-e15_DPO.ckpt')} vs ${normalizeName('遐蝶_v2_e8_s256.pth')}`)
check('clean: 代码块不念', !cleanForSpeech('看这个\n```js\nconst a = 1\n```\n好了').includes('const'))
check('clean: emoji 去掉', !/[\u{1F300}-\u{1FAFF}]/u.test(cleanForSpeech('好耶 🎉🔥')))
check('split: 按句号切', splitText('第一句。第二句！').length === 2, JSON.stringify(splitText('第一句。第二句！')))
check('split: 长句硬切', splitText('啊'.repeat(400)).every((chunk) => chunk.length <= 140))
check('split: 空文本没有块', splitText('   ').length === 0)

// ---- 配对 ---------------------------------------------------------------
const voices = scanVoices({ dir: root })
check('scan: 三个音色', voices.length === 3, voices.map((v) => v.name).join(','))
const aoba = voices.find((v) => v.name.includes('Aoba'))
check('scan: Aoba 参考音频配上', aoba && aoba.ref === refA, aoba && aoba.ref)
check('scan: Aoba 参考文本来自文件名', aoba && aoba.promptText === '你好呀，今天天气不错。', aoba && aoba.promptText)
const lonely = voices.find((v) => v.name.includes('孤独'))
check('scan: 没参考音频的也能列出来', lonely && lonely.ref === '')
const ling = voices.find((v) => v.name.includes('令'))
check('scan: B 的参考音频按同名目录配上（深层 使用模型）', ling && ling.ref === refB, ling && ling.ref)
check('scan: B 的台词按编号从语音录里取', ling && ling.promptText === '第二句台词在这里。', ling && ling.promptText)

// ---- 假引擎 -------------------------------------------------------------
const calls = { setGpt: [], setSovits: [], tts: 0, texts: [] }
const wav = (size = 200) => {
  const buf = Buffer.alloc(44 + size)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + size, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(32000, 24)
  buf.writeUInt32LE(64000, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(size, 40)
  // 有振幅的正弦，别让「静音检测」把测试全判死
  for (let i = 0; i + 1 < size; i += 2) {
    buf.writeInt16LE(Math.round(Math.sin(i / 12) * 12000), 44 + i)
  }
  return buf
}

// 引擎偶尔会给一段全零 wav，这时我们要明确报错而不是静默播放
const silentWav = (size = 200) => {
  const buf = wav(size)
  buf.fill(0, 44)
  return buf
}

const engine = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/docs') {
    res.writeHead(200, { 'content-type': 'text/html' })
    return res.end('<html>docs</html>')
  }
  if (url.pathname === '/set_gpt_weights' || url.pathname === '/set_sovits_weights') {
    const file = url.searchParams.get('weights_path') || ''
    if (url.pathname === '/set_gpt_weights') calls.setGpt.push(file)
    else calls.setSovits.push(file)
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ message: 'success' }))
  }
  if (url.pathname === '/tts' && req.method === 'POST') {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const payload = JSON.parse(raw)
      calls.tts += 1
      calls.texts.push(payload.text)
      if (payload.text.includes('爆炸')) {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ message: '合成失败（假引擎）' }))
      }
      if (payload.text.includes('静音')) {
        const quiet = silentWav()
        res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': quiet.length })
        return res.end(quiet)
      }
      const body = wav()
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': body.length })
      res.end(body)
    })
    return
  }
  res.writeHead(404).end()
})

await new Promise((resolve) => engine.listen(0, '127.0.0.1', resolve))
const enginePort = engine.address().port

// ---- 宿主 ---------------------------------------------------------------
const stateFile = path.join(root, 'state', 'sovits-bridge.json')
const app = createApp({ ctx: { sessions: { list: () => [] } }, config: { dir: root, port: enginePort, stateFile, autoStart: true, outDir: path.join(root, 'out'), saveAudio: true } })

const server = http.createServer((req, res) => app.handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}${PREFIX}`

const get = async (url) => {
  const res = await fetch(base + url)
  const type = res.headers.get('content-type') || ''
  if (type.includes('json')) return { status: res.status, data: await res.json(), headers: res.headers }
  return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()), headers: res.headers }
}
const post = async (url, value) => {
  const res = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value || {}) })
  return { status: res.status, data: await res.json() }
}

const started = await get('/state')
check('state: 200 + ok', started.status === 200 && started.data.ok === true)
check('state: 启动就扫出了音色', started.data.voices.length === 3, String(started.data.voices.length))
check('state: voiceId 已选', Boolean(started.data.voiceId))
check('state: 引擎还没起来', started.data.engine.online === false)
check('state: 没有一个会话却也不炸', Array.isArray(started.data.sessions))

const patched = await post('/settings', { speed: 1.2, auto: true, sessions: ['s1'] })
check('settings: 保存成功', patched.status === 200 && patched.data.settings.speed === 1.2)
check('settings: 写进 state.json', JSON.parse(fs.readFileSync(stateFile, 'utf8')).config.speed === 1.2)
check('settings: auto/sessions 一起存了', patched.data.settings.auto === true && patched.data.settings.sessions[0] === 's1')

const badSpeed = await post('/settings', { speed: 99 })
check('settings: 语速被夹到 2', badSpeed.status === 200 && badSpeed.data.settings.speed === 2)

const spoken = await post('/speak', { text: '第一句。第二句！第三句？' })
check('speak: 200 + 三块', spoken.status === 200 && spoken.data.chunks === 3, JSON.stringify(spoken.data && spoken.data.texts))
const job = spoken.data.job

const first = await get(`/audio?job=${job}&i=0`)
check('audio: 200 + wav', first.status === 200 && first.buffer.slice(0, 4).toString('ascii') === 'RIFF')
check('audio: content-type', (first.headers.get('content-type') || '').includes('audio/wav'))
const activeVoice = started.data.voices.find((v) => v.id === started.data.voiceId)
const baseName = (p) => String(p || '').replace(/\\/g, '/').split('/').pop()
check('audio: 切了权重（gpt）', baseName(calls.setGpt[0]) === activeVoice.gpt, `${baseName(calls.setGpt[0])} vs ${activeVoice.gpt}`)
check('audio: 切了权重（sovits）', baseName(calls.setSovits[0]) === activeVoice.sovits, baseName(calls.setSovits[0]))
check('audio: 第一句话对', calls.texts[0] === '第一句。', calls.texts[0])

await get(`/audio?job=${job}&i=0`)
check('audio: 同一块只合成一次', calls.tts === 1, String(calls.tts))

const third = await get(`/audio?job=${job}&i=2`)
check('audio: 第三块也能取', third.status === 200 && third.buffer.length > 40)
check('audio: 越界 i 报 400', (await get(`/audio?job=${job}&i=9`)).status === 400)
check('audio: 不存在的 job 报 404', (await get('/audio?job=nope&i=0')).status === 404)

const exported = await get(`/export?job=${job}&i=0`)
check('export: 附件头', (exported.headers.get('content-disposition') || '').includes('attachment'))
check('export: 文件名带 wav', (exported.headers.get('content-disposition') || '').includes('.wav'))

// 合成完顺手落盘：/audio 的 x-saved-as 头 + 文件真的在 outDir 里
const saved = first.headers.get('x-saved-as') || ''
const savedPath = saved ? decodeURIComponent(saved) : ''
check('save: /audio 回了保存路径', Boolean(savedPath) && savedPath.startsWith(path.join(root, 'out')), savedPath)
check('save: 文件真的有内容', savedPath && fs.statSync(savedPath).size === first.buffer.length, savedPath)
check('save: 关掉开关就不再存', (await post('/settings', { saveAudio: false })).data.settings.saveAudio === false)
const beforeQuiet = fs.readdirSync(path.join(root, 'out')).filter((name) => name.endsWith('.wav')).length
const quiet = await post('/speak', { text: '关掉保存之后再念一句。' })
const quietAudio = await get(`/audio?job=${quiet.data.job}&i=0`)
const afterQuiet = fs.readdirSync(path.join(root, 'out')).filter((name) => name.endsWith('.wav')).length
check('save: 关掉后没有新文件落在目录里', quietAudio.status === 200 && afterQuiet === beforeQuiet, `${beforeQuiet} -> ${afterQuiet}`)
await post('/settings', { saveAudio: true })

check('open: 不认识的 kind 报 400', (await post('/open', { kind: 'nope' })).status === 400)
check('open: 不存在的文件夹报 400', (await post('/open', { kind: 'out2' })).status === 400)

const stopped = await post('/stop', { job })
check('stop: 200', stopped.status === 200)
const afterStop = await get(`/audio?job=${job}&i=1`)
check('stop 之后不再合成', afterStop.status === 500 && String(afterStop.data.error).includes('已停止'), JSON.stringify(afterStop.data))

const empty = await post('/speak', { text: '   ' })
check('speak: 空文本 400', empty.status === 400)
const noText = await post('/speak', {})
check('speak: 什么都没有 400', noText.status === 400)

// 引擎报错要能透出来
const again = await post('/speak', { text: '这句会爆炸。' })
const failed = await get(`/audio?job=${again.data.job}&i=0`)
check('audio: 引擎失败透传', failed.status === 500 && String(failed.data.error).includes('合成失败'), JSON.stringify(failed.data && String(failed.data.error).slice(0, 80)))

// 全长静音的 wav 必须报错，不能安安静静播出去
const muteJob = await post('/speak', { text: '这一段是静音。' })
const muteAudio = await get(`/audio?job=${muteJob.data.job}&i=0`)
check('audio: 静音 wav 会被指出来', muteAudio.status === 500 && String(muteAudio.data.error).includes('静音'), JSON.stringify(muteAudio.data && String(muteAudio.data.error).slice(0, 90)))

// 换音色
const nextVoice = started.data.voices.find((v) => v.id !== started.data.voiceId)
const switchedSettings = await post('/settings', { voiceId: nextVoice.id })
check('换音色：设置已经改', switchedSettings.data.settings.voiceId === nextVoice.id, switchedSettings.data.settings.voiceId)
const switched = await post('/speak', { text: '换人说话。' })
const switchedAudio = await get(`/audio?job=${switched.data.job}&i=0`)
check('换音色后权重也换了', switchedAudio.status === 200 && baseName(calls.setGpt[calls.setGpt.length - 1]) === nextVoice.gpt && calls.setGpt.length > 1,
  `${switchedAudio.status} / ${JSON.stringify(calls.setGpt.map((f) => baseName(f)))}`)

// 文件列表
const refFiles = await get('/files?kind=ref')
check('files: 参考音频列表', refFiles.data.files.length === 2, String(refFiles.data.files.length))
const gptFiles = await get('/files?kind=gpt')
check('files: 权重列表', gptFiles.data.files.length === 3)

// 引擎：端口上已经有别人的引擎 → 只能说 already，不许去动人家的进程
const existing = await post('/engine', { action: 'start' })
check('engine: 端口上已有引擎 → already', existing.status === 200 && existing.data.already === true, JSON.stringify(existing.data))

// 换到一个没人听的端口，而目录里没有 api_v2.py → 说人话
const freePort = await new Promise((resolve) => {
  const probe = http.createServer()
  probe.listen(0, '127.0.0.1', () => {
    const port = probe.address().port
    probe.close(() => resolve(port))
  })
})
await post('/settings', { port: freePort })
const badEngine = await post('/engine', { action: 'start' })
check('engine: 缺 python / api_v2 时说人话', badEngine.status === 500 && /python|api_v2\.py/.test(String(badEngine.data.error)), JSON.stringify(badEngine.data))

const notLocal = await new Promise((resolve) => {
  const req = { socket: { remoteAddress: '10.0.0.9' }, url: `${PREFIX}/state`, method: 'GET', headers: { host: 'x' } }
  const res = {
    statusCode: 0,
    body: '',
    writeHead(code) {
      this.statusCode = code
    },
    end(body) {
      this.body = String(body)
      resolve({ status: this.statusCode, body: this.body })
    },
  }
  app.handler(req, res)
})
check('非本机请求 403', notLocal.status === 403)

const unknown = await get('/nope')
check('未知接口 404', unknown.status === 404)

// 卸载时把引擎收掉（这里只是确认它不抛）
app.dispose()

server.close()
engine.close()
fs.rmSync(root, { recursive: true, force: true })

console.log(problems.length ? `\n${problems.length} 条没过（共 ${pass + problems.length} 条）` : `\n${pass}/${pass} 全部通过`)
if (problems.length) process.exitCode = 1

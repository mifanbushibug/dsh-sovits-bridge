/**
 * dsh-sovits-bridge — 宿主半边。
 *
 * 职责三件：
 *   1. 管引擎：按需拉起本机 GPT-SoVITS 的 api_v2.py（9880），并替它切 GPT / SoVITS 权重。
 *   2. 管音色：扫权重目录和参考音频目录，按名字自动配对，凑出「一套能念的音色」。
 *   3. 管朗读：把一轮回复切句、排队、合成、缓存，再用 /audio 一片片吐给前端。
 *
 * 这里不碰 DOM、不碰音频设备 —— 出声是客户端 <audio> 的事。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const PREFIX = '/dsh-sovits-bridge'

const AUDIO_EXT = new Set(['.wav', '.mp3', '.flac', '.ogg', '.m4a'])
const MAX_CHUNK = 140
const JOB_LIMIT = 40
const RECENT_LIMIT = 12

const PRESETS = {
  v2ProPlus: {
    version: 'v2ProPlus',
    t2s: 'GPT_SoVITS/pretrained_models/s1v3.ckpt',
    vits: 'GPT_SoVITS/pretrained_models/v2Pro/s2Gv2ProPlus.pth',
    bert: 'GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large',
    hubert: 'GPT_SoVITS/pretrained_models/chinese-hubert-base',
  },
}

const DEFAULTS = {
  dir: 'D:\\GPT-SoVITS-v2pro-20250604',
  python: 'runtime\\python.exe',
  host: '127.0.0.1',
  port: 9880,
  preset: 'v2ProPlus',
  device: 'cuda',
  // 半精度默认关：16 系/部分 Turing 卡上 v2ProPlus 的 fp16 推理会输出全零静音（实测 1650 Ti）。
  // 打开能快一些，但如果听见的是「有长度、没声音」，先把它关掉。
  isHalf: false,
  speed: 1,
  cut: 'cut5',
  promptLang: 'zh',
  textLang: 'zh',
  autoStart: true,
  saveAudio: true,
  gptDir: '',
  sovitsDir: '',
  refDir: '',
  outDir: '',
  stateFile: '',
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const isFile = (file) => {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

const isDir = (file) => {
  try {
    return fs.statSync(file).isDirectory()
  } catch {
    return false
  }
}

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

const clamp = (value, min, max, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

/**
 * 看一段 wav 里最大的 16 位样本。只用来回答一个问题：这是不是静音。
 * 不是音频就返回 -1（让调用方别因为格式不认识就报静音）。
 */
function wavPeak(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return -1
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') return -1
  let offset = 12
  let bits = 16
  let data = null
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    if (id === 'fmt ') bits = buffer.readUInt16LE(offset + 22)
    if (id === 'data') {
      data = { start: offset + 8, size }
      break
    }
    offset += 8 + size + (size % 2)
  }
  if (!data) return -1
  if (bits !== 16) return -1
  const end = Math.min(data.start + data.size, buffer.length - 1)
  let peak = 0
  for (let i = data.start; i < end; i += 2) {
    const value = Math.abs(buffer.readInt16LE(i))
    if (value > peak) peak = value
  }
  return peak
}

// 同一个人的几种写法：同音字、译名差一个字母、文件夹用了别的名字
const REF_ALIAS = new Map([
  ['瑕蝶', '遐蝶'],
  ['蕾欧娜', '雷欧娜'],
  ['忧雾', '优雾'],
  ['蜗蜗', '优雾'],
])

export function normalizeName(name) {
  const base = String(name || '')
    .replace(/\.[a-z0-9]+$/i, '')
    // 「诺诺 (13)」这种纯编号的括号丢掉；其它括号只当分隔符，里面的名字要留着
    .replace(/[（(]\s*\d{1,3}\s*[）)]/g, ' ')
    .replace(/[【】\[\]（）()]/g, ' ')
    // 目录前缀、模型版本号
    .replace(/(卡拉彼丘|卡拉比丘|星穹铁道|参考音频|使用模型|模型喵|模型2喵|喵)/g, ' ')
    .replace(/gpt\s*\d+(\.\d+)?/gi, ' ')
    .replace(/【[^】]*】/g, ' ')
    // 训练轮次、步数、版本、DPO 之类的尾巴
    .replace(/[-_ ]?e\d+([-_ ]?s\d+)?/gi, ' ')
    .replace(/[-_ ]?v\d+(\w*)?/gi, ' ')
    .replace(/[-_ ]?dpo/gi, ' ')
    .replace(/[\s\-—·._]+/g, '')
    .toLowerCase()
  // 「令_II」「千代 _I」这种罗马数字后缀：只在前面是汉字时才去掉（Elysia 的 a 不能动）
  const key = base.replace(/[ivx]{1,3}$/i, (match, offset, whole) => {
    const prev = whole[offset - 1] || ''
    return /[\u4e00-\u9fff]/.test(prev) ? '' : match
  })
  return REF_ALIAS.get(key) || key
}

function listDir(dir, ext) {
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    const full = path.join(dir, name)
    if (!isFile(full)) continue
    if (ext && !ext.has(path.extname(name).toLowerCase())) continue
    let stat = { size: 0, mtimeMs: 0 }
    try {
      stat = fs.statSync(full)
    } catch {}
    out.push({ name, path: full, size: stat.size, mtimeMs: stat.mtimeMs })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

/** 参考文件里所有音频（含子目录，最多四层 —— 训练包常放在「使用模型/音频」这种深层）。 */
function listRefAudio(refRoot, maxDepth = 4) {
  const out = []
  const walk = (dir, depth, parts) => {
    if (depth > maxDepth) return
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const full = path.join(dir, name)
      if (isDir(full)) {
        walk(full, depth + 1, [...parts, name])
        continue
      }
      if (!AUDIO_EXT.has(path.extname(name).toLowerCase())) continue
      let stat = { size: 0, mtimeMs: 0 }
      try {
        stat = fs.statSync(full)
      } catch {}
      out.push({ name, path: full, rel: [...parts, name].join('/'), dirs: parts, size: stat.size, mtimeMs: stat.mtimeMs })
    }
  }
  walk(refRoot, 0, [])
  return out
}

// ---------------------------------------------------------------------------
// 参考文本：文件名本身就是台词的那些目录，直接拿来用
// ---------------------------------------------------------------------------

function promptFromFileName(name) {
  const stem = name.replace(/\.[^.]+$/, '')
  const stripped = stem
    .replace(/【[^】]*】/g, '')
    .replace(/[（(]\s*\d+\s*[）)]/g, '')
    .replace(/^[\s\-_—…、0-9.]+/, '')
    .trim()
  // 「诺诺 (13)」「不甘」「艾卡大招」这种只有名字/标题的，不算台词；
  // 真台词至少像句话：有点标点，字也够多
  const body = stripped.replace(/[\s\p{P}]/gu, '')
  if (body.length < 5) return ''
  if (!/[，。！？；：、,.!?;:…—]/u.test(stripped)) return ''
  return stripped
}

function promptFromSidecar(file) {
  const stem = file.replace(/\.[^.]+$/, '')
  for (const ext of ['.txt', '.lab', '.text']) {
    const side = `${stem}${ext}`
    if (!isFile(side)) continue
    try {
      const text = fs.readFileSync(side, 'utf8').trim()
      if (text) return text.split(/\r?\n/)[0].trim()
    } catch {}
  }
  return ''
}

/** 「1，我叫夜守诺…」这种带编号的录音稿；编号后面没说完的续行也接上。 */
function scriptEntries(text) {
  const entries = new Map()
  let current = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (/^(备注|tips|注意)/i.test(line)) continue
    const numbered = line.match(/^(\d{1,3})\s*[，,、.．:：]\s*(.*)$/)
    if (numbered) {
      current = Number(numbered[1])
      entries.set(current, numbered[2].trim())
      continue
    }
    if (current != null) entries.set(current, `${entries.get(current) || ''} ${line}`.trim())
  }
  return entries
}

/** 「诺诺 (13).wav」「1.wav」里的编号。 */
function numberOf(name) {
  const hit =
    name.match(/[（(]\s*(\d{1,3})\s*[）)]/) ||
    name.match(/[_\-\s](\d{1,3})\.[^.]+$/) ||
    name.match(/^(\d{1,3})\.[^.]+$/)
  return hit ? Number(hit[1]) : null
}

/** 目录里的「XX 语音录.txt / XX文本.txt」：先按编号对，再按排序对。 */
function promptFromScript(dir, audioPath) {
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return ''
  }
  const scripts = names.filter((n) => /\.txt$/i.test(n) && /录|稿|文本|台词/.test(n))
  if (!scripts.length) return ''
  const audio = names.filter((n) => AUDIO_EXT.has(path.extname(n).toLowerCase())).sort((a, b) => a.localeCompare(b, 'zh', { numeric: true }))
  const base = path.basename(audioPath)
  const index = audio.indexOf(base)
  const num = numberOf(base)
  for (const script of scripts) {
    let text = ''
    try {
      text = fs.readFileSync(path.join(dir, script), 'utf8')
    } catch {
      continue
    }
    const entries = scriptEntries(text)
    if (num != null && entries.get(num)) return entries.get(num)
    if (index >= 0 && entries.get(index + 1)) return entries.get(index + 1)
    if (!entries.size && index >= 0) {
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      if (lines.length === audio.length) return lines[index]
    }
  }
  return ''
}

const promptCache = new Map()

export function guessPromptText(file) {
  if (promptCache.has(file)) return promptCache.get(file)
  const text =
    promptFromSidecar(file) ||
    promptFromScript(path.dirname(file), file) ||
    promptFromFileName(path.basename(file))
  promptCache.set(file, text)
  return text
}

// ---------------------------------------------------------------------------
// 音色：把 GPT 权重、SoVITS 权重、参考音频配成一套
// ---------------------------------------------------------------------------

export function scanVoices(config) {
  promptCache.clear()
  const root = config.dir
  const gptDir = config.gptDir || path.join(root, 'GPT_weights_v2ProPlus')
  const sovitsDir = config.sovitsDir || path.join(root, 'SoVITS_weights_v2ProPlus')
  const refDir = config.refDir || path.join(root, '参考文件')

  const gpt = listDir(gptDir, new Set(['.ckpt']))
  const sovits = listDir(sovitsDir, new Set(['.pth']))
  const refs = listRefAudio(refDir)

  const groups = new Map()
  const touch = (key, name) => {
    if (!key) return null
    if (!groups.has(key)) groups.set(key, { key, name, gpt: [], sovits: [], ref: [] })
    const group = groups.get(key)
    if (!group.name && name) group.name = name
    return group
  }

  for (const file of gpt) {
    const key = normalizeName(file.name)
    const group = touch(key, file.name.replace(/【[^】]*】/g, '').replace(/[-_ ]?e\d+.*$/i, '').trim())
    if (group) group.gpt.push(file)
  }
  for (const file of sovits) {
    const key = normalizeName(file.name)
    const group = touch(key, file.name.replace(/【[^】]*】/g, '').replace(/[-_ ]?e\d+.*$/i, '').trim())
    if (group) group.sovits.push(file)
  }
  for (const file of refs) {
    // 参考音频可能放在「人物名/使用模型」「人物名/音频」这种深层，目录名和文件名都算线索
    const keys = new Set([normalizeName(file.name), ...file.dirs.map(normalizeName)])
    for (const key of keys) {
      const group = groups.get(key)
      if (group) group.ref.push(file)
    }
  }

  const voices = []
  for (const group of groups.values()) {
    if (!group.gpt.length || !group.sovits.length) continue
    const pick = (list) => list[list.length - 1]
    const gptFile = pick(group.gpt.sort((a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true })))
    const sovitsFile = pick(group.sovits.sort((a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true })))
    // 优先挑「能自动读出台词」的那条参考音频，读不出再退一步用最大的
    const candidates = group.ref.sort((a, b) => b.size - a.size)
    const refFile = candidates.find((file) => guessPromptText(file.path)) || candidates[0] || null
    voices.push({
      id: group.key,
      name: group.name || group.key,
      gpt: gptFile.path,
      sovits: sovitsFile.path,
      ref: refFile ? refFile.path : '',
      promptText: refFile ? guessPromptText(refFile.path) : '',
      promptLang: config.promptLang || 'zh',
      textLang: config.textLang || 'zh',
    })
  }
  return voices.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

// ---------------------------------------------------------------------------
// 切句：念出来的单位，不是写下来的单位
// ---------------------------------------------------------------------------

export function cleanForSpeech(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ') // 代码不念
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // 图片不念
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接只念字
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^[\s>*\-+]+\s?/gm, '')
    .replace(/[*_~|]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '') // emoji / 符号
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

export function splitText(text, limit = MAX_CHUNK) {
  const clean = cleanForSpeech(text)
  if (!clean) return []
  const pieces = clean.split(/(?<=[。！？!?；;…\n])/u).map((s) => s.trim()).filter(Boolean)
  const body = (s) => s.replace(/[。！？!?；;…\n，,、\s]/gu, '')
  const chunks = []
  let buffer = ''
  for (const piece of pieces) {
    if (!buffer) {
      buffer = piece
      continue
    }
    // 只把「短得没头没尾」的碎片（好。嗯。对。）并到相邻的句子里，正常句子一句一块 —— 第一声出得快
    const merge = (body(piece).length <= 2 || body(buffer).length <= 2) && (buffer + piece).length <= limit
    if (merge) {
      buffer += piece
      continue
    }
    chunks.push(buffer)
    buffer = piece
  }
  if (buffer) chunks.push(buffer)
  const out = []
  for (const chunk of chunks) {
    let rest = chunk
    while (rest.length > limit) {
      out.push(rest.slice(0, limit))
      rest = rest.slice(limit)
    }
    if (rest) out.push(rest)
  }
  return out.filter((chunk) => /[\p{Script=Han}\p{L}]/u.test(chunk))
}

// ---------------------------------------------------------------------------
// 引擎
// ---------------------------------------------------------------------------

export function createEngine(state) {
  let child = null
  let chain = Promise.resolve()

  const config = () => state.config

  const engineUrl = (suffix) => `http://${config().host}:${config().port}${suffix}`

  const log = (line) => {
    const text = String(line || '').trim()
    if (!text) return
    state.engine.log.push(text.slice(0, 300))
    if (state.engine.log.length > 40) state.engine.log.shift()
  }

  async function probe(timeout = 1200) {
    try {
      const res = await fetch(engineUrl('/docs'), { signal: AbortSignal.timeout(timeout) })
      return res.ok
    } catch {
      return false
    }
  }

  function yamlFile() {
    const custom = PRESETS[config().preset] || PRESETS.v2ProPlus
    const target = path.join(path.dirname(state.stateFile), 'tts_infer.bridge.yaml')
    const body = [
      '# dsh-sovits-bridge 生成，别手改 —— 改插件面板里的引擎设置就行。',
      'custom:',
      `  bert_base_path: ${custom.bert}`,
      `  cnhuhbert_base_path: ${custom.hubert}`,
      `  device: ${config().device}`,
      `  is_half: ${config().isHalf ? 'true' : 'false'}`,
      `  t2s_weights_path: ${custom.t2s}`,
      `  vits_weights_path: ${custom.vits}`,
      `  version: ${custom.version}`,
      '',
    ].join('\n')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, body, 'utf8')
    return target
  }

  async function start() {
    if (await probe()) {
      state.engine.online = true
      state.engine.error = ''
      return { ok: true, already: true }
    }
    const dir = config().dir
    if (!isDir(dir)) return { ok: false, error: `找不到 GPT-SoVITS 目录：${dir}` }
    const python = path.join(dir, config().python)
    if (!isFile(python)) return { ok: false, error: `找不到 python：${python}` }
    if (!isFile(path.join(dir, 'api_v2.py'))) return { ok: false, error: `找不到 api_v2.py：${dir}` }

    const args = ['-I', 'api_v2.py', '-a', config().host, '-p', String(config().port), '-c', yamlFile()]
    log(`> ${python} ${args.join(' ')}`)
    child = spawn(python, args, {
      cwd: dir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    state.engine.pid = child.pid || null
    state.engine.startedByUs = true
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => String(chunk).split(/\r?\n/).forEach(log))
    child.stderr?.on('data', (chunk) => String(chunk).split(/\r?\n/).forEach(log))
    child.on('exit', (code) => {
      log(`[引擎退出 code=${code}]`)
      state.engine.online = false
      state.engine.startedByUs = false
      state.engine.pid = null
      child = null
    })

    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
      if (await probe(1500)) {
        state.engine.online = true
        state.engine.error = ''
        return { ok: true }
      }
      if (!child) return { ok: false, error: `引擎起来了又退了，看下面日志里的最后几行。` }
      await new Promise((resolve) => setTimeout(resolve, 1200))
    }
    return { ok: false, error: '等了 3 分钟还没起来（首次启动要加载模型，慢是正常的，看看日志）' }
  }

  async function stop() {
    if (!child) {
      if (await probe()) {
        return { ok: false, error: '这个 9880 不是我拉起来的（可能是你自己开的 api_v2 / WebUI），我不去动它。' }
      }
      return { ok: true, already: true }
    }
    try {
      child.kill()
    } catch {}
    child = null
    state.engine.online = false
    state.engine.startedByUs = false
    state.engine.pid = null
    return { ok: true }
  }

  async function ensure() {
    if (await probe()) {
      state.engine.online = true
      return { ok: true }
    }
    if (!config().autoStart) return { ok: false, error: '引擎没在跑，而且「自动启动」是关的。' }
    const result = await start()
    if (!result.ok) state.engine.error = result.error
    return result
  }

  async function setWeights(gptPath, sovitsPath) {
    const setOne = async (kind, file) => {
      const key = kind === 'gpt' ? 'gpt' : 'sovits'
      if (!file || state.engine[key] === file) return { ok: true, skipped: true }
      const res = await fetch(engineUrl(`/set_${kind}_weights?weights_path=${encodeURIComponent(file)}`), {
        signal: AbortSignal.timeout(120_000),
      })
      const text = await res.text().catch(() => '')
      if (!res.ok) return { ok: false, error: `切 ${kind} 权重失败：${text.slice(0, 200)}` }
      state.engine[key] = file
      return { ok: true }
    }
    const first = await setOne('gpt', gptPath)
    if (!first.ok) return first
    return setOne('sovits', sovitsPath)
  }

  function synthesize(voice, text, opts) {
    const run = async () => {
      const ready = await ensure()
      if (!ready.ok) throw new Error(ready.error || '引擎没起来')
      const weights = await setWeights(voice.gpt, voice.sovits)
      if (!weights.ok) throw new Error(weights.error)
      const body = {
        text,
        text_lang: opts.textLang || voice.textLang || 'zh',
        ref_audio_path: voice.ref,
        prompt_text: voice.promptText || '',
        prompt_lang: opts.promptLang || voice.promptLang || 'zh',
        top_k: 5,
        top_p: 1,
        temperature: 1,
        text_split_method: 'cut0',
        batch_size: 1,
        speed_factor: opts.speed ?? config().speed,
        media_type: 'wav',
        streaming_mode: false,
        parallel_infer: true,
        repetition_penalty: 1.35,
        sample_steps: 32,
      }
      const res = await fetch(engineUrl('/tts'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600_000),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`合成失败（${res.status}）：${text.slice(0, 300)}`)
      }
      const type = res.headers.get('content-type') || ''
      const buffer = Buffer.from(await res.arrayBuffer())
      if (!type.includes('audio') && !(buffer[0] === 0x52 && buffer[1] === 0x49)) {
        throw new Error(`引擎回的不是音频：${buffer.toString('utf8', 0, 200)}`)
      }
      return buffer
    }
    // 引擎是单进程单卡，合成必须排队，别并发打它
    const next = chain.then(run, run)
    chain = next.catch(() => {})
    return next
  }

  return { probe, start, stop, ensure, synthesize, log }
}

// ---------------------------------------------------------------------------
// 主应用
// ---------------------------------------------------------------------------

export function createApp({ ctx, config = {}, home } = {}) {
  const dshHome = home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const stateFile = path.resolve(config.stateFile || path.join(dshHome, 'sovits-bridge.json'))
  const saved = readJson(stateFile, {})

  const state = {
    stateFile,
    config: { ...DEFAULTS, ...(saved.config || {}), ...config },
    voices: Array.isArray(saved.voices) ? saved.voices : [],
    voiceId: saved.voiceId || '',
    auto: saved.auto === true,
    sessions: Array.isArray(saved.sessions) ? saved.sessions : [],
    recent: [],
    jobs: new Map(),
    current: '',
    engine: { online: false, pid: null, startedByUs: false, error: '', log: [], gpt: '', sovits: '' },
  }
  delete state.config.stateFile

  if (!state.config.gptDir) state.config.gptDir = path.join(state.config.dir, 'GPT_weights_v2ProPlus')
  if (!state.config.sovitsDir) state.config.sovitsDir = path.join(state.config.dir, 'SoVITS_weights_v2ProPlus')
  if (!state.config.refDir) state.config.refDir = path.join(state.config.dir, '参考文件')
  if (!state.config.outDir) state.config.outDir = path.join(os.homedir(), 'Desktop', '本地朗读')
  try {
    fs.mkdirSync(state.config.outDir, { recursive: true })
  } catch {}

  const engine = createEngine(state)

  const persist = () => {
    writeJson(stateFile, {
      config: state.config,
      voices: state.voices,
      voiceId: state.voiceId,
      auto: state.auto,
      sessions: state.sessions,
    })
  }

  if (!state.voices.length) {
    try {
      state.voices = scanVoices(state.config)
      if (state.voices.length) state.voiceId = state.voices[0].id
    } catch {}
  }

  const voiceById = (id) => state.voices.find((voice) => voice.id === id)
  const activeVoice = () => voiceById(state.voiceId) || state.voices[0] || null

  // ---- 会话扫描 -----------------------------------------------------------
  const seen = new Map()
  const pending = new Map()

  function textOfMessage(message) {
    if (!message) return ''
    const content = Array.isArray(message.content) ? message.content : []
    const parts = content.filter((part) => part && part.type === 'text' && typeof part.text === 'string').map((part) => part.text)
    if (parts.length) return parts.join('\n').trim()
    if (typeof message.text === 'string') return message.text.trim()
    return ''
  }

  function remember(kind, text, job) {
    state.recent.unshift({ id: randomUUID(), kind, text: String(text).slice(0, 120), at: Date.now(), job: job?.id || '' })
    state.recent = state.recent.slice(0, RECENT_LIMIT)
  }

  async function speak(text, { sessionId = '', messageId = '', source = 'manual' } = {}) {
    const voice = activeVoice()
    if (!voice) return { ok: false, error: '还没有可用的音色：先去「设置 → 本地朗读」扫一遍。' }
    if (!voice.ref) return { ok: false, error: `音色「${voice.name}」没有参考音频，去面板里挑一个。` }
    const chunks = splitText(text)
    if (!chunks.length) return { ok: false, error: '这段没有可念的字。' }
    const job = {
      id: randomUUID().slice(0, 8),
      chunks,
      bufs: new Array(chunks.length).fill(null),
      files: new Array(chunks.length).fill(''),
      voice: { ...voice },
      speed: state.config.speed,
      textLang: state.config.textLang,
      promptLang: state.config.promptLang,
      sessionId,
      messageId,
      source,
      cancelled: false,
      error: '',
      createdAt: Date.now(),
    }
    state.jobs.set(job.id, job)
    state.current = job.id
    while (state.jobs.size > JOB_LIMIT) {
      const oldest = state.jobs.keys().next().value
      state.jobs.delete(oldest)
    }
    persist()
    return {
      ok: true,
      job: job.id,
      chunks: chunks.length,
      voice: voice.name,
      texts: chunks,
    }
  }

  async function chunkOf(job, index) {
    if (job.bufs[index]) return job.bufs[index]
    if (job.cancelled) throw new Error('已停止')
    const buffer = await engine.synthesize(job.voice, job.chunks[index], {
      speed: job.speed,
      textLang: job.textLang,
      promptLang: job.promptLang,
    })
    // 引擎偶尔会回一段「长度正常但全是 0」的 wav（fp16 推理最常见）。这种音频放出来就是寂静，
    // 与其让用户以为播放坏了，不如当场说清楚。
    const peak = wavPeak(buffer)
    if (peak === 0) {
      throw new Error(`引擎返回的是静音（${Math.round(buffer.length / 1024)} KB 全零）——多半是半精度 fp16 导致的，把引擎设置的 isHalf 关掉再试`)
    }
    job.bufs[index] = buffer
    // 用户指定了输出目录就顺手落盘，面板的「打开输出文件夹」直接能看到
    if (state.config.saveAudio !== false) {
      try {
        fs.mkdirSync(state.config.outDir, { recursive: true })
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const safe = String((job.voice && job.voice.name) || 'voice').replace(/[\\/:*?"<>|\s]+/g, '_')
        const file = path.join(state.config.outDir, `${stamp}-${safe}-${index + 1}.wav`)
        fs.writeFileSync(file, buffer)
        job.files[index] = file
      } catch (error) {
        job.saveError = String((error && error.message) || error)
      }
    }
    return buffer
  }

  function resolveMessage(sessionId, messageId) {
    const ids = sessionId ? [sessionId] : safeSessionList().map((item) => item.id)
    for (const id of ids) {
      let session = null
      try {
        session = ctx?.sessions?.get?.(id)
      } catch {
        session = null
      }
      if (!session) continue
      let messages = []
      try {
        messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
      } catch {
        messages = []
      }
      const hit = messages.find((message) => message && (message.id === messageId || message.messageId === messageId))
      if (hit) return { sessionId: id, text: textOfMessage(hit) }
    }
    return null
  }

  function safeSessionList() {
    try {
      const list = ctx?.sessions?.list?.()
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  function sessionTitle(id) {
    try {
      const session = ctx?.sessions?.get?.(id)
      if (!session) return ''
      const title = ctx?.sessionTitle?.get?.(session) ?? session.title ?? session.name ?? ''
      return typeof title === 'string' ? title : ''
    } catch {
      return ''
    }
  }

  async function scan() {
    const list = safeSessionList()
    for (const item of list) {
      const id = item.id
      const seq = Number(item.seq) || 0
      const previous = seen.get(id)
      if (!previous) {
        seen.set(id, { seq })
        continue
      }
      if (seq <= previous.seq) continue
      let session = null
      try {
        session = ctx?.sessions?.get?.(id)
      } catch {}
      if (!session || typeof session.snapshotEvents !== 'function') {
        seen.set(id, { seq })
        continue
      }
      let events = []
      try {
        events = await session.snapshotEvents(previous.seq)
      } catch {
        events = []
      }
      let buffer = []
      for (const event of events || []) {
        const type = event?.type
        if (type === 'assistant/message') {
          const text = textOfMessage(event.data?.message)
          if (text) buffer.push(text)
          continue
        }
        if (type === 'turn/end') {
          const kind = event.data?.reason?.kind
          const text = buffer.join('\n\n').trim()
          buffer = []
          if (kind === 'completed' && text && state.auto && state.sessions.includes(id)) {
            const result = await speak(text, { sessionId: id, source: 'auto' })
            if (result.ok) pending.set(id, { job: result.job, chunks: result.chunks, voice: result.voice })
          }
        }
      }
      seen.set(id, { seq })
    }
  }

  // ---- HTTP ---------------------------------------------------------------
  const json = (res, status, value) => {
    const body = Buffer.from(JSON.stringify(value), 'utf8')
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': body.length })
    res.end(body)
  }

  async function body(req, limit = 1 << 20) {
    const chunks = []
    let total = 0
    for await (const chunk of req) {
      total += chunk.length
      if (total > limit) throw new Error('请求体太大')
      chunks.push(chunk)
    }
    if (!chunks.length) return {}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  const isLocal = (req) => {
    const addr = req.socket?.remoteAddress || ''
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  }

  function settingsPayload() {
    return {
      ...state.config,
      auto: state.auto,
      voiceId: state.voiceId,
      sessions: state.sessions,
      stateFile: state.stateFile,
    }
  }

  function publicState() {
    const voice = activeVoice()
    return {
      ok: true,
      settings: settingsPayload(),
      engine: {
        online: state.engine.online,
        pid: state.engine.pid,
        startedByUs: state.engine.startedByUs,
        error: state.engine.error,
        log: state.engine.log.slice(-12),
        port: state.config.port,
      },
      voices: state.voices.map((item) => ({
        id: item.id,
        name: item.name,
        gpt: path.basename(item.gpt || ''),
        sovits: path.basename(item.sovits || ''),
        ref: item.ref ? path.basename(item.ref) : '',
        refPath: item.ref,
        promptText: item.promptText,
        promptLang: item.promptLang,
        textLang: item.textLang,
      })),
      voiceId: voice ? voice.id : '',
      auto: state.auto,
      sessions: safeSessionList().map((item) => ({ id: item.id, title: sessionTitle(item.id) })),
      listening: state.sessions,
      recent: state.recent,
      current: state.current,
      pending: [...pending.entries()].map(([sessionId, value]) => ({ sessionId, ...value })),
    }
  }

  function patchConfig(patch) {
    const next = { ...state.config }
    if (typeof patch.dir === 'string' && patch.dir.trim()) next.dir = patch.dir.trim()
    if (typeof patch.python === 'string' && patch.python.trim()) next.python = patch.python.trim()
    if (typeof patch.host === 'string' && patch.host.trim()) next.host = patch.host.trim()
    if (patch.port !== undefined) next.port = clamp(patch.port, 1, 65535, next.port)
    if (typeof patch.preset === 'string' && PRESETS[patch.preset]) next.preset = patch.preset
    if (patch.device === 'cuda' || patch.device === 'cpu') next.device = patch.device
    if (typeof patch.isHalf === 'boolean') next.isHalf = patch.isHalf
    if (patch.speed !== undefined) next.speed = clamp(patch.speed, 0.5, 2, next.speed)
    if (typeof patch.cut === 'string') next.cut = patch.cut
    if (typeof patch.promptLang === 'string') next.promptLang = patch.promptLang
    if (typeof patch.textLang === 'string') next.textLang = patch.textLang
    if (typeof patch.autoStart === 'boolean') next.autoStart = patch.autoStart
    if (typeof patch.gptDir === 'string' && patch.gptDir.trim()) next.gptDir = patch.gptDir.trim()
    if (typeof patch.sovitsDir === 'string' && patch.sovitsDir.trim()) next.sovitsDir = patch.sovitsDir.trim()
    if (typeof patch.refDir === 'string' && patch.refDir.trim()) next.refDir = patch.refDir.trim()
    if (typeof patch.outDir === 'string' && patch.outDir.trim()) {
      next.outDir = patch.outDir.trim()
      try {
        fs.mkdirSync(next.outDir, { recursive: true })
      } catch {}
    }
    if (typeof patch.saveAudio === 'boolean') next.saveAudio = patch.saveAudio
    state.config = next
    if (typeof patch.auto === 'boolean') state.auto = patch.auto
    if (Array.isArray(patch.sessions)) state.sessions = patch.sessions.filter((id) => typeof id === 'string')
    if (typeof patch.voiceId === 'string') state.voiceId = patch.voiceId
    // 引擎参数变了，权重缓存作废
    if (patch.port !== undefined || patch.dir !== undefined || patch.preset !== undefined) {
      state.engine.gpt = ''
      state.engine.sovits = ''
    }
    persist()
    return { ok: true, settings: settingsPayload() }
  }

  async function handler(req, res) {
    try {
      if (!isLocal(req)) return json(res, 403, { ok: false, error: '只接受本机请求' })
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
      const route = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) || '/' : url.pathname
      const method = req.method || 'GET'

      if (route === '/state' && method === 'GET') return json(res, 200, publicState())

      if (route === '/settings' && method === 'POST') {
        const patch = await body(req)
        const result = patchConfig(patch)
        return json(res, 200, { ...result, state: publicState() })
      }

      if (route === '/voices' && method === 'GET') return json(res, 200, { ok: true, voices: publicState().voices })

      if (route === '/voices' && method === 'POST') {
        const payload = await body(req)
        const action = payload.action || 'scan'
        if (action === 'scan') {
          const found = scanVoices(state.config)
          const keep = new Map(state.voices.map((voice) => [voice.id, voice]))
          for (const voice of found) {
            const old = keep.get(voice.id)
            // 扫描只补空着的字段，用户改过的参考音频/文本不动
            if (old) {
              voice.ref = old.ref || voice.ref
              voice.promptText = old.promptText || voice.promptText
              voice.promptLang = old.promptLang || voice.promptLang
              voice.textLang = old.textLang || voice.textLang
            }
          }
          state.voices = found
          if (!voiceById(state.voiceId) && found.length) state.voiceId = found[0].id
          persist()
          return json(res, 200, { ok: true, found: found.length, state: publicState() })
        }
        if (action === 'update') {
          const voice = voiceById(payload.id)
          if (!voice) return json(res, 404, { ok: false, error: '没有这个音色' })
          const patch = payload.patch || {}
          if (typeof patch.ref === 'string' && isFile(patch.ref)) voice.ref = patch.ref
          if (typeof patch.promptText === 'string') voice.promptText = patch.promptText.trim()
          if (typeof patch.promptLang === 'string') voice.promptLang = patch.promptLang
          if (typeof patch.textLang === 'string') voice.textLang = patch.textLang
          if (typeof patch.name === 'string' && patch.name.trim()) voice.name = patch.name.trim()
          persist()
          return json(res, 200, { ok: true, state: publicState() })
        }
        if (action === 'remove') {
          state.voices = state.voices.filter((voice) => voice.id !== payload.id)
          if (state.voiceId === payload.id) state.voiceId = state.voices[0]?.id || ''
          persist()
          return json(res, 200, { ok: true, state: publicState() })
        }
        return json(res, 400, { ok: false, error: `不认识的 action：${action}` })
      }

      if (route === '/files' && method === 'GET') {
        const kind = url.searchParams.get('kind') || 'ref'
        if (kind === 'gpt') return json(res, 200, { ok: true, files: listDir(state.config.gptDir, new Set(['.ckpt'])).map((f) => ({ name: f.name, path: f.path })) })
        if (kind === 'sovits') return json(res, 200, { ok: true, files: listDir(state.config.sovitsDir, new Set(['.pth'])).map((f) => ({ name: f.name, path: f.path })) })
        return json(res, 200, {
          ok: true,
          files: listRefAudio(state.config.refDir).map((f) => ({ name: f.rel, path: f.path, size: f.size })),
        })
      }

      if (route === '/engine' && method === 'GET') {
        const online = await engine.probe()
        state.engine.online = online
        return json(res, 200, { ok: true, online, pid: state.engine.pid, startedByUs: state.engine.startedByUs, error: state.engine.error, log: state.engine.log.slice(-12) })
      }

      if (route === '/engine' && method === 'POST') {
        const payload = await body(req)
        if (payload.action === 'start') {
          const result = await engine.start()
          state.engine.online = result.ok ? true : state.engine.online
          if (!result.ok) state.engine.error = result.error
          return json(res, result.ok ? 200 : 500, { ...result, engine: { online: state.engine.online, pid: state.engine.pid, error: state.engine.error, log: state.engine.log.slice(-12) } })
        }
        if (payload.action === 'stop') {
          const result = await engine.stop()
          return json(res, result.ok ? 200 : 409, result)
        }
        return json(res, 400, { ok: false, error: `不认识的 action：${payload.action}` })
      }

      if (route === '/speak' && method === 'POST') {
        const payload = await body(req)
        let text = typeof payload.text === 'string' ? payload.text : ''
        let sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
        const messageId = typeof payload.messageId === 'string' ? payload.messageId : ''
        if (!text && messageId) {
          const resolved = resolveMessage(sessionId, messageId)
          if (resolved) {
            text = resolved.text
            sessionId = resolved.sessionId
          }
        }
        if (!text) return json(res, 400, { ok: false, error: '没有可念的内容（找不到这条消息，也没拿到文字）' })
        const result = await speak(text, { sessionId, messageId, source: 'manual' })
        if (!result.ok) return json(res, 400, result)
        return json(res, 200, { ok: true, ...result })
      }

      if (route === '/open' && method === 'POST') {
        const payload = await body(req)
        const kind = payload.kind || 'ref'
        const target =
          kind === 'out' ? state.config.outDir
          : kind === 'gpt' ? state.config.gptDir
          : kind === 'sovits' ? state.config.sovitsDir
          : kind === 'dir' ? state.config.dir
          : kind === 'ref' ? state.config.refDir
          : ''
        if (!target) return json(res, 400, { ok: false, error: `不认识的 kind：${kind}` })
        if (!isDir(target)) return json(res, 400, { ok: false, error: `这个文件夹不存在：${target}` })
        try {
          const opener = process.platform === 'win32'
            ? path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe')
            : process.platform === 'darwin' ? 'open' : 'xdg-open'
          const child = spawn(opener, [target], { detached: true, stdio: 'ignore' })
          child.unref()
        } catch (error) {
          return json(res, 500, { ok: false, error: String((error && error.message) || error) })
        }
        return json(res, 200, { ok: true, path: target })
      }

      if (route === '/audio' && method === 'GET') {
        const job = state.jobs.get(url.searchParams.get('job') || '')
        if (!job) return json(res, 404, { ok: false, error: '这个任务不在了（重启过 DSH？）' })
        const index = Number(url.searchParams.get('i'))
        if (!Number.isInteger(index) || index < 0 || index >= job.chunks.length) return json(res, 400, { ok: false, error: 'i 不对' })
        const buffer = await chunkOf(job, index)
        const headers = { 'content-type': 'audio/wav', 'content-length': buffer.length, 'cache-control': 'no-store' }
        const saved = job.files && job.files[index]
        if (saved) headers['x-saved-as'] = encodeURIComponent(saved)
        res.writeHead(200, headers)
        return res.end(buffer)
      }

      if (route === '/export' && method === 'GET') {
        const job = state.jobs.get(url.searchParams.get('job') || '')
        if (!job) return json(res, 404, { ok: false, error: '这个任务不在了' })
        const index = Number(url.searchParams.get('i'))
        if (!Number.isInteger(index) || index < 0 || index >= job.chunks.length) return json(res, 400, { ok: false, error: 'i 不对' })
        const buffer = await chunkOf(job, index)
        const name = `${(job.voice.name || 'voice').replace(/[\\/:*?"<>|]/g, '')}-${job.id}-${index + 1}.wav`
        res.writeHead(200, {
          'content-type': 'audio/wav',
          'content-length': buffer.length,
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        })
        return res.end(buffer)
      }

      if (route === '/stop' && method === 'POST') {
        const payload = await body(req).catch(() => ({}))
        const target = (payload && payload.job) || state.current
        const job = state.jobs.get(target)
        if (job) job.cancelled = true
        return json(res, 200, { ok: true })
      }

      return json(res, 404, { ok: false, error: `没有这个接口：${route}` })
    } catch (error) {
      try {
        return json(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
      } catch {
        return undefined
      }
    }
  }

  return {
    state,
    handler,
    scan,
    speak,
    engine,
    splitText,
    activeVoice,
    dispose: () => {
      engine.stop().catch(() => {})
    },
  }
}

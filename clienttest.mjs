/**
 * 网页半边的冒烟测试：不装浏览器，把 bundle 里的 factory 抠出来，用假 React 跑一遍，
 * 确认槽位注册正确、面板能渲染出元素树而不抛错。
 */
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8')

let entry = null
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
  useMemo: (fn) => fn(),
}

const sources = []
const fakeContext = {
  state: 'running',
  destination: { name: 'destination' },
  resume: async () => {},
  decodeAudioData: async () => ({ duration: 1.5 }),
  createBufferSource() {
    const source = {
      buffer: null,
      connected: null,
      started: 0,
      onended: null,
      connect(target) {
        source.connected = target
      },
      start() {
        source.started += 1
        sources.push(source)
      },
      stop() {},
    }
    return source
  },
}

const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (value) => {
        entry = value
      },
    },
    AudioContext: function AudioContext() {
      return fakeContext
    },
    setTimeout,
    clearTimeout,
    sessionStorage: { getItem: () => null, setItem: () => {} },
  },
  document: {
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, append() {}, addEventListener() {}, remove() {}, removeAttribute() {}, load() {}, pause() {}, play: () => Promise.reject(new Error('no')) }),
    body: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
  },
  fetch: async (url) => {
    const target = String(url)
    if (target.includes('/audio')) {
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(44), json: async () => ({}) }
    }
    if (target.endsWith('/state')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          settings: { speed: 1, dir: 'D:\\GPT-SoVITS', port: 9880, autoStart: true, device: 'cuda', isHalf: true, cut: 'cut5', saveAudio: true, outDir: 'D:\\美丽新世界\\朗读输出', promptLang: 'zh', textLang: 'zh' },
          engine: { online: true, port: 9880, log: [], error: '', startedByUs: true, pid: 1234 },
          voices: [{ id: 'aika', name: '艾卡', ref: 'a.wav', refPath: 'D:\\a.wav', promptText: '你好' }],
          voiceId: 'aika',
          auto: false,
          sessions: [],
          listening: [],
          recent: [],
          current: null,
          pending: [],
        }),
      }
    }
    if (target.includes('/files')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, files: [] }) }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, job: 'job-1', chunks: 1, voice: '艾卡' }),
    }
  },
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
  Audio: function Audio() {
    return { play: () => Promise.reject(new Error('no')), pause() {}, addEventListener() {}, load() {} }
  },
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

const problems = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) problems.push(label)
}

check('loader captured one entry', entry !== null)
check('entry id', entry && entry.id === 'dsh-sovits-bridge', entry && entry.id)

const mod = entry.factory((id) => {
  if (id === 'react') return fakeReact
  throw new Error(`unexpected require: ${id}`)
})

check('module exports apply', typeof mod.apply === 'function')
check('module exports inject [slots]', JSON.stringify(mod.inject) === '["slots"]', JSON.stringify(mod.inject))

const registry = []
const disposers = []
const ctx = {
  effect(fn, label) {
    const dispose = fn()
    disposers.push({ label, dispose })
    return () => {}
  },
  slots: {
    inject(name, fn) {
      registry.push({ name, value: fn() })
      return () => {}
    },
    register(options, component) {
      registry.push({ options, component })
      return () => {}
    },
  },
}

mod.apply(ctx)

const injected = registry.filter((item) => item.name)
const registered = registry.filter((item) => item.options)

check('three slots injected', injected.length === 3, injected.map((item) => item.name).join(','))
check('sidebar entry registered', registered.some((item) => item.options.name === 'sidebar.panellist' && item.options.id === 'sovits-bridge'))
check('main page keyed by panel id', registered.some((item) => item.options.name === 'main' && item.options.key === 'sovits-bridge'))
check('message action registered', registered.some((item) => item.options.name === 'conversation.chat.assistant-actions'))

const icon = registered.find((item) => item.options.name === 'sidebar.panellist').component
const glyph = icon({ size: 20, active: true })
check('icon is an svg at the requested size', glyph.type === 'svg' && glyph.props.width === 20 && glyph.props.height === 20, JSON.stringify(glyph.props).slice(0, 80))

const page = registered.find((item) => item.options.name === 'main').component
let tree = null
let threw = ''
try {
  tree = page({})
} catch (error) {
  threw = String((error && error.message) || error)
}
check('panel renders without throwing', tree !== null, threw)
check('panel renders a div', tree && tree.type === 'div', tree && tree.type)

check('effect labels registered', disposers.length >= 3, disposers.map((item) => item.label).join(' | '))

// ---- 点「试听」真的会出声 -------------------------------------------------
// 回归用例：以前用 <audio>.play()，而一句话要 5–10 秒才合成完，那时点击手势已过期，
// Chromium 直接拒掉 play()，用户看到的就是「什么都没响」。现在必须走 Web Audio。
function collectButtons(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) collectButtons(item, out)
    return out
  }
  if (node.type === 'button') out.push(node)
  for (const child of node.children || []) collectButtons(child, out)
  return out
}

// 面板的按钮要等 state 加载完才出现（这里没有真 hook，所以只测 speakRequest 这条主链路）。
// 回归用例：以前用 <audio>.play()，而一句话要 5–10 秒才合成完，那时点击手势已过期，
// Chromium 直接拒掉 play()，用户看到的就是「什么都没响」。现在必须走 Web Audio。
check('module exposes internals for the test', Boolean(mod.__internal && mod.__internal.speakRequest))
await mod.__internal.speakRequest({ text: '你好，我是你的本地声音。' })
await new Promise((resolve) => setTimeout(resolve, 80))
check('speak starts a Web Audio source', sources.length === 1, String(sources.length))
check('source connected to the speaker', Boolean(sources[0] && sources[0].connected === fakeContext.destination))
check('source got the decoded buffer', Boolean(sources[0] && sources[0].buffer && sources[0].buffer.duration === 1.5))
mod.__internal.stop()

console.log(problems.length ? `\n${problems.length} problem(s)` : '\nall wiring checks passed')
process.exit(problems.length ? 1 : 0)

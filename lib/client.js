/**
 * dsh-sovits-bridge — 网页半边。
 *
 * 三处露面：
 *   - 设置 → 本地朗读：引擎开关、音色、参考音频、听哪些会话、语速。
 *   - 每条助手消息下面的小喇叭：单条念 / 停止。
 *   - 左下角的播放条：正在念第几句、停止、保存成 wav。
 *
 * 出声走 Web Audio（AudioContext 在点击那一刻解锁），音频由宿主 /audio 一片片合成后吐出来。
 * 不用 <audio>：合成一句要 5–10 秒，等拿到音频时点击手势已经过期，play() 会被自动播放策略拒掉。
 */

window.__ModuleLoader__.load({
  id: 'dsh-sovits-bridge',
  factory(require) {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const PREFIX = '/dsh-sovits-bridge'

    // ---- 播放器（模块级，不跟着组件卸载） --------------------------------
    // ⚠️ 出声必须走 Web Audio，不能用 <audio>：
    //    一句话要等 5–10 秒才合成完，那时点击手势早就过期，<audio>.play() 会被自动播放策略拒掉，
    //    而且只在 console 里留一个 NotAllowedError —— 用户看到的就是「什么都没响」。
    //    AudioContext 在点击的同一个同步段里 resume() 一次，之后 start() 就不再受手势限制。
    let audioCtx = null
    let sources = []
    let token = 0
    const played = new Set()
    const watchers = new Set()

    function contextOf() {
      if (audioCtx) return audioCtx
      const Ctor = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)
      if (!Ctor) return null
      try {
        audioCtx = new Ctor()
      } catch (error) {
        audioCtx = null
      }
      return audioCtx
    }

    /** 必须在点击事件的同步段里调用；隔着 await 再 resume 就不算手势了。 */
    function unlock() {
      const ctx = contextOf()
      if (!ctx) return
      if (ctx.state === 'running') return
      try {
        ctx.resume().catch(() => {})
      } catch (error) {
        /* 老浏览器没有 resume，忽略 */
      }
    }

    function haltSources() {
      for (const source of sources) {
        try {
          source.stop()
        } catch (error) {
          /* 已经停了 */
        }
      }
      sources = []
    }


    function broadcast(value) {
      watchers.forEach((fn) => {
        try {
          fn(value)
        } catch (error) {
          console.warn('[sovits-bridge]', error)
        }
      })
    }

    async function api(url, options) {
      const res = await fetch(PREFIX + url, options)
      let data = null
      try {
        data = await res.json()
      } catch {
        data = null
      }
      return { ok: res.ok, status: res.status, data }
    }

    const post = (url, value) =>
      api(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value || {}) })

    function stop() {
      token += 1
      haltSources()
      broadcast(null)
      post('/stop').catch(() => {})
    }

    async function play(job, total, voice) {
      const mine = ++token
      // 有手势时 ctx 在 speakRequest 里已经 resume 过；自动朗读没有手势，
      // 这里给 resume 一次很短的机会，起不来就退回 <audio>（有人点过页面时它通常仍能放）。
      let ctx = contextOf()
      if (ctx && ctx.state !== 'running') {
        try {
          await Promise.race([ctx.resume(), new Promise((resolve) => setTimeout(resolve, 400))])
        } catch (error) {
          /* 被自动播放策略拒了 */
        }
        if (ctx.state !== 'running') ctx = null
      }
      const urls = new Map()
      const buffers = new Map()
      const load = async (index) => {
        if (buffers.has(index) || urls.has(index)) return
        const res = await fetch(`${PREFIX}/audio?job=${encodeURIComponent(job)}&i=${index}`)
        if (!res.ok) {
          const detail = await res.json().catch(() => null)
          throw new Error((detail && detail.error) || `第 ${index + 1} 句合成失败`)
        }
        if (ctx) buffers.set(index, await res.arrayBuffer())
        else urls.set(index, URL.createObjectURL(await res.blob()))
      }
      try {
        for (let index = 0; index < total; index += 1) {
          if (mine !== token) return
          broadcast({ job, index, total, voice, loading: true })
          await load(index)
          if (mine !== token) return
          broadcast({ job, index, total, voice })
          if (index + 1 < total) load(index + 1).catch(() => {})

          if (buffers.has(index)) {
            const data = buffers.get(index)
            buffers.delete(index)
            const decoded = await ctx.decodeAudioData(data.slice(0))
            if (mine !== token) return
            await new Promise((resolve) => {
              const src = ctx.createBufferSource()
              src.buffer = decoded
              src.connect(ctx.destination)
              sources.push(src)
              let settled = false
              const done = () => {
                if (settled) return
                settled = true
                resolve()
              }
              src.onended = done
              setTimeout(done, (Number(decoded.duration) + 30) * 1000)
              try {
                src.start()
              } catch (error) {
                done()
              }
            })
          } else if (urls.has(index)) {
            const url = urls.get(index)
            urls.delete(index)
            await new Promise((resolve) => {
              const player = new Audio(url)
              let settled = false
              const done = () => {
                if (settled) return
                settled = true
                resolve()
              }
              player.onended = done
              player.onerror = done
              player.play().catch(done)
              setTimeout(done, 120_000)
            })
          }
          if (mine !== token) return
        }
      } catch (error) {
        const message = String((error && error.message) || error)
        console.warn('[sovits-bridge]', error)
        broadcast({ job, index: 0, total, voice, error: message })
      } finally {
        if (mine === token) broadcast(null)
        setTimeout(() => urls.forEach((url) => URL.revokeObjectURL(url)), 30_000)
      }
    }

    async function speakRequest(payload) {
      unlock() // ⚠️ 必须在下面的 await 之前：这一步吃掉点击手势，之后的 start() 才不会被拦
      const result = await post('/speak', payload)
      if (!result.ok) {
        const message = (result.data && result.data.error) || `朗读失败（HTTP ${result.status}）`
        broadcast({ job: '', index: 0, total: 0, voice: '', error: message })
        return result
      }
      const { job, chunks, voice } = result.data
      played.add(job)
      play(job, chunks, voice)
      return result
    }

    // ---- 左下角播放条（纯 DOM，不依赖槽位） ------------------------------
    function mountBar() {
      if (typeof document === 'undefined' || !document.body) return () => {}
      const bar = document.createElement('div')
      bar.style.cssText = [
        'position:fixed',
        'left:18px',
        'bottom:18px',
        'z-index:99980',
        'display:none',
        'align-items:center',
        'gap:10px',
        'padding:8px 12px',
        'border-radius:999px',
        'border:1px solid rgba(0,0,0,.12)',
        'background:var(--dsw-alias-bg-elevated,#fff)',
        'box-shadow:0 6px 20px rgba(0,0,0,.12)',
        'font-size:12.5px',
        'color:var(--dsw-alias-text-primary,#1f2328)',
        'font-family:inherit',
      ].join(';')

      const text = document.createElement('span')
      const stopButton = document.createElement('button')
      stopButton.textContent = '停止'
      stopButton.style.cssText = 'font:inherit;padding:3px 10px;border-radius:6px;border:1px solid rgba(0,0,0,.14);background:transparent;cursor:pointer;color:inherit'
      stopButton.onclick = stop

      const save = document.createElement('a')
      save.textContent = '保存'
      save.style.cssText = 'font:inherit;padding:3px 10px;border-radius:6px;border:1px solid rgba(0,0,0,.14);text-decoration:none;color:inherit'
      save.setAttribute('download', '')

      bar.append(text, stopButton, save)
      document.body.appendChild(bar)

      let errorTimer = null
      const update = (value) => {
        if (!value) {
          bar.style.display = 'none'
          return
        }
        bar.style.display = 'inline-flex'
        if (value.error) {
          text.textContent = `⚠️ ${value.error}`
          stopButton.style.display = 'none'
          save.style.display = 'none'
          clearTimeout(errorTimer)
          errorTimer = setTimeout(() => {
            bar.style.display = 'none'
          }, 6000)
          return
        }
        stopButton.style.display = ''
        save.style.display = ''
        if (value.loading) {
          text.textContent = `⏳ 合成第 ${value.index + 1}/${value.total} 句…`
          save.style.display = 'none'
          return
        }
        text.textContent = `🔊 ${value.voice || ''} ${value.index + 1}/${value.total}`
        save.href = `${PREFIX}/export?job=${encodeURIComponent(value.job)}&i=${value.index}`
      }
      watchers.add(update)
      return () => {
        watchers.delete(update)
        bar.remove()
      }
    }

    // ---- 共用样式 --------------------------------------------------------
    const S = {
      page: { padding: '22px 26px', display: 'flex', flexDirection: 'column', gap: '18px', maxWidth: '980px', height: '100%', overflowY: 'auto' },
      title: { fontSize: '17px', fontWeight: 600, margin: '0 0 4px', color: 'var(--dsw-alias-text-primary, #1f2328)' },
      sub: { fontSize: '12.5px', color: 'var(--dsw-alias-text-secondary, #6b7280)', margin: 0, lineHeight: 1.6 },
      card: {
        border: '1px solid var(--dsw-alias-border-subtle, rgba(0,0,0,.09))',
        borderRadius: '10px',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        background: 'var(--dsw-alias-bg-elevated, #fff)',
      },
      row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      col: { display: 'flex', flexDirection: 'column', gap: '8px' },
      label: { fontSize: '13px', color: 'var(--dsw-alias-text-secondary, #4b5563)', display: 'flex', alignItems: 'center', gap: '6px' },
      input: {
        fontSize: '13px',
        padding: '6px 9px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-subtle, rgba(0,0,0,.14))',
        background: 'var(--dsw-alias-bg-base, #fff)',
        color: 'inherit',
        fontFamily: 'inherit',
      },
      button: {
        fontSize: '13px',
        padding: '6px 12px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-subtle, rgba(0,0,0,.14))',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      primary: {
        fontSize: '13px',
        padding: '6px 12px',
        borderRadius: '6px',
        border: '1px solid transparent',
        background: 'var(--dsw-alias-accent, #2563eb)',
        color: '#fff',
        cursor: 'pointer',
      },
      dot: (on) => ({ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: on ? '#16a34a' : '#9ca3af' }),
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '11.5px', color: 'var(--dsw-alias-text-secondary, #6b7280)', wordBreak: 'break-all' },
      note: { fontSize: '12px', color: 'var(--dsw-alias-text-secondary, #6b7280)' },
      error: { fontSize: '12px', color: '#dc2626', whiteSpace: 'pre-wrap' },
      ok: { fontSize: '12px', color: '#16a34a' },
      list: { display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '220px', overflowY: 'auto' },
      item: { display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 8px', borderRadius: '6px', fontSize: '12.5px' },
    }

    // ---- 设置页 ----------------------------------------------------------
    const PANEL_ID = 'sovits-bridge'

    function PanelIcon(props) {
      const size = (props && props.size) || 18
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M4 9.5h3l4.5-3.5v12L7 14.5H4z' }),
        h('path', { d: 'M15.5 9a4 4 0 0 1 0 6' }),
        h('path', { d: 'M18 6.5a7.5 7.5 0 0 1 0 11' }),
      )
    }

    function Panel() {
      const [data, setData] = React.useState(null)
      const [failed, setFailed] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [note, setNote] = React.useState('')
      const [fail, setFail] = React.useState('')
      const [dir, setDir] = React.useState('')
      const [outDir, setOutDir] = React.useState('')
      const [refs, setRefs] = React.useState([])
      const [prompt, setPrompt] = React.useState('')

      const refresh = React.useCallback(async () => {
        const result = await api('/state')
        if (result.ok && result.data) setData(result.data)
        else setFailed((result.data && result.data.error) || `HTTP ${result.status}`)
      }, [])

      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          if (!alive) return
          await refresh()
        }
        tick()
        const timer = setInterval(tick, 3000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [refresh])

      const voice = data ? data.voices.find((item) => item.id === data.voiceId) : null
      const settings = data ? data.settings : null
      const voiceId = voice ? voice.id : ''
      const voicePrompt = voice ? voice.promptText : ''

      React.useEffect(() => {
        setPrompt(voicePrompt || '')
      }, [voiceId, voicePrompt])

      const refDir = settings ? settings.refDir : ''

      React.useEffect(() => {
        if (!refDir) return
        let alive = true
        api('/files?kind=ref').then((result) => {
          if (alive && result.ok && result.data) setRefs(result.data.files || [])
        })
        return () => {
          alive = false
        }
      }, [refDir])

      if (!data) return h('div', { style: S.page }, h('div', { style: S.error }, failed || '正在读状态…'))

      const engine = data.engine
      const patch = async (value, message) => {
        setBusy('save')
        setFail('')
        const result = await post('/settings', value)
        setBusy('')
        if (!result.ok) setFail((result.data && result.data.error) || '保存失败')
        else if (message) setNote(message)
        await refresh()
      }

      const engineAction = async (action) => {
        setBusy(action)
        setFail('')
        setNote(action === 'start' ? '正在拉起引擎，首次要加载模型，等一会儿…' : '')
        const result = await post('/engine', { action })
        setBusy('')
        if (!result.ok) setFail((result.data && result.data.error) || '引擎没起来')
        else setNote(action === 'start' ? '引擎已就绪' : '引擎已停止')
        await refresh()
      }

      const scanVoices = async () => {
        setBusy('scan')
        setFail('')
        const result = await post('/voices', { action: 'scan' })
        setBusy('')
        if (!result.ok) setFail((result.data && result.data.error) || '扫描失败')
        else setNote(`扫到 ${result.data.found} 个音色`)
        await refresh()
      }

      const updateVoice = async (value, message) => {
        if (!voice) return
        setBusy('voice')
        const result = await post('/voices', { action: 'update', id: voice.id, patch: value })
        setBusy('')
        if (!result.ok) setFail((result.data && result.data.error) || '保存失败')
        else if (message) setNote(message)
        await refresh()
      }

      const preview = async () => {
        setBusy('preview')
        setFail('')
        const result = await speakRequest({ text: '你好，我是你的本地声音。这句话用来试听。' })
        setBusy('')
        if (!result.ok) setFail((result.data && result.data.error) || '念不出来')
      }

      // 交给宿主用系统资源管理器打开，比在页面里塞 file:// 可靠（浏览器会拦）
      const openFolder = async (kind) => {
        setFail('')
        const result = await post('/open', { kind })
        if (!result.ok) setFail((result.data && result.data.error) || '打不开这个文件夹')
      }

      return h(
        'div',
        { style: S.page },
        h('div', null, h('h2', { style: S.title }, '本地朗读'), h('p', { style: S.sub }, '把会话里的回复交给本机的 GPT-SoVITS 念出来。引擎是 api_v2（默认 9880），不需要开 WebUI；换音色 = 换一套「GPT 权重 + SoVITS 权重 + 参考音频」。')),

        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.row },
            h('span', { style: { ...S.label, fontWeight: 600, color: 'inherit' } }, h('span', { style: S.dot(engine.online) }), engine.online ? '引擎在线' : '引擎没在跑'),
            h('span', { style: S.note }, `端口 ${engine.port} · ${engine.startedByUs ? '本插件启动' : '外部进程'}`),
            h('span', { style: { flex: '1 1 auto' } }),
            h('button', { style: S.primary, disabled: Boolean(busy), onClick: () => engineAction('start') }, busy === 'start' ? '启动中…' : '启动'),
            h('button', { style: S.button, disabled: Boolean(busy), onClick: () => engineAction('stop') }, '停止'),
          ),
          h(
            'div',
            { style: S.row },
            h('label', { style: S.label }, '目录', h('input', { style: { ...S.input, width: '380px' }, value: dir || settings.dir, spellCheck: false, onChange: (event) => setDir(event.target.value) })),
            h('button', { style: S.button, onClick: () => patch({ dir }) }, '保存'),
            h('button', { style: S.button, onClick: () => openFolder('dir') }, '打开…'),
            h('label', { style: S.label }, h('input', { type: 'checkbox', checked: settings.autoStart === true, onChange: (event) => patch({ autoStart: event.target.checked }) }), '第一次朗读时自动启动'),
            h('select', { style: S.input, value: settings.device, onChange: (event) => patch({ device: event.target.value }) }, h('option', { value: 'cuda' }, 'CUDA'), h('option', { value: 'cpu' }, 'CPU（很慢）')),
          ),
          engine.error ? h('div', { style: S.error }, engine.error) : null,
          engine.log && engine.log.length ? h('div', { style: S.mono }, engine.log.slice(-4).join('\n')) : null,
        ),

        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.row },
            h('label', { style: S.label }, '音色'),
            data.voices.length
              ? h('select', { style: { ...S.input, minWidth: '220px' }, value: data.voiceId, onChange: (event) => patch({ voiceId: event.target.value }) }, data.voices.map((item) => h('option', { key: item.id, value: item.id }, item.name)))
              : h('span', { style: S.note }, '还没有音色'),
            h('button', { style: S.button, disabled: Boolean(busy), onClick: scanVoices }, busy === 'scan' ? '扫描中…' : '重新扫描'),
            h('button', { style: S.button, disabled: Boolean(busy), onClick: preview }, busy === 'preview' ? '准备中…' : '试听'),
            h('span', { style: { flex: '1 1 auto' } }),
            h('button', { style: S.button, onClick: stop }, '停止'),
          ),
          voice
            ? h(
                'div',
                { style: S.col },
                h('div', { style: S.mono }, `GPT  ${voice.gpt}`),
                h('div', { style: S.mono }, `SoVITS  ${voice.sovits}`),
                h(
                  'div',
                  { style: S.row },
                  h('label', { style: S.label }, '参考音频'),
                  h(
                    'select',
                    { style: { ...S.input, flex: '1 1 420px' }, value: voice.refPath || '', onChange: (event) => updateVoice({ ref: event.target.value }, '参考音频已换') },
                    h('option', { value: '' }, '（还没选）'),
                    refs.map((file) => h('option', { key: file.path, value: file.path }, file.name)),
                  ),
                  h('button', { style: S.button, onClick: () => openFolder('ref') }, '打开文件夹…'),
                ),
                h(
                  'div',
                  { style: { ...S.row, alignItems: 'flex-start' } },
                  h('label', { style: { ...S.label, paddingTop: '6px' } }, '参考文本'),
                  h('textarea', {
                    style: { ...S.input, flex: '1 1 420px', minHeight: '54px', resize: 'vertical' },
                    value: prompt,
                    placeholder: '参考音频里说的那句话，一字不差',
                    onChange: (event) => setPrompt(event.target.value),
                    onBlur: () => updateVoice({ promptText: prompt }, '参考文本已保存'),
                  }),
                ),
                h('span', { style: S.note }, '参考音频 + 参考文本决定「像谁」，权重决定「是谁的模型」。两者对不上会念得很怪。'),
              )
            : h('div', { style: S.note }, '点「重新扫描」会把权重目录和参考文件按名字配对成音色。'),
        ),

        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.row },
            h('label', { style: S.label }, h('input', { type: 'checkbox', checked: data.auto === true, onChange: (event) => patch({ auto: event.target.checked }) }), '新回复自动朗读'),
            h('label', { style: S.label }, '语速', h('input', { style: { ...S.input, width: '72px' }, type: 'number', min: 0.5, max: 2, step: 0.1, value: settings.speed, onChange: (event) => patch({ speed: Number(event.target.value) }) })),
          ),
          data.sessions.length
            ? h(
                'div',
                { style: S.list },
                data.sessions.map((item) =>
                  h(
                    'label',
                    { key: item.id, style: { ...S.item, cursor: 'pointer' } },
                    h('input', {
                      type: 'checkbox',
                      checked: data.listening.includes(item.id),
                      onChange: (event) => {
                        const next = event.target.checked ? [...data.listening, item.id] : data.listening.filter((id) => id !== item.id)
                        patch({ sessions: next })
                      },
                    }),
                    h('span', { style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.title || item.id),
                  ),
                ),
              )
            : h('div', { style: S.note }, '还没有会话列表。'),
          h('span', { style: S.note }, '只有勾上的会话会自动念；不勾也没关系，每条回复下面的小喇叭可以随时手动念。'),
        ),

        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.row },
            h('label', { style: S.label }, '输出文件夹'),
            h('input', {
              style: { ...S.input, flex: '1 1 360px' },
              value: outDir || settings.outDir,
              spellCheck: false,
              onChange: (event) => setOutDir(event.target.value),
            }),
            h('button', { style: S.button, onClick: () => patch({ outDir }) }, '保存'),
            h('button', { style: S.button, onClick: () => openFolder('out') }, '打开文件夹…'),
          ),
          h(
            'div',
            { style: S.row },
            h(
              'label',
              { style: S.label },
              h('input', { type: 'checkbox', checked: settings.saveAudio !== false, onChange: (event) => patch({ saveAudio: event.target.checked }) }),
              '每次念完自动存成 wav',
            ),
            h('span', { style: S.note }, '文件名是「时间-音色-序号.wav」，默认落在桌面\\本地朗读，可以改成任何文件夹。'),
          ),
        ),

        data.recent.length
          ? h(
              'div',
              { style: S.card },
              h('span', { style: { ...S.label, fontWeight: 600 } }, '最近念过'),
              h(
                'div',
                { style: S.list },
                data.recent.map((item) =>
                  h(
                    'div',
                    { key: item.id, style: { ...S.item, cursor: 'pointer' }, onClick: () => speakRequest({ text: item.text }) },
                    h('span', { style: S.note }, new Date(item.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })),
                    h('span', { style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.text),
                  ),
                ),
              ),
            )
          : null,

        fail ? h('div', { style: S.error }, fail) : null,
        note ? h('div', { style: S.ok }, note) : null,
        h('div', { style: S.note }, `状态文件：${settings.stateFile}`),
      )
    }

    // ---- 每条消息上的小喇叭 ----------------------------------------------
    function SpeakButton(props) {
      const [busy, setBusy] = React.useState(false)
      const [playing, setPlaying] = React.useState(false)
      const jobRef = React.useRef('')

      React.useEffect(() => {
        const watch = (value) => setPlaying(Boolean(value && jobRef.current && value.job === jobRef.current))
        watchers.add(watch)
        return () => {
          watchers.delete(watch)
        }
      }, [])

      const onClick = async () => {
        if (playing) {
          stop()
          return
        }
        setBusy(true)
        const result = await speakRequest({ sessionId: props.sessionId, messageId: props.messageId })
        setBusy(false)
        if (result.ok && result.data) jobRef.current = result.data.job
        else console.warn('[sovits-bridge]', result.data && result.data.error)
      }

      return h('button', { style: { ...S.button, padding: '2px 8px', fontSize: '12px' }, title: playing ? '停止' : '用本地声音念这段', onClick }, busy ? '…' : playing ? '⏹' : '🔊')
    }

    function apply(ctx) {
      const attempt = (label, fn) => {
        ctx.effect(() => {
          try {
            return fn()
          } catch (error) {
            console.warn(`[sovits-bridge] ${label} 挂不上去：`, error)
            return () => {}
          }
        }, `sovits-bridge: ${label}`)
      }

      // 左侧插件栏：列表项（sidebar.panellist）+ 主区域页面（main），两边用同一个 id 配对
      attempt('sidebar entry', () =>
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 92, label: '本地朗读' }, PanelIcon),
        ),
      )

      attempt('panel page', () =>
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, inject: () => ({}) }, Panel)),
      )

      attempt('message action', () =>
        ctx.slots.inject('conversation.chat.assistant-actions', () =>
          ctx.slots.register({ name: 'conversation.chat.assistant-actions', id: 'sovits-bridge', order: 40 }, SpeakButton),
        ),
      )

      attempt('player bar', () => mountBar())

      // 自动朗读：每 3 秒问一次宿主有没有新任务
      let alive = true
      const poll = async () => {
        try {
          const result = await api('/state')
          if (!alive || !result.ok || !result.data) return
          for (const item of result.data.pending || []) {
            if (!item.job || played.has(item.job)) continue
            played.add(item.job)
            play(item.job, item.chunks || 1, item.voice)
          }
        } catch {}
      }
      const timer = setInterval(poll, 3000)
      ctx.effect(() => () => {
        alive = false
        clearInterval(timer)
      }, 'sovits-bridge: auto poll')
    }

    exports.inject = ['slots']
    exports.apply = apply
    // 给自测用（浏览器里也挂着，不影响行为）
    exports.__internal = { speakRequest, stop, play, unlock, contextOf }
    return module.exports
  },
})

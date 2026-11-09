import { createApp, PREFIX } from './lib/app.js'

export const name = 'dsh-sovits-bridge'

// webServer：挂 /dsh-sovits-bridge/* 给面板和 <audio> 用
// sessions / sessionTitle：读会话、给勾选列表起名字
// timer：定时扫「一轮说完没有」
export const inject = ['webServer', 'sessions', 'sessionTitle', 'timer']

export function apply(ctx, config = {}) {
  const app = createApp({ ctx, config })

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler: app.handler }),
    'sovits-bridge: http routes',
  )

  ctx.effect(() => ctx.interval(app.scan, 2000), 'sovits-bridge: turn scanner')

  ctx.effect(() => () => app.dispose(), 'sovits-bridge: stop engine on dispose')

  return app
}

export { PREFIX }

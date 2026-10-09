// Which chats make sound through the headless Chrome profiles (contract: shared/headless-audio.ts). The runtime
// (browser/headless-audio-runtime.ts) runs on the Windows audio helper's lines; this plugin serves its state and mute.
// Only the Desk's own page may read or change it (browser/guard.ts).

import type { Context, Hono } from 'hono'
import { HEADLESS_AUDIO, HEADLESS_AUDIO_MUTE, type HeadlessAudioMuteIn, type HeadlessAudioState } from '@shared/headless-audio'
import { compileHelper, livePages, spawnHelper } from '../browser/headless-audio-host'
import { HeadlessAudio, chatResolver } from '../browser/headless-audio-runtime'
import { readPortFile } from '../browser/cdp'
import { notOwnPage } from '../browser/guard'
import { type Bridge, bridge } from '../bridge'
import type { ServerContext } from '../context'

const WORKERS_TTL_MS = 5000

export default function plugin(app: Hono, ctx: ServerContext): void {
  const b = (ctx.deps.bridge as Bridge | undefined) ?? bridge()
  const directChat = ctx.deps.chatForSession as ((sessionId: string) => string | null) | undefined

  let cached: { at: number; map: Map<string, string> } | null = null
  async function workerParents(): Promise<Map<string, string>> {
    const now = Date.now()
    if (cached && now - cached.at < WORKERS_TTL_MS) return cached.map
    const map = new Map<string, string>()
    for (const w of await b.workers({ all: true }).catch(() => [])) {
      if (!w.originSessionId) continue
      for (const s of w.sessions ?? []) map.set(s, w.originSessionId)
    }
    cached = { at: now, map }
    return map
  }

  async function chatOf(): Promise<(sessionId: string) => string | null> {
    return chatResolver(directChat ?? (() => null), await workerParents())
  }

  const runtime = new HeadlessAudio({
    platform: process.platform,
    compile: () => compileHelper(ctx.home),
    spawn: spawnHelper,
    page: livePages,
    readPort: (dir) => readPortFile(dir)?.port ?? null,
    chatOf,
    broadcast: (state) => ctx.broadcast({ type: 'browser.audio', state }),
  })

  runtime.start()
  ctx.onStop(() => runtime.stop())

  app.get(HEADLESS_AUDIO, (c) => {
    const why = notOwnPage(c.req.raw.headers)
    if (why) return c.json({ error: why }, 403)
    return c.json(runtime.state() satisfies HeadlessAudioState)
  })

  app.post(HEADLESS_AUDIO_MUTE, async (c: Context) => {
    const why = notOwnPage(c.req.raw.headers)
    if (why) return c.json({ error: why }, 403)
    const body = (await c.req.json().catch(() => null)) as Partial<HeadlessAudioMuteIn> | null
    if (typeof body?.chat !== 'string' || body.chat === '' || typeof body.muted !== 'boolean') {
      return c.json({ error: 'chat and muted required' }, 400)
    }
    return c.json(await runtime.setMuted(body.chat, body.muted))
  })
}

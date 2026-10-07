// The native host reports a page view's sound end to end (bun run e2e:host-audio; Windows): the real
// launcher/HydraDesk2.exe in --side-run (its own throwaway WebView2 folder, never the person's open window), a
// "window page" on one local origin that opens a browser view of a second local origin whose page plays a tone
// with no gesture, then mutes and unmutes that view through window.ipc. The window page forwards every
// `agenthydra:browser` event to this script. Passes when playing:true arrives, then muted:true, then muted:false.
// Only the side-run process this script started is closed (by pid). Exits 0 on pass, 1 with the received log.

import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const EXE = resolve(import.meta.dir, '../launcher/HydraDesk2.exe')
const WITHIN_MS = 20_000
const ID = 't1'

type Detail = { id?: string; type?: string; playing?: boolean; muted?: boolean; [k: string]: unknown }
const log: Detail[] = []
const pending: string[] = [] // ipc messages the window page should post, in order
let ready = '' // what the window page says about itself

// One second of 440 Hz at 22.05 kHz, 16-bit mono: loops forever from an <audio> tag.
function tone(): Uint8Array {
  const rate = 22_050
  const n = rate
  const buf = new ArrayBuffer(44 + n * 2)
  const v = new DataView(buf)
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  str(36, 'data'); v.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12_000), true)
  return new Uint8Array(buf)
}
const wav = tone()

const servers: ReturnType<typeof Bun.serve>[] = []
const origin = (s: ReturnType<typeof Bun.serve>) => `http://127.0.0.1:${s.port}`

const soundServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname
    if (p === '/tone.wav') {
      const range = req.headers.get('range')
      const m = range && /^bytes=(\d+)-(\d*)$/.exec(range)
      if (m) {
        const a = Number(m[1])
        const b = m[2] ? Math.min(Number(m[2]), wav.length - 1) : wav.length - 1
        return new Response(wav.slice(a, b + 1), {
          status: 206,
          headers: { 'content-type': 'audio/wav', 'content-range': `bytes ${a}-${b}/${wav.length}`, 'accept-ranges': 'bytes' },
        })
      }
      return new Response(wav, { headers: { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-length': String(wav.length) } })
    }
    if (p === '/sound.html') {
      return new Response('<!doctype html><title>sound</title><audio src="/tone.wav" autoplay loop></audio><p>tone</p>', {
        headers: { 'content-type': 'text/html' },
      })
    }
    return new Response('not found', { status: 404 })
  },
})
servers.push(soundServer)

const windowServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const p = new URL(req.url).pathname
    if (p === '/') {
      const open = JSON.stringify({ kind: 'browser', op: 'open', id: ID, url: `${origin(soundServer)}/sound.html`, rect: { left: 0, top: 0, right: 400, bottom: 300 } })
      return new Response(
        `<!doctype html><meta charset=utf-8><title>host-audio window page</title><body style="background:#111;color:#ddd">window page<script>
const post = (o) => fetch('/log', { method: 'POST', body: JSON.stringify(o) }).catch(() => {})
const audio = window.agentHydraHost && window.agentHydraHost.audio
post({ type: 'ready', audio, host: JSON.stringify(window.agentHydraHost || null) })
window.addEventListener('agenthydra:browser', (e) => post(e.detail))
if (audio === 1) {
  window.ipc.postMessage(${JSON.stringify(open)})
  setInterval(async () => {
    try {
      const r = await fetch('/cmd')
      const list = await r.json()
      for (const m of list) window.ipc.postMessage(m)
    } catch {}
  }, 150)
}
</script>`,
        { headers: { 'content-type': 'text/html' } },
      )
    }
    if (p === '/log' && req.method === 'POST') {
      const d = JSON.parse(await req.text()) as Detail
      if (d.type === 'ready') ready = JSON.stringify(d)
      else log.push(d)
      return new Response('ok')
    }
    if (p === '/cmd') return Response.json(pending.splice(0))
    return new Response('not found', { status: 404 })
  },
})
servers.push(windowServer)

let child: ReturnType<typeof spawn> | undefined
function cleanup() {
  const pid = child?.pid
  if (pid) {
    try {
      process.kill(pid)
    } catch {}
    // Its WebView2 children let go of the throwaway folder a moment after the host dies; the host sweeps what is left on its next side-run.
    try {
      rmSync(join(tmpdir(), `HydraDesk2-smoke-${pid}`), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    } catch {}
  }
  for (const s of servers) s.stop(true)
}

function fail(why: string): never {
  console.log(`FAIL ${why}`)
  console.log(`window page said: ${ready || '(nothing: it never loaded)'}`)
  console.log(`received log (${log.length}):`)
  for (const d of log) console.log('  ' + JSON.stringify(d))
  cleanup()
  process.exit(1)
}

async function waitFor(what: string, test: (d: Detail) => boolean, from: number, ms = WITHIN_MS): Promise<Detail> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const hit = log.slice(from).find(test)
    if (hit) return hit
    await Bun.sleep(100)
  }
  return fail(`no ${what} within ${ms / 1000} s`)
}

if (!existsSync(EXE)) fail(`${EXE} is missing`)

const env: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--autoplay-policy=no-user-gesture-required' // the child only
child = spawn(EXE, ['--side-run', '--url', `${origin(windowServer)}/`], { env, stdio: 'ignore', windowsHide: false })
console.log(`side-run pid ${child.pid}; window page ${origin(windowServer)}, sound page ${origin(soundServer)}`)

const isT1 = (d: Detail) => d.id === ID && d.type === 'audio'
const t0 = Date.now()
const playing = await waitFor(`{id:${ID},type:audio,playing:true,muted:false}`, (d) => isT1(d) && d.playing === true && d.muted === false, 0)
console.log(`PASS playing after ${Date.now() - t0} ms: ${JSON.stringify(playing)}`)
if (!/"audio":1/.test(ready)) fail('window page did not see agentHydraHost.audio === 1')

let at = log.length
pending.push(JSON.stringify({ kind: 'browser', op: 'mute', id: ID, muted: true }))
const muted = await waitFor(`{id:${ID},type:audio,muted:true}`, (d) => isT1(d) && d.muted === true, at, 10_000)
console.log(`PASS muted: ${JSON.stringify(muted)} (IsDocumentPlayingAudio while muted: ${muted.playing})`)

at = log.length
pending.push(JSON.stringify({ kind: 'browser', op: 'mute', id: ID, muted: false }))
const unmuted = await waitFor(`{id:${ID},type:audio,muted:false}`, (d) => isT1(d) && d.muted === false, at, 10_000)
console.log(`PASS unmuted: ${JSON.stringify(unmuted)}`)

console.log(`received log (${log.length}):`)
for (const d of log) console.log('  ' + JSON.stringify(d))
cleanup()
console.log('PASS host-audio')
process.exit(0)

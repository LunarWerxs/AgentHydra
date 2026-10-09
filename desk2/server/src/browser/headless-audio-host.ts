// The Windows and Chrome side of the headless audio runtime: the helper compiled with the .NET Framework's csc.exe into
// the data folder and started with no window, and each page's DevTools websocket for sound and mute.

import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PageSound } from './headless-audio'
import type { HelperPort, PageAccess } from './headless-audio-runtime'
import { pageTabs } from './cdp'

const CSC = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe'
const SOURCE = fileURLToPath(new URL('./audio-helper/HeadlessAudioHelper.cs', import.meta.url))
const CALL_MS = 2000
const GROUP = 'hydra-audio'

export async function compileHelper(home: string): Promise<string | null> {
  const dir = join(home, 'headless-audio')
  const exe = join(dir, 'HeadlessAudioHelper.exe')
  if (existsSync(exe) && statSync(exe).mtimeMs >= statSync(SOURCE).mtimeMs) return exe
  if (!existsSync(CSC)) return null
  mkdirSync(dir, { recursive: true })
  const proc = Bun.spawn([CSC, '/nologo', '/target:exe', '/optimize+', `/out:${exe}`, '/reference:System.Management.dll', SOURCE], {
    stdout: 'ignore',
    stderr: 'ignore',
    windowsHide: true,
  })
  return (await proc.exited) === 0 ? exe : null
}

export function spawnHelper(exe: string): HelperPort {
  const proc = Bun.spawn([exe], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', windowsHide: true })
  const listeners: ((line: string) => void)[] = []
  void (async () => {
    const reader = proc.stdout.pipeThrough(new TextDecoderStream()).getReader()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += value
      let at = buf.indexOf('\n')
      while (at >= 0) {
        const line = buf.slice(0, at).trim()
        buf = buf.slice(at + 1)
        if (line !== '') for (const fn of listeners) fn(line)
        at = buf.indexOf('\n')
      }
    }
  })().catch(() => undefined)
  return {
    onLine: (fn) => listeners.push(fn),
    send: (line) => {
      try {
        proc.stdin.write(`${line}\n`)
        void proc.stdin.flush()
      } catch {
        // the helper is gone; the restart loop starts a new one
      }
    },
    exited: proc.exited,
    kill: () => proc.kill(),
  }
}

type Call = (method: string, params?: Record<string, unknown>) => Promise<any>

async function openPage(port: number, id: string): Promise<{ call: Call; close(): void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${encodeURIComponent(id)}`)
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  let seq = 0
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message?: string } }
    if (msg.id === undefined) return
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.error) p.reject(new Error(msg.error.message ?? 'cdp error'))
    else p.resolve(msg.result)
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cdp connect timeout')), CALL_MS)
      ws.onopen = () => {
        clearTimeout(timer)
        resolve()
      }
      ws.onerror = () => {
        clearTimeout(timer)
        reject(new Error('cdp socket'))
      }
    })
  } catch (err) {
    ws.close()
    throw err
  }
  const call: Call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const callId = ++seq
      const timer = setTimeout(() => {
        pending.delete(callId)
        reject(new Error(`${method} timed out`))
      }, CALL_MS)
      pending.set(callId, { resolve, reject, timer })
      ws.send(JSON.stringify({ id: callId, method, params }))
    })
  return { call, close: () => ws.close() }
}

async function instancesOf(call: Call, proto: string): Promise<string | null> {
  const ev = await call('Runtime.evaluate', { expression: proto, objectGroup: GROUP })
  const objectId = ev.result?.objectId as string | undefined
  if (!objectId || ev.exceptionDetails) return null
  const q = await call('Runtime.queryObjects', { prototypeObjectId: objectId, objectGroup: GROUP })
  return (q.objects?.objectId as string | undefined) ?? null
}

async function countOn(call: Call, objectId: string | null, fn: string): Promise<number> {
  if (objectId === null) return 0
  const r = await call('Runtime.callFunctionOn', { objectId, functionDeclaration: fn, returnByValue: true })
  return Number(r.result?.value ?? 0)
}

const PLAYING = 'function(){return this.filter(e=>!e.paused&&!e.muted&&e.volume>0).length}'
const RUNNING = 'function(){return this.filter(c=>c.state==="running").length}'
const MUTE_MEDIA =
  'function(){const L=window.__hydraMuted||(window.__hydraMuted=[]);let n=0;for(const e of this)if(!e.muted){e.muted=true;L.push(e);n++}return n}'
const SUSPEND =
  'function(){const L=window.__hydraMuted||(window.__hydraMuted=[]);let n=0;for(const c of this)if(c.state==="running"){c.suspend().catch(()=>{});L.push(c);n++}return n}'
const RESTORE =
  '(function(){const L=window.__hydraMuted||[];window.__hydraMuted=[];for(const x of L){if("muted" in x)x.muted=false;else x.resume().catch(()=>{})}return L.length})()'

export const livePages: PageAccess = {
  tabs: (port) => pageTabs(port),
  async sound(port, id): Promise<PageSound> {
    const page = await openPage(port, id)
    try {
      const audible = await countOn(page.call, await instancesOf(page.call, 'HTMLMediaElement.prototype'), PLAYING)
      const contexts = await countOn(page.call, await instancesOf(page.call, 'AudioContext.prototype'), RUNNING)
      return { audible, contexts }
    } finally {
      await page.call('Runtime.releaseObjectGroup', { objectGroup: GROUP }).catch(() => undefined)
      page.close()
    }
  },
  async mute(port, id, on): Promise<void> {
    const page = await openPage(port, id)
    try {
      if (on) {
        await countOn(page.call, await instancesOf(page.call, 'HTMLMediaElement.prototype'), MUTE_MEDIA)
        await countOn(page.call, await instancesOf(page.call, 'AudioContext.prototype'), SUSPEND)
      } else {
        await page.call('Runtime.evaluate', { expression: RESTORE, returnByValue: true })
      }
    } finally {
      await page.call('Runtime.releaseObjectGroup', { objectGroup: GROUP }).catch(() => undefined)
      page.close()
    }
  },
}

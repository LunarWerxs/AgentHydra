/**
 * THE SWITCH, read and thrown from the phone.
 *
 * Nothing in the orchestrator acts without the tray icon (owner order, 2026-09-01: "it can't be
 * running without the status bar icon, so I can terminate it if I want"). The icon beats into
 * state/tray.json; scripts/lib/armlib.py reads that beat before every act. This module reads the
 * SAME file with the SAME rules (fresh = under 60 s, `paused` reads as off) so the page and the
 * lanes can never disagree, and it throws the switch only through the toolbox's own entry point -
 * `python orch.py arm` / `python orch.py disarm` - never by touching the file itself.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT, STATE_DIR } from './config.ts'

/** Same as armlib.STALE_SECS. */
export const STALE_SECS = 60
/** How far ahead of us a heartbeat may be dated before it stops counting as one. */
export const FUTURE_TOLERANCE_SECS = 30

export interface SwitchStatus {
  up: boolean
  paused: boolean
  pid: number | null
  ageSecs: number | null
  why: string
}

/** armlib.tray_status without the pid liveness probe: a fresh beat from a dead process can
 *  only last STALE_SECS, and a page refresh is cheaper than a tasklist per request. */
export function trayStatus(nowMs = Date.now(), path = join(STATE_DIR, 'tray.json')): SwitchStatus {
  let rec: { at?: number; pid?: number; paused?: boolean }
  try {
    rec = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {
      up: false,
      paused: false,
      pid: null,
      ageSecs: null,
      why: 'the tray icon is not running',
    }
  }
  const rawAge = (nowMs - Number(rec.at ?? 0)) / 1000
  const pid = typeof rec.pid === 'number' ? rec.pid : null
  const paused = !!rec.paused
  // ⛔ A BEAT FROM THE FUTURE IS NOT A FRESH BEAT. Clamping a negative age to 0 (which this did)
  // makes any future timestamp read as up:true forever, so a clock stepped backwards - an NTP
  // correction, a VM resume, a DST slip - would leave a dead icon looking alive for the whole
  // skew, with the public tunnel still open. A small tolerance absorbs ordinary jitter between
  // the writer's clock and ours; beyond that the record is not trustworthy and is treated as
  // gone, which is the safe direction. Found by audit, 2026-09-03.
  if (rawAge < -FUTURE_TOLERANCE_SECS) {
    return {
      up: false,
      paused,
      pid,
      ageSecs: Math.round(rawAge),
      why: `the tray icon's heartbeat is dated ${Math.abs(Math.round(rawAge))}s in the future - the clock moved, so it cannot be trusted`,
    }
  }
  const age = Math.max(0, rawAge)
  if (age > STALE_SECS) {
    return {
      up: false,
      paused,
      pid,
      ageSecs: Math.floor(age),
      why: `the tray icon's heartbeat is ${Math.floor(age)}s old - it is gone`,
    }
  }
  return {
    up: true,
    paused,
    pid,
    ageSecs: Math.floor(age),
    why: paused ? "paused from the icon's menu" : '',
  }
}

/**
 * THE TRAY SUPERVISION WATCHDOG - what makes "no icon, no remote access" structural.
 *
 * The tray icon starts this gateway and stops it again on Exit, which covers the orderly case.
 * It does not cover a HARD kill (Task Manager, a crashed PowerShell host, a logout that reaps the
 * icon), and that gap matters more here than anywhere else in the toolbox: this process can throw
 * the arm switch from a phone, so a gateway outliving its icon is a way to arm the machine with
 * no kill switch present on screen - exactly what the owner's rule forbids. So the gateway also
 * watches the heartbeat itself and shuts down when it goes stale.
 *
 * PAUSED IS NOT GONE. A paused icon still beats (`up: true, paused: true`), so pausing the lanes
 * deliberately keeps the dashboard reachable - otherwise pausing from the phone would sever the
 * connection you would need to un-pause.
 *
 * Only armed when the tray sets ORCH_TRAY_SUPERVISED=1, so `bun run remote` in a terminal is
 * still a normal foreground process a developer owns.
 */
export function watchTray(
  onLost: (why: string) => void,
  opts: { intervalMs?: number; graceTicks?: number; read?: () => SwitchStatus } = {},
): { stop: () => void } {
  const intervalMs = opts.intervalMs ?? 15_000
  // Two consecutive stale reads before acting: a single missed beat is a busy machine, not a
  // closed icon, and killing remote access on one hiccup would be its own outage.
  const graceTicks = opts.graceTicks ?? 2
  const read = opts.read ?? (() => trayStatus())
  let missed = 0
  const timer = setInterval(() => {
    const s = read()
    if (s.up) {
      missed = 0
      return
    }
    missed += 1
    if (missed >= graceTicks) {
      clearInterval(timer)
      onLost(s.why || 'the tray icon is not running')
    }
  }, intervalMs)
  // Never hold the process open on this timer alone: if everything else has finished, the
  // gateway should be free to exit rather than being pinned alive by its own watchdog.
  ;(timer as unknown as { unref?: () => void }).unref?.()
  return { stop: () => clearInterval(timer) }
}

export interface OrchResult {
  ok: boolean
  code: number | null
  output: string
}

let inFlight: Promise<OrchResult> | null = null

/** Run `python orch.py <args>` in the repo, one at a time, with a hard timeout. */
export function runOrch(args: string[], timeoutMs: number): Promise<OrchResult> {
  const run = async (): Promise<OrchResult> => {
    const python = process.env.ORCH_PYTHON_CONSOLE ?? 'python'
    return new Promise<OrchResult>((resolve) => {
      let out = ''
      let settled = false
      const child = spawn(python, [join(REPO_ROOT, 'orch.py'), ...args], {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // orch.py never needs the tunnel credential; do not pass it one (audit, 2026-09-03).
        env: { ...process.env, CF_TUNNEL_TOKEN: undefined } as NodeJS.ProcessEnv,
      })
      const finish = (code: number | null, extra = ''): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ ok: code === 0, code, output: `${out}${extra}`.trim().slice(-4000) })
      }
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* gone */
        }
        finish(null, `\n(timed out after ${Math.round(timeoutMs / 1000)}s)`)
      }, timeoutMs)
      child.stdout.on('data', (b: Buffer) => {
        out += b.toString()
      })
      child.stderr.on('data', (b: Buffer) => {
        out += b.toString()
      })
      child.on('error', (err) => finish(null, `\n${String(err)}`))
      child.on('exit', (code) => finish(code))
    })
  }
  const next = (inFlight ?? Promise.resolve()).then(run, run)
  inFlight = next.finally(() => {
    if (inFlight === next) inFlight = null
  })
  return next
}

/** `orch.py arm` registers any missing lane and starts the icon; waits for its first heartbeat. */
export function arm(): Promise<OrchResult> {
  return runOrch(['arm'], 60_000)
}

export function disarm(): Promise<OrchResult> {
  return runOrch(['disarm'], 30_000)
}

#!/usr/bin/env node
// scripts/watchdog.mjs - SUPERVISE THE DAEMON, because nothing else does.
//
// WHY THIS EXISTS. The standing sweep is the thing that keeps the fleet decided: it gates every
// chat every couple of minutes, archives what is done, delivers staged prompts, and opens an
// work when chats are waiting. All of that lives in ONE process, and on this machine
// that process had no supervisor at all - no tray host, no service wrapper, nothing. If it died
// or its loop stopped, the fleet simply stopped being managed and NOTHING SAID SO.
//
// That silence is the exact failure class this project keeps re-learning. A launch onto an
// expired login still stamped the cooldown, so the fleet looked attended while nothing was
// happening. A gate whose UI click failed still reported the archive. An unsupervised daemon is
// the same lie at the largest scale available: every dashboard reads "fine" because nothing is
// left running to say otherwise.
//
// THE ALARM OUTRANKS THE RESTART. A loop that fails visibly beats one that fails quietly, so
// every unhealthy verdict raises a STICKY Windows toast whether or not the restart works. The
// restart is the convenience; the noise is the point.
//
// TWO FAILURES, NOT ONE. Probing "is the process up" would have missed the more dangerous shape:
// the daemon alive but its sweep loop no longer ticking. So this checks liveness AND liveliness -
// the loop's own lastRun stamp against its configured interval. A daemon answering HTTP while its
// loop is dead is precisely the thing that looks healthiest and is not.
//
// WHO SUPERVISES THE SUPERVISOR: nobody, deliberately. This is a short-lived script run by
// Windows Task Scheduler, which the OS keeps. A resident watchdog process would just move the
// unsupervised-process problem one step along.
//
// Usage:
//   node scripts/watchdog.mjs            # one check; exit 0 healthy, 1 unhealthy
//   node scripts/watchdog.mjs --install  # register the scheduled task (every 2 minutes)
//   node scripts/watchdog.mjs --status   # what the last checks saw
//   node scripts/watchdog.mjs --no-restart   # alarm only, never restart

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { wedgedVerdict } from '../server/src/watchdog-health.ts'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.AGENTHYDRA_PORT ?? process.env.PORT ?? 7787)
const BASE = `http://127.0.0.1:${PORT}`
const STATE_DIR = join(process.env.LOCALAPPDATA ?? join(homedir(), '.agenthydra'), 'AgentHydra')
const STATE_FILE = join(STATE_DIR, 'watchdog-state.json')
const TASK_NAME = 'AgentHydra Daemon Watchdog'

/** Re-alarm no more often than this while a fault persists, so a broken daemon does not paint
 *  the screen with toasts - but never goes quiet either, which would be the original bug. */
const REALARM_MS = 30 * 60_000

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return { status: 'unknown', since: 0, lastAlarmAt: 0, consecutiveWedged: 0 }
  }
}

function writeState(s) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(s, null, 2))
  } catch {
    // A watchdog that cannot persist still checks and still alarms; it just re-alarms more.
  }
}

async function probe(timeoutMs = 8000) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(`${BASE}/api/sweep-loop`, { signal: ac.signal })
    if (!r.ok) return { up: false, reason: `HTTP ${r.status}` }
    return { up: true, status: await r.json() }
  } catch (err) {
    return { up: false, reason: err?.name === 'AbortError' ? 'timed out' : String(err?.message ?? err) }
  } finally {
    clearTimeout(t)
  }
}

/**
 * Raise the alarm, through THE APP'S OWN toast builder rather than a copy of it.
 *
 * The first cut hand-rolled the PowerShell, and it silently produced no toast at all: it omitted
 * one line - the WinRT projection for `Windows.Data.Xml.Dom.XmlDocument` - so every alarm died
 * on "cannot find type" while the restart half kept reporting success. A watchdog whose alarm
 * does not fire is the failure it exists to prevent, wearing the watchdog's own badge. There is
 * exactly one toast implementation in this repo now, and it is the one already proven in the
 * daemon.
 */
async function alarm(title, body) {
  try {
    const { windowsToastScript, encodePowerShellCommand } = await import(
      '../server/src/notify-os.ts'
    )
    const script = windowsToastScript({ title, body, sticky: true })
    const r = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShellCommand(script)],
      // ⛔ windowsHide, or the alarm becomes the nuisance it is warning about. This runs from a
      // scheduled task with no console of its own, so powershell.exe would allocate a NEW
      // visible one every time it fires - a console flashing on the owner's screen on a timer,
      // which is exactly the complaint that produced the hidden-by-default rule. The toast is
      // the alarm; the window is not part of it. Found by an audit of every spawn in the repo,
      // not by noticing it here.
      { encoding: 'utf8', timeout: 20_000, windowsHide: true },
    )
    // The alarm failing is itself worth saying out loud, into the log the scheduled task keeps.
    if (r.status !== 0)
      console.error(`[watchdog] TOAST FAILED: ${(r.stderr ?? '').trim().slice(0, 300)}`)
    return r.status === 0
  } catch (err) {
    console.error(`[watchdog] TOAST FAILED to build: ${err?.message ?? err}`)
    return false
  }
}

function bunExe() {
  for (const p of [
    join(homedir(), '.bun', 'bin', 'bun.exe'),
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'bun', 'bin', 'bun.exe'),
  ])
    if (existsSync(p)) return p
  return 'bun'
}

async function restart() {
  // Detached and fully released: the daemon must outlive this short-lived watchdog process, and
  // a child still tied to it would die with the task.
  const child = spawn(bunExe(), ['server/src/index.ts'], {
    cwd: APP_DIR,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    if ((await probe(4000)).up) return { ok: true, secs: (i + 1) * 2 }
  }
  return { ok: false }
}

function installTask() {
  // schtasks, not a resident process: the OS is the only supervisor that never needs one itself.
  const cmd = `"${bunExe()}" "${join(APP_DIR, 'scripts', 'watchdog.mjs')}"`
  const r = spawnSync(
    'schtasks',
    [
      '/Create', '/F',
      '/TN', TASK_NAME,
      '/SC', 'MINUTE', '/MO', '2',
      '/TR', cmd,
      '/RL', 'LIMITED',
    ],
    // Same reason as the alarm: schtasks is a console program, and a silent install path with
    // no console of its own would flash a window registering the task.
    { encoding: 'utf8', windowsHide: true },
  )
  console.log((r.stdout || r.stderr || '').trim())
  return r.status === 0
}

/** --install / --status short-circuit before anything is probed. Neither returns. */
function handleFlags(argv) {
  if (argv.includes('--install')) process.exit(installTask() ? 0 : 1)
  if (argv.includes('--status')) {
    console.log(JSON.stringify(readState(), null, 2))
    process.exit(0)
  }
}

/** The verdict from one probe: down (restarted first, when that is allowed), wedged, or healthy. */
async function firstVerdict(first, now, mayRestart) {
  if (first.up) {
    const w = wedgedVerdict(first.status, now)
    return w.wedged
      ? {
          status: 'wedged',
          detail: `The daemon answers but ${w.why}. The fleet is not being swept.`,
        }
      : { status: 'healthy', detail: w.why }
  }
  const detail = `The AgentHydra daemon is not responding on port ${PORT} (${first.reason}).`
  if (!mayRestart)
    return { status: 'down', detail: `${detail} Restart is disabled (--no-restart).` }
  const r = await restart()
  return {
    status: r.ok ? 'restarted' : 'down',
    detail:
      detail +
      (r.ok
        ? ` It was restarted and answered after ${r.secs}s.`
        : ' The restart FAILED - the fleet is not being managed right now.'),
  }
}

/**
 * A WEDGED daemon is restarted only on the SECOND consecutive sighting. One long tick is not a
 * fault, and killing a daemon mid-UI-click to fix a problem it did not have would be its own
 * outage. The alarm, however, goes out on the first.
 *
 * Returns the consecutive-wedged run to persist; appends the restart outcome to `verdict.detail`
 * exactly as the inline version did.
 */
async function escalateWedged(verdict, state, mayRestart) {
  if (verdict.status !== 'wedged') return 0
  const wedgedRun = (state.consecutiveWedged ?? 0) + 1
  if (wedgedRun < 2 || !mayRestart) return wedgedRun
  const r = await restart()
  verdict.detail += r.ok ? ' It was restarted.' : ' The restart FAILED.'
  return r.ok ? 0 : wedgedRun
}

/** Alarm on every unhealthy verdict that is new or has gone unacknowledged for a while, and once
 *  on recovery - a fault that clears silently leaves the last thing you saw being a lie. */
function raiseAlarm(verdict, state, changed, stale) {
  const healthy = verdict.status === 'healthy'
  if (!healthy && (changed || stale))
    return alarm('AgentHydra: the fleet is not being managed', verdict.detail)
  if (healthy && changed && state.status !== 'unknown')
    return alarm('AgentHydra: back to normal', verdict.detail)
  return false
}

async function main() {
  const argv = process.argv.slice(2)
  handleFlags(argv)
  const mayRestart = !argv.includes('--no-restart')

  const now = Date.now()
  const state = readState()
  const first = await probe()

  const verdict = await firstVerdict(first, now, mayRestart)
  const wedgedRun = await escalateWedged(verdict, state, mayRestart)

  const healthy = verdict.status === 'healthy'
  const changed = state.status !== verdict.status
  const stale = now - (state.lastAlarmAt ?? 0) > REALARM_MS
  const alarmed = raiseAlarm(verdict, state, changed, stale)

  writeState({
    status: verdict.status,
    detail: verdict.detail,
    since: changed ? now : (state.since ?? now),
    checkedAt: new Date(now).toISOString(),
    lastAlarmAt: alarmed ? now : (state.lastAlarmAt ?? 0),
    consecutiveWedged: wedgedRun,
  })

  console.log(`[watchdog] ${verdict.status}: ${verdict.detail}`)
  process.exit(healthy || verdict.status === 'restarted' ? 0 : 1)
}

// Importable for tests without running a check.
if (!process.env.AGENTHYDRA_WATCHDOG_IMPORT_ONLY) await main()

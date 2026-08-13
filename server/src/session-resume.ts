// server/src/session-resume.ts — reopen a finished session in a real terminal.
//
// AgentHydra can type into a session that is already running, and could queue a new run against
// one, but there was no way to simply SIT BACK DOWN in a finished conversation and keep going by
// hand. `claude --resume <id>` does exactly that, and the only thing missing was somewhere to run it.
//
// THE TERMINAL IS THE USER'S SURFACE, not ours. The daemon opens a window and gets out of the way:
// it does not pipe the session, does not capture output, and does not track the process. That is the
// same posture core/cli-instances.ts takes for "Launch", and for the same reason — an interactive
// Claude session belongs in a terminal the user owns, not behind a web UI that would have to
// re-implement one.
//
// THIS WINDOW IS MEANT TO BE SEEN, which is the opposite of nearly every other spawn in this repo,
// so `windowsHide` is deliberately ABSENT here. scripts/checks/spawn-console-window.mjs enforces
// that intent everywhere else and skips this file for the same reason it skips cli-instances.ts:
// hiding the window would defeat the entire feature. Ground rule 4 in PLAN.md, satisfied by being
// in the exempt list rather than by accident.
//
// THE COMMAND IS ALWAYS AVAILABLE AS TEXT. Terminal detection cannot be right on every machine —
// a Linux box with no `x-terminal-emulator`, a Windows user who lives in WSL, someone whose Claude
// CLI is not on PATH — so the API returns the command line it would run alongside launching it, and
// the UI offers "copy the command" whether or not the spawn worked. A feature that fails silently on
// an unusual setup is worse than one that hands you the string.

import { resolveClaudeExe } from './config'
import type { SessionSource } from './types'

export interface ResumePlan {
  /** What to spawn. Empty when this platform has no known way to open a terminal. */
  argv: string[]
  /** The same thing as text, for the copy-to-clipboard fallback. Always populated. */
  command: string
  /** Where it would run. */
  cwd: string | null
}

/** Quote only when it needs it, so the copyable command stays readable. */
function quote(s: string): string {
  return /[\s"']/.test(s) ? `"${s.replaceAll('"', '\\"')}"` : s
}

/**
 * The command that reopens this session, and the argv that would launch it in a terminal.
 *
 * Pure and platform-parameterised so the tests can pin all three platforms from one machine, the
 * same shape server/src/transcript-open.ts uses for the editor launch.
 */
export function buildResumePlan(
  platform: NodeJS.Platform,
  sessionId: string,
  exe: string,
  cwd: string | null,
): ResumePlan {
  const command = `${quote(exe)} --resume ${sessionId}`
  if (platform === 'win32') {
    // `/k` keeps the window alive after claude exits, so a failed resume leaves its own error on
    // screen instead of a window that blinks out of existence. The empty '' is start's title slot,
    // which is not optional: without it `start` treats the quoted path as the title and opens a
    // blank console (the same trap transcript-open.ts documents).
    return { argv: ['cmd', '/c', 'start', '', 'cmd', '/k', command], command, cwd }
  }
  if (platform === 'darwin') {
    const script = `tell application "Terminal" to do script ${JSON.stringify(
      cwd ? `cd ${quote(cwd)} && ${command}` : command,
    )}`
    return { argv: ['osascript', '-e', script], command, cwd }
  }
  if (platform === 'linux') {
    // `exec bash` for the same reason as `/k` above: keep the shell after the CLI exits.
    return {
      argv: ['x-terminal-emulator', '-e', 'bash', '-lc', `${command}; exec bash`],
      command,
      cwd,
    }
  }
  // An unknown platform still gets the command text; only the launch is unavailable.
  return { argv: [], command, cwd }
}

export interface ResumeResult {
  ok: boolean
  /** The command line, always. The UI shows this whether the launch worked or not. */
  command: string
  /** Why the terminal did not open, when it did not. Never a reason to withhold `command`. */
  reason?: string
}

/**
 * Open a terminal sitting in this session. Only Claude sessions can be resumed this way — Codex and
 * OpenCode have their own CLIs and their own resume syntax, and inventing one here would produce a
 * command that looks authoritative and does not work.
 */
export function resumeSessionInTerminal(
  sessionId: string,
  source: SessionSource,
  cwd: string | null,
): ResumeResult {
  const exe = resolveClaudeExe()
  const plan = buildResumePlan(process.platform, sessionId, exe, cwd)
  if (source !== 'claude') return { ok: false, command: plan.command, reason: 'source-unsupported' }
  if (plan.argv.length === 0) return { ok: false, command: plan.command, reason: 'no-terminal' }
  try {
    Bun.spawn(plan.argv, {
      // No windowsHide: see the header. This window is the point.
      ...(cwd ? { cwd } : {}),
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    })
    return { ok: true, command: plan.command }
  } catch (err) {
    return {
      ok: false,
      command: plan.command,
      reason: err instanceof Error ? err.message : 'spawn-failed',
    }
  }
}

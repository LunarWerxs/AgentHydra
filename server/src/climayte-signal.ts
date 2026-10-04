// server/src/climayte-signal.ts — how a running CliMayte worker is told to wind down, and the hooks
// that carry it into the CLI.
//
// The daemon writes the worker's signal file (signalWindDown, climayte.ts). The CLI shows it to the
// model through a PostToolUse hook that runs after EVERY tool call. As a shell command (`cat <file>`)
// that hook cost Git's bash launcher, bash, cat and a conhost for each: measured 2026-10-04 on a box
// running 14 workers, about 88 of every 1,000 process births and 3 to 5 processes a call, to print
// nothing 12 times in 14. An `http` hook costs the CLI one POST to 127.0.0.1 and starts nothing, and
// a hook that cannot be reached is a non-blocking error, so a worker is never held up by it.
//
// What answers is the worker's OWN runner (climayte-runner.ts), not the daemon: it lives exactly as
// long as the worker, so a daemon restart (which may land on another port) cannot strand a running
// worker's hook, and a stalled daemon (9 s main-thread stalls were measured the same day) cannot
// slow its tool calls. The runner serves the signal file and, before it starts the CLI, rewrites the
// settings file the daemon wrote so the hook points at it. Until then, and if either step fails,
// the settings keep the `cat` form: nothing is lost, it is only dearer.
//
// Imports nothing of the daemon's: the runner process loads this too.

import { readFileSync, writeFileSync } from 'node:fs'

/** Longest a tool call can wait on the signal hook. The answer is one small file read; a runner that
 *  has not answered in this long is gone, and the call goes on without it. */
export const SIGNAL_HOOK_TIMEOUT_S = 3

type Hook =
  | { type: 'command'; command: string; args?: string[]; timeout?: number }
  | { type: 'http'; url: string; timeout?: number }
export interface HookGroup {
  matcher: string
  hooks: Hook[]
}
export interface WorkerHooks {
  PreToolUse?: HookGroup[]
  PostToolUse: HookGroup[]
}

/** The hooks of a worker's own settings file, as the daemon writes them.
 *  - PostToolUse, every tool: the wind-down signal, in its shell form (the runner swaps in the http
 *    form, pointSignalHook). `signalFile` is slash-separated, for the shell.
 *  - PreToolUse on edits, when the owner's edit_claims hook is installed: it records the file under
 *    this task's id and says when another chat or worker edited it in the last half hour (2026-10-01:
 *    workers carry none of the owner's hooks, so their edits were invisible to the other chats). In
 *    exec form, `python` itself with no shell in front: the hook is advisory (it never exits 2), so
 *    the `|| true` the shell form carried changes nothing, and `-S` skips the site import (it reads
 *    only the standard library). */
export function workerHooks(opts: { signalFile: string; claims: string | null }): WorkerHooks {
  return {
    ...(opts.claims
      ? {
          PreToolUse: [
            {
              matcher: 'Edit|Write|MultiEdit|NotebookEdit',
              hooks: [
                { type: 'command', command: 'python', args: ['-S', opts.claims], timeout: 10 },
              ],
            },
          ],
        }
      : {}),
    PostToolUse: [
      {
        matcher: '*',
        hooks: [{ type: 'command', command: `cat '${opts.signalFile}' 2>/dev/null || true` }],
      },
    ],
  }
}

/** A loopback server that answers every request with the signal file's JSON, or `{}` when there is
 *  none (or it is half written: the daemon writes it in one call, but a read can still land inside
 *  it). Read afresh each time, so the signal shows on every call from the moment it is written
 *  until the file is removed, as the `cat` it replaces did. Null when no port could be bound. */
export function serveSignal(signalFile: string): { port: number; stop: () => void } | null {
  try {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        let body = '{}'
        try {
          const text = readFileSync(signalFile, 'utf8')
          JSON.parse(text)
          body = text
        } catch {
          // No signal yet, or not whole: nothing to say.
        }
        return new Response(body, { headers: { 'content-type': 'application/json' } })
      },
    })
    return { port: server.port as number, stop: () => void server.stop(true) }
  } catch {
    return null
  }
}

/** Rewrite the worker's settings so its PostToolUse hook is an http hook at the runner's port.
 *  False, with the file untouched, when it cannot be read or parsed. */
export function pointSignalHook(settingsFile: string, port: number): boolean {
  try {
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as {
      hooks?: Record<string, unknown>
    }
    settings.hooks = {
      ...settings.hooks,
      PostToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'http',
              url: `http://127.0.0.1:${port}/signal`,
              timeout: SIGNAL_HOOK_TIMEOUT_S,
            },
          ],
        },
      ],
    }
    writeFileSync(settingsFile, JSON.stringify(settings))
    return true
  } catch {
    return false
  }
}

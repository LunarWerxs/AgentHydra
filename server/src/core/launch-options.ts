import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Model/effort values eventually appear in a command used to open a visible terminal — inline in a
 * command string on macOS/Linux, as argv entries on Windows. Keep that narrow shell boundary
 * value-blind: real model ids need letters, digits, and a small separator set, never shell
 * metacharacters, quotes, whitespace, or variable expansion.
 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/

/**
 * Windows argv for opening a persistent terminal running `exe args…`.
 *
 * `start` needs its mandatory (here empty) title slot; `/k` keeps the window open after the program
 * exits so the user can read output or answer a login prompt.
 *
 * ⚠ The exe and each arg MUST stay SEPARATE argv entries. Pre-quoting the path and joining it all
 * into one string — which both callers used to do — is silently broken: the spawn layer applies
 * MSVCRT quoting to whatever we hand it, so `"C:\…\claude.exe"` reaches the real command line as
 * `"\"C:\…\claude.exe\""`. cmd.exe has no backslash escape, so it strips the outer pair and tries
 * to run a program whose name literally begins with a quote, reporting
 * `'"C:\…\claude.exe"' is not recognized as an internal or external command`. Handing the parts
 * over separately lets the spawn layer quote them correctly, and is the only form that also
 * survives an install path containing spaces (`C:\Program Files\…`).
 */
export function windowsTerminalArgv(target: string, args: readonly string[] = []): string[] {
  return ['cmd', '/c', 'start', '', 'cmd', '/k', target, ...args]
}

/**
 * True when an arg carries a character cmd.exe mangles on its way through, so the split-argv form
 * above cannot deliver it and a launcher script is required instead.
 *
 * Quotes are the case that actually bites: codex's reasoning-effort override is the TOML assignment
 * `model_reasoning_effort="high"`, and the quotes are PART OF THE VALUE (the macOS path delivers
 * them, so Windows must too). The spawn layer escapes them MSVCRT-style as `\"`, which cmd.exe does
 * not understand, so the launch dies exactly like the unquoted-exe bug did. Measured 2026-09-19
 * against a probe that echoes what it received:
 *
 *   split argv                       -> program never ran
 *   launcher script, written literal -> `-c model_reasoning_effort="high"`  ← matches macOS
 *   launcher script, doubled quotes  -> `-c "model_reasoning_effort=""high"""`
 *
 * The other characters are cmd's own metacharacters, which would be interpreted rather than passed.
 */
export function needsCmdLauncher(args: readonly string[]): boolean {
  return args.some((arg) => /["^&|<>%!]/.test(arg))
}

/**
 * Contents of a .cmd launcher running `exe args…`, for the cases needsCmdLauncher flags.
 *
 * Inside a script file there is no spawn layer re-escaping our text, so each arg is written
 * VERBATIM and reaches the program byte-for-byte. Only the exe is quoted, for install paths with
 * spaces. CRLF because cmd.exe requires it, and `@echo off` so the user sees their program's output
 * rather than the script.
 */
export function cmdLauncherScript(exe: string, args: readonly string[] = []): string {
  return `@echo off\r\n"${exe}"${args.map((arg) => ` ${arg}`).join('')}\r\n`
}

/** Writes a cmdLauncherScript to a unique temp path and returns it. Windows callers only. */
export function writeCmdLauncher(exe: string, args: readonly string[] = []): string {
  const path = join(tmpdir(), `agenthydra-launch-${randomUUID()}.cmd`)
  writeFileSync(path, cmdLauncherScript(exe, args))
  return path
}

/**
 * Deletes a launcher once cmd.exe has read it. cmd reads a script at start-up, so the file is dead
 * weight within a second; the delay is slack for a slow spawn, and `unref` keeps a pending cleanup
 * from holding the daemon open at shutdown. Failure is ignored on purpose — a stray file in the
 * temp dir is not worth failing a launch that already succeeded.
 */
export function scheduleLauncherCleanup(path: string, delayMs = 15_000): void {
  setTimeout(() => {
    try {
      rmSync(path, { force: true })
    } catch {
      /* temp file the OS will reap anyway */
    }
  }, delayMs).unref?.()
}

export const CLAUDE_LAUNCH_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
export const CODEX_LAUNCH_EFFORTS = new Set([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
])

export interface LaunchOptionsInput {
  model?: unknown
  effort?: unknown
}

/** Returns a caller-facing validation error, or null when both optional values are safe. */
export function launchOptionError(
  options: LaunchOptionsInput,
  validEfforts: ReadonlySet<string>,
): string | null {
  if (options.model !== undefined) {
    if (typeof options.model !== 'string' || !MODEL_ID.test(options.model)) {
      return 'model must be a 1–120 character model id using only letters, digits, ., _, :, /, @, +, or -'
    }
  }
  if (options.effort !== undefined) {
    if (typeof options.effort !== 'string' || !validEfforts.has(options.effort)) {
      return `effort must be one of: ${[...validEfforts].join(', ')}`
    }
  }
  return null
}

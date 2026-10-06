// How to spawn a managed dev server: directly, or through the OS shell (ported from DevWebUI's spawn-plan.ts).
//
// A command is a free-form string (`node ../../vite.js --port 4173`, `npm run dev`, `A && B`). Running every one
// through `shell: true` leaves a persistent cmd.exe per server on Windows, but splitting a string into argv breaks on
// shell operators, %VAR%, `.cmd`/`.bat` shims (CreateProcess cannot run a batch file) and quoting rules. So only the
// provably safe subset runs directly: a command that tokenizes cleanly (no unquoted shell metacharacters, balanced
// quotes) whose first token resolves to an `.exe`/`.com` on PATH (an executable file on POSIX). Everything else keeps
// the shell. Pure and platform-injectable; the PATH probe is the only impurity and any doubt falls back to the shell.

import { statSync } from 'node:fs'
import path from 'node:path'

export type SpawnPlan = { shell: true; command: string } | { shell: false; file: string; args: string[] }

// cmd.exe operators, grouping and %VAR%/!delayed! expansion. Backslash is a path separator on Windows, not an escape.
export const WIN_META = new Set('&|<>^()%!'.split(''))
// /bin/sh operators, expansion, globbing and escaping. Double quote is consumed by the tokenizer; single quote is left
// to the shell because only double quotes group here.
export const POSIX_META = new Set('&|;<>()$`*?~#\\\''.split(''))

// `.cmd`/`.bat` are absent on purpose: only cmd.exe can run them, so npm/pnpm/yarn/vite shims stay on the shell.
const WIN_DIRECT_EXTS = ['.exe', '.com']

/**
 * One backslash run at `i` (CommandLineToArgvW rules): N backslashes are literal unless a `"` follows, then N/2
 * backslashes are emitted and an odd one escapes the quote. Returns the index past the run and the text to emit.
 */
function consumeBackslashRun(command: string, i: number): { i: number; text: string } {
  let n = 0
  while (command[i] === '\\') {
    n++
    i++
  }
  if (command[i] === '"') {
    let text = '\\'.repeat(n >> 1)
    if (n % 2 === 1) {
      text += '"'
      i++
    }
    return { i, text }
  }
  return { i, text: '\\'.repeat(n) }
}

const isSeparator = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n'

type CharClass = 'backslash' | 'quote' | 'separator' | 'operator' | 'content'

function classifyChar(ch: string, quoted: boolean, meta: Set<string>, escapes: boolean): CharClass {
  if (ch === '\\' && escapes) return 'backslash'
  if (ch === '"') return 'quote'
  if (quoted) return 'content'
  if (isSeparator(ch)) return 'separator'
  return meta.has(ch) ? 'operator' : 'content'
}

/** Splits a command line into argv, or returns null when it needs a real shell (an unquoted operator, a bad quote). */
export function tokenize(command: string, meta: Set<string>): string[] | null {
  const tokens: string[] = []
  const escapes = !meta.has('\\')
  let cur: string | null = null
  let quoted = false
  let i = 0
  while (i < command.length) {
    const ch = command[i]!
    switch (classifyChar(ch, quoted, meta, escapes)) {
      case 'backslash': {
        const consumed = consumeBackslashRun(command, i)
        cur = (cur ?? '') + consumed.text
        i = consumed.i
        break
      }
      case 'quote':
        quoted = !quoted
        cur ??= ''
        i++
        break
      case 'separator':
        if (cur !== null) {
          tokens.push(cur)
          cur = null
        }
        i++
        break
      case 'operator':
        return null
      case 'content':
        cur = (cur ?? '') + ch
        i++
        break
    }
  }
  if (quoted) return null
  if (cur !== null) tokens.push(cur)
  return tokens.length ? tokens : null
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

const isExecutableFile = (p: string): boolean => {
  try {
    const s = statSync(p)
    return s.isFile() && (s.mode & 0o111) !== 0
  } catch {
    return false
  }
}

/** PATH read case-insensitively (Windows spells it `Path`; a merged env may too). */
function envPath(env: NodeJS.ProcessEnv): string {
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') return env[key] ?? ''
  return ''
}

/** The running binary's own folder first (so `bun` always resolves: the service is bun), then PATH. */
function searchDirs(env: NodeJS.ProcessEnv, delimiter: string): string[] {
  return [path.dirname(process.execPath), ...envPath(env).split(delimiter)].filter(Boolean)
}

const hasDirectExt = (file: string): boolean => WIN_DIRECT_EXTS.some((e) => file.toLowerCase().endsWith(e))

function resolveWindows(file: string, cwd: string, env: NodeJS.ProcessEnv): string | null {
  const direct = hasDirectExt(file)
  if (file.includes('\\') || file.includes('/')) {
    const base = path.resolve(cwd, file)
    if (direct) return isFile(base) ? base : null
    for (const e of WIN_DIRECT_EXTS) if (isFile(base + e)) return base + e
    return null
  }
  for (const dir of searchDirs(env, ';')) {
    if (direct) {
      const p = path.join(dir, file)
      if (isFile(p)) return p
      continue
    }
    for (const e of WIN_DIRECT_EXTS) {
      const p = path.join(dir, file + e)
      if (isFile(p)) return p
    }
  }
  return null
}

function resolvePosix(file: string, cwd: string, env: NodeJS.ProcessEnv): string | null {
  if (file.includes('/')) {
    const p = path.resolve(cwd, file)
    return isExecutableFile(p) ? p : null
  }
  for (const dir of searchDirs(env, ':')) {
    const p = path.join(dir, file)
    if (isExecutableFile(p)) return p
  }
  return null
}

/** `{ shell: false, file, args }` only for a plain executable invocation; any doubt returns the shell plan. */
export function planManagedSpawn(command: string, opts: { cwd?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}): SpawnPlan {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? process.cwd()
  const win = platform === 'win32'
  const tokens = tokenize(command, win ? WIN_META : POSIX_META)
  if (!tokens?.[0]) return { shell: true, command }
  const [file, ...args] = tokens
  const exe = win ? resolveWindows(file, cwd, env) : resolvePosix(file, cwd, env)
  if (!exe) return { shell: true, command }
  return { shell: false, file: exe, args }
}

// Runtime selection (ported from DevWebUI's runtime.ts): whether a server's command runs under Node or Bun. The rewrite
// is conservative: it only touches clear node/bun invocations and leaves anything it does not recognise as written.
//   bun:   `node x` -> `bun x`;  `bun run x` -> `bun --bun run x`
//   node:  `bun --bun run x` -> `bun run x`;  `bun x.js` -> `node x.js`
// `npm run ...`, `bunx ...` and bare shorthands such as `bun dev` are left alone.

import { existsSync } from 'node:fs'
import path from 'node:path'
import type { DevWebRuntimePref } from '@shared/devwebui'

export type Runtime = 'node' | 'bun'

const BUN_LOCKFILES = ['bun.lock', 'bun.lockb']
const NODE_LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']

/** The runtime a folder's lockfile says its scripts expect; undefined with no lockfile (the command stays as written). */
export function detectProjectRuntime(dir: string): Runtime | undefined {
  for (const f of BUN_LOCKFILES) if (existsSync(path.join(dir, f))) return 'bun'
  for (const f of NODE_LOCKFILES) if (existsSync(path.join(dir, f))) return 'node'
  return undefined
}

/** A server's own pin wins, then a forced global setting, then (under `auto`) the lockfile's runtime. */
export function effectiveRuntime(pin: Runtime | undefined, global: DevWebRuntimePref, projectRuntime?: Runtime): Runtime | undefined {
  return pin ?? (global !== 'auto' ? global : projectRuntime)
}

export function withRuntime(command: string, runtime?: Runtime): string {
  if (!runtime) return command
  const m = command.match(/^(\s*)(\S+)(?:\s+(\S+))?/)
  if (!m) return command
  const [, ws = '', first = '', second] = m
  const afterFirst = command.slice(ws.length + first.length)
  if (runtime === 'bun') {
    if (first === 'node' || first === 'node.exe') return `${ws}bun${afterFirst}`
    if (first === 'bun' && second === 'run') return command.replace(/^(\s*)bun(\s+)run\b/, '$1bun$2--bun run')
    return command
  }
  if (first !== 'bun' && first !== 'bun.exe') return command
  if (second === '--bun') return command.replace(/^(\s*)bun(\s+)--bun\b/, '$1bun')
  if (second && /\.(?:js|cjs|mjs|ts|cts|mts)$/i.test(second)) return `${ws}node${afterFirst}`
  return command
}

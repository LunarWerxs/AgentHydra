// Installing a connector from its GitHub release and starting what was installed, hidden. The one rule: nothing
// downloaded is kept, let alone run, unless its SHA-256 matches the line for that exact asset in the release's
// SHA256SUMS.txt. No token goes out: the releases of a public repository are readable without one.

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const SUMS_NAME = 'SHA256SUMS.txt'
const USER_AGENT = 'HydraDesk2-connectors'

export interface InstallOptions {
  /** 'LunarWerxs/RepoYeti' */
  repo: string
  /** The exact asset name, e.g. 'repoyeti-windows-x64.exe'. */
  asset: string
  /** <home>/apps/<id> */
  dest: string
  progress?: (line: string) => void
  fetchImpl?: typeof fetch
}

export interface Installed {
  file: string
  version: string
  sha256: string
}

interface ReleaseAsset {
  name: string
  browser_download_url: string
  size?: number
}

const mb = (n: number): number => Math.round(n / 1_048_576)

/** The hash `sums` (sha256sum format: "<hex>  <name>" or "<hex> *<name>") lists for exactly `asset`, or null. */
function sumFor(sums: string, asset: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line)
    if (m && m[2] === asset) return (m[1] as string).toLowerCase()
  }
  return null
}

export async function installFromRelease(o: InstallOptions): Promise<Installed> {
  const doFetch = o.fetchImpl ?? fetch
  const say = o.progress ?? (() => {})
  const get = async (url: string, accept: string): Promise<Response> => {
    const res = await doFetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: accept }, redirect: 'follow' })
    if (!res.ok) throw new Error(`${url} answered ${res.status}`)
    return res
  }

  say('Looking up the latest release')
  const rel = (await (await get(`https://api.github.com/repos/${o.repo}/releases/latest`, 'application/vnd.github+json')).json()) as {
    tag_name?: string
    assets?: ReleaseAsset[]
  }
  const assets = rel.assets ?? []
  const wanted = assets.find((a) => a.name === o.asset)
  if (!wanted) throw new Error(`the latest release of ${o.repo} has no asset named ${o.asset}`)
  const sumsAsset = assets.find((a) => a.name === SUMS_NAME)
  if (!sumsAsset) throw new Error(`the latest release of ${o.repo} has no ${SUMS_NAME}; refusing to install what cannot be checked`)
  const expected = sumFor(await (await get(sumsAsset.browser_download_url, 'text/plain')).text(), o.asset)
  if (!expected) throw new Error(`${SUMS_NAME} has no line for ${o.asset}; refusing to install what cannot be checked`)

  mkdirSync(o.dest, { recursive: true })
  const file = join(o.dest, o.asset)
  const partial = `${file}.partial`
  const res = await get(wanted.browser_download_url, 'application/octet-stream')
  const total = wanted.size ?? Number(res.headers.get('content-length') ?? 0)
  const hash = createHash('sha256')
  const out = createWriteStream(partial)
  let got = 0
  let shown = -1
  try {
    if (!res.body) throw new Error('the download had no body')
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
      got += value.length
      if (mb(got) !== shown) {
        shown = mb(got)
        say(total > 0 ? `Downloading ${mb(got)} / ${mb(total)} MB` : `Downloading ${mb(got)} MB`)
      }
    }
    await new Promise<void>((r, j) => out.end((err?: Error | null) => (err ? j(err) : r())))
  } catch (err) {
    out.destroy()
    rmSync(partial, { force: true })
    throw err
  }
  const sha256 = hash.digest('hex')
  if (sha256 !== expected) {
    rmSync(partial, { force: true })
    throw new Error(`${o.asset} failed its checksum (got ${sha256.slice(0, 12)}…, ${SUMS_NAME} says ${expected.slice(0, 12)}…); removed it`)
  }
  rmSync(file, { force: true })
  renameSync(partial, file)
  const version = rel.tag_name ?? 'unknown'
  writeFileSync(join(o.dest, 'installed.json'), JSON.stringify({ version, asset: o.asset, sha256, installedAt: new Date().toISOString() }, null, 2))
  say(`Installed ${version}`)
  return { file, version, sha256 }
}

/** What installFromRelease left in `dest`, or null when nothing (or no file) is there. */
export function installedApp(dest: string): { file: string; version: string } | null {
  try {
    const info = JSON.parse(readFileSync(join(dest, 'installed.json'), 'utf8')) as { version?: unknown; asset?: unknown }
    if (typeof info.asset !== 'string' || typeof info.version !== 'string') return null
    const file = join(dest, info.asset)
    return existsSync(file) ? { file, version: info.version } : null
  } catch {
    return null
  }
}

const whichCache = new Map<string, string>()

/**
 * Bun.which, its found path kept while that file exists: the probes run it every few seconds and PATH rarely changes.
 * A name not found is asked again, so an app installed or removed while Desk runs is seen at the next probe.
 */
export function whichOnce(name: string): string | null {
  const kept = whichCache.get(name)
  if (kept && existsSync(kept)) return kept
  const found = Bun.which(name)
  if (found) whichCache.set(name, found)
  else whichCache.delete(name)
  return found
}

/** Starts `cmd` detached with no console window, its output appended to `log`; the pid, or null when it could not start. */
export function startHidden(cmd: string[], o: { cwd?: string; log: string; env?: Record<string, string | undefined> }): number | null {
  try {
    mkdirSync(dirname(o.log), { recursive: true })
    const fd = openSync(o.log, 'a')
    try {
      const child = spawn(cmd[0] as string, cmd.slice(1), {
        cwd: o.cwd,
        stdio: ['ignore', fd, fd],
        detached: true,
        windowsHide: true,
        env: { ...process.env, ...o.env }
      })
      child.on('error', () => {})
      child.unref()
      return child.pid ?? null
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

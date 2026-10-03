// server/src/climayte-owner-sync.ts — the owner's global instructions and skills for CliMayte workers
// (docs/CLIMAYTE.md "The owner's CLAUDE.md and skills").
//
// WHY (field note 5, 2026-09-30): a worker runs with CLAUDE_CONFIG_DIR set to its account's folder
// (`~/.agenthydra/cli-instances/<id>`), which had no CLAUDE.md and no skills, so the owner's global
// rules ("never open a visible window", "heavy commands go through fairjob", the walk guard's
// reasons) never reached a worker unless the orchestrator repeated them in every prompt. Workers
// then ran `grep -r .` over whole trees within their first minute (note 9).
//
// Before each launch, the account folder is made to match `~/.claude`:
// - CLAUDE.md is COPIED (44 KB; a link to a file needs admin rights or developer mode on Windows,
//   and a hard link breaks the first time an editor saves by replacing the file). Only when the
//   source changed, and never over a CLAUDE.md this code did not write.
// - Each skill folder is a directory JUNCTION to the owner's (no admin rights needed, and always
//   current, so an edited skill needs no re-sync). The account's own entries (its `synced/` folder)
//   are left alone; a junction whose skill the owner removed is removed. Measured 2026-09-30: Bun's
//   rmSync(recursive) on an account folder removes a junction, never the owner's files behind it.
// Hooks and settings.json are NOT carried: desktop-only hooks can block a headless worker.
//
// THE LEAN WORKER PROFILE (owner, 2026-09-30, after the run-1 audit). When `~/.claude/climayte-worker/`
// holds a CLAUDE.md, workers get THAT instead of the full one, and when it holds `skills.txt` (one
// skill name per line, `#` comments), only those skills are linked. Measured on run 1: the full
// CLAUDE.md (44 KB, mostly rules for the desktop chat: routing, releases, memory) and 84 skill
// descriptions added 24-33k tokens to every request a worker made, and a cache write of that size
// to every fresh session and every move (cache writes were 32% of what filled the 5-hour meter).
//
// Cheap: a signature (CLAUDE.md's size and mtime, the skill names) is kept in memory per account
// and in `<account>/.agenthydra-owner-sync.json`; an unchanged one costs a stat and a readdir.
//
// THE OWNER'S MCP SERVERS (2026-10-02, ownerMcpServers): a worker is given them on its command
// line, read from the owner's own user scope, never from the account's `.claude.json`. That copy
// was seeded once, when the account was made (core/cli-instances.ts), and drifts: measured
// 2026-10-02, one of 33 accounts listed no MCP server at all, so its workers had no zswarm and no
// connections-local, and a server the owner adds later never reaches an account made before it.

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

const STAMP = '.agenthydra-owner-sync.json'

interface Stamp {
  sig: string
  /** The CLAUDE.md this code wrote (size:mtime of the copy), so a hand-written one is never replaced. */
  claudeMd: string | null
  /** The owner's CLAUDE.md (size:mtime) that copy was made from, so it is copied again only when it changed. */
  src?: string | null
}

const seen = new Map<string, string>()

function stampOf(file: string): string | null {
  try {
    const s = statSync(file)
    return `${s.size}:${Math.round(s.mtimeMs)}`
  } catch {
    return null
  }
}

function readStamp(accountDir: string): Stamp | null {
  try {
    return JSON.parse(readFileSync(join(accountDir, STAMP), 'utf8')) as Stamp
  } catch {
    return null
  }
}

/** The owner's skill folders by name (files at the skills root, such as licences, are not skills). */
function ownerSkills(ownerDir: string): string[] {
  const root = join(ownerDir, 'skills')
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || e.isSymbolicLink()))
      .filter((e) => e.isDirectory() || statSync(join(root, e.name)).isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

const WORKER_DIR = 'climayte-worker'

/** The CLAUDE.md a worker gets: the lean worker profile's when there is one, else the owner's. */
function workerClaudeMd(ownerDir: string): string {
  const lean = join(ownerDir, WORKER_DIR, 'CLAUDE.md')
  return existsSync(lean) ? lean : join(ownerDir, 'CLAUDE.md')
}

/** The skills the lean profile allows (`climayte-worker/skills.txt`), or null for every skill. */
function workerSkillList(ownerDir: string): Set<string> | null {
  try {
    const text = readFileSync(join(ownerDir, WORKER_DIR, 'skills.txt'), 'utf8')
    return new Set(
      text
        .split(/\r?\n/)
        .map((l) => l.replace(/#.*/, '').trim())
        .filter(Boolean),
    )
  } catch {
    return null
  }
}

/** A link at `path` that points into `skillsRoot` (one this code made), or false. */
function isOurLink(path: string, skillsRoot: string): boolean {
  try {
    if (!lstatSync(path).isSymbolicLink()) return false
    const to = resolve(readlinkSync(path)).toLowerCase()
    return to.startsWith(`${resolve(skillsRoot).toLowerCase()}${sep}`)
  } catch {
    return false
  }
}

export interface OwnerSyncResult {
  changed: boolean
  claudeMd: 'copied' | 'unchanged' | 'kept-own' | 'no-source'
  linked: string[]
  unlinked: string[]
  /** Owner skills not linked because the account has its own folder of that name. */
  shadowed: string[]
}

/** The sync signature: which CLAUDE.md a worker gets, its stamp, and the skill names the lean
 *  profile allows. */
function syncSignature(ownerDir: string): { srcMd: string; skills: string[]; sig: string } {
  const srcMd = workerClaudeMd(ownerDir)
  const allowed = workerSkillList(ownerDir)
  const skills = ownerSkills(ownerDir).filter((name) => !allowed || allowed.has(name))
  return { srcMd, skills, sig: `${srcMd}|${stampOf(srcMd) ?? '-'}|${skills.join('/')}` }
}

/** CLAUDE.md: copy over our own earlier copy or into an empty place, never over the account's own.
 *  Says what happened, with the two stamps the account's record keeps (the earlier ones unless it
 *  copied). */
function syncClaudeMdFile(
  srcMd: string,
  dstMd: string,
  stamp: Stamp | null,
): { claudeMd: string | null; src: string | null; status: OwnerSyncResult['claudeMd'] } {
  const kept = { claudeMd: stamp?.claudeMd ?? null, src: stamp?.src ?? null }
  const srcNow = stampOf(srcMd)
  const dstNow = stampOf(dstMd)
  if (srcNow === null) return { ...kept, status: 'no-source' }
  if (dstNow !== null && dstNow !== stamp?.claudeMd) return { ...kept, status: 'kept-own' }
  if (dstNow !== null && srcNow === stamp?.src) return { ...kept, status: 'unchanged' }
  copyFileSync(srcMd, dstMd)
  return { claudeMd: stampOf(dstMd), src: srcNow, status: 'copied' }
}

/** Link one owner skill, unless it is already our link or the account has its own of that name. */
function linkSkill(srcRoot: string, dstRoot: string, name: string, result: OwnerSyncResult): void {
  const dst = join(dstRoot, name)
  if (isOurLink(dst, srcRoot)) return
  if (existsSync(dst) || lstatExists(dst)) {
    result.shadowed.push(name)
    return
  }
  symlinkSync(join(srcRoot, name), dst, process.platform === 'win32' ? 'junction' : 'dir')
  result.linked.push(name)
}

/** Remove links this code made whose skills are no longer wanted. */
function unlinkStaleLinks(
  srcRoot: string,
  dstRoot: string,
  want: Set<string>,
  result: OwnerSyncResult,
): void {
  for (const name of readdirSync(dstRoot)) {
    const dst = join(dstRoot, name)
    if (!want.has(name) && isOurLink(dst, srcRoot)) {
      removeLink(dst)
      result.unlinked.push(name)
    }
  }
}

/** Make `accountDir`'s CLAUDE.md and skills match `ownerDir` (`~/.claude`). Never throws: a worker
 *  without the owner's rules is worse, but not a reason to refuse the launch. */
export function syncOwnerClaude(ownerDir: string, accountDir: string): OwnerSyncResult {
  const result: OwnerSyncResult = {
    changed: false,
    claudeMd: 'unchanged',
    linked: [],
    unlinked: [],
    shadowed: [],
  }
  try {
    const { srcMd, skills, sig } = syncSignature(ownerDir)
    if (seen.get(accountDir) === sig) return result
    const stamp = readStamp(accountDir)
    const dstMd = join(accountDir, 'CLAUDE.md')
    if (stamp?.sig === sig && stampOf(dstMd) === stamp.claudeMd) {
      seen.set(accountDir, sig)
      return result
    }

    const md = syncClaudeMdFile(srcMd, dstMd, stamp)
    result.claudeMd = md.status

    // Skills: one junction per owner skill; the account's own folders stay.
    const srcRoot = join(ownerDir, 'skills')
    const dstRoot = join(accountDir, 'skills')
    mkdirSync(dstRoot, { recursive: true })
    const want = new Set(skills)
    for (const name of skills) linkSkill(srcRoot, dstRoot, name, result)
    unlinkStaleLinks(srcRoot, dstRoot, want, result)

    writeFileSync(
      join(accountDir, STAMP),
      JSON.stringify({ sig, claudeMd: md.claudeMd, src: md.src } satisfies Stamp),
    )
    seen.set(accountDir, sig)
    result.changed =
      result.claudeMd === 'copied' || result.linked.length + result.unlinked.length > 0
  } catch (err) {
    console.error(`[climayte] could not give ${accountDir} the owner's CLAUDE.md and skills:`, err)
  }
  return result
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** Remove a junction or symlink itself, never what it points at. */
function removeLink(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // A Windows junction to a directory is removed as a directory entry; rmSync without
    // `recursive` removes only the link.
    rmSync(path, { force: true })
  }
}

export interface McpUrlEntry {
  type: 'http' | 'sse'
  url: string
  headersHelper?: string
}

/** A word shaped like a key or token: 24 or more characters of a token's alphabet with letters and
 *  digits both. Path segments, flags and file names (`connections-local`, `loader.mjs`) are not. */
const TOKEN_LIKE = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_\-+.~]{24,}$/

/** Text that may hold a credential: a scheme or header name that announces one (`Bearer `,
 *  `Authorization`, an API key header), or a token-like word once quotes, separators and path
 *  slashes are split off. */
function holdsCredential(text: string): boolean {
  if (/\b(bearer|basic)\s|authorization|api[-_]?key|x-auth/i.test(text)) return true
  return text.split(/[\s"'`=:,;/\\]+/).some((word) => TOKEN_LIKE.test(word))
}

/** A URL with no credential in it: no user info, query or fragment, and no token-like host label
 *  or path segment (a key in the path, `/s/<key>/mcp`, is as much a key as one in the query). */
function credentialFreeUrl(u: URL): boolean {
  if (u.username || u.password || u.search || u.hash) return false
  const segments = u.pathname.split('/').map((s) => {
    try {
      return decodeURIComponent(s)
    } catch {
      return s
    }
  })
  return ![...u.hostname.split('.'), ...segments].some((part) => holdsCredential(part))
}

/** What an owner entry is to a worker: the entry to carry, `credential` when it holds or may hold
 *  one, or `other` (a stdio server, or not an MCP entry at all), which the account's own copy
 *  serves. */
type Carry = { entry: McpUrlEntry } | 'credential' | 'other'

/** An entry is carried only when it holds no credential: a URL, and at most a `headersHelper`, the
 *  command the CLI runs at connect time to sign in through this machine's session (the owner's
 *  connections-local is `node <loader.mjs> --connect`, hswarm `python -m hswarm connect`), which
 *  holds no secret itself. Static `headers`, `oauth` and `env` can each hold one, and so can the URL
 *  or a helper that echoes a literal header (holdsCredential); what is carried is written to a
 *  file. */
function carryEntry(entry: unknown): Carry {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'other'
  const { type, url, headersHelper, ...rest } = entry as Record<string, unknown>
  if ((type !== 'http' && type !== 'sse') || typeof url !== 'string') return 'other'
  if (Object.keys(rest).length > 0) return 'credential'
  if (headersHelper !== undefined && typeof headersHelper !== 'string') return 'other'
  if (headersHelper !== undefined && holdsCredential(headersHelper)) return 'credential'
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return 'other'
  }
  if (!credentialFreeUrl(u)) return 'credential'
  return { entry: headersHelper === undefined ? { type, url } : { type, url, headersHelper } }
}

/** The path of an http(s) URL, lower case and without a trailing slash, or null. */
function urlPath(url: string): string | null {
  try {
    return new URL(url).pathname.replace(/\/+$/, '').toLowerCase()
  } catch {
    return null
  }
}

/** Names already said to be left out, so a launch every minute does not say it every minute. */
const saidLeftOut = new Set<string>()

/** The owner's MCP servers a worker is given (`--mcp-config`, climayte-launch.ts): those in the
 *  owner's user scope, the `.claude.json` beside `ownerDir` (`~/.claude` -> `~/.claude.json`), less
 *  the `deny.names` and any server whose URL path is one of `deny.paths`, whatever its name (a
 *  second PC's AgentHydra is the same server under another name). Only an entry that holds no
 *  credential is carried (carryEntry): the owner's local servers (connections-local, hswarm) sign
 *  in through this machine's own session, and no credential is ever copied into a worker's file;
 *  one left out for that is said by its name only. Any other entry is left to the account's own
 *  `.claude.json`, which still loads beside these. No owner config is no servers; one that cannot
 *  be read is said, never with the parser's message (it quotes the text, which can be a token), and
 *  also no servers: the launch goes on with the account's own. */
export function ownerMcpServers(
  ownerDir: string,
  deny: { names: readonly string[]; paths: readonly string[] },
): Record<string, McpUrlEntry> {
  const file = join(dirname(resolve(ownerDir)), '.claude.json')
  if (!existsSync(file)) return {}
  let servers: unknown
  try {
    servers = (JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: unknown }).mcpServers
  } catch (err) {
    const why = (err as NodeJS.ErrnoException)?.code ?? 'it is not valid JSON'
    console.error(`[climayte] could not read the owner's MCP servers from ${file}: ${why}`)
    return {}
  }
  const out: Record<string, McpUrlEntry> = {}
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return out
  const deniedPaths = deny.paths.map((p) => p.replace(/\/+$/, '').toLowerCase())
  for (const [name, entry] of Object.entries(servers)) {
    const url = (entry as { url?: unknown } | null)?.url
    if (deny.names.includes(name)) continue
    if (typeof url === 'string' && deniedPaths.includes(urlPath(url) ?? '')) continue
    const carry = carryEntry(entry)
    if (carry === 'other') continue
    if (carry === 'credential') {
      if (!saidLeftOut.has(name))
        console.error(
          `[climayte] the owner's MCP server ${JSON.stringify(name)} holds or may hold a credential; workers get only their account's copy of it`,
        )
      saidLeftOut.add(name)
      continue
    }
    out[name] = carry.entry
  }
  return out
}

/** Tests: forget what was synced and said, so the next call looks at the disk again. */
export function forgetOwnerSync(): void {
  seen.clear()
  saidLeftOut.clear()
}

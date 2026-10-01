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
import { join, resolve, sep } from 'node:path'

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
    const srcMd = workerClaudeMd(ownerDir)
    const allowed = workerSkillList(ownerDir)
    const skills = ownerSkills(ownerDir).filter((name) => !allowed || allowed.has(name))
    const sig = `${srcMd}|${stampOf(srcMd) ?? '-'}|${skills.join('/')}`
    if (seen.get(accountDir) === sig) return result
    const stamp = readStamp(accountDir)
    const dstMd = join(accountDir, 'CLAUDE.md')
    if (stamp?.sig === sig && stampOf(dstMd) === stamp.claudeMd) {
      seen.set(accountDir, sig)
      return result
    }

    // CLAUDE.md: copy over our own earlier copy or into an empty place, never over the account's own.
    let claudeMd = stamp?.claudeMd ?? null
    let src = stamp?.src ?? null
    const srcNow = stampOf(srcMd)
    const dstNow = stampOf(dstMd)
    if (srcNow === null) result.claudeMd = 'no-source'
    else if (dstNow !== null && dstNow !== stamp?.claudeMd) result.claudeMd = 'kept-own'
    else if (dstNow === null || srcNow !== stamp?.src) {
      copyFileSync(srcMd, dstMd)
      claudeMd = stampOf(dstMd)
      src = srcNow
      result.claudeMd = 'copied'
    }

    // Skills: one junction per owner skill; the account's own folders stay.
    const srcRoot = join(ownerDir, 'skills')
    const dstRoot = join(accountDir, 'skills')
    mkdirSync(dstRoot, { recursive: true })
    const want = new Set(skills)
    for (const name of skills) {
      const dst = join(dstRoot, name)
      if (isOurLink(dst, srcRoot)) continue
      if (existsSync(dst) || lstatExists(dst)) {
        result.shadowed.push(name)
        continue
      }
      symlinkSync(join(srcRoot, name), dst, process.platform === 'win32' ? 'junction' : 'dir')
      result.linked.push(name)
    }
    for (const name of readdirSync(dstRoot)) {
      const dst = join(dstRoot, name)
      if (!want.has(name) && isOurLink(dst, srcRoot)) {
        removeLink(dst)
        result.unlinked.push(name)
      }
    }

    writeFileSync(join(accountDir, STAMP), JSON.stringify({ sig, claudeMd, src } satisfies Stamp))
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

/** Tests: forget what was synced, so the next call looks at the disk again. */
export function forgetOwnerSync(): void {
  seen.clear()
}

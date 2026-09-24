#!/usr/bin/env bun
/**
 * save-bundle: commit the WHOLE dirty tree as one `wip: bundle` commit whose message names every
 * file taken from another session.
 *
 * ⛔ ONLY when the owner has said to sweep the tree. The standing rule is path-scoped adds; this
 * script is the one legitimate sweep, and it exists so that when the owner does say "commit and
 * sync as we go, including the entirety of the dirty work tree" (Michael, 2026-09-12), the peer
 * whose half-finished files get published can find them by reading the log. The commit-msg hook
 * (.githooks/check-bundle-message.mjs) refuses a bundle whose message and contents disagree, and
 * this script never passes --no-verify: a bundle that needed to dodge a gate is a bundle that
 * should not have been made.
 *
 * Usage:
 *   bun run save:bundle -- --mine <path> [<path>...] [--subject "text"] [--trailer "Key: v"]... [--dry-run]
 *
 *   --mine      paths THIS session edited (relative to the repo root, or absolute). Everything
 *               else that is dirty is listed under Swept:. A --mine path that is not dirty is an
 *               error, because a wrong claim of ownership is worse than none.
 *   --subject   text after "wip: bundle "; default names the date and the owner instruction.
 *   --trailer   appended as-is at the end of the message (e.g. Co-Authored-By), repeatable.
 *   --dry-run   print the message and the partition; stage nothing, commit nothing.
 *
 * It does not push. The pre-push gate decides that, with its own announcement.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

/** The OS's one true spelling of a path. On Windows a cwd can arrive as an 8.3 short name
 *  (`C:\Users\RUNNER~1\...` on GitHub's runner) while git reports the same repo by its long name,
 *  and `relative()` between the two climbs to the drive root instead of answering `a.txt`. A path
 *  that no longer exists (a deleted file listed as --mine) keeps its given spelling. */
function canonical(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}

function normalize(root: string, p: string): string {
  const abs = canonical(isAbsolute(p) ? p : resolve(process.cwd(), p))
  return relative(root, abs).replace(/\\/g, '/')
}

interface Args {
  mine: string[]
  subject: string
  trailers: string[]
  dryRun: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { mine: [], subject: '', trailers: [], dryRun: false }
  let mode: 'mine' | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--mine') {
      mode = 'mine'
      continue
    }
    if (a === '--subject') {
      args.subject = argv[++i] ?? ''
      mode = null
      continue
    }
    if (a === '--trailer') {
      args.trailers.push(argv[++i] ?? '')
      mode = null
      continue
    }
    if (a === '--dry-run') {
      args.dryRun = true
      mode = null
      continue
    }
    if (a.startsWith('--')) throw new Error(`unknown option ${a}`)
    if (mode === 'mine') args.mine.push(a)
    else throw new Error(`unexpected argument ${a} (paths go after --mine)`)
  }
  return args
}

export function buildMessage(
  subject: string,
  mine: string[],
  swept: string[],
  trailers: string[],
): string {
  const today = new Date().toISOString().slice(0, 10)
  const head = `wip: bundle ${subject || `peer sessions' in-flight work (owner-instructed sync, ${today})`}`
  const body = [
    head,
    '',
    'The owner asked for the whole dirty tree to be committed and synced. Files under Swept: were',
    'being edited by another session and are published at a moment their author did not choose;',
    'author, find yours by path here rather than by accident.',
    '',
    'Mine:',
    ...mine.map((p) => `  ${p}`),
    'Swept:',
    ...(swept.length ? swept.map((p) => `  ${p}`) : ['  (none)']),
  ]
  if (trailers.length) body.push('', ...trailers)
  return `${body.join('\n')}\n`
}

function main(): number {
  const args = parseArgs(process.argv.slice(2))
  const root = canonical(git('rev-parse', '--show-toplevel').trim())
  if (args.mine.length === 0) {
    console.error(
      'save-bundle: --mine <path>... is required (what THIS session edited). Nothing staged.',
    )
    return 2
  }

  // What is dirty, before touching the index: tracked changes plus untracked files, exactly what
  // `git add -A` would take, so a dry run reports the real partition.
  const dirty = git('-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all')
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.slice(3).replace(/\\/g, '/'))
    .map((p) => (p.includes(' -> ') ? p.split(' -> ')[1] : p))
  const dirtySet = new Set(dirty)
  const mine = args.mine.map((p) => normalize(root, p))
  const notDirty = mine.filter((p) => !dirtySet.has(p))
  if (notDirty.length) {
    console.error(
      `save-bundle: these --mine paths are not dirty, so they cannot be in this bundle:\n${notDirty.map((p) => `  ${p}`).join('\n')}`,
    )
    return 2
  }
  const mineSet = new Set(mine)
  const swept = dirty.filter((p) => !mineSet.has(p)).sort()
  if (swept.length === 0) {
    console.error(
      'save-bundle: every dirty file is yours; there is nothing to sweep. Commit normally.',
    )
    return 2
  }

  const message = buildMessage(args.subject, [...mineSet].sort(), swept, args.trailers)
  console.error(`save-bundle: ${mine.length} mine, ${swept.length} swept from other sessions`)
  if (args.dryRun) {
    process.stdout.write(message)
    return 0
  }

  git('-C', root, 'add', '-A')
  const dir = mkdtempSync(join(tmpdir(), 'save-bundle-'))
  const file = join(dir, 'MESSAGE')
  writeFileSync(file, message)
  try {
    // No --no-verify: the commit-msg hook checks this message against the index, on purpose.
    execFileSync('git', ['-C', root, 'commit', '-F', file], { stdio: 'inherit' })
  } catch {
    console.error(
      'save-bundle: git commit refused (see above). The tree is staged; nothing was committed.',
    )
    return 1
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return 0
}

if (import.meta.main) process.exit(main())

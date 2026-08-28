// The full-mode backlog scanner's detectors (server/src/backlog.ts).
//
// Everything tested here is the pure, filesystem-only half: which repositories a set of roots
// resolves to, what counts as an unticked task, how a marker line is parsed and identified, what
// a repo declares as its gate, and what redaction removes. The git-spawning half (`scanBacklog`)
// is deliberately not exercised here - it is a thin loop over these functions plus `git rev-parse`
// and `git grep`, and a test that shells out to git would be testing git.
//
// The one behaviour worth stating: MARKER IDENTITY IS LINE-INDEPENDENT. The same comment moved
// down a file must be the same marker, or every edit anywhere would announce a repo's whole
// backlog as new. There is a test for exactly that below, because it is the property the entire
// baselining scheme rests on.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BacklogMemory } from '../server/src/backlog'
import {
  backlogFailures,
  backlogGateIsGreen,
  backlogResolved,
  describeGate,
  findTodoBoxes,
  MAX_ITEM_FAILURES,
  markerGrepArgs,
  noteBacklogFailure,
  parseMarkerGrep,
  redactSecrets,
  resolveBacklogItem,
  resolveBacklogRepos,
} from '../server/src/backlog'

const scratches: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ah-backlog-'))
  scratches.push(dir)
  return dir
}

/** A directory that looks like a git checkout to everything in this module (which only ever asks
 *  whether `.git` exists). */
function fakeRepo(parent: string, name: string): string {
  const dir = join(parent, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.git'), 'gitdir: elsewhere')
  return dir
}

function memory(): BacklogMemory {
  const m = new Map<string, string>()
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) }
}

afterEach(() => {
  while (scratches.length > 0) {
    const dir = scratches.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

const noRoot = () => null

/**
 * A credential-SHAPED string, assembled at runtime and never written as a literal.
 *
 * Testing a redactor needs something that looks like a live key, and a 32+ character opaque
 * literal in source is indistinguishable from a real one to a secret scanner - GitHub push
 * protection blocked this branch for exactly that (GH013, "Stripe API Key") on a fixture that was
 * invented here and never existed anywhere else. A false positive is the scanner working, not
 * failing, so the answer is to stop handing it something to find rather than to wave the push
 * through. Assembled from eight-character fragments, it exercises the same regex and leaves
 * nothing in the repo for a scanner to flag.
 *
 * Do NOT inline this back into a single string, however obviously fake the value looks: the next
 * push of that branch is blocked until the offending commit itself is rewritten, and the tempting
 * way out is the "allow this secret" URL, which on a public repo is not ours to click.
 */
function credentialShapedToken(): string {
  return ['A1b2C3d4', 'E5f6G7h8', 'J9k0L1m2', 'N3p4Q5r6', 'S7t8U9v0'].join('')
}

describe('resolveBacklogRepos', () => {
  test('an explicit path that is itself a repo is taken as-is', () => {
    const base = scratch()
    const repo = fakeRepo(base, 'thing')
    const { repos } = resolveBacklogRepos({
      roots: [repo],
      fallbackCwds: [],
      repoRootFor: noRoot,
      maxRepos: 50,
    })
    expect(repos).toEqual([repo])
  })

  test('a container expands ONE level to the repos directly inside it', () => {
    const base = scratch()
    const a = fakeRepo(base, 'alpha')
    const b = fakeRepo(base, 'beta')
    // A repo one level deeper must NOT be picked up: the whole point of stopping at one level is
    // that a recursive walk over a projects folder full of node_modules is unbounded.
    const deep = join(base, 'gamma', 'nested')
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(deep, '.git'), 'gitdir: elsewhere')

    const { repos } = resolveBacklogRepos({
      roots: [base],
      fallbackCwds: [],
      repoRootFor: noRoot,
      maxRepos: 50,
    })
    expect(repos.sort()).toEqual([a, b].sort())
  })

  test('a missing root is reported, never silently dropped', () => {
    const { repos, skipped } = resolveBacklogRepos({
      roots: [join(scratch(), 'nope')],
      fallbackCwds: [],
      repoRootFor: noRoot,
      maxRepos: 50,
    })
    expect(repos).toEqual([])
    expect(skipped[0]?.why).toBe('does not exist')
  })

  test('a directory with no repos in it is reported as such', () => {
    const base = scratch()
    mkdirSync(join(base, 'plain'), { recursive: true })
    const { repos, skipped } = resolveBacklogRepos({
      roots: [base],
      fallbackCwds: [],
      repoRootFor: noRoot,
      maxRepos: 50,
    })
    expect(repos).toEqual([])
    expect(skipped[0]?.why).toContain('no repos')
  })

  test('the repo cap is a hard bound', () => {
    const base = scratch()
    for (const n of ['a', 'b', 'c', 'd']) fakeRepo(base, n)
    const { repos } = resolveBacklogRepos({
      roots: [base],
      fallbackCwds: [],
      repoRootFor: noRoot,
      maxRepos: 2,
    })
    expect(repos.length).toBe(2)
  })

  test('with no roots configured it falls back to session cwds, folded to repo roots and deduped', () => {
    const { repos } = resolveBacklogRepos({
      roots: [],
      fallbackCwds: ['C:/work/app/src', 'C:/work/app/tests', 'C:/other'],
      repoRootFor: (cwd) => (cwd.startsWith('C:/work/app') ? 'C:/work/app' : 'C:/other'),
      maxRepos: 50,
    })
    expect(repos).toEqual(['C:/work/app', 'C:/other'])
  })

  test('scratch and temp cwds are not codebases and are dropped', () => {
    const { repos } = resolveBacklogRepos({
      roots: [],
      fallbackCwds: [
        'C:/Users/x/AppData/Local/Temp/claude/abc/scratchpad',
        'D:/.SystemFiles/Desktop/scratch',
        'D:/real/repo',
      ],
      repoRootFor: (cwd) => cwd,
      maxRepos: 50,
    })
    expect(repos).toEqual(['D:/real/repo'])
  })
})

describe('findTodoBoxes', () => {
  test('finds unticked boxes and ignores ticked ones', () => {
    const repo = scratch()
    writeFileSync(
      join(repo, 'TODO.md'),
      ['# Tasks', '- [ ] wire the thing up', '- [x] already done', '* [ ] star bullet', ''].join(
        '\n',
      ),
    )
    const boxes = findTodoBoxes(repo)
    expect(boxes.map((b) => b.text)).toEqual(['wire the thing up', 'star bullet'])
    expect(boxes[0]?.file).toBe('TODO.md')
    expect(boxes[0]?.line).toBe(2)
  })

  test('reads docs/todo/*.md and BURNDOWN-prefixed files at the root', () => {
    const repo = scratch()
    mkdirSync(join(repo, 'docs', 'todo'), { recursive: true })
    writeFileSync(join(repo, 'docs', 'todo', 'alpha.md'), '- [ ] from docs/todo\n')
    writeFileSync(join(repo, 'BURNDOWN-2026-08-28.md'), '- [ ] from the burndown\n')
    // A markdown file that is neither a known task file nor BURNDOWN/TODO-prefixed is NOT read:
    // a checkbox in a README example is not a task.
    writeFileSync(join(repo, 'README.md'), '- [ ] not a task, just an example\n')
    const texts = findTodoBoxes(repo).map((b) => b.text)
    expect(texts).toContain('from docs/todo')
    expect(texts).toContain('from the burndown')
    expect(texts).not.toContain('not a task, just an example')
  })

  test('a repo with no task files yields nothing rather than throwing', () => {
    expect(findTodoBoxes(scratch())).toEqual([])
  })

  test('box text is redacted before it can reach the feed', () => {
    const repo = scratch()
    const token = credentialShapedToken()
    writeFileSync(join(repo, 'TODO.md'), `- [ ] rotate api_key = ${token}\n`)
    const text = findTodoBoxes(repo)[0]?.text ?? ''
    expect(text).toContain('<redacted>')
    expect(text).not.toContain(token)
  })
})

describe('parseMarkerGrep', () => {
  const line = (f: string, n: number, t: string) => `${f}:${n}:${t}`

  test('parses path:line:text and keeps only real marker tokens', () => {
    const out = parseMarkerGrep(
      [
        line('src/a.ts', 12, '// FIXME: this is wrong'),
        line('src/b.ts', 4, '// just a comment'),
        line('src/c.ts', 9, '  // HACK: works for now'),
      ].join('\n'),
      false,
    )
    expect(out.map((m) => m.token)).toEqual(['FIXME', 'HACK'])
    expect(out[0]?.file).toBe('src/a.ts')
    expect(out[0]?.line).toBe(12)
  })

  test('TODO is only a marker when it is opted into', () => {
    const src = line('src/a.ts', 3, '// TODO: later')
    expect(parseMarkerGrep(src, false)).toEqual([])
    expect(parseMarkerGrep(src, true).map((m) => m.token)).toEqual(['TODO'])
  })

  test('IDENTITY IS LINE-INDEPENDENT: the same comment moved is the same marker', () => {
    const a = parseMarkerGrep(line('src/a.ts', 12, '// FIXME: this is wrong'), false)[0]
    const b = parseMarkerGrep(line('src/a.ts', 480, '// FIXME: this is wrong'), false)[0]
    expect(a?.id).toBe(b?.id ?? '')
    // ...but a different comment in the same file is a different marker.
    const c = parseMarkerGrep(line('src/a.ts', 12, '// FIXME: something else'), false)[0]
    expect(c?.id).not.toBe(a?.id ?? '')
  })

  test('secret-shaped paths are dropped even if git handed them over', () => {
    const out = parseMarkerGrep(
      [
        line('.env.local', 2, '# FIXME: rotate this'),
        line('config/credentials.json', 1, '// FIXME: move out'),
        line('certs/server.key', 1, '// FIXME: expiring'),
        line('src/ok.ts', 1, '// FIXME: keep me'),
      ].join('\n'),
      false,
    )
    expect(out.map((m) => m.file)).toEqual(['src/ok.ts'])
  })

  test('malformed lines are skipped rather than throwing', () => {
    expect(parseMarkerGrep('nonsense\n\nalso:nonsense\n', false)).toEqual([])
  })

  test('the grep excludes vendored trees and env files before a byte is read', () => {
    const args = markerGrepArgs(false)
    expect(args[0]).toBe('grep')
    expect(args).toContain(':(exclude)**/node_modules/**')
    expect(args).toContain(':(exclude)**/.env*')
    expect(args.join(' ')).toContain('FIXME|HACK|XXX|BUG')
    expect(markerGrepArgs(true).join(' ')).toContain('TODO')
  })
})

describe('redactSecrets', () => {
  test('blanks assigned values while keeping the sentence readable', () => {
    expect(redactSecrets('FIXME: password = hunter2sekrit')).toContain('<redacted>')
    expect(redactSecrets('FIXME: password = hunter2sekrit')).toContain('FIXME')
  })

  test('blanks long opaque strings with no assignment around them', () => {
    const token = credentialShapedToken()
    const out = redactSecrets(`note ${token} here`)
    expect(out).toContain('<redacted>')
    // The value itself is what must not survive - asserting only that '<redacted>' appears would
    // pass even if the token were still sitting beside it.
    expect(out).not.toContain(token)
  })

  test('leaves ordinary prose alone, including the word key', () => {
    const s = 'FIXME: rotate the signing key before release'
    expect(redactSecrets(s)).toBe(s)
  })

  // Found by review: the first version matched only `=` and `:`, so a FIXME written the way a
  // human actually writes one carried a live credential straight into the feed.
  test('catches the PROSE form, which is how a note-to-self is really written', () => {
    const out = redactSecrets('FIXME: default password is admin123, change before prod')
    expect(out).not.toContain('admin123')
    expect(out).toContain('<redacted>')
    expect(redactSecrets('TODO: the api_key was hunter2')).not.toContain('hunter2')
  })
})

describe('secret-shaped files', () => {
  test('the grep excludes them by pathspec, so their bytes are never read', () => {
    const args = markerGrepArgs(false).join(' ')
    for (const p of ['*secret*', '*credential*', '*password*', '*.pem', '*.key', '*.p12', '*.pfx'])
      expect(args).toContain(`:(exclude)**/${p}`)
  })

  test('...but NOT *token*, which would take tokenizer.ts with it', () => {
    // The second gate (SECRET_PATH, applied in parseMarkerGrep) catches the real shape exactly,
    // and a glob cannot say "named token.ts" without also saying "named tokenizer.ts".
    expect(markerGrepArgs(false).join(' ')).not.toContain(':(exclude)**/*token*')
    expect(parseMarkerGrep('src/tokenizer.ts:4:// FIXME: keep me', false).length).toBe(1)
    expect(parseMarkerGrep('src/token.ts:4:// FIXME: drop me', false).length).toBe(0)
  })
})

describe('the gate green re-check', () => {
  // Found by review: a sweep over many repos reads a repo's green sha minutes before it finishes,
  // so the reviewer can resolve that very gate mid-sweep and have it handed straight back.
  test('an item whose head is already recorded green is spent', () => {
    const m = memory()
    const item = { key: 'gate:abc123', evidence: { head: 'deadbeef' } }
    expect(backlogGateIsGreen(m, item)).toBe(false)
    resolveBacklogItem(m, 'gate:abc123', 'deadbeef')
    expect(backlogGateIsGreen(m, item)).toBe(true)
  })

  test('a DIFFERENT head is not green: moving the code re-arms the gate', () => {
    const m = memory()
    resolveBacklogItem(m, 'gate:abc123', 'deadbeef')
    expect(backlogGateIsGreen(m, { key: 'gate:abc123', evidence: { head: 'cafef00d' } })).toBe(
      false,
    )
  })

  test('a non-gate item is never green by this route', () => {
    const m = memory()
    expect(backlogGateIsGreen(m, { key: 'todo:abc123:x', evidence: { head: 'deadbeef' } })).toBe(
      false,
    )
  })
})

describe('describeGate', () => {
  test('reads the scripts a package.json declares, in priority order', () => {
    const repo = scratch()
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ scripts: { test: 'x', check: 'y', lint: 'z' } }),
    )
    const gate = describeGate(repo)
    expect(gate.present).toBe(true)
    expect(gate.commands).toEqual(['npm run check', 'npm run lint', 'npm run test'])
  })

  test('uses bun when the repo has a bun lockfile', () => {
    const repo = scratch()
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { check: 'y' } }))
    writeFileSync(join(repo, 'bun.lock'), '')
    expect(describeGate(repo).commands[0]).toBe('bun run check')
  })

  test('an .arkitect repo asks for its architecture counts FIRST', () => {
    const repo = scratch()
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { check: 'y' } }))
    mkdirSync(join(repo, '.arkitect'), { recursive: true })
    const gate = describeGate(repo)
    expect(gate.commands[0]).toBe('bun run arkitect:counts')
    expect(gate.sources).toContain('.arkitect')
  })

  test('Rust and workflow repos are recognised without a package.json', () => {
    const repo = scratch()
    writeFileSync(join(repo, 'Cargo.toml'), '[package]\nname = "x"\n')
    mkdirSync(join(repo, '.github', 'workflows'), { recursive: true })
    const gate = describeGate(repo)
    expect(gate.present).toBe(true)
    expect(gate.commands.join(' ')).toContain('cargo clippy')
    expect(gate.sources).toContain('.github/workflows')
  })

  test('a repo that declares no gate says so instead of guessing one', () => {
    expect(describeGate(scratch()).present).toBe(false)
  })

  test('an unparseable package.json is not a gate and not a crash', () => {
    const repo = scratch()
    writeFileSync(join(repo, 'package.json'), '{ not json')
    expect(describeGate(repo).present).toBe(false)
  })
})

describe('the retry budget', () => {
  test('counts failures and retires an item that cannot be fixed', () => {
    const m = memory()
    const key = 'gate:abc123'
    expect(backlogFailures(m, key)).toBe(0)
    for (let i = 1; i <= MAX_ITEM_FAILURES; i++) expect(noteBacklogFailure(m, key)).toBe(i)
    expect(backlogFailures(m, key)).toBeGreaterThanOrEqual(MAX_ITEM_FAILURES)
  })

  test('resolving clears the counter, and a gate records the sha it was green at', () => {
    const m = memory()
    const key = 'gate:abc123'
    noteBacklogFailure(m, key)
    resolveBacklogItem(m, key, 'deadbeefcafe')
    expect(backlogFailures(m, key)).toBe(0)
    expect(m.get('backlogGreen:abc123')).toBe('deadbeefcafe')
  })

  test('a non-gate item has no sha to record and does not invent one', () => {
    const m = memory()
    resolveBacklogItem(m, 'todo:abc123:ffff', 'deadbeef')
    expect(m.get('backlogGreen:abc123')).toBeNull()
  })
})

describe('resolution', () => {
  // Found in live testing: without this, a `todo` item the reviewer had just resolved came back on
  // the very next sweep and was re-proposed, because its detector still finds the same unticked
  // boxes and nothing remembered that a decision had been made about them.
  test('a resolved content-keyed item stays resolved', () => {
    const m = memory()
    const key = 'todo:abc123:content-hash'
    expect(backlogResolved(m, key)).toBe(false)
    resolveBacklogItem(m, key)
    expect(backlogResolved(m, key)).toBe(true)
  })

  test('...but a DIFFERENT content hash in the same repo is different work', () => {
    const m = memory()
    resolveBacklogItem(m, 'todo:abc123:one')
    expect(backlogResolved(m, 'todo:abc123:two')).toBe(false)
  })

  test('a GATE key is never suppressed this way - its quiet comes from the green sha', () => {
    // A gate key is constant for the life of the repo, so pinning "resolved" to the key would
    // silence that repository's gate forever. The sha is what re-arms it, and it must.
    const m = memory()
    resolveBacklogItem(m, 'gate:abc123', 'deadbeef')
    expect(backlogResolved(m, 'gate:abc123')).toBe(false)
    expect(m.get('backlogGreen:abc123')).toBe('deadbeef')
  })
})

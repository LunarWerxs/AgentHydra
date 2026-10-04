import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { forkPoint, seedSession } from '../../src/bridge/seed-session'
import { encodeProjectDir } from '../../src/bridge/session-jsonl'

const home = mkdtempSync(join(tmpdir(), 'desk-seed-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))

const SID = '0a1b2c3d-1111-4222-8333-444455556666'
const cwd = 'C:\work\Alpha Project'
const slug = encodeProjectDir(cwd)
const defaultRoot = join(home, '.claude', 'projects')
const cliDir = join(home, 'cli-7')

mkdirSync(join(defaultRoot, slug), { recursive: true })
writeFileSync(join(defaultRoot, slug, `${SID}.jsonl`), '{"type":"user"}\n{"type":"assistant"}\n')

describe('seedSession', () => {
  test('copies a transcript into an account folder that lacks it, keeping the project folder name', () => {
    const r = seedSession(SID, cwd, cliDir, [defaultRoot], home)
    expect(r.status).toBe('copied')
    const to = join(cliDir, 'projects', slug, `${SID}.jsonl`)
    expect(readFileSync(to, 'utf8')).toBe('{"type":"user"}\n{"type":"assistant"}\n')
    expect(existsSync(join(defaultRoot, slug, `${SID}.jsonl`))).toBe(true)
  })

  test('says present when the folder has it, and never overwrites it', () => {
    const to = join(cliDir, 'projects', slug, `${SID}.jsonl`)
    writeFileSync(to, 'newer work here\n')
    expect(seedSession(SID, cwd, cliDir, [defaultRoot], home).status).toBe('present')
    expect(readFileSync(to, 'utf8')).toBe('newer work here\n')
  })

  test('the default login (configDir null) is the folder under the home it is given', () => {
    expect(seedSession(SID, cwd, null, [join(cliDir, 'projects')], home).status).toBe('present')
  })

  test('missing when no folder has it, and a bad id never names a file', () => {
    expect(seedSession('11111111-2222-4333-8444-555555555555', cwd, join(home, 'cli-9'), [defaultRoot], home).status).toBe('missing')
    expect(seedSession('../escape', cwd, join(home, 'cli-9'), [defaultRoot], home).status).toBe('missing')
    expect(existsSync(join(home, 'cli-9'))).toBe(false)
  })
})

describe('seedSession: a chat that moved between accounts', () => {
  const MOVED = '5a5a5a5a-1111-4222-8333-444455556666'
  const aDir = join(home, 'acct-a')
  const bDir = join(home, 'acct-b')
  const file = (dir: string) => join(dir, 'projects', slug, `${MOVED}.jsonl`)
  const write = (dir: string, text: string, mtimeSec: number) => {
    mkdirSync(join(dir, 'projects', slug), { recursive: true })
    writeFileSync(file(dir), text)
    utimesSync(file(dir), mtimeSec, mtimeSec)
  }

  test('an older copy of the same transcript is refreshed from the newer one (A -> B -> A)', () => {
    write(aDir, 'turn 1\n', 1_000)
    write(bDir, 'turn 1\nturn 2 on B\n', 2_000)
    const r = seedSession(MOVED, cwd, aDir, [join(bDir, 'projects')], home)
    expect(r).toEqual({ status: 'refreshed', from: file(bDir), to: file(aDir) })
    expect(readFileSync(file(aDir), 'utf8')).toBe('turn 1\nturn 2 on B\n')
    // up to date now: present
    expect(seedSession(MOVED, cwd, aDir, [join(bDir, 'projects')], home).status).toBe('present')
  })

  test('a copy that went its own way, or a source that is not newer, is kept', () => {
    write(aDir, 'turn 1\nturn 2 on A\n', 3_000)
    write(bDir, 'turn 1\nturn 2 on B\nturn 3\n', 4_000)
    expect(seedSession(MOVED, cwd, aDir, [join(bDir, 'projects')], home).status).toBe('present')
    expect(readFileSync(file(aDir), 'utf8')).toBe('turn 1\nturn 2 on A\n')

    write(aDir, 'turn 1\n', 5_000)
    expect(seedSession(MOVED, cwd, aDir, [join(bDir, 'projects')], home).status).toBe('present')
    expect(readFileSync(file(aDir), 'utf8')).toBe('turn 1\n')
  })

  test('the folder the chat last ran in is the source, though another copy is newer', () => {
    const cDir = join(home, 'acct-c')
    const dDir = join(home, 'acct-d')
    write(bDir, 'turn 1\nturn 2 on B\n', 6_000)
    write(dDir, 'someone else\n', 7_000)
    const r = seedSession(MOVED, cwd, cDir, [join(dDir, 'projects')], home, join(bDir, 'projects'))
    expect(r).toEqual({ status: 'copied', from: file(bDir), to: file(cDir) })
    expect(readFileSync(file(cDir), 'utf8')).toBe('turn 1\nturn 2 on B\n')
  })
})

describe('seedSession: the sidecar folder goes along', () => {
  const SIDE = '7c7c7c7c-1111-4222-8333-444455556666'
  const at = (dir: string, ...parts: string[]) => join(dir, 'projects', slug, ...parts)
  const put = (path: string, text: string, mtimeSec?: number) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
    if (mtimeSec !== undefined) utimesSync(path, mtimeSec, mtimeSec)
  }
  const sidecar = ['subagents/agent-a1.jsonl', 'subagents/agent-a1.meta.json', 'tool-results/r1.txt', 'workflows/w1/run.js', 'custom-title.json']

  test('a copy takes the sub-agent transcripts, tool results, workflows and title with it', () => {
    const src = join(home, 'side-src-1')
    const dst = join(home, 'side-dst-1')
    put(at(src, `${SIDE}.jsonl`), 'turn 1\n')
    for (const f of sidecar) put(at(src, SIDE, f), `from ${f}`)
    expect(seedSession(SIDE, cwd, dst, [join(src, 'projects')], home).status).toBe('copied')
    for (const f of sidecar) expect(readFileSync(at(dst, SIDE, f), 'utf8')).toBe(`from ${f}`)
  })

  test('a refresh adds only the files the target lacks, and keeps its own', () => {
    const src = join(home, 'side-src-2')
    const dst = join(home, 'side-dst-2')
    put(at(dst, `${SIDE}.jsonl`), 'turn 1\n', 1_000)
    put(at(dst, SIDE, 'custom-title.json'), '{"title":"named on this account"}')
    put(at(src, `${SIDE}.jsonl`), 'turn 1\nturn 2\n', 2_000)
    put(at(src, SIDE, 'custom-title.json'), '{"title":"named at the source"}')
    put(at(src, SIDE, 'tool-results', 'r2.txt'), 'turn 2 output')
    expect(seedSession(SIDE, cwd, dst, [join(src, 'projects')], home).status).toBe('refreshed')
    expect(readFileSync(at(dst, SIDE, 'custom-title.json'), 'utf8')).toBe('{"title":"named on this account"}')
    expect(readFileSync(at(dst, SIDE, 'tool-results', 'r2.txt'), 'utf8')).toBe('turn 2 output')
  })

  test('a copy already there without its sidecar (made before sidecars went along) gets it, its transcript untouched', () => {
    const src = join(home, 'side-src-4')
    const dst = join(home, 'side-dst-4')
    put(at(dst, `${SIDE}.jsonl`), 'turn 1\nturn 2 here\n', 2_000)
    put(at(src, `${SIDE}.jsonl`), 'turn 1\n', 1_000)
    for (const f of sidecar) put(at(src, SIDE, f), `from ${f}`)
    expect(seedSession(SIDE, cwd, dst, [join(src, 'projects')], home).status).toBe('present')
    for (const f of sidecar) expect(readFileSync(at(dst, SIDE, f), 'utf8')).toBe(`from ${f}`)
    expect(readFileSync(at(dst, `${SIDE}.jsonl`), 'utf8')).toBe('turn 1\nturn 2 here\n')
  })

  test('a copy whose sidecar fails partway leaves no transcript, so the next call finishes it', () => {
    const src = join(home, 'side-src-5')
    const dst = join(home, 'side-dst-5')
    put(at(src, `${SIDE}.jsonl`), 'turn 1\n')
    for (const f of sidecar) put(at(src, SIDE, f), `from ${f}`)
    // a file where the subagents folder must go makes the sidecar copy throw
    put(at(dst, SIDE, 'subagents'), 'in the way')
    expect(() => seedSession(SIDE, cwd, dst, [join(src, 'projects')], home)).toThrow()
    expect(existsSync(at(dst, `${SIDE}.jsonl`))).toBe(false)

    rmSync(at(dst, SIDE, 'subagents'))
    expect(seedSession(SIDE, cwd, dst, [join(src, 'projects')], home).status).toBe('copied')
    for (const f of sidecar) expect(readFileSync(at(dst, SIDE, f), 'utf8')).toBe(`from ${f}`)
    expect(readFileSync(at(dst, `${SIDE}.jsonl`), 'utf8')).toBe('turn 1\n')
  })

  test('a session without one is copied alone, and no empty folder is made', () => {
    const LONE = '8d8d8d8d-1111-4222-8333-444455556666'
    const src = join(home, 'side-src-3')
    const dst = join(home, 'side-dst-3')
    put(at(src, `${LONE}.jsonl`), 'turn 1\n')
    expect(seedSession(LONE, cwd, dst, [join(src, 'projects')], home).status).toBe('copied')
    expect(existsSync(at(dst, `${LONE}.jsonl`))).toBe(true)
    expect(existsSync(at(dst, LONE))).toBe(false)
  })
})

describe('forkPoint', () => {
  const FORKED = '6b6b6b6b-1111-4222-8333-444455556666'
  const root = join(home, 'fork-root', 'projects')
  const at = join(root, slug, `${FORKED}.jsonl`)

  test("the last chain entry's uuid, past summaries and sidechains; null with no file or no entry", () => {
    expect(forkPoint(FORKED, cwd, [root])).toBeNull()
    mkdirSync(join(root, slug), { recursive: true })
    writeFileSync(at, '{"type":"summary","leafUuid":"x"}\n')
    expect(forkPoint(FORKED, cwd, [root])).toBeNull()
    const lines = [
      { type: 'user', uuid: 'u-1', parentUuid: null },
      { type: 'assistant', uuid: 'a-1', parentUuid: 'u-1' },
      { type: 'assistant', uuid: 'side-1', parentUuid: 'a-1', isSidechain: true },
      { type: 'file-history-snapshot', messageId: 'm' },
    ]
    writeFileSync(at, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    expect(forkPoint(FORKED, cwd, [root])).toBe('a-1')
  })

  test('an entry longer than the short tail is still found', () => {
    const big = JSON.stringify({ type: 'user', uuid: 'u-big', parentUuid: 'a-1', message: { content: 'x'.repeat(100 * 1024) } })
    writeFileSync(at, JSON.stringify({ type: 'assistant', uuid: 'a-1', parentUuid: null }) + '\n' + big + '\n')
    expect(forkPoint(FORKED, cwd, [root])).toBe('u-big')
  })
})

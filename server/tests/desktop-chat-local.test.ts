import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatLocal, type ImportArgs } from '../src/core/desktop-chat-local'
import type { IncomingChat } from '../src/core/desktop-chat-types'

const ACCT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ORG = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SESSION = '11111111-1111-4111-8111-111111111111'
const STALE = '22222222-2222-4222-8222-222222222222'

let root: string
let profile: string
let projects: string

function record(dir: string, account: string, id: string, extra: Record<string, unknown> = {}) {
  const folder = join(dir, 'claude-code-sessions', account, ORG)
  mkdirSync(folder, { recursive: true })
  writeFileSync(
    join(folder, `local_${id}.json`),
    JSON.stringify({ cliSessionId: id, title: 'A chat', cwd: 'X:\\work', ...extra }),
  )
}

function incoming(over: Partial<IncomingChat> = {}): IncomingChat {
  return {
    id: SESSION,
    sessionId: SESSION,
    project: 'proj',
    account: ACCT,
    org: ORG,
    record: { title: 'Shared chat', effort: 'high' },
    archived: false,
    origin: { pc: 'pc-1', name: 'other-pc' },
    ...over,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chat-local-'))
  profile = join(root, 'profile')
  projects = join(root, 'projects')
  mkdirSync(profile, { recursive: true })
  mkdirSync(projects, { recursive: true })
  writeFileSync(join(profile, 'config.json'), JSON.stringify({ lastKnownAccountUuid: ACCT }))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('list', () => {
  test('returns a visible chat with its project and size, and skips a stale-login record', () => {
    record(profile, ACCT, SESSION)
    record(profile, OTHER, STALE)
    mkdirSync(join(projects, 'proj'))
    writeFileSync(join(projects, 'proj', `${SESSION}.jsonl`), 'hello\n')
    const chats = createChatLocal({ profileRoots: () => [profile], projectsDir: projects }).list()
    expect(chats).toHaveLength(1)
    expect(chats[0]).toMatchObject({
      id: SESSION,
      sessionId: SESSION,
      project: 'proj',
      account: ACCT,
      org: ORG,
      archived: false,
      size: 6,
    })
    expect(chats[0].record.title).toBe('A chat')
  })
})

describe('transcripts', () => {
  test('append writes only at the expected length', () => {
    const local = createChatLocal({ projectsDir: projects })
    expect(local.append('proj', SESSION, 0, Buffer.from('abc'))).toBe(true)
    expect(local.append('proj', SESSION, 1, Buffer.from('zzz'))).toBe(false)
    expect(readFileSync(join(projects, 'proj', `${SESSION}.jsonl`), 'utf8')).toBe('abc')
    expect(Buffer.from(local.read('proj', SESSION, 1, 3)).toString()).toBe('bc')
  })

  test('a path-escaping project or session name is refused', () => {
    const local = createChatLocal({ projectsDir: projects })
    expect(local.append('..', SESSION, 0, Buffer.from('x'))).toBe(false)
    expect(local.append('a/b', SESSION, 0, Buffer.from('x'))).toBe(false)
    expect(local.append('C:', SESSION, 0, Buffer.from('x'))).toBe(false)
    expect(local.append('proj', '../evil', 0, Buffer.from('x'))).toBe(false)
    expect(existsSync(join(root, 'evil.jsonl'))).toBe(false)
    expect(local.size('..', SESSION)).toBe(0)
  })
})

describe('land', () => {
  const faked = () => {
    const calls = { imports: [] as any[], archives: [] as string[] }
    return {
      calls,
      opts: {
        profileRoots: () => [profile],
        projectsDir: projects,
        isRunning: async () => true,
        importChat: async (a: ImportArgs) => {
          calls.imports.push(a)
          return { ok: true }
        },
        archiveChat: async (_p: string, s: string) => {
          calls.archives.push(s)
          return { ok: true }
        },
        renameChat: async () => ({ ok: true }),
      },
    }
  }

  test('imports into the profile signed into the chat account, with its title and settings', async () => {
    const f = faked()
    expect(await createChatLocal(f.opts).land(incoming())).toEqual({ ok: true })
    expect(f.calls.imports).toHaveLength(1)
    expect(f.calls.imports[0]).toMatchObject({
      sessionId: SESSION,
      instanceDir: profile,
      title: 'Shared chat',
      carried: { effort: 'high' },
    })
  })

  test('retries when no profile is signed into that account', async () => {
    const f = faked()
    const r = await createChatLocal(f.opts).land(incoming({ account: OTHER }))
    expect(r).toMatchObject({ ok: false, retry: true })
    expect(f.calls.imports).toHaveLength(0)
  })

  test('retries without importing when that profile app is closed', async () => {
    const f = faked()
    const r = await createChatLocal({ ...f.opts, isRunning: async () => false }).land(incoming())
    expect(r).toEqual({
      ok: false,
      reason: 'its desktop app is closed here; it lands when that app runs',
      retry: true,
    })
    expect(f.calls.imports).toHaveLength(0)
  })

  test('archives the existing copy when the incoming chat is archived', async () => {
    record(profile, ACCT, SESSION)
    const f = faked()
    expect(await createChatLocal(f.opts).land(incoming({ archived: true }))).toEqual({ ok: true })
    expect(f.calls.archives).toEqual([SESSION])
    expect(f.calls.imports).toHaveLength(0)
  })
})

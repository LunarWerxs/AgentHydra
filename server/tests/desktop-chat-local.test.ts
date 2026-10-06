import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatLocal } from '../src/core/desktop-chat-local'

const ACCT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ORG = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SESSION = '11111111-1111-4111-8111-111111111111'
const STALE = '22222222-2222-4222-8222-222222222222'

let root: string
let profile: string
let projects: string
let view: string

function record(dir: string, account: string, id: string, extra: Record<string, unknown> = {}) {
  const folder = join(dir, 'claude-code-sessions', account, ORG)
  mkdirSync(folder, { recursive: true })
  writeFileSync(
    join(folder, `local_${id}.json`),
    JSON.stringify({ cliSessionId: id, title: 'A chat', cwd: 'X:\\work', ...extra }),
  )
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chat-local-'))
  profile = join(root, 'profile')
  projects = join(root, 'projects')
  view = join(root, 'view')
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

describe('viewer', () => {
  test('a write starts the copy over at 0 and appends only at the length it has', () => {
    const local = createChatLocal({ projectsDir: projects, viewDir: view })
    expect(local.viewWrite('proj', SESSION, 0, Buffer.from('abc'))).toBe(true)
    expect(local.viewWrite('proj', SESSION, 1, Buffer.from('zzz'))).toBe(false)
    expect(local.viewWrite('proj', SESSION, 3, Buffer.from('de'))).toBe(true)
    expect(local.viewSize('proj', SESSION)).toBe(5)
    expect(local.viewWrite('proj', SESSION, 0, Buffer.from('x'))).toBe(true)
    expect(readFileSync(join(view, 'proj', `${SESSION}.jsonl`), 'utf8')).toBe('x')
    expect(existsSync(join(projects, 'proj'))).toBe(false)
  })

  test('a path-escaping project or session name is refused', () => {
    const local = createChatLocal({ projectsDir: projects, viewDir: view })
    expect(local.viewWrite('..', SESSION, 0, Buffer.from('x'))).toBe(false)
    expect(local.viewWrite('a/b', SESSION, 0, Buffer.from('x'))).toBe(false)
    expect(local.viewWrite('C:', SESSION, 0, Buffer.from('x'))).toBe(false)
    expect(local.viewWrite('proj', '../evil', 0, Buffer.from('x'))).toBe(false)
    expect(existsSync(join(root, 'evil.jsonl'))).toBe(false)
    expect(local.viewSize('..', SESSION)).toBe(0)
  })
})

describe('retire', () => {
  const landed = (text: string) => {
    record(profile, ACCT, SESSION)
    mkdirSync(join(projects, 'C--Users-other-work'), { recursive: true })
    writeFileSync(join(projects, 'C--Users-other-work', `${SESSION}.jsonl`), text)
  }
  const faked = (archive: { ok: boolean; reason?: string } = { ok: true }) => {
    const archives: string[] = []
    const local = createChatLocal({
      profileRoots: () => [profile],
      projectsDir: projects,
      viewDir: view,
      archiveChat: async (_p, s) => {
        archives.push(s)
        return archive
      },
    })
    return { archives, local }
  }

  test('archives the copy in the chat list and moves its transcript into the viewer', async () => {
    landed('{"n":1}\n')
    const f = faked()
    expect(await f.local.retire(SESSION, 8)).toEqual({ ok: true, kept: false })
    expect(f.archives).toEqual([SESSION])
    expect(f.local.viewSize('C--Users-other-work', SESSION)).toBe(8)
    expect(existsSync(join(projects, 'C--Users-other-work'))).toBe(false)
  })

  test('a transcript someone here went on in is kept where it is, unarchived', async () => {
    landed('{"n":1}\n{"here":1}\n')
    const f = faked()
    expect(await f.local.retire(SESSION, 8)).toEqual({ ok: true, kept: true })
    expect(f.archives).toEqual([])
    expect(readFileSync(join(projects, 'C--Users-other-work', `${SESSION}.jsonl`), 'utf8')).toBe(
      '{"n":1}\n{"here":1}\n',
    )
  })

  test('an archive the app did not confirm leaves the transcript and asks for another try', async () => {
    landed('{"n":1}\n')
    const f = faked({ ok: false, reason: 'native archive was not verified' })
    expect(await f.local.retire(SESSION, 8)).toEqual({
      ok: false,
      reason: 'native archive was not verified',
      retry: true,
    })
    expect(existsSync(join(projects, 'C--Users-other-work', `${SESSION}.jsonl`))).toBe(true)
    expect(f.local.viewSize('C--Users-other-work', SESSION)).toBe(0)
  })
})

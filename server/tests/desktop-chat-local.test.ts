import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatLocal, DESK_IDLE_MS } from '../src/core/desktop-chat-local'

const ACCT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ORG = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SESSION = '11111111-1111-4111-8111-111111111111'
const STALE = '22222222-2222-4222-8222-222222222222'
const DESK_ID = '33333333-3333-4333-8333-333333333333'
const DESK_SESSION = '44444444-4444-4444-8444-444444444444'
const SAME_ID = '55555555-5555-4555-8555-555555555555'
const IDLE_ID = '66666666-6666-4666-8666-666666666666'
const IDLE_SESSION = '77777777-7777-4777-8777-777777777777'
const NEW_ID = '88888888-8888-4888-8888-888888888888'

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
    const chats = createChatLocal({
      profileRoots: () => [profile],
      projectsDir: projects,
      deskHomes: [],
    }).list()
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

  test("lists Hydra Desk's chats with the transcript in their account's folder, each session once, and holds back one idle over a week", () => {
    record(profile, ACCT, SESSION)
    mkdirSync(join(projects, 'proj'))
    writeFileSync(join(projects, 'proj', `${SESSION}.jsonl`), 'hello\n')
    const account = join(root, 'cli-account')
    mkdirSync(join(account, 'projects', 'X--work'), { recursive: true })
    writeFileSync(join(account, 'projects', 'X--work', `${DESK_SESSION}.jsonl`), 'desk turn\n')
    mkdirSync(join(projects, 'X--work'))
    writeFileSync(join(projects, 'X--work', `${IDLE_SESSION}.jsonl`), 'old\n')
    const desk = join(root, 'desk')
    mkdirSync(desk)
    const now = Date.now()
    const chat = (
      id: string,
      sessionId: string | null,
      configDir: string | null,
      updatedAt = now,
    ) => ({
      id,
      sessionId,
      title: 'A Desk chat',
      cwd: 'X:\\work',
      archived: false,
      updatedAt,
      account: { id: configDir ? 'cli-1' : 'default', configDir },
    })
    writeFileSync(
      join(desk, 'chats.json'),
      JSON.stringify([
        chat(DESK_ID, DESK_SESSION, account),
        // The desktop record's session: listed once, as the record.
        chat(SAME_ID, SESSION, null),
        chat(IDLE_ID, IDLE_SESSION, null, now - DESK_IDLE_MS - 60_000),
        // Not started yet: it has no session.
        chat(NEW_ID, null, null),
      ]),
    )
    const local = createChatLocal({
      profileRoots: () => [profile],
      projectsDir: projects,
      deskHomes: [desk],
    })
    const chats = local.list()
    expect(chats.map((c) => [c.id, c.project, c.size, c.holdBack === true])).toEqual([
      [SESSION, 'proj', 6, false],
      [DESK_ID, 'X--work', 10, false],
      [IDLE_ID, 'X--work', 4, true],
    ])
    expect(chats[1].record).toMatchObject({
      title: 'A Desk chat',
      cwd: 'X:\\work',
      isArchived: false,
    })
    expect(Buffer.from(local.read('X--work', DESK_SESSION, 0, 100)).toString()).toBe('desk turn\n')
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

  test('archives the copy in the chat list and moves every copy of its transcript into the viewer', async () => {
    landed('{"n":1}\n')
    // An older copy, left under the folder the chat sat in before it was moved on its own PC.
    mkdirSync(join(projects, 'C--Users-other-earlier'), { recursive: true })
    writeFileSync(join(projects, 'C--Users-other-earlier', `${SESSION}.jsonl`), '{"n":')
    const f = faked()
    expect(await f.local.retire(SESSION, 8)).toEqual({ ok: true, kept: false })
    expect(f.archives).toEqual([SESSION])
    expect(f.local.viewSize('C--Users-other-work', SESSION)).toBe(8)
    expect(f.local.viewSize('C--Users-other-earlier', SESSION)).toBe(5)
    expect(existsSync(join(projects, 'C--Users-other-work'))).toBe(false)
    expect(existsSync(join(projects, 'C--Users-other-earlier'))).toBe(false)
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

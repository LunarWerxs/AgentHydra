// server/tests/session-launch.test.ts — the visible-terminal launch plan, pinned per platform.
//
// The prompt rides in a FILE, never on the command line: handoff prompts are long, multiline
// and quote-riddled, and the first design (inline quoting through `cmd /c start`) is exactly
// how arguments get silently mangled. These tests pin that the plan reads the file, keeps the
// window open on failure, and never interpolates the prompt text itself into argv.
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from '../src/db'
import {
  applyDesktopChatAutomation,
  applyDesktopChatTitle,
  archiveDesktopChat,
  buildImportPlan,
  buildTerminalLaunchPlan,
  bundledClaudeExe,
  desktopChatArchiveState,
  importSessionToDesktop,
  isSessionSuperseded,
  launchTerminalSession,
  seedDesktopSession,
  stampImportedChat,
  sweepUntitledDesktopChats,
} from '../src/session-launch'

function markDone(sessionId: string, done: boolean): void {
  db.query(
    'insert into session_marks (session_id, done, updated_at) values (?, ?, ?) on conflict(session_id) do update set done = ?, updated_at = ?',
  ).run(sessionId, done ? 1 : 0, Date.now(), done ? 1 : 0, Date.now())
}

test('windows: powershell reads the prompt file raw, window survives exit', () => {
  const plan = buildTerminalLaunchPlan(
    'win32',
    'C:\\Tools\\claude.exe',
    'C:\\tmp\\prompt-1.txt',
    'sonnet',
  )
  expect(plan.argv.slice(0, 5)).toEqual(['cmd', '/c', 'start', '', 'powershell'])
  expect(plan.argv).toContain('-NoExit')
  const ps = plan.argv[plan.argv.length - 1]
  expect(ps).toContain("Get-Content -Raw 'C:\\tmp\\prompt-1.txt'")
  expect(ps).toContain('--model sonnet')
  const withEffort = buildTerminalLaunchPlan(
    'win32',
    'C:\\Tools\\claude.exe',
    'C:\\tmp\\prompt-1.txt',
    'opus',
    'max',
  )
  expect(withEffort.argv[withEffort.argv.length - 1]).toContain('--model opus --effort max')
  // A terminal RESUME continues an existing thread with the prompt as its next turn - the
  // visible replacement for headless queue resumes (owner rule: nothing runs headless).
  const resume = buildTerminalLaunchPlan(
    'win32',
    'C:\\Tools\\claude.exe',
    'C:\\tmp\\p.txt',
    null,
    null,
    'sess-abc',
  )
  expect(resume.argv[resume.argv.length - 1]).toContain('--resume sess-abc')
})

test('windows: single quotes in paths are doubled for powershell, not left to break it', () => {
  const plan = buildTerminalLaunchPlan('win32', "C:\\o'brien\\claude.exe", 'C:\\tmp\\p.txt', null)
  expect(plan.argv[plan.argv.length - 1]).toContain("C:\\o''brien\\claude.exe")
  expect(plan.argv[plan.argv.length - 1]).not.toContain('--model')
})

test('the desktop import plan targets one instance via its profile dir', () => {
  const win = buildImportPlan(
    'win32',
    'C:\\LA\\AnthropicClaude\\claude.exe',
    'c:\\users\\x\\.claude-instances\\work',
    'abc-123',
  )
  expect(win).toEqual([
    'C:\\LA\\AnthropicClaude\\claude.exe',
    '--user-data-dir=c:\\users\\x\\.claude-instances\\work',
    'claude://resume?session=abc-123',
  ])
  // darwin: resolveLaunchBinary returns the 'Claude' marker, which must go through `open -na`.
  const mac = buildImportPlan('darwin', 'Claude', '/Users/x/instances/work', 'abc-123')
  expect(mac.slice(0, 4)).toEqual(['open', '-na', 'Claude', '--args'])
})

test('import refuses a non-running instance instead of booting it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthydra-import-guard-'))
  const r = await importSessionToDesktop({
    sessionId: 'no-such-session',
    instanceDir: dir,
    isLive: () => false,
    isInstanceRunning: async () => false,
  })
  expect(r.ok).toBe(false)
  expect(r.reason).toContain('instance-not-running')
  const live = await importSessionToDesktop({
    sessionId: 'no-such-session',
    instanceDir: dir,
    isLive: () => true,
    isInstanceRunning: async () => true,
  })
  expect(live.reason).toContain('session-live')
})

test('applyDesktopChatTitle writes the same field pair the app itself writes', () => {
  const profile = mkdtempSync(join(tmpdir(), 'agenthydra-title-'))
  const store = join(profile, 'claude-code-sessions', 'org-1', 'user-1')
  mkdirSync(store, { recursive: true })
  const metaPath = join(store, 'local_sess-t1.json')
  writeFileSync(metaPath, JSON.stringify({ cliSessionId: 'sess-t1', isArchived: false }))
  expect(applyDesktopChatTitle(profile, 'sess-t1', 'My Real Title')).toBe('titled')
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  expect(meta.title).toBe('My Real Title')
  expect(meta.titleSource).toBe('tool')
  expect(applyDesktopChatTitle(profile, 'sess-nope', 'x')).toBe('not-found')
})

test('the title janitor names untitled chats, respects real names, skips generic candidates', () => {
  const profile = mkdtempSync(join(tmpdir(), 'agenthydra-janitor-'))
  const store = join(profile, 'claude-code-sessions', 'org-1', 'user-1')
  mkdirSync(store, { recursive: true })
  writeFileSync(
    join(store, 'local_sid-untitled.json'),
    JSON.stringify({ cliSessionId: 'sid-untitled' }),
  )
  writeFileSync(
    join(store, 'local_sid-generic.json'),
    JSON.stringify({ cliSessionId: 'sid-generic', title: 'General coding session' }),
  )
  writeFileSync(
    join(store, 'local_sid-named.json'),
    JSON.stringify({ cliSessionId: 'sid-named', title: 'My hand-picked name' }),
  )
  writeFileSync(
    join(store, 'local_sid-nocandidate.json'),
    JSON.stringify({ cliSessionId: 'sid-nocandidate' }),
  )
  const titles: Record<string, string | null> = {
    'sid-untitled': 'Ship the parser rewrite',
    'sid-generic': 'PyOverdrive batch 15 (shape sweep)',
    'sid-named': 'Should never be used',
    'sid-nocandidate': 'Untitled',
  }
  const swept = sweepUntitledDesktopChats((sid) => titles[sid] ?? null, [profile])
  expect(swept.fixed).toBe(2)
  expect(swept.profiles).toEqual([profile]) // renamed profiles feed the visibility restart
  const read = (n: string) => JSON.parse(readFileSync(join(store, n), 'utf8'))
  expect(read('local_sid-untitled.json').title).toBe('Ship the parser rewrite')
  expect(read('local_sid-generic.json').title).toBe('PyOverdrive batch 15 (shape sweep)')
  expect(read('local_sid-named.json').title).toBe('My hand-picked name')
  expect(read('local_sid-nocandidate.json').title).toBeUndefined()
})

test('imported chats are stamped bypassPermissions, not left to deadlock on a shell prompt', () => {
  // Measured 2026-08-26: the app creates an imported chat with permissionMode 'acceptEdits',
  // which auto-approves EDITS but prompts on every shell command - so five revived chats each
  // ran one Bash call and froze forever at an approval the remote owner could never click.
  const profile = mkdtempSync(join(tmpdir(), 'agenthydra-perm-'))
  const store = join(profile, 'claude-code-sessions', 'org-1', 'user-1')
  mkdirSync(store, { recursive: true })
  const metaPath = join(store, 'local_sess-perm-1.json')
  writeFileSync(
    metaPath,
    JSON.stringify({ cliSessionId: 'sess-perm-1', permissionMode: 'acceptEdits' }),
  )
  expect(applyDesktopChatAutomation(profile, 'sess-perm-1')).toBe(true)
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  expect(meta.permissionMode).toBe('bypassPermissions')
  expect(meta.cliSessionId).toBe('sess-perm-1') // nothing else disturbed
  expect(applyDesktopChatAutomation(profile, 'sess-nope')).toBe(false)
})

test('an UNTITLED import is still stamped bypassPermissions', async () => {
  // The regression this pins: the stamping step used to start `if (!title) return`, placed BEFORE
  // the automation stamp, so an import with no title kept the app's `acceptEdits` default and then
  // deadlocked on its first shell call with nobody there to approve it. Both import routes can
  // pass an empty title, and no test reached this code because every other import test stops at a
  // guard long before the spawn. Measured 2026-08-28 moving 13 chats between accounts.
  const profile = mkdtempSync(join(tmpdir(), 'agenthydra-untitled-'))
  const store = join(profile, 'claude-code-sessions', 'org-1', 'user-1')
  mkdirSync(store, { recursive: true })
  const metaPath = join(store, 'local_sess-untitled.json')
  writeFileSync(
    metaPath,
    JSON.stringify({ cliSessionId: 'sess-untitled', permissionMode: 'acceptEdits' }),
  )

  for (const noTitle of [undefined, null, '   ']) {
    writeFileSync(
      metaPath,
      JSON.stringify({ cliSessionId: 'sess-untitled', permissionMode: 'acceptEdits' }),
    )
    const titled = await stampImportedChat(profile, 'sess-untitled', noTitle)
    expect(titled).toBe(false) // no title was written...
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    expect(meta.permissionMode).toBe('bypassPermissions') // ...but the posture WAS stamped
    expect(meta.title).toBeUndefined()
  }

  // and a titled import still does both
  const titled = await stampImportedChat(profile, 'sess-untitled', 'Real title')
  expect(titled).toBe(true)
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  expect(meta.title).toBe('Real title')
  expect(meta.permissionMode).toBe('bypassPermissions')
})

test('stampImportedChat gives up at its deadline instead of blocking forever', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agenthydra-stamp-deadline-'))
  mkdirSync(join(profile, 'claude-code-sessions', 'org-1', 'user-1'), { recursive: true })
  let slept = 0
  const titled = await stampImportedChat(profile, 'never-created', 'x', 1200, async (ms) => {
    slept += ms
  })
  expect(titled).toBe(false)
  expect(slept).toBeGreaterThan(0) // it really did poll rather than bail on the first miss
})

test('archiveDesktopChat flips the metadata flag by filename across profiles', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agenthydra-archive-'))
  const store = join(profile, 'claude-code-sessions', 'org-1', 'user-1')
  mkdirSync(store, { recursive: true })
  const metaPath = join(store, 'local_sess-arch-1.json')
  writeFileSync(metaPath, JSON.stringify({ cliSessionId: 'sess-arch-1', isArchived: false }))
  const notRunning = async () => false
  const r = await archiveDesktopChat('sess-arch-1', true, [profile], notRunning)
  expect(r.ok).toBe(true)
  expect(r.hits).toHaveLength(1)
  expect(r.hits[0].wasRunning).toBe(false)
  expect(JSON.parse(readFileSync(metaPath, 'utf8')).isArchived).toBe(true)
  // The read-only probe the archive janitor proposes from agrees with the flag at every step.
  expect(desktopChatArchiveState('sess-arch-1', [profile])).toEqual({
    found: true,
    archived: true,
  })
  const back = await archiveDesktopChat('sess-arch-1', false, [profile], notRunning)
  expect(back.ok).toBe(true)
  expect(JSON.parse(readFileSync(metaPath, 'utf8')).isArchived).toBe(false)
  expect(desktopChatArchiveState('sess-arch-1', [profile])).toEqual({
    found: true,
    archived: false,
  })
  expect(desktopChatArchiveState('sess-nope', [profile]).found).toBe(false)
  const miss = await archiveDesktopChat('sess-nope', true, [profile], notRunning)
  expect(miss.ok).toBe(false)
  expect(miss.reason).toBe('no-desktop-chat-found')
})

test('bundledClaudeExe picks the numerically newest version, not the lexicographic one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthydra-bundled-'))
  const exeName = process.platform === 'win32' ? 'claude.exe' : 'claude'
  // 2.1.9 vs 2.1.237: lexicographic sort would pick 2.1.9. The real store hit exactly this shape.
  for (const v of ['2.1.9', '2.1.237']) {
    mkdirSync(join(dir, 'claude-code', v), { recursive: true })
    writeFileSync(join(dir, 'claude-code', v, exeName), '')
  }
  expect(bundledClaudeExe(dir)).toContain('2.1.237')
  expect(bundledClaudeExe(join(dir, 'no-such'))).toBe(null)
})

// --- one lineage, one continuation: superseded (done-marked) sessions stay retired ------------

test('isSessionSuperseded reads the done-mark ledger', () => {
  expect(isSessionSuperseded('lineage-none')).toBe(false)
  markDone('lineage-a', true)
  expect(isSessionSuperseded('lineage-a')).toBe(true)
  markDone('lineage-a', false)
  expect(isSessionSuperseded('lineage-a')).toBe(false)
})

test('import refuses a done-marked lineage; force falls through to the next guard', async () => {
  markDone('lineage-b', true)
  const refused = await importSessionToDesktop({
    sessionId: 'lineage-b',
    instanceDir: 'X:\\no-such-instance',
    isLive: () => false,
  })
  expect(refused.ok).toBe(false)
  expect(refused.reason).toStartWith('superseded')
  // force: the lineage guard steps aside and the ordinary guards take over.
  const forced = await importSessionToDesktop({
    sessionId: 'lineage-b',
    instanceDir: 'X:\\no-such-instance',
    isLive: () => false,
    force: true,
  })
  expect(forced.reason).toBe('instance-dir-not-found')
  markDone('lineage-b', false)
})

test('a terminal resume of a done-marked lineage is refused before anything launches', async () => {
  markDone('lineage-c', true)
  const res = await launchTerminalSession({
    cwd: 'D:\\Fake',
    prompt: 'resume',
    resumeSessionId: 'lineage-c',
  })
  expect(res.ok).toBe(false)
  expect(res.reason).toStartWith('superseded')
  markDone('lineage-c', false)
})

test('seedDesktopSession writes a resumable two-record transcript, gated on a running instance', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agenthydra-seed-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'agenthydra-seed-cwd-'))
  const inst = mkdtempSync(join(tmpdir(), 'agenthydra-seed-inst-'))
  // A closed instance refuses the seed the same way it refuses imports (never boot an account).
  const refused = await seedDesktopSession({
    cwd,
    title: 'Seeded thread',
    instanceRef: `desktop:${inst}`,
    isInstanceRunning: async () => false,
    claudeHome: home,
  })
  expect(refused.ok).toBe(false)
  expect(refused.reason).toContain('instance-not-running')
  expect(
    seedDesktopSession({ cwd, title: 'x', instanceRef: 'cli:whatever', claudeHome: home }),
  ).resolves.toMatchObject({ ok: false })
  // The transcript the refused attempt wrote is still a valid seed: two linked records, the
  // session id in every record, and a tail that parses as a finished turn.
  const projectKey = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const files = readdirSync(join(home, 'projects', projectKey))
  expect(files).toHaveLength(1)
  const lines = readFileSync(join(home, 'projects', projectKey, files[0]), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  expect(lines).toHaveLength(2)
  expect(lines[0].type).toBe('user')
  expect(lines[1].type).toBe('assistant')
  expect(lines[0].sessionId).toBe(files[0].replace(/\.jsonl$/, ''))
  expect(lines[1].parentUuid).toBe(lines[0].uuid)
  expect(lines[0].cwd).toBe(cwd)
})

test('darwin and linux read the file via cat; unknown platforms still return the command text', () => {
  const mac = buildTerminalLaunchPlan('darwin', '/usr/local/bin/claude', '/tmp/p.txt', null)
  expect(mac.argv[0]).toBe('osascript')
  expect(mac.command).toContain("$(cat '/tmp/p.txt')")
  const linux = buildTerminalLaunchPlan('linux', '/usr/bin/claude', '/tmp/p.txt', 'haiku')
  expect(linux.argv[0]).toBe('x-terminal-emulator')
  expect(linux.command).toContain('--model haiku')
  const other = buildTerminalLaunchPlan('freebsd' as NodeJS.Platform, 'claude', '/tmp/p.txt', null)
  expect(other.argv).toHaveLength(0)
  expect(other.command).toContain('claude')
})

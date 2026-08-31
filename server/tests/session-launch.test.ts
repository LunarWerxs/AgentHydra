// server/tests/session-launch.test.ts — the visible-terminal launch plan, pinned per platform.
//
// The prompt rides in a FILE, never on the command line: handoff prompts are long, multiline
// and quote-riddled, and the first design (inline quoting through `cmd /c start`) is exactly
// how arguments get silently mangled. These tests pin that the plan reads the file, keeps the
// window open on failure, and never interpolates the prompt text itself into argv.
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from '../src/db'
import {
  alreadyRendersIn,
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
  reassertAutomationStamps,
  reassertChatAutomation,
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
    title: 'A real guard-test title',
    sessionId: 'no-such-session',
    instanceDir: dir,
    isLive: () => false,
    isInstanceRunning: async () => false,
  })
  expect(r.ok).toBe(false)
  expect(r.reason).toContain('instance-not-running')
  const live = await importSessionToDesktop({
    title: 'A real guard-test title',
    sessionId: 'no-such-session',
    instanceDir: dir,
    isLive: () => true,
    isInstanceRunning: async () => true,
  })
  expect(live.reason).toContain('session-live')
})

// A SECOND IMPORT OF AN ALREADY-RENDERED CHAT IS THE BUG THAT MADE SURFACED CHATS
// UNREACHABLE: the app draws a second row with the same name, and every name-aimed operation
// (courier delivery, UI archive, rename) then correctly refuses as ambiguous - so the resume
// never arrives and the chat sits dormant with its prompt staged. Measured 2026-08-31 on a
// chat that collected three identical rows across three surfaces.
test('alreadyRendersIn only claims residency for a live chat under that instance', () => {
  const dir = 'C:\\Users\\x\\.claude-instances\\temp2'
  const inside = `${dir}\\claude-code-sessions\\org\\user\\local_abc.json`
  expect(alreadyRendersIn({ archived: false, path: inside }, dir)).toBe(true)
  // Slash style and a trailing separator must not change the answer.
  expect(alreadyRendersIn({ archived: false, path: inside.replace(/\\/g, '/') }, `${dir}\\`)).toBe(
    true,
  )
  // An ARCHIVED row draws nothing, so importing is exactly right there.
  expect(alreadyRendersIn({ archived: true, path: inside }, dir)).toBe(false)
  // A row in a DIFFERENT instance is not this instance's row.
  expect(
    alreadyRendersIn({ archived: false, path: inside }, 'C:\\Users\\x\\.claude-instances\\temp1'),
  ).toBe(false)
  // A sibling whose name merely starts the same must not count as being inside it.
  expect(
    alreadyRendersIn(
      { archived: false, path: 'C:\\Users\\x\\.claude-instances\\temp20\\a\\local_abc.json' },
      dir,
    ),
  ).toBe(false)
  expect(alreadyRendersIn(null, dir)).toBe(false)
})

test('import skips the spawn when the chat already renders in that instance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthydra-import-dup-'))
  const r = await importSessionToDesktop({
    title: 'A real duplicate-guard title',
    sessionId: 'already-there',
    instanceDir: dir,
    isLive: () => false,
    isInstanceRunning: async () => true,
    findRendered: () => ({ archived: false, path: join(dir, 'claude-code-sessions', 'x.json') }),
  })
  expect(r.ok).toBe(true)
  expect(r.alreadyRendered).toBe(true)
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

test('the stamp survives the app boot re-save: the watcher rewrites what the app flips back', async () => {
  // The regression this pins, measured 2026-08-29 01:58 UTC: a freshly seeded chat (stamped
  // bypassPermissions) was booted via send_message ~15s later, the app's boot re-save rewrote
  // the metadata from memory — 'acceptEdits' again — and the chat froze forever at its first
  // PowerShell approval prompt. The watcher must restore the stamp after the flip, so the file
  // stops testifying to the wrong mode at the app's next store read.
  const profile = mkdtempSync(join(tmpdir(), 'agenthydra-reassert-'))
  const store = join(profile, 'claude-code-sessions', 'org-1', 'user-1')
  mkdirSync(store, { recursive: true })
  const metaPath = join(store, 'local_sess-boot-1.json')
  // As stampImportedChat leaves a seeded chat: stamped, titled, not yet booted.
  const seeded = { cliSessionId: 'sess-boot-1', permissionMode: 'bypassPermissions', title: 'S' }
  writeFileSync(metaPath, JSON.stringify(seeded))
  let ticks = 0
  const restores = await reassertChatAutomation(profile, 'sess-boot-1', {
    windowMs: 10_000,
    intervalMs: 1_000,
    now: () => ticks * 1_000,
    sleep: async () => {
      ticks++
      // Tick 2 is the app's boot re-save: the whole record rewritten from memory, where the
      // import handler put acceptEdits.
      if (ticks === 2)
        writeFileSync(metaPath, JSON.stringify({ ...seeded, permissionMode: 'acceptEdits' }))
    },
  })
  expect(restores).toBe(1) // restored once, then left alone — no tug-of-war on a settled file
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  expect(meta.permissionMode).toBe('bypassPermissions')
  expect(meta.title).toBe('S') // the restore rewrites the mode, not the record
  // Idempotence: a second watch over an already-correct file writes nothing.
  ticks = 0
  const again = await reassertChatAutomation(profile, 'sess-boot-1', {
    windowMs: 3_000,
    intervalMs: 1_000,
    now: () => ticks * 1_000,
    sleep: async () => {
      ticks++
    },
  })
  expect(again).toBe(0)
})

test('the watcher is bounded: a restore cap against a hostile flipper, a miss cap for a chat that never appears', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agenthydra-reassert-bound-'))
  const store = join(profile, 'claude-code-sessions', 'org-1', 'user-1')
  mkdirSync(store, { recursive: true })
  const metaPath = join(store, 'local_sess-fight.json')
  const record = { cliSessionId: 'sess-fight', permissionMode: 'acceptEdits' }
  writeFileSync(metaPath, JSON.stringify(record))
  let ticks = 0
  // The app "wins" every tick: the watcher restores maxRestores times and stands down long
  // before its window, instead of fighting forever.
  const restores = await reassertChatAutomation(profile, 'sess-fight', {
    windowMs: 600_000,
    intervalMs: 1_000,
    maxRestores: 3,
    now: () => ticks * 1_000,
    sleep: async () => {
      ticks++
      writeFileSync(metaPath, JSON.stringify(record))
    },
  })
  expect(restores).toBe(3)
  expect(ticks).toBe(3)
  // A session whose metadata never appears (the import failed): give up at the miss cap, not
  // at the far window — there is nothing to guard.
  let missTicks = 0
  const none = await reassertChatAutomation(profile, 'sess-never-created', {
    windowMs: 600_000,
    intervalMs: 1_000,
    maxMisses: 5,
    now: () => missTicks * 1_000,
    sleep: async () => {
      missTicks++
    },
  })
  expect(none).toBe(0)
  expect(missTicks).toBe(5)
})

test('reassertAutomationStamps restamps clobbered imports only, never app-created chats', () => {
  // The durable half: run in the archive-visibility restart's quit→reopen window, the one
  // moment a daemon write provably enters the app's memory (same window 4499079 proved for
  // archive flags). Import shape = file named after the CLI id; an app-created chat is filed
  // under the app's own id and its mode may be the owner's deliberate UI choice.
  const profile = mkdtempSync(join(tmpdir(), 'agenthydra-restamp-'))
  const store = join(profile, 'claude-code-sessions', 'org-1', 'user-1')
  mkdirSync(store, { recursive: true })
  const read = (n: string) => JSON.parse(readFileSync(join(store, n), 'utf8'))
  // A seeded import whose stamp the app's boot re-save erased.
  writeFileSync(
    join(store, 'local_imp-clobbered.json'),
    JSON.stringify({ cliSessionId: 'imp-clobbered', permissionMode: 'acceptEdits', title: 'T' }),
  )
  // An import still carrying its stamp: left byte-identical (idempotence).
  writeFileSync(
    join(store, 'local_imp-fine.json'),
    JSON.stringify({ cliSessionId: 'imp-fine', permissionMode: 'bypassPermissions' }),
  )
  // An app-created chat (filed under the app's own id, CLI id inside) on acceptEdits: NOT ours.
  writeFileSync(
    join(store, 'local_app-own-id.json'),
    JSON.stringify({ cliSessionId: 'cli-elsewhere', permissionMode: 'acceptEdits' }),
  )
  // A corrupt file must not stop the sweep.
  writeFileSync(join(store, 'local_broken.json'), '{not json')
  expect(reassertAutomationStamps(profile)).toBe(1)
  expect(read('local_imp-clobbered.json').permissionMode).toBe('bypassPermissions')
  expect(read('local_imp-clobbered.json').title).toBe('T')
  expect(read('local_imp-fine.json').permissionMode).toBe('bypassPermissions')
  expect(read('local_app-own-id.json').permissionMode).toBe('acceptEdits')
  // Second pass: everything already converged, nothing rewritten.
  expect(reassertAutomationStamps(profile)).toBe(0)
  // A profile with no store is a no-op, not a throw.
  expect(reassertAutomationStamps(join(profile, 'no-such-dir'))).toBe(0)
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
    title: 'A real guard-test title',
    sessionId: 'lineage-b',
    instanceDir: 'X:\\no-such-instance',
    isLive: () => false,
  })
  expect(refused.ok).toBe(false)
  expect(refused.reason).toStartWith('superseded')
  // force: the lineage guard steps aside and the ordinary guards take over.
  const forced = await importSessionToDesktop({
    title: 'A real guard-test title',
    sessionId: 'lineage-b',
    instanceDir: 'X:\\no-such-instance',
    isLive: () => false,
    force: true,
  })
  expect(forced.reason).toBe('instance-dir-not-found')
  markDone('lineage-b', false)
})

test('the import chokepoint refuses a generic or missing title - the naming law has no bypass', async () => {
  const { importSessionToDesktop } = await import('../src/session-launch')
  for (const title of [null, undefined, '', 'Untitled', '[orchestrator] seeded']) {
    const r = await importSessionToDesktop({
      sessionId: 'any-session',
      instanceDir: 'C:\nowhere',
      title: title as string | null,
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('title-required')
  }
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

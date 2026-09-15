// server/tests/ui-archive.test.ts - the server-side UI archive click's safety rails, pinned:
// it may only fire on a real disk title rendered exactly once, and success is verified BY ID
// on disk, never by title (the drill-cleanup law).
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHAT_MANAGER_FILE, RUNTIME_MISC_FILES } from '../src/misc-assets'
import {
  bestRenderedAlias,
  parseListOutput,
  renameChatDiscoveringRenderedTitle,
  type UiArchiveDeps,
  uiArchiveChat,
  uiRenameChat,
} from '../src/ui-archive'

function deps(over: {
  title?: string | null
  rendered?: string[]
  invokeCode?: number
  archivedAfter?: boolean
  titleCount?: number
  /** How many chats with that title are NOT archived - i.e. could be wrongly retired. */
  liveTitleCount?: number
}): { d: UiArchiveDeps; calls: string[] } {
  const calls: string[] = []
  let t = 0
  const d: UiArchiveDeps = {
    readTitle: () => (over.title === undefined ? 'Real Chat Name' : over.title),
    list: async () => over.rendered ?? ['Real Chat Name', 'Something Else'],
    invoke: async (_dir, title) => {
      calls.push(`invoke:${title}`)
      return { code: over.invokeCode ?? 0, out: 'x' }
    },
    readArchived: () => over.archivedAfter ?? true,
    readTitleCount: () => over.titleCount ?? 1,
    readLiveTitleCount: () => over.liveTitleCount ?? over.titleCount ?? 1,
    sleep: async () => {},
    now: () => (t += 1000),
  }
  return { d, calls }
}

test('happy path: unique rendered title, click fires, archive verified by id', async () => {
  const { d, calls } = deps({})
  const r = await uiArchiveChat('C:/i1', 'sid', d)
  expect(r).toEqual({ clicked: true, verified: true })
  expect(calls).toEqual(['invoke:Real Chat Name'])
})

test('a generic or missing disk title never clicks - a generic row could be the wrong chat', async () => {
  const { d, calls } = deps({ title: 'General coding session' })
  const r = await uiArchiveChat('C:/i1', 'sid', d)
  expect(r.clicked).toBe(false)
  expect(calls).toEqual([])
  const none = deps({ title: null })
  expect((await uiArchiveChat('C:/i1', 'sid', none.d)).clicked).toBe(false)
})

test('title not rendered and flag not set -> honest no-click (the flag sticks at restart)', async () => {
  const { d, calls } = deps({ rendered: ['Other A', 'Other B'], archivedAfter: false })
  const r = await uiArchiveChat('C:/i1', 'sid', d)
  expect(r.clicked).toBe(false)
  expect(r.verified).toBe(false)
  expect(r.reason).toContain('does not render')
  expect(calls).toEqual([])
})

test('title not rendered but flag already set -> settled (an idempotent re-act reads done)', async () => {
  const { d, calls } = deps({ rendered: ['Other A'], archivedAfter: true })
  const r = await uiArchiveChat('C:/i1', 'sid', d)
  expect(r.clicked).toBe(false)
  expect(r.verified).toBe(true)
  expect(r.reason).toContain('settled')
  expect(calls).toEqual([])
})

test('the SAME chat rendered twice is safe to click - disk holds one chat with the title', async () => {
  // Measured live: one imported chat rendered in two sidebar sections. The identity question
  // is answered on disk, not in the render tree.
  const { d, calls } = deps({ rendered: ['Real Chat Name', 'Real Chat Name'], titleCount: 1 })
  const r = await uiArchiveChat('C:/i1', 'sid', d)
  expect(r).toEqual({ clicked: true, verified: true })
  expect(calls).toEqual(['invoke:Real Chat Name'])
})

test('two chats sharing the title, one still LIVE -> refuse; the click could hit the wrong one', async () => {
  const { d, calls } = deps({ titleCount: 2, liveTitleCount: 1 })
  const r = await uiArchiveChat('C:/i1', 'sid', d)
  expect(r.clicked).toBe(false)
  expect(r.reason).toContain('2 chats')
  expect(calls).toEqual([])
})

test('a hard tool failure (exit 1/3) is a no-click with the exit surfaced', async () => {
  const { d } = deps({ invokeCode: 1 })
  const r = await uiArchiveChat('C:/i1', 'sid', d)
  expect(r.clicked).toBe(false)
  expect(r.reason).toContain('exited 1')
})

test('exit 2 (invoked, row lingered) still polls the disk - a late removal settles as verified', async () => {
  // The app can remove the row a beat after the script's fixed check; the disk flag is the
  // truth (review-confirmed: treating 2 as a hard failure threw away real successes).
  const { d } = deps({ invokeCode: 2, archivedAfter: true })
  const r = await uiArchiveChat('C:/i1', 'sid', d)
  expect(r).toEqual({ clicked: true, verified: true })
  const bad = deps({ invokeCode: 2, archivedAfter: false })
  const rb = await uiArchiveChat('C:/i1', 'sid', bad.d)
  expect(rb.clicked).toBe(true)
  expect(rb.verified).toBe(false)
  expect(rb.reason).toContain('do not blind-retry')
})

test('parseListOutput keeps titles VERBATIM past the two-space indent, and handles CRLF', () => {
  const out = '== c:\\x (pid 1) rendered chats ==\r\n   Leading Space\r\n  Normal Title\r\n  \r\n'
  expect(parseListOutput(out)).toEqual([' Leading Space', 'Normal Title'])
})

test('clicked but the disk flag never confirms -> clicked true, verified false, says so', async () => {
  const { d } = deps({ archivedAfter: false })
  const r = await uiArchiveChat('C:/i1', 'sid', d)
  expect(r.clicked).toBe(true)
  expect(r.verified).toBe(false)
  expect(r.reason).toContain('did not confirm')
})

test('a LOCALIZED row menu still matches the chat - the phrase is chrome, the title is the key', async () => {
  // Found live 2026-08-30 on a German app: the row menu reads 'Weitere Optionen fur <title>',
  // so matching the English 'More options for' prefix made archive silently inert for chats
  // sitting in plain view. The PS1 now emits menu names VERBATIM and the match happens here.
  const { d, calls } = deps({
    rendered: ['Weitere Navigationselemente', 'Weitere Optionen fur Real Chat Name', 'Filter'],
  })
  const r = await uiArchiveChat('C:/i1', 'sid', d)
  expect(r.clicked).toBe(true)
  expect(calls).toEqual(['invoke:Real Chat Name'])
})

test('a menu name that merely CONTAINS the title is not a match - only a suffix is', async () => {
  const { d, calls } = deps({
    rendered: ['Weitere Optionen fur Real Chat Name and then some'],
    archivedAfter: false,
  })
  const r = await uiArchiveChat('C:/i1', 'sid', d)
  expect(r.clicked).toBe(false)
  expect(calls).toEqual([])
})

// --- RENAME: the one write a running app cannot undo. It exists so an imported chat that the
// app renders as 'Untitled' can be given a real name - which is also what makes it deliverable,
// since the courier aims by rendered name.

test('rename refuses a generic name - renaming Untitled to Untitled fixes nothing', async () => {
  let ran = false
  const r = await uiRenameChat('C:inst', 'Untitled', 'New chat', async () => {
    ran = true
    return { code: 0, out: '' }
  })
  expect(r.ok).toBe(false)
  expect(ran).toBe(false)
  expect(r.detail).toContain('generic')
})

test('ONE CHAT DRAWN TWICE: the rename may act on duplicate rows only when disk says the name is unique', async () => {
  // Measured 2026-09-15 proving the 0.42.0 build: a chat seconds old rendered two kebabs with
  // the identical name and the actuator refused "2 rendered chats end with ... refusing to
  // guess". Identical names are one chat; only the store can say so.
  let args: string[] = []
  const run = async (a: string[]) => {
    args = a
    return { code: 0, out: 'renamed' }
  }
  await uiRenameChat('C:inst', 'Real Chat Name', 'A new name', run, () => 1)
  expect(args).toContain('-AllowDuplicateRows')
  // Two live chats share it, or the disk does not carry it at all: the refusal stands.
  await uiRenameChat('C:inst', 'Real Chat Name', 'A new name', run, () => 2)
  expect(args).not.toContain('-AllowDuplicateRows')
  await uiRenameChat('C:inst', 'Real Chat Name', 'A new name', run, () => 0)
  expect(args).not.toContain('-AllowDuplicateRows')
})

test('rename names the CURRENT on-screen row and the new title, in the app it lives in', async () => {
  let args: string[] = []
  const r = await uiRenameChat(
    'C:inst',
    'Untitled',
    'Courier ledger rebuild',
    async (a) => {
      args = a
      return { code: 0, out: 'renamed' }
    },
    () => 0,
  )
  expect(r.ok).toBe(true)
  expect(args).toEqual([
    '-Title',
    'Untitled',
    '-Instance',
    'C:inst',
    '-Action',
    'Rename',
    '-NewTitle',
    'Courier ledger rebuild',
  ])
})

test('a failed rename is reported as a failure, with whatever the tool said', async () => {
  const r = await uiRenameChat('C:inst', 'Untitled', 'Real name', async () => ({
    code: 3,
    out: 'ambiguous: two rows match',
  }))
  expect(r.ok).toBe(false)
  expect(r.detail).toContain('ambiguous')
})

// There is no PowerShell test harness in this repo (no Pester) to drive
// misc/Manage-DesktopChat.ps1's rename write loop against a real UIA element, and a live
// element is off-limits to a test anyway. This pins the contract that write loop depends on
// at the layer that IS tested: when the app re-renders the row mid-write, the PS1 now
// re-acquires the edit box and retries the write once, then exits non-zero with a FAIL line
// if that retry also fails - uiRenameChat must still surface that as ok:false with the PS1's
// own detail, never collapse a double-failure into a false ok.
test('a stale rename editor that fails even after the PS1 re-acquires and retries once is a real failure, never a false ok', async () => {
  const r = await uiRenameChat('C:inst', 'Untitled', 'Real name', async () => ({
    code: 1,
    out: 'FAIL: rename editor write failed again after re-acquiring - Element not available',
  }))
  expect(r.ok).toBe(false)
  expect(r.detail).toContain('re-acquiring')
})

// ⛔ REFUSING ON THE COUNT ALONE STRANDED ROWS NOTHING COULD EVER CLEAR. Measured live: two
// retired chats sharing one title sat in the sidebar permanently, because every pass
// declined to click either on the grounds it might hit "the wrong one" - when both were already
// archived and either click was correct. The hazard is a chat that should SURVIVE, not a shared
// name, so the question is whether any holder of that title is still live.
test('two chats sharing the title, ALL already archived -> click, because none can be lost', async () => {
  const { d, calls } = deps({ titleCount: 2, liveTitleCount: 0 })
  const r = await uiArchiveChat('C:/i1', 'sid', d)
  expect(r.clicked).toBe(true)
  expect(r.verified).toBe(true)
  expect(calls).toContain('invoke:Real Chat Name')
})

// --- discovering the rendered name itself (chat_rename, 2026-09-15) ------------------------
// ⛔ THE BUG: a fresh import's disk title can survive just long enough for a caller to read it,
// then a RUNNING app re-saves its own in-memory record and erases it - so by the time a rename
// is attempted, the sidebar renders the chat under a different name than the one on disk. A
// caller with no current_title of its own used to get a flat refusal with no route to a
// confirmed rename.

test('DISK TITLE PRESENT, RENDERED NAME DIFFERS: bestRenderedAlias finds the one clear match', () => {
  // Mirrors automation_chat.py's own proven fixture: a long real title on disk, a short
  // auto-derived name on screen, one unrelated row beside it.
  const alias = bestRenderedAlias('QuickDictate listening stops intermittently', [
    'more options for QuickDictate',
    'more options for Ask AI rollout',
  ])
  expect(alias).toBe('more options for QuickDictate')
  // The real -List also carries menu names that are not chat rows; they neither hide the
  // menu phrase nor count as candidates.
  expect(
    bestRenderedAlias('QuickDictate listening stops intermittently', [
      'Filter',
      'more options for QuickDictate',
      'more options for Ask AI rollout',
      'more navigation items',
    ]),
  ).toBe('more options for QuickDictate')
  expect(
    bestRenderedAlias('QuickDictate listening stops intermittently', [
      'Weitere Navigationselemente',
      'Weitere Optionen fur QuickDictate',
      'Weitere Optionen fur Ask AI rollout',
      'Weitere Optionen fur Courier ledger rebuild',
      'Filter',
    ]),
  ).toBe('Weitere Optionen fur QuickDictate')
})

test('bestRenderedAlias refuses when nothing stands unambiguously clear', () => {
  expect(bestRenderedAlias('QuickDictate listening stops intermittently', [])).toBeNull()
  expect(
    bestRenderedAlias('QuickDictate listening stops intermittently', ['Unrelated Other']),
  ).toBeNull()
  // Two rows that score identically: refuse rather than guess which one is right.
  expect(
    bestRenderedAlias('Resume Stackspire project', [
      'more options for Stackspire',
      'weitere optionen fur Stackspire',
    ]),
  ).toBeNull()
})

test('bestRenderedAlias never aims a rename at a DIFFERENT chat that only shares a last word', () => {
  // The chat's own row is not rendered under anything like its title. Scoring each row's
  // word-suffixes made "integration" a normalized substring of the title, a perfect 1.0, so the
  // rename would have landed on the Google Maps chat. Whole names share one word of nine.
  expect(
    bestRenderedAlias('Sub-brand logo set integration', [
      'more options for Google Maps SEO integration',
      'more options for Untitled',
      'more options for Ask AI rollout',
    ]),
  ).toBeNull()
  // One row cannot show which leading words are the menu chrome, so nothing is discovered.
  expect(
    bestRenderedAlias('QuickDictate listening stops intermittently', [
      'more options for QuickDictate',
    ]),
  ).toBeNull()
})

test('DISK TITLE PRESENT, RENDERED NAME DIFFERS: chat_rename discovers it and renames under it', async () => {
  const calls: string[] = []
  const r = await renameChatDiscoveringRenderedTitle(
    'C:inst',
    'QuickDictate listening stops intermittently',
    'Real new name',
    /* titleIsRendered */ false,
    {
      run: async (args) => {
        const title = args[1]
        calls.push(title)
        if (title === 'more options for QuickDictate') return { code: 0, out: 'renamed' }
        return { code: 3, out: "not rendered in this instance's window" }
      },
      list: async () => ['more options for QuickDictate', 'more options for Ask AI rollout'],
    },
  )
  expect(r.ok).toBe(true)
  expect(calls).toEqual([
    'QuickDictate listening stops intermittently',
    'more options for QuickDictate',
  ])
  expect(r.detail).toContain(
    "discovered the app renders this chat as 'more options for QuickDictate'",
  )
})

test('an EXPLICIT current_title is never overridden by a discovery guess, even when it fails', async () => {
  let attempts = 0
  const r = await renameChatDiscoveringRenderedTitle(
    'C:inst',
    'Wrong guess the caller asserted',
    'Real new name',
    /* titleIsRendered */ true,
    {
      run: async () => {
        attempts++
        return { code: 3, out: 'not rendered' }
      },
      list: async () => ['more options for Wrong guess the caller asserted, but longer'],
    },
  )
  expect(r.ok).toBe(false)
  expect(attempts).toBe(1)
})

// ⛔ THE ACTUATOR PATH, PINNED AT THE SOURCE. Until 2026-09-12 this module built its .ps1 path
// with join(import.meta.dir, '..', '..', 'misc', ...), which is correct in a checkout and wrong
// in every compiled build: inside a `bun build --compile` exe import.meta.dir is the virtual
// embedded root, so two ..-hops land on B:\ and the spawn asked for B:\misc\...
//
// It could not be caught by the unit tests above, because they all inject `run`. And it failed
// SILENTLY in production: `powershell -File <missing>` exits 0, so `code === 0` reported ok:true
// over a script that never ran - a migrated chat's rename "succeeded" three times while the
// sidebar never changed. So the guard is on the SOURCE, the same shape misc-assets.test.ts uses
// for the build wiring, and it is the only thing standing between that regression and a reship.
const UI_ARCHIVE_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'ui-archive.ts'), 'utf8')

test('the actuator path is resolved through misc-assets, never from import.meta.dir', () => {
  const code = UI_ARCHIVE_SRC.split(/\r?\n/)
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n')
  expect(code).toContain('resolveMiscAsset')
  expect(code).toContain('CHAT_MANAGER_FILE')
  expect(code).not.toContain('import.meta.dir')
})

test('a misc file that cannot be resolved is a NON-ZERO code, never a silent ok', () => {
  // The false OK is the half that made the wrong path invisible; pin it independently.
  const code = UI_ARCHIVE_SRC.split(/\r?\n/)
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n')
  expect(code).toMatch(/if \(!asset\.path\)[\s\S]{0,200}code: [1-9]/)
})

test('the chat manager is on the list the build embeds, so a compiled exe carries it', () => {
  expect(RUNTIME_MISC_FILES).toContain(CHAT_MANAGER_FILE)
})

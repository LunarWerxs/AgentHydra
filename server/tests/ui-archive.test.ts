// server/tests/ui-archive.test.ts - the server-side UI archive click's safety rails, pinned:
// it may only fire on a real disk title rendered exactly once, and success is verified BY ID
// on disk, never by title (the drill-cleanup law).
import { expect, test } from 'bun:test'
import { parseListOutput, type UiArchiveDeps, uiArchiveChat } from '../src/ui-archive'

function deps(over: {
  title?: string | null
  rendered?: string[]
  invokeCode?: number
  archivedAfter?: boolean
  titleCount?: number
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

test('two DIFFERENT chats sharing the title on disk -> refuse; the click could hit the wrong one', async () => {
  const { d, calls } = deps({ titleCount: 2 })
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

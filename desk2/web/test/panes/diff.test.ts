import { describe, expect, it } from 'bun:test'
import { finishedTurns, parseUnifiedDiff, sameFolder, statusLetter } from '../../src/components/panes/diff'
import { accountLabel, resetText } from '../../src/components/accounts/format'

const MODIFIED = `diff --git a/src/a.ts b/src/a.ts
index 3b1c2d4..9f8e7a6 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@ export function a() {
 const x = 1
-const y = 2
+const y = 3
+const z = 4

 return x
@@ -20,2 +21,2 @@ function b() {
-  old()
+  next()
\\ No newline at end of file
`

describe('parseUnifiedDiff', () => {
  it('numbers context, added and removed lines from the hunk headers and drops file headers', () => {
    const d = parseUnifiedDiff(MODIFIED)
    expect(d.added).toBe(3)
    expect(d.removed).toBe(2)
    expect(d.binary).toBe(false)
    expect(d.rows.map((r) => [r.kind, r.oldNo, r.newNo, r.text])).toEqual([
      ['hunk', null, null, '@@ -1,4 +1,5 @@ export function a() {'],
      ['ctx', 1, 1, 'const x = 1'],
      ['del', 2, null, 'const y = 2'],
      ['add', null, 2, 'const y = 3'],
      ['add', null, 3, 'const z = 4'],
      ['ctx', 3, 4, ''],
      ['ctx', 4, 5, 'return x'],
      ['hunk', null, null, '@@ -20,2 +21,2 @@ function b() {'],
      ['del', 20, null, '  old()'],
      ['add', null, 21, '  next()'],
      ['note', null, null, 'No newline at end of file']
    ])
  })

  it('reads an untracked file shown as all-added, with CRLF line ends and single-line hunks', () => {
    const d = parseUnifiedDiff('--- /dev/null\r\n+++ b/new.txt\r\n@@ -0,0 +1 @@\r\n+hello\r\n')
    expect(d.rows).toEqual([
      { kind: 'hunk', text: '@@ -0,0 +1 @@', oldNo: null, newNo: null },
      { kind: 'add', text: 'hello', oldNo: null, newNo: 1 }
    ])
    expect(d.added).toBe(1)
  })

  it('does not count +++/--- file headers as changes and flags binary files', () => {
    const bin = parseUnifiedDiff('diff --git a/x.png b/x.png\nindex 1..2 100644\nBinary files a/x.png and b/x.png differ\n')
    expect(bin.binary).toBe(true)
    expect(bin.added + bin.removed).toBe(0)
    expect(parseUnifiedDiff('').rows).toEqual([])
  })
})

describe('statusLetter', () => {
  it('maps porcelain codes to one letter', () => {
    expect(statusLetter('??').letter).toBe('U')
    expect(statusLetter(' M').letter).toBe('M')
    expect(statusLetter('R').word).toBe('Renamed')
    expect(statusLetter('D').letter).toBe('D')
  })
})

describe('auto-refresh helpers', () => {
  it('matches folders across slashes, case and trailing separators', () => {
    expect(sameFolder('C:\\Users\\jacob\\desk\\', 'c:/users/jacob/desk')).toBe(true)
    expect(sameFolder('C:/a/desk', 'C:/a/desk2')).toBe(false)
    expect(sameFolder(null, 'C:/a')).toBe(false)
  })

  it('reports only chats whose turn just ended', () => {
    const prev = new Map([
      ['a', 'working'],
      ['b', 'idle'],
      ['c', 'needs_you'],
      ['d', 'working']
    ])
    const next = new Map([
      ['a', 'idle'],
      ['b', 'idle'],
      ['c', 'working'],
      ['d', 'stopped'],
      ['e', 'idle']
    ])
    expect(finishedTurns(prev, next)).toEqual(['a', 'd'])
  })
})

describe('accounts format', () => {
  it('never shows an email and drops a plan the badge already shows', () => {
    expect(accountLabel('#71 work@example.com (Max 5x)', 'Max 5x', '71')).toBe('#71')
    expect(accountLabel('#68 eek (Max 20x)', 'Max 20x', '68')).toBe('#68 eek')
    expect(accountLabel('jacob@example.com', null, 'default')).toBe('Default login')
  })

  it('writes reset times relative under a day', () => {
    const now = 1_000_000_000_000
    expect(resetText(now + 47 * 60_000, now)).toBe('resets in 47m')
    expect(resetText(now + (2 * 60 + 14) * 60_000, now)).toBe('resets in 2h 14m')
    expect(resetText(null, now)).toBe('')
  })
})

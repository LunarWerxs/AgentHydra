// Pure helpers for the diff pane: unified diff parsing and folder matching. No Vue, no fetch, so
// bun tests (web/test/panes) import this file directly.

export type DiffRowKind = 'hunk' | 'add' | 'del' | 'ctx' | 'note'

export interface DiffRow {
  kind: DiffRowKind
  text: string // the line without its leading +, - or space; the whole header for 'hunk' and 'note'
  oldNo: number | null // line number in the old file (ctx, del)
  newNo: number | null // line number in the new file (ctx, add)
}

export interface ParsedDiff {
  rows: DiffRow[]
  added: number
  removed: number
  binary: boolean
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/**
 * Parse one file's unified diff (what `git diff` prints, as /api/git/diff answers). File headers
 * (diff --git, index, ---, +++, mode lines) are dropped; hunk headers, added, removed and context
 * lines keep their old/new line numbers; "\ No newline at end of file" becomes a note.
 */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  const rows: DiffRow[] = []
  let added = 0
  let removed = 0
  let binary = false
  let oldNo = 0
  let newNo = 0
  let inHunk = false

  const lines = diff.replace(/\r\n/g, '\n').split('\n')
  // A diff ends with a newline; the empty string after it is not a context line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  for (const line of lines) {
    const hunk = HUNK.exec(line)
    if (hunk) {
      inHunk = true
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      rows.push({ kind: 'hunk', text: line, oldNo: null, newNo: null })
      continue
    }
    if (!inHunk) {
      if (/^Binary files .* differ$/.test(line) || line.startsWith('GIT binary patch')) {
        binary = true
        rows.push({ kind: 'note', text: line, oldNo: null, newNo: null })
      }
      continue
    }
    if (line.startsWith('diff --git ')) {
      // A second file in the same text: its headers are skipped until the next hunk.
      inHunk = false
      continue
    }
    const mark = line[0]
    const text = line.slice(1)
    if (mark === '+') {
      added++
      rows.push({ kind: 'add', text, oldNo: null, newNo: newNo++ })
    } else if (mark === '-') {
      removed++
      rows.push({ kind: 'del', text, oldNo: oldNo++, newNo: null })
    } else if (mark === '\\') {
      rows.push({ kind: 'note', text: line.slice(2), oldNo: null, newNo: null })
    } else {
      // ' ' or an empty line some tools leave for an empty context line.
      rows.push({ kind: 'ctx', text: mark === ' ' ? text : line, oldNo: oldNo++, newNo: newNo++ })
    }
  }

  return { rows, added, removed, binary }
}

/** Porcelain status -> the one letter the pane shows, and its word for the tooltip. */
export function statusLetter(status: string): { letter: string; word: string } {
  const s = status.trim()
  if (s === '??' || s === '?') return { letter: 'U', word: 'Untracked' }
  const c = s[0] ?? ''
  switch (c) {
    case 'M':
      return { letter: 'M', word: 'Modified' }
    case 'A':
      return { letter: 'A', word: 'Added' }
    case 'D':
      return { letter: 'D', word: 'Deleted' }
    case 'R':
      return { letter: 'R', word: 'Renamed' }
    case 'C':
      return { letter: 'C', word: 'Copied' }
    case 'U':
      return { letter: '!', word: 'Conflict' }
    default:
      return { letter: c || '?', word: s || 'Changed' }
  }
}

/** Same folder whatever the slashes, case (Windows) or a trailing separator. */
export function sameFolder(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/** Statuses during which a chat's turn is still open. */
const TURN_OPEN = new Set(['starting', 'working', 'needs_you'])

/**
 * Given the previous and current status of every chat (by id), the ids whose turn just ended:
 * they were starting/working/needs_you and are now anything else.
 */
export function finishedTurns(prev: Map<string, string>, next: Map<string, string>): string[] {
  const out: string[] = []
  for (const [id, status] of next) {
    const before = prev.get(id)
    if (before && TURN_OPEN.has(before) && !TURN_OPEN.has(status)) out.push(id)
  }
  return out
}

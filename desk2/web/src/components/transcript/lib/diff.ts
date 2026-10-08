// Line diffs for Edit / MultiEdit / Write tool rows. Pure: no Vue, no DOM.

export interface DiffLine {
  type: 'ctx' | 'add' | 'del'
  text: string
  /** 1-based line number in the old text (ctx, del). */
  oldNo?: number
  /** 1-based line number in the new text (ctx, add). */
  newNo?: number
}

export interface Diff {
  lines: DiffLine[]
  added: number
  removed: number
}

/** Split into lines; a trailing newline does not make an extra empty line. */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

// Above this many cells the LCS table is skipped and the middle shown as all-removed then all-added.
const MAX_CELLS = 4_000_000

/** A line diff of oldText -> newText (common prefix/suffix trimmed, LCS in the middle). */
export function diffLines(oldText: string, newText: string): Diff {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  const { start, endA, endB } = commonEnds(a, b)

  const lines: DiffLine[] = []
  for (let i = 0; i < start; i++) lines.push({ type: 'ctx', text: a[i], oldNo: i + 1, newNo: i + 1 })
  for (const l of changedLines(a.slice(start, endA), b.slice(start, endB), start)) lines.push(l)
  for (let k = 0; k < a.length - endA; k++) {
    lines.push({ type: 'ctx', text: a[endA + k], oldNo: endA + k + 1, newNo: endB + k + 1 })
  }

  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.type === 'add') added++
    else if (l.type === 'del') removed++
  }
  return { lines, added, removed }
}

function commonEnds(a: string[], b: string[]): { start: number; endA: number; endB: number } {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  return { start, endA, endB }
}

function changedLines(midA: string[], midB: string[], start: number): DiffLine[] {
  if (midA.length === 0 || midB.length === 0 || midA.length * midB.length > MAX_CELLS) {
    return [
      ...midA.map((t, i): DiffLine => ({ type: 'del', text: t, oldNo: start + i + 1 })),
      ...midB.map((t, j): DiffLine => ({ type: 'add', text: t, newNo: start + j + 1 })),
    ]
  }
  const lines = lcsLines(midA, midB, start)
  // Show removals before additions inside each changed run, as Claude Code does.
  reorderRuns(lines)
  return lines
}

function lcsLines(midA: string[], midB: string[], start: number): DiffLine[] {
  const n = midA.length
  const m = midB.length
  // lcs[i][j] = LCS length of midA[i..] and midB[j..], stored flat.
  const w = m + 1
  const lcs = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] =
        midA[i] === midB[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
    }
  }
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      lines.push({ type: 'ctx', text: midA[i], oldNo: start + i + 1, newNo: start + j + 1 })
      i++
      j++
    } else if (j < m && (i >= n || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) {
      lines.push({ type: 'add', text: midB[j], newNo: start + j + 1 })
      j++
    } else {
      lines.push({ type: 'del', text: midA[i], oldNo: start + i + 1 })
      i++
    }
  }
  return lines
}

function reorderRuns(lines: DiffLine[]) {
  let k = 0
  while (k < lines.length) {
    if (lines[k].type === 'ctx') {
      k++
      continue
    }
    let end = k
    while (end < lines.length && lines[end].type !== 'ctx') end++
    const run = lines.slice(k, end)
    const sorted = [...run.filter((l) => l.type === 'del'), ...run.filter((l) => l.type === 'add')]
    lines.splice(k, end - k, ...sorted)
    k = end
  }
}

/** Every line added: a Write of a new file. */
export function allAdded(text: string): Diff {
  const lines = splitLines(text).map((t, i): DiffLine => ({ type: 'add', text: t, newNo: i + 1 }))
  return { lines, added: lines.length, removed: 0 }
}

/**
 * Keep `context` unchanged lines around each change; longer unchanged runs become one `gap` marker
 * (a ctx line with text '' and no numbers is never produced by diffLines, so null marks the gap).
 */
export function collapseContext(lines: DiffLine[], context = 3): (DiffLine | null)[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((l, i) => {
    if (l.type === 'ctx') return
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true
  })
  const out: (DiffLine | null)[] = []
  let gap = false
  lines.forEach((l, i) => {
    if (keep[i]) {
      out.push(l)
      gap = false
    } else if (!gap) {
      out.push(null)
      gap = true
    }
  })
  return out
}

/** The diff a tool_use item shows, or null for tools that are not edits. */
export function toolDiff(name: string, input: Record<string, unknown>): Diff | null {
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  if (name === 'Edit') return diffLines(str(input.old_string), str(input.new_string))
  if (name === 'Write') return allAdded(str(input.content))
  if (name === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : []
    const lines: DiffLine[] = []
    let added = 0
    let removed = 0
    edits.forEach((e, i) => {
      const d = diffLines(str(e?.old_string), str(e?.new_string))
      if (i > 0) lines.push({ type: 'ctx', text: '…' })
      lines.push(...d.lines)
      added += d.added
      removed += d.removed
    })
    return { lines, added, removed }
  }
  return null
}

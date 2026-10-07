// Pulls every `file:line[:col]` an error names out of its text, so the errors list can jump to the line in an editor
// (ported from DevWebUI's shared/source-frames.ts). It only finds candidates: whether one is a real file is decided
// when the editor is asked to open it.

export interface SourceFrame {
  /** The path as logged, with a `file://` prefix undone. May be relative to the server's folder. */
  file: string
  line: number
  column?: number
  /** Offset and length of the linkable span in the text. */
  index: number
  length: number
}

// A path ends in a dotted extension that starts with a letter, which keeps `127.0.0.1:3000` and `v1.2.3:4` from
// reading as frames.
const EXT = String.raw`\.[A-Za-z][A-Za-z0-9]*`
const LEAD = String.raw`(?:file:\/\/\/?)?(?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/])?`
// The parenthesised form admits spaces in the path, so it demands an absolute start.
const ABS_LEAD = String.raw`(?:file:\/\/\/?[A-Za-z]:[\\/]|file:\/\/\/?|[A-Za-z]:[\\/]|[\\/])`

// The shapes dev servers print, most specific first (an earlier pattern wins a span a later one also matches): a
// Node/Bun frame in parens, Python's `File "x", line N`, tsc's `x.ts(12,5)`, and a bare `path:line[:col]`.
const PATTERNS: { re: RegExp; span: (m: RegExpExecArray) => [number, number] }[] = [
  { re: new RegExp(String.raw`\((${ABS_LEAD}[^()\n]*?${EXT}):(\d+)(?::(\d+))?\)`, 'g'), span: (m) => [m.index + 1, m[0].length - 2] },
  { re: /File "([^"\n]+)", line (\d+)()/g, span: (m) => [m.index, m[0].length] },
  { re: new RegExp(String.raw`(?<![\w:/.\\-])(${LEAD}[^\s:()"'<>|*?]*${EXT})\((\d+),(\d+)\)`, 'g'), span: (m) => [m.index, m[0].length] },
  { re: new RegExp(String.raw`(?<![\w:/.\\-])(${LEAD}[^\s:()"'<>|*?]*${EXT}):(\d+)(?::(\d+))?(?!\w|\.\d)`, 'g'), span: (m) => [m.index, m[0].length] },
]

/** Undoes a `file://` URL prefix (`file:///C:/x%20y/a.ts` becomes `C:/x y/a.ts`); plain paths pass through. */
export function frameFilePath(raw: string): string {
  if (!/^file:\/\//i.test(raw)) return raw
  let p = raw.replace(/^file:\/\//i, '')
  try {
    p = decodeURIComponent(p)
  } catch {
    // a stray % in the URL: keep it as logged
  }
  return /^\/[A-Za-z]:[\\/]/.test(p) ? p.slice(1) : p
}

/** Every source location in `text`, in order of appearance, with no two spans overlapping. */
export function findSourceFrames(text: string): SourceFrame[] {
  const found: SourceFrame[] = []
  const taken = (start: number, len: number) => found.some((f) => start < f.index + f.length && f.index < start + len)
  for (const { re, span } of PATTERNS) {
    re.lastIndex = 0
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const line = Number(m[2])
      if (!Number.isInteger(line) || line < 1) continue
      const file = frameFilePath(m[1] ?? '')
      // Runtime-internal frames (`node:internal/...`) have no file on disk.
      if (/^(?:node|bun|internal):/i.test(file)) continue
      const [index, length] = span(m)
      if (taken(index, length)) continue
      const column = m[3] ? Number(m[3]) : undefined
      found.push({ file, line, ...(column && column >= 1 ? { column } : {}), index, length })
    }
  }
  return found.sort((a, b) => a.index - b.index)
}

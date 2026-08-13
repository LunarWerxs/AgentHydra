// Advanced session BODY search: streams each transcript JSONL file line-by-line (constant
// memory even for gigantic files) instead of buffering it whole, unlike sessions.ts's scanMeta()
// (bounded 12MB tail read) or transcript.ts's readTailBytes() (bounded byte-tail read). Kept in
// its own module so the fast/simple metadata list path (sessions.ts, GET /api/sessions) stays
// completely untouched; this is a separate, slower, opt-in code path.
import safeRegex from 'safe-regex2'
import { instanceSessionMap } from './instance-sessions'
import { listOpenCodeSearchEvents } from './opencode-sessions'
import { eventToTailEventsForSource, listTranscriptFiles, type TranscriptFile } from './transcript'
import type { SessionSearchResponse, SessionSearchResult, SessionSource } from './types'

export type { SessionSearchResponse, SessionSearchResult }

export interface SearchOptions {
  query: string
  regex?: boolean
  caseSensitive?: boolean
  /** Scope to one instance dir name, "default", or "other"; same semantics as listSessions(). */
  instance?: string
  /** Scope to one provider. Omitted means all supported stores. */
  source?: SessionSource
  /** Max sessions returned, newest-first. */
  limit?: number
  /** Max snippets collected per session before moving on. */
  perFileLimit?: number
  /** Wall-clock budget for the whole search; returns partial results past this, never hangs. */
  budgetMs?: number
}

const DEFAULT_LIMIT = 50
const DEFAULT_PER_FILE_LIMIT = 5
const DEFAULT_BUDGET_MS = 7000
const CONCURRENCY = 6
const SNIPPET_LEN = 160
const MAX_REGEX_LENGTH = 200

function compact(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function snippetAround(text: string, index: number, len: number): string {
  const t = compact(text)
  // recompute the match index against the compacted string is unreliable, so just center
  // a window on the original index, clamped to the compacted length
  const half = Math.floor(len / 2)
  const start = Math.max(0, Math.min(index, t.length) - half)
  const end = Math.min(t.length, start + len)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < t.length ? '…' : ''
  return `${prefix}${t.slice(start, end)}${suffix}`
}

type Matcher = (haystack: string) => number // returns match index, or -1

function buildMatcher(opts: SearchOptions): Matcher {
  const { query, regex, caseSensitive } = opts
  if (regex) {
    // A deadline cannot interrupt a synchronous RegExp.exec once catastrophic backtracking has
    // started. Reject structurally unsafe (or unreasonable) patterns before compiling; the
    // wall-clock budget below then bounds the ordinary multi-file work around each match.
    if (query.length > MAX_REGEX_LENGTH)
      throw new Error(`regular expression must be at most ${MAX_REGEX_LENGTH} characters`)
    if (!safeRegex(query)) throw new Error('unsafe regular expression')
    const re = new RegExp(query, caseSensitive ? '' : 'i')
    return (haystack: string) => {
      const m = re.exec(haystack)
      return m ? m.index : -1
    }
  }
  const needle = caseSensitive ? query : query.toLowerCase()
  return (haystack: string) => {
    const h = caseSensitive ? haystack : haystack.toLowerCase()
    return h.indexOf(needle)
  }
}

/** Streams a file's lines with constant memory via Bun's native ReadableStream, decoding and
 *  splitting on '\n' manually (mirrors dispatch.ts's `for await (const chunk of proc.stdout)`
 *  pump idiom, different source, same shape). Never buffers the whole file into memory.
 *
 *  Exported because session-usage.ts needs the same constant-memory read over a single transcript
 *  (the largest on a real machine is ~40 MB, which is not a thing to hold in the daemon's heap). */
export async function* streamLines(path: string): AsyncGenerator<string> {
  const stream = Bun.file(path).stream()
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of stream as ReadableStream<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true })
    let idx = buf.indexOf('\n')
    while (idx >= 0) {
      yield buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      idx = buf.indexOf('\n')
    }
  }
  buf += decoder.decode()
  if (buf) yield buf
}

/** Extracts the displayable text for one parsed JSONL event (same filter used for the
 *  transcript view, via the provider-aware event converter), so body search matches what's shown,
 *  not raw JSON noise like tool-call ids or base64. */
function displayableText(tf: TranscriptFile, ev: any): string[] {
  const tes = eventToTailEventsForSource(tf.source, ev)
  return tes.map((e) => e.text).filter(Boolean)
}

/** One file's outcome. `stoppedEarly` means the wall-clock budget ran out PART-WAY THROUGH this
 *  file, so its match count is an undercount and a miss proves nothing — the caller has to be able
 *  to say so rather than reporting a confident zero. */
interface FileSearchOutcome {
  hit: SessionSearchResult | null
  stoppedEarly: boolean
}

/** Exported for the unit test: this is where the deadline is actually noticed, and the flag it
 *  raises is what stops an empty result from being read as "the text is not on this machine". */
export async function searchOneFile(
  tf: TranscriptFile,
  matcher: Matcher,
  perFileLimit: number,
  deadline: number,
): Promise<FileSearchOutcome> {
  let matchCount = 0
  const snippets: string[] = []
  let cwd = ''
  let stoppedEarly = false

  try {
    for await (const rawLine of streamLines(tf.path)) {
      if (performance.now() > deadline) {
        stoppedEarly = true
        break
      }
      const line = rawLine.trim()
      if (!line) continue
      let ev: any
      try {
        ev = JSON.parse(line)
      } catch {
        continue
      }
      if (!cwd && typeof ev?.cwd === 'string') cwd = ev.cwd
      if (!cwd && typeof ev?.payload?.cwd === 'string') cwd = ev.payload.cwd

      const texts = displayableText(tf, ev)
      for (const text of texts) {
        const idx = matcher(text)
        if (idx === -1) continue
        matchCount++
        if (snippets.length < perFileLimit) snippets.push(snippetAround(text, idx, SNIPPET_LEN))
        break // one match counted per event line is enough signal; avoid double-counting blocks
      }
      if (snippets.length >= perFileLimit && matchCount >= perFileLimit * 4) break // this file is clearly a hit; stop early
    }
  } catch {
    return { hit: null, stoppedEarly } // unreadable/vanished file, skip silently, best-effort
  }

  if (matchCount === 0) return { hit: null, stoppedEarly }
  return {
    stoppedEarly,
    hit: {
      session_id: tf.session_id,
      source: tf.source,
      cwd: cwd || tf.project,
      project: tf.project,
      match_count: matchCount,
      truncated: snippets.length < matchCount,
      snippets,
    },
  }
}

function searchOpenCode(
  matcher: Matcher,
  perFileLimit: number,
  limit: number,
): SessionSearchResult[] {
  const found = new Map<string, SessionSearchResult>()
  for (const event of listOpenCodeSearchEvents()) {
    let result = found.get(event.session_id)
    const idx = matcher(event.text)
    if (idx === -1) continue
    if (!result) {
      if (found.size >= limit) continue
      result = {
        session_id: event.session_id,
        source: 'opencode',
        cwd: event.cwd,
        project: event.project,
        match_count: 0,
        truncated: false,
        snippets: [],
      }
      found.set(event.session_id, result)
    }
    result.match_count++
    if (result.snippets.length < perFileLimit)
      result.snippets.push(snippetAround(event.text, idx, SNIPPET_LEN))
    result.truncated = result.snippets.length < result.match_count
  }
  return [...found.values()]
}

/** A tiny fixed-size worker pool: runs `items` through `fn` with at most `concurrency` in
 *  flight at once, so many small files don't serialize needlessly while large ones stream. */
async function pooledMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

/** Nothing searched, nothing found — the shape a blank query answers with. */
const EMPTY_RESPONSE: SessionSearchResponse = {
  results: [],
  budgetExhausted: false,
  limitReached: false,
  filesSearched: 0,
  filesTotal: 0,
  budgetMs: 0,
}

/**
 * Streams every transcript's BODY content looking for `query`, newest files first. Constant
 * memory per file (streamLines), a small worker pool for cross-file concurrency, a per-file
 * early-exit once a file is clearly a match, and an overall wall-clock budget so a huge
 * history or a slow regex returns partial results instead of hanging the request.
 *
 * RETURNS A RESPONSE, NOT A BARE ARRAY, because the budget above makes "no matches" and "gave up
 * after 7 seconds" indistinguishable otherwise. An agent that reads an empty array as proof the
 * text does not exist anywhere is worse off than one that was never given the search at all, so
 * every caller now gets `budgetExhausted` and the file counts behind it.
 */
export async function searchSessionBodies(opts: SearchOptions): Promise<SessionSearchResponse> {
  const query = opts.query.trim()
  if (!query) return EMPTY_RESPONSE

  const matcher = buildMatcher(opts)
  const limit = opts.limit ?? DEFAULT_LIMIT
  const perFileLimit = opts.perFileLimit ?? DEFAULT_PER_FILE_LIMIT
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS
  const deadline = performance.now() + budgetMs

  let files = listTranscriptFiles().filter((file) => file.source !== 'opencode')
  if (opts.source) files = files.filter((file) => file.source === opts.source)
  if (opts.instance) {
    const imap = instanceSessionMap()
    files = files.filter((f) =>
      opts.instance === 'other'
        ? f.source === 'claude' && !imap.has(f.session_id)
        : f.source === 'claude' && imap.get(f.session_id) === opts.instance,
    )
  }
  files = files.slice().sort((a, b) => b.mtime_ms - a.mtime_ms)

  const found: SessionSearchResult[] = []
  const includeOpenCode = (!opts.source || opts.source === 'opencode') && !opts.instance
  if (includeOpenCode) found.push(...searchOpenCode(matcher, perFileLimit, limit))
  // Process in newest-first batches so we can stop dispatching more work once `limit` is hit,
  // without giving up the pool's cross-file concurrency within each batch.
  const batchSize = CONCURRENCY * 3
  let fileFound = 0
  let filesSearched = 0
  let stoppedMidFile = false
  let outOfTime = false
  let limitReached = false
  for (let start = 0; start < files.length; start += batchSize) {
    // Deadline first: hitting the CAP is a different answer from running out of TIME, and the
    // caller reports them differently ("your limit" vs "results may be incomplete").
    if (performance.now() > deadline) {
      outOfTime = true
      break
    }
    if (fileFound >= limit) {
      limitReached = true
      break
    }
    const batch = files.slice(start, start + batchSize)
    const results = await pooledMap(batch, CONCURRENCY, (tf) =>
      searchOneFile(tf, matcher, perFileLimit, deadline),
    )
    filesSearched += batch.length
    for (const r of results) {
      if (r.stoppedEarly) stoppedMidFile = true
      if (r.hit) {
        found.push(r.hit)
        fileFound++
      }
    }
  }

  const activity = new Map(
    listTranscriptFiles().map((file) => [`${file.source}:${file.session_id}`, file.mtime_ms]),
  )
  const sorted = found.sort(
    (a, b) =>
      (activity.get(`${b.source}:${b.session_id}`) ?? 0) -
      (activity.get(`${a.source}:${a.session_id}`) ?? 0),
  )
  // Trimming to `limit` here is also a cap: OpenCode's rows are collected outside the file loop, so
  // the list can exceed the limit without the loop ever having noticed.
  if (sorted.length > limit) limitReached = true
  return {
    results: sorted.slice(0, limit),
    // Either a file was abandoned part-way through, or whole batches were never opened because the
    // clock ran out. Both mean a miss is not evidence of absence. Files left unopened because the
    // LIMIT was hit are a different thing entirely, and are reported as `limitReached`.
    budgetExhausted: stoppedMidFile || outOfTime,
    limitReached,
    filesSearched,
    filesTotal: files.length,
    budgetMs,
  }
}

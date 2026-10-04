// AgentHydra's transcript search mapped to SearchHit (SPEC.md "Search"). It is the route behind its
// search_sessions MCP tool, GET /api/sessions/search (../server/src/routes/sessions.ts,
// session-search.ts): its conversation index answers by whole words and phrases of what was said (tool
// output is not in it); before the index is built it scans the transcripts under a 7 s budget. A hit
// has no title or activity time, so the bridge joins each with its session row (GET /api/sessions/:id).

import type { SearchHit } from '@shared/protocol'
import type { AhSearchResult, AhSessionRow } from './client'
import { sessionSource } from './external'

export const SEARCH_MIN_CHARS = 2
export const SEARCH_LIMIT_DEFAULT = 25
export const SEARCH_LIMIT_MAX = 50
export const SNIPPET_MAX = 160

/** The query's words, lowercased. */
export function queryTerms(q: string): string[] {
  return [...new Set(q.toLowerCase().split(/\s+/).filter(Boolean))]
}

function firstMatch(text: string, terms: string[]): number {
  const lower = text.toLowerCase()
  let at = -1
  for (const t of terms) {
    const i = lower.indexOf(t)
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  return at
}

/** The first snippet holding a query word (else AgentHydra's first), cut to SNIPPET_MAX with the match a third in. */
export function pickSnippet(snippets: string[], q: string): string {
  const terms = queryTerms(q)
  const text = (snippets.find((s) => firstMatch(s, terms) >= 0) ?? snippets[0] ?? '').replace(/\s+/g, ' ').trim()
  // AgentHydra cuts at 160 already and marks a cut with an ellipsis at either end.
  if (text.replace(/^…|…$/g, '').length <= SNIPPET_MAX) return text
  const at = Math.max(0, firstMatch(text, terms))
  const start = Math.max(0, Math.min(at - Math.floor(SNIPPET_MAX / 3), text.length - SNIPPET_MAX))
  const end = start + SNIPPET_MAX
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`
}

/** The results of a search answer; an answer of another shape (no results, a result with no session id) gives fewer or none. */
export function searchResults(answer: unknown): AhSearchResult[] {
  const results = (answer as { results?: unknown } | null)?.results
  return Array.isArray(results) ? results.filter((r): r is AhSearchResult => typeof r?.session_id === 'string') : []
}

/** `rows[i]` is the session row of `results[i]`, null when it could not be read. One hit per session id. */
export function mapSearch(results: AhSearchResult[] | null | undefined, rows: (AhSessionRow | null)[], q: string): SearchHit[] {
  const out = new Map<string, SearchHit>()
  ;(results ?? []).forEach((r, i) => {
    if (out.has(r.session_id)) return
    const row = rows[i] ?? null
    out.set(r.session_id, {
      sessionId: r.session_id,
      title: row?.title || r.session_id.slice(0, 8),
      cwd: r.cwd || row?.cwd || null,
      snippet: pickSnippet(Array.isArray(r.snippets) ? r.snippets.filter((s) => typeof s === 'string') : [], q),
      source: sessionSource(r.source),
      lastActivityAt: row?.last_activity_at ?? null,
      score: r.match_count,
    })
  })
  return [...out.values()]
}

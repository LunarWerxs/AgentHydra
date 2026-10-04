// server/src/session-branch.ts - "copy up to here into a new chat" (owner, 2026-10-04): a new Claude
// transcript holding a chat's lines up to a chosen reply, so `claude --resume <new id>` carries on
// from that point while the original chat stays exactly as it was.
//
// The CLI cannot resume from the middle of a chat, so the branch is a cut-down copy: the lines in
// file order up to the reply's own line, each moved to the new session id. A tool call made before
// the cut whose result comes after it pulls the lines up to that result in too: a call left without
// its result is a transcript the API refuses to continue. The copy goes beside the original, in the
// same projects folder of the same Claude home, so it lists and resumes on the same account.

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Tool calls opened and answered on one transcript line. */
function toolIds(ev: any): { calls: string[]; results: string[] } {
  const calls: string[] = []
  const results: string[] = []
  const content = ev?.message?.content
  if (Array.isArray(content))
    for (const b of content) {
      if (b?.type === 'tool_use' && typeof b.id === 'string') calls.push(b.id)
      if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string')
        results.push(b.tool_use_id)
    }
  return { calls, results }
}

/**
 * The branch's transcript text: the lines up to the one whose `uuid` is `uuid` (plus any lines a
 * tool call before it needs for its result), moved to `sessionId`, ending with its title. Null when
 * no line carries that uuid.
 */
export function branchTranscript(
  text: string,
  uuid: string,
  sessionId: string,
  title: string,
): string | null {
  const lines = text.split('\n').filter((l) => l.trim())
  const parsed = lines.map((l) => {
    try {
      return JSON.parse(l)
    } catch {
      return null
    }
  })
  const at = parsed.findIndex((ev) => ev?.uuid === uuid)
  if (at < 0) return null
  const open = new Set<string>()
  let end = 0
  for (; end < parsed.length; end++) {
    if (end > at && open.size === 0) break
    const { calls, results } = toolIds(parsed[end])
    for (const id of calls) open.add(id)
    for (const id of results) open.delete(id)
  }
  const out = parsed
    .slice(0, end)
    .filter((ev) => ev !== null)
    .map((ev) => JSON.stringify('sessionId' in ev ? { ...ev, sessionId } : ev))
  out.push(JSON.stringify({ type: 'custom-title', customTitle: title, sessionId }))
  return `${out.join('\n')}\n`
}

/** Writes the branch beside `path`; its new session id and file. Never overwrites a file. */
export function branchSession(
  path: string,
  uuid: string,
  title: string,
): { sessionId: string; path: string } | null {
  const sessionId = randomUUID()
  const body = branchTranscript(readFileSync(path, 'utf8'), uuid, sessionId, title)
  if (body === null) return null
  const out = join(dirname(path), `${sessionId}.jsonl`)
  writeFileSync(out, body, { flag: 'wx' })
  return { sessionId, path: out }
}

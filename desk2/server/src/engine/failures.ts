// The failure ledger (SPEC "Failure ledger"): one JSON line per failure in <home>/failures.jsonl, append-only.
// A recovery (the chat moved to another account and sent again) is a later line `{ event: 'recovered', ... }`
// that readers fold into the failure's row. The file rolls to failures-YYYY-MM.jsonl at a new month or past
// MAX_BYTES. Writing never throws: a ledger that cannot be written must not break the chat that failed.

import { randomUUID } from 'node:crypto'
import type { FailureCause, FailureRow, FailuresResponse } from '@shared/protocol'
import { isUsageLimitText } from './chat-runtime'
import { dayKey, JsonlLog, safeText } from './diagnostics'

const MAX_MESSAGE = 500

/**
 * The one classifier: a failure's text to its cause. `fallback` is what the caller knows when the text says
 * nothing (a refused first send, a worker that failed).
 */
export function classifyFailure(text: string, fallback: FailureCause = 'unknown'): FailureCause {
  if (/\bhooks?\b/i.test(text) && /timed? ?out|timeout|exceeded|too long/i.test(text)) return 'hook_timeout'
  if (/disabled claude subscription access|(organization|org)[^\n]{0,40}(disabled|not allowed|mismatch)|oauth authentication is currently not allowed/i.test(text)) return 'org_disabled'
  if (/failed to authenticate|please run \/login|not logged in|invalid api key|oauth (?:token|session) (?:has )?(?:expired|been revoked)|authentication_error|invalid authentication credentials|\b40[13]\b[^\n]{0,40}(unauthori[sz]ed|forbidden|authenticat)|identity verification is required|signed out/i.test(text)) return 'auth_expired'
  if (isUsageLimitText(text)) return 'usage_limit'
  if (/\bhooks?\b[^\n]*\bfailed\b/i.test(text)) return 'hook_failed'
  if (/ede_diagnostic|interrupted|request was aborted|aborted by user/i.test(text)) return 'interrupted'
  if (/cannot be sent|could not be sent|was not sent|not sent|refus/i.test(text)) return 'refused_send'
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|network|overloaded|\b529\b|\b50[234]\b|connection (error|refused|reset)|unreachable/i.test(text)) return 'network'
  return fallback
}

export interface FailureInput {
  chatId: string
  title: string
  cwd: string
  kind: 'sdk' | 'worker'
  accountId: string
  accountNumber?: number | null
  model: string | null
  message: string
  /** The cause when the text does not name one. */
  fallback?: FailureCause
  /** Set when the caller already knows the cause (a failed account move). */
  cause?: FailureCause
  durationMs?: number | null
  sessionId: string | null
}

type Line = Omit<FailureRow, 'recovered' | 'movedToAccountId'> | { event: 'recovered'; ts: number; failureId: string; movedToAccountId: string }

export class FailureLedger {
  private readonly log: JsonlLog

  constructor(
    readonly home: string,
    private readonly now: () => number = Date.now,
  ) {
    this.log = new JsonlLog(home, 'failures', now)
  }

  get file(): string {
    return this.log.file
  }

  /** Appends one failure; returns its id (for a later `recovered`). */
  record(i: FailureInput): string {
    const id = randomUUID()
    this.log.append({
      id,
      ts: this.now(),
      chatId: i.chatId,
      title: safeText(i.title, 120),
      cwd: i.cwd,
      kind: i.kind,
      accountId: i.accountId,
      accountNumber: i.accountNumber ?? null,
      model: i.model,
      cause: i.cause ?? classifyFailure(i.message, i.fallback),
      message: safeText(i.message, MAX_MESSAGE),
      durationMs: i.durationMs ?? null,
      sessionId: i.sessionId,
    } satisfies Line)
    return id
  }

  /** The chat was moved to `movedToAccountId` and its messages sent again. */
  recovered(failureId: string, movedToAccountId: string): void {
    this.log.append({ event: 'recovered', ts: this.now(), failureId, movedToAccountId } satisfies Line)
  }

  /** The rows newest first, filtered, with counts over every match. Rolled files are read only when `since` is given. */
  read(o: { since?: number; cause?: string; limit?: number } = {}): FailuresResponse {
    const rows = new Map<string, FailureRow>()
    const moves: { failureId: string; movedToAccountId: string }[] = []
    for (const l of this.log.read(o.since !== undefined) as ({ event?: string } & Record<string, unknown>)[]) {
      if (l.event === 'recovered') moves.push({ failureId: String(l.failureId), movedToAccountId: String(l.movedToAccountId) })
      else if (typeof l.id === 'string') rows.set(l.id, { ...(l as unknown as FailureRow), recovered: false, movedToAccountId: null })
    }
    for (const m of moves) {
      const r = rows.get(m.failureId)
      if (r) {
        r.recovered = true
        r.movedToAccountId = m.movedToAccountId
      }
    }
    let all = [...rows.values()].sort((a, b) => b.ts - a.ts)
    if (o.since !== undefined) all = all.filter((r) => r.ts >= o.since!)
    if (o.cause) all = all.filter((r) => r.cause === o.cause)
    const out: FailuresResponse = { rows: all.slice(0, o.limit ?? 100), total: all.length, byCause: {}, byAccount: {}, byDay: {} }
    for (const r of all) {
      out.byCause[r.cause] = (out.byCause[r.cause] ?? 0) + 1
      const acct = r.accountNumber !== null ? `#${r.accountNumber}` : r.accountId
      out.byAccount[acct] = (out.byAccount[acct] ?? 0) + 1
      const day = dayKey(r.ts)
      out.byDay[day] = (out.byDay[day] ?? 0) + 1
    }
    return out
  }
}

// server/src/crash-record.ts - the one-line crash record index.ts's last-resort handlers write to
// daemon.log before the process exits. Pulled out of index.ts (which cannot be imported by a test
// without booting the whole daemon - db open, port bind, the works) so the FORMAT is unit-testable
// on its own: pid, uptime and reason present, a stack trace flattened rather than left multi-line.
//
// Why this exists at all (docs/todo/TODO.md, "Overnight orchestration run", 2026-09-15): the daemon
// died silently three times overnight - 09:14:17Z, and 01:10Z / 04:23Z the same night, pids 79360 ->
// 61040 on the last one - with NO error line in daemon.log. index.ts already had uncaughtException /
// unhandledRejection handlers that log and exit(1); the silence means neither one ran, i.e. whatever
// killed the process was outside the JS process model entirely (see index.ts's crash-handler
// comment). This module cannot fix that - nothing can catch an untrappable kill - it exists so that
// every death the process DOES get a chance to see leaves an unambiguous, greppable line.

/** One flattened record line: time is the log-file.mjs tee's own timestamp prefix, so this covers
 *  reason, pid, uptime, the error's message and (if there is one) its stack - never embedding a raw
 *  newline, so a `findstr`/`grep` for "CRASH reason=" against daemon.log's one-event-per-line shape
 *  still finds the whole record. */
export function crashRecordLine(reason: string, detail: unknown): string {
  const err = detail instanceof Error ? detail : null
  const message = err ? err.message : String(detail)
  const stack = err?.stack ? ` | stack: ${err.stack.replace(/\s*\n\s*/g, ' > ')}` : ''
  return (
    `[agenthydra] CRASH reason=${reason} pid=${process.pid} ` +
    `uptimeMs=${Math.round(process.uptime() * 1000)} message=${message}${stack}`
  )
}

/** The final, unconditional line index.ts's 'exit' listener writes for every way the process ends -
 *  see that listener's own comment for why an unconditional record matters even on top of the
 *  reason-specific ones above. */
export function exitRecordLine(code: number | null): string {
  return (
    `[agenthydra] exiting code=${code} pid=${process.pid} ` +
    `uptimeMs=${Math.round(process.uptime() * 1000)}`
  )
}

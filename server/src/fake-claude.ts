// A harmless stand-in for the real `claude` CLI, used when AGENTHYDRA_FAKE=1.
// Emits a few stream-json lines shaped like Claude Code's real output, then exits 0.
// Lets us verify the entire dispatch → parse → run_events → SSE → status pipeline
// WITHOUT spending any real Claude quota or touching a real repo.
//
// Run as `bun fake-claude.ts <prompt>` from a source checkout, or as the compiled exe's
// `__fake_claude <prompt>` subcommand (server/src/main.ts).

function emit(obj: unknown) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

/**
 * Die the way the real CLI dies, so the failure paths can be driven end to end.
 *
 * `overloaded` reproduces the exact shape of the incident that motivated the quota/transient split:
 * a `system/init`, then the CLI's own synthetic error notice carrying a 529, then a non-zero exit —
 * and critically NO model turn in between, which is what makes an automatic retry safe.
 * `session_limit` is its opposite number: the user's own wall, which must never be retried.
 */
const ERROR_NOTICES: Record<string, string> = {
  overloaded:
    'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.',
  session_limit: "You've hit your session limit · resets 9:10am (America/Chicago)",
  weekly_limit: "You've hit your weekly limit · resets 3am (America/Chicago)",
}

/** The structured wall signal the real CLI emits BEFORE the human-readable notice. Copied verbatim
 *  from a live 2026-07-27 run (only the reset time is synthetic). `weekly_limit` replays it so the
 *  daemon's handling of the typed event is driven end to end, not just the prose. */
const WEEKLY_RATE_LIMIT_EVENT = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'rejected',
    resetsAt: 1785225600,
    rateLimitType: 'seven_day',
    overageStatus: 'rejected',
    overageDisabledReason: 'org_level_disabled',
    isUsingOverage: false,
  },
}

export async function runFakeClaude(promptArg: string | undefined): Promise<void> {
  const prompt = promptArg ?? '(no prompt)'
  const sessionId = process.env.FAKE_SESSION_ID ?? '00000000-0000-0000-0000-000000000000'
  // Inter-emit delay; a test can raise it (FAKE_SLEEP_MS) to keep a fake run in flight long enough
  // to exercise the daemon dying + reattaching mid-run.
  const SLEEP = Number(process.env.FAKE_SLEEP_MS ?? 120)

  emit({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-fake' })
  await Bun.sleep(SLEEP)

  const mode = process.env.FAKE_ERROR_MODE ?? ''
  const notice = ERROR_NOTICES[mode]
  if (notice) {
    if (mode === 'weekly_limit') emit(WEEKLY_RATE_LIMIT_EVENT)
    // The CLI reports a limit as a SYNTHETIC assistant message flagged isApiErrorMessage — that
    // pair is precisely what the detector trusts (see rate-limit-signal.ts isApiErrorEvent).
    emit({
      type: 'assistant',
      isApiErrorMessage: true,
      message: {
        role: 'assistant',
        model: '<synthetic>',
        content: [{ type: 'text', text: notice }],
      },
    })
    process.exit(1)
  }

  emit({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'this should never be shown', signature: 'x' },
        { type: 'text', text: `Fake run received prompt: ${prompt}` },
      ],
    },
  })
  await Bun.sleep(SLEEP)
  emit({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo hello' } }],
    },
  })
  await Bun.sleep(SLEEP)
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Fake run complete. All good.',
  })
  process.exit(0)
}

if (import.meta.main) {
  await runFakeClaude(process.argv[2])
}

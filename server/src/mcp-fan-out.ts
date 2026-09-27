// server/src/mcp-fan-out.ts - the fan-out MCP tools (fan_out, fan_out_status, report_progress,
// fan_out_send, fan_out_recover, fan_out_delete), split out of mcp.ts with the helpers only they
// use. Each wraps orchestrator/fan_out.py through the daemon, as move_chat wraps migrate_chat.
import { randomUUID } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUTO_DETACH_MS, api, busyRefusal, JSON_HEADERS, resolveRef, S, str } from './mcp-client'
import { instanceLabel, selfIdentity } from './mcp-self'
import type { McpEngineTool } from './mcp-stdio.mjs'

/** The orchestrator's arg limit is 4000 characters; a seven-task spec with real prompts can pass
 *  it. Under the limit the spec travels inline (visible in the returned `command`); over it, it is
 *  written to a temp file the script reads (fan_out.py accepts either). */
const SPEC_INLINE_MAX = 3800
/** How long `fan_out` waits, after its last spawn, for every chat to echo its task receipt before
 *  re-delivering once to a chat that never started. Spawns are sequential, so the earlier chats
 *  have had minutes already; this is the last chat's window. */
const FAN_OUT_RECEIPT_SECS = 180
function specArg(spec: string): string {
  if (spec.length <= SPEC_INLINE_MAX) return spec
  const path = join(tmpdir(), `agenthydra-fanout-${randomUUID()}.json`)
  writeFileSync(path, spec, 'utf8')
  return path
}

/** Build report_progress's beacon JSON for `fan_out beacon --beacon`. The same caps fan_out.py's
 *  parse_beacon keeps, then trimmed to fit ONE orchestrator arg (4000 characters): review paths
 *  go first, then the summary is shortened - a beacon is a pointer, the transcript has the rest. */
function beaconArg(a: Record<string, unknown>): string {
  const text = (v: unknown, cap: number) => str(v).trim().slice(0, cap)
  const paths = (Array.isArray(a.paths_to_review) ? a.paths_to_review : [])
    .map((p) => text(p, 260))
    .filter(Boolean)
    .slice(0, 10)
  const beacon: Record<string, unknown> = {
    member: Number(a.member),
    mode: str(a.mode).trim().toLowerCase(),
    taskName: text(a.task_name, 120),
    summary: text(a.summary, 1200),
    nextStep: text(a.next_step, 400),
    pathsToReview: paths,
    blockedOnUser: a.blocked_on_user === true,
  }
  if (a.confidence != null) beacon.confidence = Number(a.confidence)
  if (a.confidence_why != null) beacon.confidenceWhy = text(a.confidence_why, 400)
  let json = JSON.stringify(beacon)
  while (json.length > SPEC_INLINE_MAX && paths.length > 0) {
    paths.pop()
    json = JSON.stringify(beacon)
  }
  if (json.length > SPEC_INLINE_MAX) {
    const summary = str(beacon.summary)
    beacon.summary = summary.slice(0, Math.max(0, summary.length - (json.length - SPEC_INLINE_MAX)))
    json = JSON.stringify(beacon)
  }
  return json
}

/** What fan_out.py's own exit codes mean (its docstring is the source) - the FALLBACK verdict used
 *  only when the payload carries no members/results to count for itself (no JSON on stdout, or an
 *  empty group). Whenever there IS a per-member or per-result list, fanOutVerdict below reads it
 *  instead of trusting the exit code alone. */
const FAN_OUT_VERDICTS: Readonly<Record<number, string>> = Object.freeze({
  0: 'ok: every member spawned and confirmed / read / delivered / deleted and verified',
  4: 'partial: some members not confirmed, refused, unassigned, or not delivered - read each member',
  2: 'nothing happened: no account with room, every spawn refused, or nothing to deliver to',
  3: 'refused: bad spec, unknown group, or bad usage',
  1: 'daemon failure',
})

/** Member/result states that mean the work is NOT done, so a verdict built from these must never
 *  read "ok" - whatever fan_out.py's own exit code said.
 *
 *  ⛔ FALSE GREEN, TWICE (found live 2026-09-15). `fan_out_status` answered `verdict: "ok: every
 *  member spawned and confirmed..."` for a group whose counts were `finished 1, planned 1,
 *  unassigned 1`, and `fan_out_delete` printed the identical sentence over `skipped: "no session"`
 *  for two members that never spawned - because the verdict came ONLY from fan_out.py's exit code
 *  (status always exits 0; delete's own exit code ignores a member with no session to delete at
 *  all, see fan_out.py's `delete_exit_code`). A member that never spawned, was never assigned, or
 *  was skipped is not ok, however the exit code reads. */
const FAN_OUT_BAD_MEMBER_STATES = new Set([
  'planned',
  'unassigned',
  'refused',
  'refused-duplicate',
  'open-failed',
  'not-registered',
  'spawned-unconfirmed',
  'unbound',
  'crashed',
  'stalled',
  'unknown',
  'ungateable',
])

/** Tally `items` by `key(item)`, insertion order, as `"state N"` fragments joined for the verdict. */
function stateCounts<T>(items: readonly T[], key: (item: T) => string): string {
  const counts = new Map<string, number>()
  for (const item of items) {
    const k = key(item) || '?'
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return [...counts.entries()].map(([k, v]) => `${k} ${v}`).join(', ')
}

/** A `send`/`delete` result's own state, for the same per-state counting `fan_out_status` gets
 *  from a member's `state` field - these reports carry `delivered`/`deleted` booleans and a
 *  `skipped` reason instead. */
function fanOutResultState(r: Record<string, unknown>): string {
  if (r.skipped) return 'skipped'
  // a `recover` row: recovered, or escalated by its recipe
  if ('outcome' in r) return str(r.outcome)
  if ('delivered' in r) return r.delivered ? 'delivered' : 'not-delivered'
  if ('deleted' in r) return r.deleted ? 'deleted' : 'not-deleted'
  return '?'
}

/** The verdict text AND whether it is actually ok, read from the payload's own member/result
 *  states when there are any - the exit-code table above is the fallback for a payload with
 *  nothing to count (no JSON on stdout, or a group with no members yet). */
function fanOutVerdict(
  code: number | null,
  payload: Record<string, unknown> | null,
): { verdict: string; bad: boolean } {
  const fallback = code == null ? 'no exit code' : (FAN_OUT_VERDICTS[code] ?? `exit ${code}`)
  // A group recorded before ranking (fan_out.py's placeholder) has no members yet: it either
  // failed there or is still planning, and neither is "ok".
  if (payload && str(payload.error)) return { verdict: `failed: ${str(payload.error)}`, bad: true }
  if (payload && payload.phase === 'planning')
    return { verdict: 'not yet: still ranking accounts, no member planned', bad: true }
  const members = payload && Array.isArray(payload.members) ? payload.members : null
  if (members && members.length > 0) {
    const rows = members as Record<string, unknown>[]
    // A member whose own beacon (report_progress) says it is blocked on a person is not done,
    // whatever its transcript state reads - "finished" is exactly what a chat waiting on a
    // question looks like from outside.
    const blocked = rows.filter(
      (m) => ((m.beacon ?? null) as Record<string, unknown> | null)?.blockedOnUser === true,
    ).length
    const bad = blocked > 0 || rows.some((m) => FAN_OUT_BAD_MEMBER_STATES.has(str(m.state)))
    const tail = blocked > 0 ? `; blocked on user ${blocked} (listed first)` : ''
    return {
      verdict: `${bad ? 'partial' : 'ok'}: ${stateCounts(rows, (m) => str(m.state))}${tail}`,
      bad,
    }
  }
  const results = payload && Array.isArray(payload.results) ? payload.results : null
  if (results && results.length > 0) {
    const rows = results as Record<string, unknown>[]
    const bad = rows.some(
      (r) => !['delivered', 'deleted', 'recovered', 'asked'].includes(fanOutResultState(r)),
    )
    return {
      verdict: `${bad ? 'partial' : 'ok'}: ${stateCounts(rows, fanOutResultState)}`,
      bad,
    }
  }
  return { verdict: fallback, bad: false }
}

/** Run one fan_out.py invocation through the daemon and hand back its JSON report with the exit
 *  code translated. No JSON on stdout means the script never reached its own report (python
 *  missing, usage error), so the raw run comes back with ok:false rather than a bare failure.
 *
 *  `background: true` posts `async: true` and hands back the daemon's 202 (`operationId`,
 *  `status`) verbatim - there is no stdout to parse yet, exactly like move_chats' own detached
 *  path (mcp.ts's orchestrator_run / move_chats). The caller decorates that with the group id it
 *  already knows (see the `fan_out` tool) and how to poll it. */
async function runFanOut(
  args: string[],
  timeoutMs: number,
  opts: { background?: boolean } = {},
): Promise<Record<string, unknown>> {
  const run = (await api('/api/orchestrator/run', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ script: 'fan_out', args, timeoutMs, async: opts.background === true }),
  })) as Record<string, unknown>
  if (opts.background === true) return run
  let payload: Record<string, unknown> | null = null
  try {
    const parsed: unknown = JSON.parse(str(run.stdout))
    if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>
  } catch {
    payload = null
  }
  const code = typeof run.exitCode === 'number' ? run.exitCode : null
  const { verdict, bad } = fanOutVerdict(code, payload)
  if (!payload) return { ...run, ok: false, args, verdict }
  return {
    ok: code === 0 && !bad,
    ...payload,
    exitCode: code,
    verdict,
    ...(str(run.stderr).trim() ? { stderr: run.stderr } : {}),
  }
}

export const FAN_OUT_TOOLS: McpEngineTool[] = [
  // --- fan-out: one task list -> N visible chats on N accounts -------------------------
  // The owner's ask (2026-09-04): "if I start a single chat and tell it to do something that
  // involves checking or linting six or seven planes, can it orchestrate those chats into other
  // accounts and manage them?" Before this the honest answer was "by hand, in ~20 round trips, and
  // the two tools that look like the answer are refused". These three wrap orchestrator/fan_out.py
  // exactly the way move_chat wraps migrate_chat: every rail lives in the script.
  {
    name: 'fan_out',
    description:
      "MUTATES: DISSEMINATE one task list into N VISIBLE Claude Desktop chats, ONE ACCOUNT EACH, and track them as a group — the path for \"lint/check these seven planes in parallel on other accounts\" (owner ask, 2026-09-04). Each task is {cwd, prompt, title?}. Accounts are ranked by REAL room (the fill ceiling minus the account's peak across 5-hour/weekly/binding; an unknown or stale reading is never room), OPEN desktop instances first, one task per account by default (`per_account` raises the cap; spread, never dump). The calling chat's own account is EXCLUDED by default (`exclude_self: false` to allow it). Each chat is spawned through the app's own claude://code/new deeplink into a RUNNING app — trust pre-written, composer submitted, bypass set at birth — so it is a real chat in a sidebar, never headless; spawns run ONE AT A TIME (~30-90 s each) because two lanes driving two windows at once is how text lands in the wrong pane, so budget minutes, not seconds. Closed instances are used only with `open_closed: true` (opening an app is the last resort). A task whose exact prompt already runs somewhere in the fleet is refused as a duplicate (`force` is a PERSON's word to insist); tasks in the SAME call may share a prompt on purpose. A task no account can take is reported UNASSIGNED, never dropped. SPAWN TREE CAP: every fan-out, a brand-new one included, belongs to a tree of at most 12 chats by default (`max_nodes`), so tasks past that come back UNASSIGNED even with room left; a member fanning out again is found by its own session and can only narrow its group's envelope (accounts, per_account, closed apps, quota ceiling, depth). Returns the group id plus one member per task (instance, sessionId, state: spawned / spawned-unconfirmed / refused / unassigned, why). DELIVERY IS PROVEN, NOT ASSUMED: every prompt carries a short task receipt (token, repo, task id, expected artifact) the chat is asked to echo first; after the last spawn fan_out waits `receipt_secs` for every echo, nudges a chat that never started ONCE, and never types into a chat whose first turn lacks its token (`receipt: false` opts out). ⛔ SPAWNING RUNS IN THE DAEMON, NOT ON THIS CONNECTION: a real fan-out (~30-90s per chat, sequential) is always DETACHED automatically past 120s declared - you get the group id and an operationId AT ONCE, and the daemon keeps spawning every chat regardless of whether this call's own connection is abandoned (a lost client can no longer cancel work mid-spawn). Poll fan_out_status { group } for each member's progress; pass `background: false` only for a one-or-two-chat call you know your transport can hold open. Then fan_out_status reads them and fan_out_send steers them. Each member's first prompt ends with a [fan-out beacon] line naming its group and index and asking it to call report_progress, so fan_out_status also shows each member's own phase, next step and blocked-on-user flag. `dry_run: true` returns the plan and spawns nothing, and always blocks (it only ranks and plans). This is a person's act and does not need the tray icon. WRONG TOOL when every Claude account is at/above 90% weekly (check list_usage first): mechanical, checkable batch work belongs on the DeepSeek zswarm instead (zswarm_run) rather than queued behind N account resets; fan_out remains right for work that needs a real Claude Desktop chat. A PROBE OR DRILL FAN-OUT MUST BE DELETED AFTERWARDS (owner rule, 2026-09-04: a ping or account-identification chat is never left in the account): fan_out_delete {group}.",
    inputSchema: S(
      {
        tasks: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: "The group's label for this member (optional).",
              },
              cwd: { type: 'string', description: 'Absolute folder the chat starts in.' },
              prompt: { type: 'string', description: "The chat's first message." },
              artifact: {
                type: 'string',
                description:
                  "What the chat should produce, named in its task receipt (optional; default 'a final report in this chat').",
              },
            },
            required: ['cwd', 'prompt'],
            additionalProperties: false,
          },
          description: 'One entry per chat to start. Same prompt across entries is fine.',
        },
        group: {
          type: 'string',
          description: 'A name for the group (optional; the id is generated).',
        },
        per_account: {
          type: 'number',
          description: 'Max chats per account in this fan-out. Default 1.',
        },
        only: {
          type: 'array',
          items: { type: ['string', 'number'] },
          description: 'Restrict targets to these instances (number, name, label or email).',
        },
        exclude: {
          type: 'array',
          items: { type: ['string', 'number'] },
          description: 'Never target these instances (number, name, label or email).',
        },
        exclude_self: {
          type: 'boolean',
          description:
            'Default true: the instance THIS process runs as is left out (when its identity is exact). false = allow it.',
        },
        open_closed: {
          type: 'boolean',
          description: 'Allow opening closed instances when running ones run out. Default false.',
        },
        force: {
          type: 'boolean',
          description:
            "A person's word: start a task even though an identical chat already exists.",
        },
        parent: {
          type: 'string',
          description:
            "The parent group id, or a member's sessionId. Omit it and the calling chat's own session is used: a fan_out member fanning out again is found by it automatically, and a caller that is no member starts a new tree. The new group's envelope is derived from the parent's by narrowing only - never more accounts, chats per account, quota or depth than the parent had - and the whole spawn tree holds at most max_nodes chats.",
        },
        max_nodes: {
          type: 'number',
          description:
            'Cap on chats across the whole spawn tree, this call included (default 12, also for a brand-new root: tasks past it come back UNASSIGNED; a child can only lower it).',
        },
        max_depth: {
          type: 'number',
          description:
            'How many levels of members fanning out again the tree allows (default 2; a child can only lower it).',
        },
        ceiling_pct: {
          type: 'number',
          description:
            "Only accounts whose peak usage is below this % may take a member (a child can only lower it). Default: each plan's own fill ceiling.",
        },
        dry_run: { type: 'boolean', description: 'Plan only: rank, assign, spawn nothing.' },
        receipt: {
          type: 'boolean',
          description:
            'Default true: every prompt carries a short task receipt (token, repo, task id, expected artifact) the chat is asked to echo first, so delivery is proven from its transcript; fan_out_status reports each member as delivered / no-echo / wrong-task / never-started / wrong-chat / pending. false sends the bare prompt.',
        },
        receipt_secs: {
          type: 'number',
          description: `Seconds to wait after the last spawn for every receipt echo (default ${FAN_OUT_RECEIPT_SECS}; 0 = do not wait). A chat still never-started then gets ONE nudge through the composer and is watched again; a wrong-chat member is never typed into.`,
        },
        background: {
          type: 'boolean',
          description:
            'ALREADY THE DEFAULT whenever this spawn declares itself longer than 120s, which is nearly every real fan-out (~30-90s per chat, sequential): answers AT ONCE with the group id and an operationId instead of holding the connection open for the whole spawn, which keeps running in the daemon regardless. Poll fan_out_status { group } for per-member progress. `false` forces blocking even past 120s - only for a caller whose own transport can wait that long. Omit it to get the auto rule; a dry_run never backgrounds (it only ranks and plans, in seconds).',
        },
      },
      ['tasks'],
    ),
    run: async (a) => {
      const rawTasks = Array.isArray(a.tasks) ? a.tasks : []
      if (rawTasks.length === 0) throw new Error('tasks is required: at least one {cwd, prompt}')
      const tasks = rawTasks.map((t, i) => {
        const task = (t ?? {}) as Record<string, unknown>
        const cwd = str(task.cwd ?? task.folder).trim()
        const prompt = str(task.prompt).trim()
        if (!cwd) throw new Error(`task ${i} has no cwd`)
        if (!prompt) throw new Error(`task ${i} has no prompt`)
        const title = str(task.title).trim()
        const artifact = str(task.artifact).trim()
        return {
          ...(title ? { title } : {}),
          folder: cwd,
          prompt,
          ...(artifact ? { artifact } : {}),
        }
      })
      const groupName = str(a.group).trim()
      const spec = JSON.stringify({ ...(groupName ? { group: groupName } : {}), tasks })
      // ⛔ GENERATED HERE, NOT BY fan_out.py, SO IT CAN BE RETURNED BEFORE SPAWNING FINISHES
      // (found live 2026-09-15, operation 2411fce7: the MCP call blocked on the WHOLE spawn -
      // 30-90s per chat, sequential - and the client gave up long before the last chat landed,
      // stranding it `planned` forever with no id anyone had ever seen). fan_out.py accepts this
      // id verbatim via --group-id instead of minting its own, so the id handed back here is
      // GUARANTEED to be the real group's id, not a guess - and the daemon keeps spawning
      // server-side however this call is answered, so an abandoned client can no longer cancel
      // work mid-spawn.
      const groupId = `fo-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
      const args = ['--spec', specArg(spec), '--group-id', groupId, '--json']
      const perAccount = Number(a.per_account)
      if (Number.isFinite(perAccount) && perAccount > 1)
        args.push('--per-account', String(Math.floor(perAccount)))
      for (const ref of Array.isArray(a.only) ? a.only : [])
        args.push('--only', String((await resolveRef(ref)).num))
      const excludes: string[] = []
      for (const ref of Array.isArray(a.exclude) ? a.exclude : [])
        excludes.push(String((await resolveRef(ref)).num))
      let selfNote: string
      if (a.exclude_self === false) {
        selfNote = 'self not excluded (exclude_self: false)'
      } else {
        // The caller's own account is the one it is trying to spare, so it is left out — but
        // only on a PROVEN identity: excluding a guessed number could remove the wrong account
        // while the real one takes the load.
        try {
          const self = await selfIdentity()
          if (
            self.instance &&
            self.confidence === 'exact' &&
            !self.warning &&
            self.instance.kind === 'desktop'
          ) {
            excludes.push(String(self.instance.num))
            selfNote = `excluded self = ${instanceLabel(self.instance)}`
          } else {
            // say the REAL reason (review 2026-09-05: this used to say "not exact" for every
            // branch, including an exact answer that was simply a CLI or Codex instance)
            const why = !self.instance
              ? 'no numbered instance matched this process'
              : self.confidence !== 'exact'
                ? `identity is only ${self.confidence}`
                : self.warning
                  ? `identity carries a warning: ${self.warning}`
                  : `${instanceLabel(self.instance)} is a ${self.instance.kind} instance, which cannot host desktop chats anyway`
            selfNote = `self NOT excluded: ${why} (${self.summary}); pass exclude explicitly if that matters`
          }
        } catch (e) {
          selfNote = `self NOT excluded: identity lookup failed (${e instanceof Error ? e.message : String(e)})`
        }
      }
      for (const n of new Set(excludes)) args.push('--exclude', n)
      if (a.open_closed === true) args.push('--open-closed')
      // the spawn tree's narrow-only envelope (fan_out.py narrow_envelope owns the rules)
      const parent = str(a.parent).trim()
      if (parent) args.push('--parent', parent)
      else {
        // A member that names no parent must still be bound by its group, or fanning out again
        // silently widens to a fresh root. This process sees the calling chat's own session ids
        // (core/self-identity.ts); fan_out.py narrows when one is a ledger member and starts a
        // root when none is. A frozen id from an older chat can only narrow, never widen.
        const callerIds = [
          process.env.CLAUDE_CODE_SESSION_ID,
          process.env.CLAUDE_CODE_HOST_SESSION_ID,
        ]
        for (const id of new Set(callerIds.map((v) => str(v).trim()).filter(Boolean)))
          args.push('--caller-session', id)
      }
      const maxNodes = Number(a.max_nodes)
      if (Number.isFinite(maxNodes) && maxNodes >= 1)
        args.push('--max-nodes', String(Math.floor(maxNodes)))
      const maxDepth = Number(a.max_depth)
      if (Number.isFinite(maxDepth) && maxDepth >= 0)
        args.push('--max-depth', String(Math.floor(maxDepth)))
      const ceilingPct = Number(a.ceiling_pct)
      if (a.ceiling_pct != null && Number.isFinite(ceilingPct))
        args.push('--ceiling-pct', String(ceilingPct))
      if (a.force === true) args.push('--force')
      if (a.dry_run === true) args.push('--dry-run')
      // The task receipt: proof from each transcript that the prompt landed and started, with
      // one re-delivery for a chat that never did (orchestrator/scripts/lib/receiptlib.py).
      const receiptSecsRaw = Number(a.receipt_secs)
      const receiptSecs =
        a.receipt === false || a.dry_run === true
          ? 0
          : Number.isFinite(receiptSecsRaw)
            ? Math.max(0, Math.min(900, Math.floor(receiptSecsRaw)))
            : FAN_OUT_RECEIPT_SECS
      if (a.receipt === false) args.push('--no-receipt')
      else if (receiptSecs > 0) args.push('--receipt-secs', String(receiptSecs))
      // one spawn can take ~4 minutes worst case (trust modal, six submit attempts); a dry run
      // only ranks and plans. The receipt check adds two waits plus one nudge (~4.5 min) per chat.
      const timeoutMs =
        a.dry_run === true
          ? 180_000
          : Math.min(
              60 * 60_000,
              90_000 +
                tasks.length * 240_000 +
                (receiptSecs > 0 ? 2 * receiptSecs * 1000 + tasks.length * 270_000 : 0),
            )
      // The SAME auto-detach rule orchestrator_run and move_chats already earned from nearly
      // identical incidents: a caller that DECLARES a run longer than AUTO_DETACH_MS is detached
      // automatically, because a real fan-out (30-90s PER CHAT, sequential) always outlives an
      // MCP client's transport. A dry run never backgrounds - it only ranks and plans, in
      // seconds, and the caller wants the plan back in the same call.
      const background =
        a.dry_run !== true &&
        (a.background === true || (a.background == null && timeoutMs > AUTO_DETACH_MS))
      try {
        const run = await runFanOut(args, timeoutMs, { background })
        if (background)
          return {
            ...run,
            groupId,
            started: true,
            selfNote,
            poll: `fan_out_status { group: "${groupId}" }`,
            note:
              a.background === true
                ? `Spawning is running in the daemon under group ${groupId}. Poll fan_out_status { group: "${groupId}" } for each member's progress; it does not block on the spawn.`
                : `Detached automatically: this spawn's own declared length (${Math.round(timeoutMs / 1000)}s, ${tasks.length} chat(s) at ~30-90s each) is longer than an MCP client will hold a connection open, and a call the client abandons loses the report for work that keeps running anyway. Group ${groupId} is spawning in the daemon regardless of this call's connection; poll fan_out_status { group: "${groupId}" } for per-member progress, or pass background:false if you really do want to block (only worth it for one or two chats).`,
          }
        return { ...run, groupId, selfNote }
      } catch (e) {
        // ⛔ BUSY IS AN ANSWER, NOT A THROW (found live 2026-09-24, chat ffb5fe39): a second
        // fan_out while a spawn held the route read, from the caller's side, as a silent drop.
        // Say so with the holder's operation id, and say plainly that no group exists.
        const refusal = busyRefusal(e)
        if (!refusal) throw e
        return {
          ...refusal,
          ok: false,
          busy: true,
          groupId: null,
          selfNote,
          note: `REFUSED busy: another fan_out (or send/delete) holds the route, so nothing was spawned and no group ${groupId} exists. Wait for operation ${str(refusal.operationId) || '(unknown)'} to finish (orchestrator_operation), then fire this call again.`,
        }
      } finally {
        // arkitect-allow: no-bandaids permanent finally-block cleanup, not scheduled for removal —
        // a spec that travelled as a temp file is ours to remove once the script has read it
        // (review 2026-09-05: nothing else ever deleted it)
        const specPath = args[1]
        if (specPath !== spec) {
          if (background) {
            // ⛔ THE SCRIPT MAY NOT HAVE READ ITS OWN ARGV YET. Backgrounding answers as soon as
            // the daemon has STARTED the child, not once fan_out.py has parsed --spec - Python
            // interpreter startup (importing orch.py, fan_out.py and everything it pulls in) can
            // take longer than this call's own round trip, and deleting the file the instant we
            // are told the run started would delete it out from under a `parse_spec` that has not
            // run yet. Cleanup here is best-effort already (see the comment above); a generous
            // delayed unlink keeps it best-effort rather than a race.
            setTimeout(() => {
              try {
                unlinkSync(specPath)
              } catch {
                /* already gone, or never written */
              }
            }, 120_000)
          } else {
            try {
              unlinkSync(specPath)
            } catch {
              /* already gone, or never written */
            }
          }
        }
      }
    },
  },
  {
    name: 'fan_out_status',
    description:
      "READ-ONLY: where every chat of a fan_out group stands — per member: instance, sessionId, the gate's verdict as one word (working / idle / stalled / finished / crashed, or the spawn state for a member that never got a session), how long it has been quiet, its cause, and its LAST WORDS (the last assistant text, capped) so a manager chat can read seven results without seven tail_session calls. Each member also carries its latest self-reported `beacon` (report_progress: mode, task, cumulative summary, next step, review paths, confidence, blocked-on-user); members blocked on a person are listed FIRST, named in `blockedOnUser`, and make the verdict partial. `group` is the id or name from fan_out (a unique id prefix works); omitted = the most recent group. Also lists the follow-ups already sent to the group. A member in a failure the recovery table knows (delivery-failed, account-at-cap, chat-stalled) carries `recovery`: the recipe's one automatic step, attempts used of its max, and the escalation that follows; `recoveries` is the group's recovery ledger - every attempt and escalation fan_out_recover made, with why. Each member also carries `receipt`: whether the chat echoed the task receipt its prompt carried (delivered / no-echo / wrong-task / never-started / wrong-chat / pending) and whether its one re-delivery was spent.",
    inputSchema: S({
      group: {
        type: 'string',
        description: 'Group id, name, or unique id prefix. Default: latest.',
      },
    }),
    run: async (a) => {
      const args = ['status']
      const group = str(a.group).trim()
      if (group) args.push(group)
      args.push('--json')
      const r = await runFanOut(args, 180_000)
      if (!group || r.exitCode !== 3) return r
      // ⛔ "NO SUCH GROUP" FOR AN ID fan_out HANDED OUT MUST SAY WHY (found live 2026-09-24):
      // the id is minted before fan_out.py runs, so a run that was refused, or died before it
      // wrote its first record, left a caller holding an id that status called nonexistent.
      // The operation that carried `--group-id <id>` knows what happened to it.
      const ops = (await api('/api/orchestrator/operations')) as {
        operations?: Array<Record<string, unknown>>
      }
      const op = (ops.operations ?? []).find((o) => {
        const argv = Array.isArray(o.args) ? o.args.map(str) : []
        const i = argv.indexOf('--group-id')
        return o.script === 'fan_out' && i >= 0 && argv[i + 1] === group
      })
      if (!op) return r
      const result = (op.result ?? null) as Record<string, unknown> | null
      return {
        ...r,
        operation: { id: op.id, status: op.status, startedAt: op.startedAt, result },
        note:
          op.status === 'running'
            ? `Group ${group} has no record yet: its fan_out (operation ${str(op.id)}) is still starting. Poll again shortly.`
            : `Group ${group} was never recorded: its fan_out (operation ${str(op.id)}) ended ${str(op.status)}${result && str(result.error) ? ` - ${str(result.error)}` : ''}${result && str(result.stderr).trim() ? ` - ${str(result.stderr).trim().slice(-400)}` : ''}.`,
      }
    },
  },
  // A typed progress beacon, reported BY a fan_out member about itself. fan_out_status used to
  // infer every member's state after the fact from its transcript, and could not tell a chat
  // waiting on a person from a finished one; each member's first prompt now names its group and
  // index and asks it to call this, so the manager sees phase, next step and blocked-on-user.
  {
    name: 'report_progress',
    description:
      'MUTATES: writes a progress record only. A fan_out MEMBER reports where it stands, for the chat that fanned it out to read in fan_out_status. Your first prompt names your `group` and `member` index (the "[fan-out beacon]" line); call this when you start, each time your phase changes, and once more when you finish or need a person. `task_name` is what you are doing, `mode` is planning / execution / verification, `summary` is CUMULATIVE (everything done so far, not just the last step), `next_step` is what you will do NEXT. On the final call add `paths_to_review` (files the manager should read), `confidence` 0-1 with `confidence_why`, and `blocked_on_user: true` when you cannot go on without a person - fan_out_status lists blocked members first. Each call replaces your previous beacon. It records only: nothing is sent to any chat, and it never waits behind a running spawn.',
    inputSchema: S(
      {
        group: { type: 'string', description: 'The fan-out group id from your first prompt.' },
        member: { type: 'number', description: 'Your member index from your first prompt.' },
        task_name: { type: 'string', description: 'What you are working on, in a few words.' },
        mode: {
          type: 'string',
          enum: ['planning', 'execution', 'verification'],
          description: 'The phase you are in now.',
        },
        summary: {
          type: 'string',
          description: 'Cumulative: everything done so far (capped at 1200 characters).',
        },
        next_step: { type: 'string', description: 'What you will do next.' },
        paths_to_review: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files the manager should review (final report; at most 10).',
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'How sure you are the work is right, 0-1 (needs confidence_why).',
        },
        confidence_why: { type: 'string', description: 'The justification for `confidence`.' },
        blocked_on_user: {
          type: 'boolean',
          description: 'true = you cannot go on without a person (a question, an approval).',
        },
      },
      ['group', 'member', 'task_name', 'mode'],
    ),
    run: async (a) => {
      const group = str(a.group).trim()
      if (!group) throw new Error('group is required: the fan-out group id from your first prompt')
      if (!Number.isInteger(Number(a.member)) || str(a.member).trim() === '')
        throw new Error('member is required: your member index from your first prompt')
      if (!str(a.task_name).trim()) throw new Error('task_name is required')
      const r = await runFanOut(['beacon', group, '--beacon', beaconArg(a), '--json'], 60_000)
      // A beacon report has no members to count, so runFanOut's exit-code fallback verdict
      // ("every member spawned...") would describe the wrong act; say what happened instead.
      return r.recorded === true
        ? { ...r, verdict: 'recorded' }
        : { ...r, verdict: `not recorded: ${str(r.stderr).trim() || str(r.verdict)}` }
    },
  },
  {
    name: 'fan_out_send',
    description:
      "MUTATES: deliver ONE follow-up message into every chat of a fan_out group (or just the `only` session ids) — the steering half of managing a fan-out. THE PEER PIPE IS NOT USED: a spawned chat nobody has clicked never drains peer messages (measured 2026-09-04), so each member's IDLE engine is stopped first (a working or stuck one refuses and that member is skipped with the reason) and the daemon's message route then types the text into the app's OWN composer, which boots the chat and is verified from the transcript. A member whose app has not yet written its sidebar record cannot be reached this way and says so. A HELD chat is skipped and named; `force` is a PERSON's word past a hold. Deliveries are sequential and each waits for the chat to move, so budget ~1-3 minutes per member. Returns per-member delivered / route / detail / engine; the group record keeps every send.",
    inputSchema: S(
      {
        group: { type: 'string', description: 'Group id, name, or unique id prefix.' },
        text: { type: 'string', description: 'The message to deliver into each chat.' },
        only: {
          type: 'array',
          items: { type: 'string' },
          description: 'Session ids to deliver to (default: every member with a session).',
        },
        force: { type: 'boolean', description: "A person's word: deliver past a hold." },
      },
      ['group', 'text'],
    ),
    run: async (a) => {
      const group = str(a.group).trim()
      const text = str(a.text).trim()
      if (!group)
        throw new Error('group is required (fan_out_status with no group shows the latest)')
      if (!text) throw new Error('text is required')
      const args = ['send', group, '--text', text]
      const only = Array.isArray(a.only) ? a.only.map(str).filter((s) => s.trim()) : []
      for (const sid of only) args.push('--only', sid.trim())
      if (a.force === true) args.push('--force')
      args.push('--json')
      return runFanOut(args, 20 * 60_000)
    },
  },
  {
    // WHY: a failed member used to get whatever the caller tried next, usually the same send
    // again. This meets each one with a fixed recipe and ONE automatic attempt, then escalates.
    name: 'fan_out_recover',
    description:
      "MUTATES: meet every FAILED member of a fan_out group with its recovery recipe - one automatic attempt, then the recipe's escalation, each written to the group's recovery ledger (fan_out_status shows it). The closed table: delivery-failed -> re-send the same text once, only when the message route REFUSED it before typing (400/404/409; a 422 or an unconfirmed send may already be on screen and is never repeated blind), then alert-human (an incident in list_incidents); chat-stalled -> ask the chat once through its composer whether it is stuck (outcome asked; the attempt stays spent until the member stops being stalled), then alert-human; account-at-cap (an unassigned task) -> re-rank the accounts once inside the group's own fence (its --exclude, so never the calling chat's account) and spawn it where there is room now, then log-and-continue. A member whose attempt is already spent escalates without trying again; a success clears it. Members with nothing owed are left alone. Holds are respected unless `force` (a PERSON's word). Returns one row per member met: kind, outcome (recovered / asked / escalated); nothing to recover is ok, not a failure, escalation, incident, detail.",
    inputSchema: S(
      {
        group: { type: 'string', description: 'Group id, name, or unique id prefix.' },
        force: { type: 'boolean', description: "A person's word: act past a hold." },
      },
      ['group'],
    ),
    run: async (a) => {
      const group = str(a.group).trim()
      if (!group)
        throw new Error('group is required (fan_out_status with no group shows the latest)')
      const args = ['recover', group]
      if (a.force === true) args.push('--force')
      args.push('--json')
      const res = await runFanOut(args, 20 * 60_000)
      // exit 2 with no rows is "no member is in a known failure": an answer, not a failure
      if (res.exitCode === 2 && Array.isArray(res.results) && res.results.length === 0)
        return {
          ...res,
          ok: true,
          verdict: 'nothing to recover: no member is in a failure the recipe table knows',
        }
      return res
    },
  },
  {
    name: 'fan_out_delete',
    description:
      "MUTATES: DELETE every chat of a fan_out group from the account it lives in — the cleanup a probe or drill fan-out owes (owner rule, 2026-09-04: \"all ping requests or account identification requests must be deleted after they are created and not left in the account\"). Per member, delete_chat.py: an IDLE engine is stopped first (a working or stuck one refuses and that member is reported), an undo copy of the meta record(s) and transcript is taken into orchestrator/state/trash/<sessionId>/, then the running app's OWN Delete control is driven (row menu Delete + the app's confirm button, both by label), then the record and the transcript are removed everywhere, and the result is VERIFIED (dossier empty, transcript gone) — anything left is named, never claimed. A HELD chat is skipped; `force` is a PERSON's word past a hold. `orchestrator_run delete_chat --undo <sessionId>` restores one from its undo copy.",
    inputSchema: S(
      {
        group: { type: 'string', description: 'Group id, name, or unique id prefix.' },
        force: { type: 'boolean', description: "A person's word: delete past a hold." },
      },
      ['group'],
    ),
    run: async (a) => {
      const group = str(a.group).trim()
      if (!group)
        throw new Error('group is required (fan_out_status with no group shows the latest)')
      const args = ['delete', group]
      if (a.force === true) args.push('--force')
      args.push('--json')
      return runFanOut(args, 15 * 60_000)
    },
  },
]

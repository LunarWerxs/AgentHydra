// server/src/mcp-self.ts - which instance is calling, split out of mcp.ts: the self-
// identification that has to run in the MCP server process, the caller-pid plumbing the HTTP
// transport feeds it, and the `nextStep` line every usage tool attaches.
import type { OwnTranscript } from './compaction-history'
import type { SelfIdentityDetection } from './core/self-identity'
import { apiOrLocal, qs, type ResolvedInstanceRow } from './mcp-client'
import type { UsageAdvice, UsageSnapshot } from './types'

// --- self-identification ------------------------------------------------------
//
// This is the part that has to run HERE, in the MCP server process, and not on the daemon: the
// whole method is reading this process's own environment and walking up to the `claude.exe` that
// spawned it. See core/self-identity.ts for what it looks at and why each signal is needed. The
// daemon is only asked the cheap, stateless question afterwards ("which instance owns this dir?").

/** The detection half is memoized: which instance a process belongs to CANNOT change while that
 *  process lives, and the ancestry fallback costs a PowerShell spawn. The dir→instance lookup is
 *  deliberately NOT cached — the fleet's account/plan data can change under us, and it is one
 *  loopback request. */
let selfDetectionCache: Promise<SelfIdentityDetection> | null = null

/** ⛔ OVER HTTP, "THIS PROCESS" IS THE DAEMON, AND THE ANSWER WAS USELESS (2026-09-11).
 *  mcp-register.ts registers the HTTP transport for every client, so `whoami` ran inside the
 *  daemon and walked the DAEMON'S ancestry - the tray, and whatever started that - then reported
 *  "this process does not look like it is running under Claude Code at all" to an agent that very
 *  much is. `to: "here"` (refused unless the identity is exact) and check_my_usage's attribution
 *  went down with it, for every caller on the machine.
 *
 *  The caller is not unknowable: it opened a loopback socket, so the OS can name its pid, and that
 *  pid IS the engine - `<instanceDir>/claude-code/<ver>/claude.exe`. Feeding that chain to the
 *  EXISTING stage-5 signals identifies it exactly. The env stages are skipped deliberately (`env:
 *  {}`): the daemon's environment says nothing about the caller, and a ruledOut line claiming a
 *  check that was never performed against that process would be a fabricated working. */
const callerDetectionCache = new Map<number, Promise<SelfIdentityDetection>>()

async function detectForCaller(callerPid: number, fresh: boolean): Promise<SelfIdentityDetection> {
  const cached = fresh ? undefined : callerDetectionCache.get(callerPid)
  if (cached) return cached
  const probe = (async () => {
    const { detectSelfIdentity } = await import('./core/self-identity')
    const { processAncestry } = await import('./core/process')
    const detection = await detectSelfIdentity({
      env: {},
      ancestry: () => processAncestry(callerPid, { includeSelf: true }),
    })
    return {
      ...detection,
      ruledOut: [
        `answered for the CALLING process (pid ${callerPid}), not for this daemon: MCP arrived over ` +
          "HTTP, so the caller's own environment cannot be read from here and only its process " +
          'chain was walked',
        ...detection.ruledOut.filter((r) => r.includes('ancestor') || r.includes('ancestry')),
      ],
    }
  })()
  callerDetectionCache.set(callerPid, probe)
  try {
    return await probe
  } catch (e) {
    callerDetectionCache.delete(callerPid) // a failed probe must not be remembered as the answer
    throw e
  }
}

/** An HTTP caller whose socket the OS table could not tie to one process (see callerPidFromArgs).
 *  ⛔ NOT this daemon's own identity: that fallback walked the daemon's parents (the tray) and told
 *  an agent on #72 it was "not running under Claude Code at all" minutes after `whoami` had named
 *  it exactly (2026-09-27, the first call after a watchdog respawn). The honest answer is that the
 *  caller could not be traced, which says nothing about what the caller is. */
const UNTRACED_CALLER: SelfIdentityDetection = {
  configDir: null,
  kind: 'unknown',
  method: null,
  confidence: 'none',
  clues: [],
  ruledOut: [
    "the call arrived over HTTP and the connection table named no single process owning its socket, so the CALLER could not be traced; this daemon's own process is not the caller and was not examined",
  ],
  conflict: false,
}

/** `callerPid` undefined: no HTTP caller (stdio), so this process IS the caller. null: an HTTP
 *  caller that could not be traced. A number: that caller. */
async function detectSelf(
  fresh = false,
  callerPid?: number | null,
): Promise<SelfIdentityDetection> {
  if (callerPid === null) return UNTRACED_CALLER
  if (callerPid) return detectForCaller(callerPid, fresh)
  if (fresh || !selfDetectionCache) {
    selfDetectionCache = (async () => {
      const { detectSelfIdentity } = await import('./core/self-identity')
      return detectSelfIdentity()
    })()
  }
  try {
    return await selfDetectionCache
  } catch (e) {
    selfDetectionCache = null // a failed probe must not be remembered as the answer
    throw e
  }
}

/** How the HTTP route hands a tool the process that sent the request. It is a FUNCTION on
 *  purpose: JSON cannot carry one, so a client cannot forge `callerPid` in its own arguments -
 *  only our own route, which resolves it from the socket, can put one here. Lazy, because
 *  resolving it costs a `netstat` and only the identity tools ever ask. */
export type CallerPidSource = () => Promise<number | null>
export const CALLER_PID_ARG = 'callerPid'
// history_search / history_read are here because "my own transcript" is a caller identity too.
// climayte_run / climayte_manage / climayte_status record or adopt the CALLING chat as the origin
// CliMayte pings when the work settles (callerOrigin; owner, 2026-10-03).
export const CALLER_AWARE_TOOLS = new Set([
  'whoami',
  'check_my_usage',
  'move_chat',
  'move_chats',
  'history_search',
  'history_read',
  'climayte_run',
  'climayte_manage',
  'climayte_status',
])

/** The HTTP caller's pid; null when the route bound a caller but the lookup named nobody (or
 *  threw); undefined when nothing was bound - the stdio transport, where this process is the
 *  caller. Anything a client put under this name is data, never a binding, so it reads as unbound. */
export async function callerPidFromArgs(
  a: Record<string, unknown>,
): Promise<number | null | undefined> {
  const source = a[CALLER_PID_ARG]
  if (typeof source !== 'function') return undefined
  try {
    return await (source as CallerPidSource)()
  } catch {
    return null
  }
}

/** The calling session's own transcript, for history_search / history_read. The live registry in
 *  ~/.claude is tried first; the caller's detected config dir only when that has no match, so the
 *  identity walk is paid for only by a CLI instance that keeps its own registry. */
export async function ownTranscript(a: Record<string, unknown>) {
  const { resolveOwnTranscript } = await import('./compaction-history')
  const callerPid = await callerPidFromArgs(a)
  return resolveOwnTranscript({
    sessionId: typeof a.session_id === 'string' ? a.session_id : undefined,
    callerPid: callerPid ?? null,
    extraHomes: async () => {
      const dir = (await detectSelf(false, callerPid)).configDir
      return dir ? [dir] : []
    },
  })
}

/** The chat CliMayte pings about work this call dispatches (climayte-ping.ts). */
export interface CallerChatOrigin {
  kind: 'chat'
  sessionId: string
  home: string
  transcript: string | null
  how: string
}

type CallerTranscriptResolver = (a: Record<string, unknown>) => Promise<OwnTranscript>
let callerTranscriptResolver: CallerTranscriptResolver | null = null
/** Tests only: stand in for the process walk (null puts the real one back). */
export function setCallerTranscriptResolver(fn: CallerTranscriptResolver | null): void {
  callerTranscriptResolver = fn
}

/** The calling chat as a ping origin, or why there is none. Only the route's caller binding counts:
 *  no argument a client sends (an `origin`, a `session_id`) is read, so a chat cannot have another
 *  chat's work reported to it, or its own reported elsewhere. Never throws. */
export async function callerOrigin(
  a: Record<string, unknown>,
): Promise<{ origin: CallerChatOrigin; why: null } | { origin: null; why: string }> {
  try {
    const t = callerTranscriptResolver
      ? await callerTranscriptResolver(a)
      : await (async () => {
          const callerPid = await callerPidFromArgs(a)
          if (callerPid === null) throw new Error('the calling process could not be traced')
          const { resolveOwnTranscript } = await import('./compaction-history')
          return resolveOwnTranscript({
            callerPid: callerPid ?? null,
            extraHomes: async () => {
              const dir = (await detectSelf(false, callerPid)).configDir
              return dir ? [dir] : []
            },
          })
        })()
    return {
      origin: {
        kind: 'chat',
        sessionId: t.sessionId,
        home: t.home,
        transcript: t.path,
        how: t.how,
      },
      why: null,
    }
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).split('\n')[0].trim()
    return { origin: null, why: msg || 'the calling chat could not be identified' }
  }
}

/** Identity as the tools report it: the instance (when it is a managed one), the evidence, and an
 *  explicit warning whenever the answer is anything less than proven. */
export interface SelfIdentityPayload {
  instance: ResolvedInstanceRow | null
  configDir: string | null
  kind: SelfIdentityDetection['kind']
  method: SelfIdentityDetection['method']
  confidence: SelfIdentityDetection['confidence']
  clues: SelfIdentityDetection['clues']
  ruledOut: string[]
  summary: string
  /** Present ONLY when the identification is uncertain or contradictory. Its absence is the
   *  signal that the number below can be quoted without a hedge. */
  warning?: string
}

export async function selfIdentity(
  fresh = false,
  callerPid?: number | null,
): Promise<SelfIdentityPayload> {
  const { describeSelfIdentity } = await import('./core/self-identity')
  const detection = await detectSelf(fresh, callerPid)

  let instance: ResolvedInstanceRow | null = null
  if (detection.configDir) {
    // A failed identity lookup may only ever cost the LABEL, never the detection — so this is
    // swallowed rather than thrown. The dir is still correct and still usable for a usage read.
    try {
      instance = (await apiOrLocal(
        `/api/instance-numbers/whoami${qs({ configDir: detection.configDir })}`,
        async () => {
          const { instanceForConfigDir } = await import('./core/instance-ref')
          return await instanceForConfigDir(detection.configDir as string)
        },
      )) as ResolvedInstanceRow | null
    } catch {
      instance = null
    }
  }

  const warnings: string[] = []
  if (detection.conflict) {
    warnings.push(
      'CONFLICT: two independent signals named different credential directories. The highest-priority one was used; do not spend quota on this identification without confirming it with the human.',
    )
  }
  if (detection.disambiguated) {
    warnings.push(
      `DISAMBIGUATED: ${detection.disambiguated}. The numbers are for the instance that rule chose; if a human names a different instance, theirs wins.`,
    )
  }
  if (detection.storeConflict) {
    // A specific instance WAS found - this is not the "fell back to default login" case below,
    // and saying so would hide the real finding: the chat store contradicts the file that named it.
    warnings.push(
      `STORE CONFLICT, not proven: ${detection.storeConflict} If a human told you an instance number, THEIRS IS THE AUTHORITATIVE ANSWER — believe it over this.`,
    )
  } else if (detection.staleHostSession) {
    // Also NOT the default-login case: an instance was named, but the host-session env is a frozen
    // leftover pointing at a dead chat, so this shared server cannot know which chat is calling it.
    warnings.push(
      `STALE HOST SESSION, not proven: ${detection.staleHostSession} If a human told you an instance number, THEIRS IS THE AUTHORITATIVE ANSWER — believe it over this.`,
    )
  } else if (detection.confidence === 'assumed') {
    warnings.push(
      'ASSUMED, not proven: no instance signal matched, so this fell back to the default ~/.claude login by elimination. If a human told you an instance number, THEIRS IS THE AUTHORITATIVE ANSWER — believe it over this.',
    )
  }
  if (detection === UNTRACED_CALLER) {
    warnings.push(
      'UNIDENTIFIED CALLER: this call came over the shared HTTP server and its socket could not be traced to a process, so which account is asking is unknown - it says nothing about whether you run under Claude Code. Call again, or name the instance number instead of "here".',
    )
  } else if (detection.confidence === 'none') {
    warnings.push(
      'UNIDENTIFIED: this process does not look like it is running under Claude Code at all. Treat any quota reading as unattributed.',
    )
  }
  if (!instance && detection.confidence === 'exact' && detection.kind === 'desktop') {
    warnings.push(
      `This is a Claude Desktop user-data dir that AgentHydra does not manage (${detection.configDir}), so it has no instance number. Its quota can still be read.`,
    )
  }

  return {
    instance,
    configDir: detection.configDir,
    kind: detection.kind,
    method: detection.method,
    confidence: detection.confidence,
    clues: detection.clues,
    ruledOut: detection.ruledOut,
    summary: describeSelfIdentity(detection, instance),
    ...(warnings.length ? { warning: warnings.join(' ') } : {}),
  }
}

/** Enough of an instance row to name it in a sentence. Both the fleet rows and the slimmer
 *  `instance` echo that `/api/usage` attaches satisfy this. */
export type NameableInstance = {
  num?: number
  name?: string
  plan?: string | null
  tier?: string | null
} | null

/** `instance #12 (Joel · Max 20×)` — the phrase an agent should use instead of a bare percentage.
 *  Prefers `tier` over `plan`: the tier is what the quota IS. */
export function instanceLabel(i: NameableInstance): string | null {
  if (!i?.num) return null
  const what = i.tier ?? i.plan ?? null
  return `instance #${i.num}${i.name ? ` (${i.name}${what ? ` · ${what}` : ''})` : what ? ` (${what})` : ''}`
}

/**
 * Attach the one-line `nextStep` instruction to a usage result.
 *
 * Every usage tool goes through here so the guidance is identical wherever it appears, and so a
 * response that reached us without an `advice` block (an older daemon, a cached row) still gets
 * one derived from its own snapshot rather than silently losing the instruction.
 */
export async function withNextStep(
  result: unknown,
  self?: SelfIdentityPayload | null,
): Promise<unknown> {
  if (result === null || typeof result !== 'object') return result
  const r = result as Record<string, unknown>
  const { nextStep, usageAdvice } = await import('./usage')
  const advice =
    (r.advice as UsageAdvice | undefined) ??
    (r.snapshot ? usageAdvice(r.snapshot as UsageSnapshot) : null)
  if (!advice) return result
  return {
    ...r,
    advice,
    nextStep: nextStep(advice, {
      // `self` is only passed when the target was worked out rather than named by the caller —
      // a caller who passed `instance: 7` has no attribution problem to warn about.
      identityUncertain: self ? self.confidence !== 'exact' || !!self.warning : false,
      instanceLabel: instanceLabel((r.instance as NameableInstance) ?? self?.instance ?? null),
    }),
  }
}

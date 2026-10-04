import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from 'hono'
import { climayteLimitWalls, climayteLiveReadings } from '../climayte'
import { cliAccountUuid } from '../core/account-tokens'
import {
  associateCliInstance,
  createCliInstance,
  deleteCliInstance,
  getCliInstance,
  launchCliInstance,
  linkCliInstanceToDesktop,
  listCliInstances,
  pruneCliInstanceAccountAssociations,
  renameCliInstance,
  setCliInstanceLimitReset,
  setCliInstanceUsage,
} from '../core/cli-instances'
import { runCliLimitReset } from '../core/cli-limit-reset'
import { exportCliLogins, importCliLogins } from '../core/cli-login-move'
import {
  configureLoginSync,
  disconnectLoginSync,
  joinLoginSync,
  loginSyncPairingCode,
  loginSyncStatus,
  noteLoggedOutHere,
  runLoginSync,
  setChatSharing,
  setLoginSyncEnabled,
  setLoginSyncExcluded,
  setQueueSharing,
} from '../core/cli-login-sync'
import { logoutCliInstance } from '../core/cli-logout'
import { redeemCodexResetCredit, resolveCodexAccount } from '../core/codex-account'
import { moveCodexChat, planCodexChatMove } from '../core/codex-chat-move'
import {
  createCodexInstance,
  deleteCodexInstance,
  findCodexInstance,
  focusCodexDesktopInstance,
  launchCodexInstance,
  listCodexInstances,
  openCodexDesktopInstance,
  quitCodexDesktopInstance,
  renameCodexInstance,
} from '../core/codex-instances'
import { logoutCodexInstance } from '../core/codex-logout'
import { feedCliFromDesktop } from '../core/desktop-cli-feed'
import { allInstanceNumbers, parseInstanceRef } from '../core/instance-numbers'
import { resolveInstance, resolveInstanceError } from '../core/instance-ref'
import { listInstances } from '../core/instances'
import {
  CLAUDE_LAUNCH_EFFORTS,
  CODEX_LAUNCH_EFFORTS,
  launchOptionError,
} from '../core/launch-options'
import { readLoginUuid } from '../core/login-state'
import { db } from '../db'
import { turnOffExtraUsage } from '../extra-usage'
import { deepseekBalance } from '../hswarm-cost'
import { app } from '../http-app'
import { instanceDirParam } from '../instance-dir-param'
import { accountTokenWindows } from '../kit/account-windows'
import type { QuotaReset } from '../kit/query'
import { readLiveRegistry } from '../live-registry'
import { jsonBody } from '../route-helpers'
import { fileNudgeStore } from '../session-keepalive'
import type { AccountTokens, UsageCheckResult, UsageSnapshot } from '../types'
import {
  allCachedUsage,
  checkUsage,
  getCachedUsage,
  isNoData,
  parseUsageOutput,
  setCachedUsage,
  usageAdvice,
} from '../usage'
import { budgetSummary, buildUsageBudget } from '../usage-budget'
import {
  clearUsageFromTables,
  dropCachedUsage,
  keepLastKnownIfMissing,
  lastKnownUsage,
  shownUsage,
  shownUsageMap,
  usageClearedAt,
} from '../usage-cache'
import { lastSampleSnapshot, usageHistoryKeys } from '../usage-history'
import { withLimitWall, withLiveReading } from '../usage-live'
import { lastAutoRefreshAt, sweepUsage } from '../usage-refresh'
import {
  checkUsageForAccount,
  checkUsageForCliInstance,
  checkUsageForCodex,
  checkUsageForDesktop,
  cliKey,
  codexKey,
  desktopKey,
  surveyUsage,
} from '../usage-service'
import { hswarmAccountId } from './hswarm'

/** Resolve an `account` query param that may be an account id OR a free-text label. */
function resolveAccountParam(param: string): { id: string; label: string } | null {
  const byId = db
    .query<{ id: string; label: string }, [string]>('select id, label from accounts where id = ?')
    .get(param)
  if (byId) return byId
  return (
    db
      .query<{ id: string; label: string }, [string]>(
        'select id, label from accounts where label = ?',
      )
      .get(param) ?? null
  )
}

function historyMtimeMs(configDir: string): number {
  try {
    return statSync(join(configDir, 'history.jsonl')).mtimeMs
  } catch {
    return 0
  }
}

const wantsRefresh = (c: Context): boolean => {
  const v = c.req.query('refresh')
  return v === '1' || v === 'true'
}

/** The usage-check subsystem (Feature B), plus CLI instances (Feature A) and Codex CLI instances.
 *  See index.ts for the app-wide middleware these routes run behind. */
// --- usage-check subsystem (Feature B) --------------------------------------
// Read an account's remaining Claude quota by spawning `claude -p "/usage"` (usage.ts), auth
// injected the SAME way dispatch does (usage-service.ts). Each result is cached per key so the UI
// never stampedes real `claude` processes; `?refresh=1` forces a fresh probe. A no-data snapshot
// (all-null) is returned honestly — never faked as "0% used".

app.get('/api/usage', async (c) => {
  const account = c.req.query('account')
  const configDir = c.req.query('configDir')
  const instance = c.req.query('instance')
  const refresh = wantsRefresh(c)

  // `instance` is the number-first path: one param that takes `7`, `#7`, a dir, an id or a name and
  // routes to whichever family's credential chain applies. It comes FIRST because it is the only
  // one of the three that is unambiguous — `account` and `configDir` each address one store.
  if (instance) {
    const hit = await resolveInstance(instance)
    if (!hit) return c.json({ error: await resolveInstanceError(instance) }, 404)
    const result: UsageCheckResult =
      hit.kind === 'desktop'
        ? await checkUsageForDesktop(hit.handle)
        : hit.kind === 'cli'
          ? ((await checkUsageForCliInstance(hit.handle)) ?? {
              snapshot: parseUsageOutput('', hit.name),
              cached: false,
              key: hit.ref,
              reason: 'check_failed',
            })
          : await checkUsageForCodex(hit.configDir, hit.handle, refresh)
    // Echo WHICH instance answered. Without it a caller that passed a name has no confirmation it
    // reached the account it meant — and that is the whole failure mode numbers exist to prevent.
    return c.json({
      ...result,
      advice: result.advice ?? usageAdvice(result.snapshot),
      instance: {
        num: hit.num,
        kind: hit.kind,
        name: hit.name,
        email: hit.email,
        plan: hit.plan,
      },
    })
  }

  if (account) {
    const resolved = resolveAccountParam(account)
    if (!resolved) return c.json({ error: `unknown account '${account}'` }, 404)
    const key = `acct:${resolved.id}`
    if (!refresh) {
      const cached = getCachedUsage(key)
      if (cached)
        return c.json({
          snapshot: cached,
          cached: true,
          key,
          reason: 'ok',
        } satisfies UsageCheckResult)
    }
    const snapshot = await checkUsageForAccount(resolved.id)
    return c.json({
      snapshot,
      cached: false,
      key,
      reason: isNoData(snapshot) ? 'check_failed' : 'ok',
      advice: usageAdvice(snapshot),
    } satisfies UsageCheckResult)
  }
  if (configDir) {
    const key = `dir:${configDir}`
    if (!refresh) {
      const cached = getCachedUsage(key)
      if (cached)
        return c.json({
          snapshot: cached,
          cached: true,
          key,
          reason: 'ok',
          advice: usageAdvice(cached),
        } satisfies UsageCheckResult)
    }
    const snapshot = await checkUsage({ configDir, account: configDir })
    // Only cache a real reading — a no-data result is the absence of a number, not a number.
    if (!isNoData(snapshot)) setCachedUsage(key, snapshot)
    return c.json({
      snapshot,
      cached: false,
      key,
      reason: isNoData(snapshot) ? 'check_failed' : 'ok',
      advice: usageAdvice(snapshot),
    } satisfies UsageCheckResult)
  }
  return c.json({ error: 'pass account (id or label) or configDir' }, 400)
})

// Whole usage cache (bulk-hydrate the Instances table on load without checking anything).
// CliMayte's live readings are laid over the CLI accounts' cached snapshots: the cache is up to 30
// minutes old, a running worker's reading is seconds old (usage-live.ts).
app.get('/api/usage/cache', (c) => {
  const cache = { ...allCachedUsage() }
  for (const [id, live] of climayteLiveReadings()) {
    const fresh = withLiveReading(cache[cliKey(id)] ?? null, live)
    if (fresh) cache[cliKey(id)] = fresh
  }
  // An account CliMayte saw hit its limit reads as at its limit until the wall ends, never as the
  // lower percentage of a snapshot taken before (field note 19).
  for (const [id, wall] of climayteLimitWalls()) {
    const walled = withLimitWall(cache[cliKey(id)] ?? null, wall)
    if (walled) cache[cliKey(id)] = walled
  }
  // A row whose usage was cleared shows only what was read after (the tables; nothing is deleted).
  const cleared = usageClearedAt()
  return c.json({
    cache: shownUsageMap(cache, cleared),
    lastKnown: shownUsageMap(lastKnownWithHistory(), cleared),
    lastAutoRefreshAt: lastAutoRefreshAt(),
  })
})

// Clear rows' usage from the tables: a dash until each row's next reading, with every number kept
// (usage-cache.ts clearUsageFromTables). Keys as the tables use them: desktop:<dir>, cli:<id>,
// codex:<id>, acct:<id>.
const USAGE_KEY = /^(desktop|cli|codex|acct):./
app.post('/api/usage/clear', async (c) => {
  const body = await jsonBody(c)
  const keys = Array.isArray(body.keys) ? body.keys : []
  if (
    keys.length === 0 ||
    !keys.every((k): k is string => typeof k === 'string' && USAGE_KEY.test(k))
  )
    return c.json(
      { error: 'keys: a list of usage keys (desktop:<dir>, cli:<id>, codex:<id>, acct:<id>)' },
      400,
    )
  return c.json({ ok: true, clearedAt: clearUsageFromTables(keys) })
})

/** Accounts that signed out before readings were kept had theirs deleted; the usage history still
 *  holds their last one. Claude desktop and CLI keys only (a Codex key's cache is also dropped when
 *  its login changes account), once per daemon. */
let historyBackfilled = false
function lastKnownWithHistory(): Record<string, UsageSnapshot> {
  if (!historyBackfilled) {
    historyBackfilled = true
    for (const key of usageHistoryKeys()) {
      if (!key.startsWith('desktop:') && !key.startsWith('cli:')) continue
      const snap = lastSampleSnapshot(key)
      if (snap) keepLastKnownIfMissing(key, snap)
    }
  }
  return lastKnownUsage()
}

// Every instance's usage in ONE call: the whole-fleet survey. This is the endpoint an AI agent wants
// ("which of my accounts has headroom?") and what the auto-refresh sweep exposes on demand. Each row
// carries the advisory verdict too, so a caller never has to re-derive "is 98% bad".
app.get('/api/usage/survey', async (c) => {
  // Concurrent, not sequential: the DeepSeek balance is a THIRD PARTY call with its own timeout
  // (hswarm-cost.ts bounds it to 3s and never throws), and awaiting it after the Claude/Codex sweep
  // would make a slow DeepSeek endpoint add straight to every survey's latency instead of hiding
  // behind the same round trip.
  const [rows, deepseek] = await Promise.all([surveyUsage(), deepseekBalance()])
  return c.json({
    rows: rows.map((r) => ({ ...r, advice: usageAdvice(r.result.snapshot) })),
    // The balance of the DeepSeek account HSwarm spends from, beside the Claude/Codex quotas above -
    // see hswarm-cost.ts's deepseekBalance for why this can never fail the survey itself.
    deepseek,
    lastAutoRefreshAt: lastAutoRefreshAt(),
  })
})

// Force one background sweep now (the same pass the auto-refresh timer runs).
app.post('/api/usage/refresh', async (c) => c.json({ ok: true, checked: await sweepUsage() }))

// MUTATES THE ACCOUNT: switch claude.ai paid extra usage off for one instance's account, so it stops
// at its limits instead of billing. `instance_ref` is 'desktop:<dir>' or 'cli:<id>'. A person's
// click, never a background job (extra-usage.ts).
app.post('/api/usage/extra-usage/off', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { instance_ref?: unknown }
  const ref = typeof body.instance_ref === 'string' ? body.instance_ref.trim() : ''
  if (!ref.startsWith('desktop:') && !ref.startsWith('cli:'))
    return c.json({ ok: false, error: "instance_ref must be 'desktop:<dir>' or 'cli:<id>'" }, 400)
  const result = await turnOffExtraUsage(ref)
  return result.ok ? c.json(result) : c.json({ ...result, error: result.detail }, 502)
})

// The BUDGET: the percentage turned into quantities an agent can actually plan with — a burn rate, a
// deadline, and an estimated token headroom derived from real transcript spend. See usage-budget.ts.
// `configDir` (repeatable) names which Claude config dirs' transcripts count toward this account's
// spend; it defaults to the plain ~/.claude login.
app.get('/api/usage/budget', async (c) => {
  const dir = c.req.query('dir')
  const account = c.req.query('account')
  const instance = c.req.query('instance')
  const configDirs = c.req.queries('configDir')

  // `instance` (a number, dir, id or name) is the one form that reaches ALL THREE families — the
  // older `dir` only ever addressed a desktop instance, so a CLI or Codex login had no way to ask
  // for a budget at all.
  const hit = instance ? await resolveInstance(instance) : null
  if (instance && !hit) return c.json({ error: await resolveInstanceError(instance) }, 404)

  const result = hit
    ? hit.kind === 'desktop'
      ? await checkUsageForDesktop(hit.handle)
      : hit.kind === 'cli'
        ? await checkUsageForCliInstance(hit.handle)
        : await checkUsageForCodex(hit.configDir, hit.handle, true)
    : dir
      ? await checkUsageForDesktop(dir)
      : account
        ? await (async () => {
            const resolved = resolveAccountParam(account)
            if (!resolved) return null
            const snapshot = await checkUsageForAccount(resolved.id)
            return { snapshot, cached: false, key: `acct:${resolved.id}`, reason: 'ok' as const }
          })()
        : // A bare credential dir — the plain `~/.claude` login, or any CLAUDE_CONFIG_DIR that has
          // been /login'd. Without this branch the ONE account that belongs to no instance and no
          // dispatch row (the everyday default login) could get a percentage from /api/usage but
          // never a burn rate, which is the number that actually decides whether to keep going.
          configDirs?.length
          ? await (async () => {
              const cd = configDirs[0] as string
              const snapshot = await checkUsage({ configDir: cd, account: cd })
              return {
                snapshot,
                cached: false,
                key: `dir:${cd}`,
                reason: isNoData(snapshot) ? ('check_failed' as const) : ('ok' as const),
              }
            })()
          : null
  if (!result)
    return c.json(
      {
        error:
          'pass instance (its number), dir (a desktop instance), account (id or label) or configDir (a logged-in Claude config dir)',
      },
      400,
    )

  // A CLI instance's transcripts live under its OWN config dir, so that is the right default for
  // "how many tokens did this account spend" — the ~/.claude fallback would measure a different
  // login entirely and quietly report someone else's burn.
  const spendDirs = configDirs?.length
    ? configDirs
    : hit?.kind === 'cli'
      ? [hit.configDir]
      : undefined

  const budget = buildUsageBudget(result.snapshot, result.key, { configDirs: spendDirs })
  return c.json({
    snapshot: result.snapshot,
    reason: result.reason,
    advice: usageAdvice(result.snapshot),
    budget,
    summary: budgetSummary(budget, result.snapshot.weekAll?.pct ?? null),
    ...(hit
      ? {
          instance: {
            num: hit.num,
            kind: hit.kind,
            name: hit.name,
            email: hit.email,
            plan: hit.plan,
          },
        }
      : {}),
  })
})

// Desktop instance usage. The credential chain (own safeStorage token → LINKED CLI instance's login
// → dispatch account matching the email) lives in usage-service.ts so the routes, the MCP tools, and
// the auto-refresh sweep all resolve it identically.
app.get('/api/instances/:dir/usage', async (c) => {
  const dir = await instanceDirParam(c)
  if (dir instanceof Response) return dir
  if (!wantsRefresh(c)) {
    const key = `desktop:${dir}`
    const cached = getCachedUsage(key)
    if (cached)
      return c.json({
        snapshot: cached,
        cached: true,
        key,
        reason: 'ok',
      } satisfies UsageCheckResult)
  }
  return c.json(await checkUsageForDesktop(dir))
})

/** Token windows by account uuid for a set of rows, from the kit: each account's window is cut at
 *  the reset its row shows (a null uuid is a signed-out row and gets nothing). */
function kitTokensFor(
  rows: { uuid: string | null; snapshot: UsageSnapshot | null | undefined }[],
): Map<string, AccountTokens> {
  const resets = new Map<string, QuotaReset>()
  const idOf = new Map<string, string>()
  for (const r of rows) {
    if (!r.uuid) continue
    const uuid = r.uuid.toLowerCase()
    const id = hswarmAccountId(uuid)
    idOf.set(uuid, id)
    const q = {
      sessionResetsAt: r.snapshot?.session?.resetsAt ?? null,
      weekResetsAt: r.snapshot?.weekAll?.resetsAt ?? null,
    }
    if (!resets.has(id) || q.sessionResetsAt || q.weekResetsAt) resets.set(id, q)
  }
  const byId = accountTokenWindows([...idOf.values()], { quota: (id) => resets.get(id) ?? null })
  const out = new Map<string, AccountTokens>()
  for (const [uuid, id] of idOf) {
    const t = byId.get(id)
    if (t) out.set(uuid, t)
  }
  return out
}

// --- CLI instances (Feature A) ----------------------------------------------
// Reconcile associations against the live account table before listing: this is where a record that
// went dangling before the delete route learned to clean up (or via a hand-edited db) heals itself,
// rather than showing a badge for an account that isn't there. One id-only read of a tiny table,
// and the prune writes nothing when nothing dangles — so the UI's polling stays free.
app.get('/api/cli-instances', (c) => {
  pruneCliInstanceAccountAssociations(
    db
      .query<{ id: string }, []>('select id from accounts')
      .all()
      .map((r) => r.id),
  )
  // How many Claude sessions run on each account right now (the CLI's own live registry, CliMayte's
  // workers included): the CLI table's per-account count (owner, 2026-09-30).
  const live = climayteLiveReadings()
  const limits = climayteLimitWalls()
  // The keepalive's last nudge per account (session-keepalive.ts), for the row's note.
  const nudges = fileNudgeStore.read()
  const cleared = usageClearedAt()
  const rows = listCliInstances().map((i) => ({
    i,
    uuid: cliAccountUuid(i.configDir, i.loggedIn),
    lastUsageCheck: shownUsage(
      cliKey(i.id),
      withLimitWall(
        withLiveReading(i.lastUsageCheck, live.get(i.id), i.name),
        limits.get(i.id),
        i.name,
      ),
      cleared,
    ),
  }))
  // One grouped read per window for every row (kit/account-windows.ts), cut at each account's own
  // quota reset as the row shows it.
  const windows = kitTokensFor(rows.map((r) => ({ uuid: r.uuid, snapshot: r.lastUsageCheck })))
  return c.json(
    rows.map(({ i, uuid, lastUsageCheck }) => ({
      ...i,
      lastNudge: nudges[i.id] ?? null,
      liveSessions: readLiveRegistry(i.configDir).length,
      // The last prompt typed on this login (the CLI appends to history.jsonl) or the last
      // keepalive nudge, whichever is newer: one stat, no transcript walk.
      lastActiveAt: Math.max(historyMtimeMs(i.configDir), nudges[i.id]?.at ?? 0) || null,
      // The account signed in here now, not this folder: a re-login shows the new account's.
      tokens: uuid ? (windows.get(uuid) ?? null) : null,
      lastUsageCheck,
    })),
  )
})
// What the account signed in to each desktop instance has run (kit/account-windows.ts), by instance
// dir, for the desktop table's Tokens column. A signed-out profile is null.
app.get('/api/desktop-instance-tokens', (c) => {
  const dirs: { dir: string; uuid: string | null; snapshot: UsageSnapshot | null | undefined }[] =
    []
  for (const ref of Object.keys(allInstanceNumbers())) {
    const parsed = parseInstanceRef(ref)
    if (parsed?.kind !== 'desktop') continue
    dirs.push({
      dir: parsed.id,
      uuid: readLoginUuid(parsed.id),
      snapshot: getCachedUsage(desktopKey(parsed.id)),
    })
  }
  const windows = kitTokensFor(dirs)
  const out: Record<string, AccountTokens | null> = {}
  for (const d of dirs) out[d.dir] = d.uuid ? (windows.get(d.uuid) ?? null) : null
  return c.json(out)
})
app.post('/api/cli-instances', async (c) => {
  const body = await jsonBody(c)
  if (typeof body.name !== 'string' || !body.name.trim())
    return c.json({ error: 'name is required' }, 400)
  return c.json(createCliInstance(body.name))
})
app.post('/api/cli-instances/:id/launch', async (c) => {
  const body = await jsonBody(c)
  const optionError = launchOptionError(body, CLAUDE_LAUNCH_EFFORTS)
  if (optionError) return c.json({ error: optionError }, 400)
  return c.json(
    launchCliInstance(c.req.param('id'), {
      model: typeof body.model === 'string' ? body.model : undefined,
      effort: typeof body.effort === 'string' ? body.effort : undefined,
    }),
  )
})
app.post('/api/cli-instances/:id/login', (c) =>
  c.json(launchCliInstance(c.req.param('id'), { login: true })),
)
// Sign a CLI instance out (removes .credentials.json) - see core/cli-logout.ts for why it refuses
// while a session runs on it. On success the cached quota is dropped: it belongs to the old login.
app.post('/api/cli-instances/:id/logout', (c) => {
  const id = c.req.param('id')
  const result = logoutCliInstance(id)
  if (result.ok) {
    dropCachedUsage(cliKey(id), { keepLastKnown: true })
    // Signed out here on purpose: login sync signs the other PCs out of it too.
    noteLoggedOutHere(id)
  }
  return c.json(result)
})
// Move CLI logins to another PC (core/cli-login-move.ts): out = one encrypted bundle in Downloads and
// this PC signed out of each; in = the bundle's logins signed in here, each checked with `claude auth
// status`. The passphrase comes from the dialog and is never sent back; the answers carry paths and
// statuses only. No MCP tool on purpose: a chat would have to hold the passphrase.
app.post('/api/cli-instances/move-out', async (c) => {
  const body = await jsonBody(c)
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((x): x is string => typeof x === 'string')
    : []
  const signOut = body.signOut === true
  const result = exportCliLogins({
    ids,
    passphrase: typeof body.passphrase === 'string' ? body.passphrase : '',
    signOut,
  })
  // A move signs this PC out: the cached quota belongs to a login this PC no longer holds (as for a
  // logout), and login sync leaves it out here so the store does not sign it back in.
  if (result.file && signOut)
    for (const r of result.rows)
      if (r.ok) {
        dropCachedUsage(cliKey(r.id), { keepLastKnown: true })
        setLoginSyncExcluded(r.id, true)
      }
  return c.json(result)
})

// Login sync through the owner's own store (core/cli-login-sync.ts, cloud/login-sync-worker).
// Answers carry statuses only; the pairing route is the one that returns a secret, for the Login
// sync dialog's copy button. No MCP tool on purpose, as for the move.
app.get('/api/cli-instances/sync', (c) => c.json(loginSyncStatus()))
app.post('/api/cli-instances/sync/setup', async (c) => {
  const body = await jsonBody(c)
  return c.json(
    await configureLoginSync({
      url: typeof body.url === 'string' ? body.url : '',
      token: typeof body.token === 'string' ? body.token : '',
    }),
  )
})
app.post('/api/cli-instances/sync/join', async (c) => {
  const body = await jsonBody(c)
  return c.json(await joinLoginSync(typeof body.code === 'string' ? body.code : ''))
})
app.post('/api/cli-instances/sync/run', async (c) => {
  const result = await runLoginSync()
  return c.json({ result, status: loginSyncStatus() })
})
app.post('/api/cli-instances/sync/enabled', async (c) => {
  const body = await jsonBody(c)
  return c.json(setLoginSyncEnabled(body.enabled === true))
})
app.post('/api/cli-instances/sync/queue', async (c) => {
  const body = await jsonBody(c)
  setQueueSharing(body.enabled === true)
  return c.json(loginSyncStatus())
})
app.post('/api/cli-instances/sync/chats', async (c) => {
  const body = await jsonBody(c)
  setChatSharing(body.enabled === true)
  return c.json(loginSyncStatus())
})
app.post('/api/cli-instances/sync/exclude', async (c) => {
  const body = await jsonBody(c)
  if (typeof body.id !== 'string') return c.json({ error: 'id is required' }, 400)
  setLoginSyncExcluded(body.id, body.excluded === true)
  return c.json(loginSyncStatus())
})
app.post('/api/cli-instances/sync/pairing', (c) => {
  const code = loginSyncPairingCode()
  return code ? c.json({ code }) : c.json({ error: 'login sync is not set up' }, 404)
})
app.post('/api/cli-instances/sync/disconnect', (c) => c.json(disconnectLoginSync()))
app.post('/api/cli-instances/move-in', async (c) => {
  const body = await jsonBody(c)
  const result = await importCliLogins({
    bundle: body.bundle,
    passphrase: typeof body.passphrase === 'string' ? body.passphrase : '',
  })
  // Read each landed login's quota now (free), so its row fills in without a click.
  for (const r of result.rows)
    if (r.ok)
      void checkUsageForCliInstance(r.id).catch((err) =>
        console.error(`[cli-login-move] usage check for ${r.id} failed:`, err),
      )
  return c.json(result)
})
// Use this account's limit reset through the CLI's own `/limit-reset` (core/cli-limit-reset.ts):
// a person's click, an MCP call, or the daily check (core/cli-reset-sweep.ts). One run per account
// at a time is enforced there; the CLI's answer is kept on the record for the row's icon.
app.post('/api/cli-instances/:id/limit-reset', async (c) => {
  const inst = getCliInstance(c.req.param('id'))
  if (!inst) return c.json({ error: 'CLI instance not found' }, 404)
  // `check: true` backs out of a banked reset's question instead of using it. That is safe below
  // the 5-hour limit; at it the weekly session reset asks nothing, so a check could use that one.
  const body = await jsonBody(c)
  const result = await runCliLimitReset(inst.configDir, { confirm: body.check !== true })
  // A failure to reach the CLI says nothing about the reset; keep the last real answer then.
  if (result.outcome !== 'error') setCliInstanceLimitReset(inst.id, result)
  return c.json(result)
})
app.post('/api/cli-instances/:id/rename', async (c) => {
  const body = await jsonBody(c)
  if (typeof body.name !== 'string') return c.json({ error: 'name is required' }, 400)
  return c.json(renameCliInstance(c.req.param('id'), body.name))
})
app.post('/api/cli-instances/:id/associate', async (c) => {
  const body = await jsonBody(c)
  const accountId = typeof body.accountId === 'string' && body.accountId ? body.accountId : null
  const accountLabel =
    typeof body.accountLabel === 'string'
      ? body.accountLabel
      : accountId
        ? (resolveAccountParam(accountId)?.label ?? null)
        : null
  return c.json(associateCliInstance(c.req.param('id'), accountId, accountLabel))
})
app.delete('/api/cli-instances/:id', async (c) => {
  const body = await jsonBody(c)
  const confirmName = typeof body.confirmName === 'string' ? body.confirmName : undefined
  return c.json(deleteCliInstance(c.req.param('id'), confirmName))
})
// Link this CLI instance to a DESKTOP instance (or clear it with desktopDir: null). Same account,
// two logins — the link is what lets the UI group them and lets each back the other up for usage.
app.post('/api/cli-instances/:id/link-desktop', async (c) => {
  const body = await jsonBody(c)
  const desktopDir = typeof body.desktopDir === 'string' && body.desktopDir ? body.desktopDir : null
  let desktopLabel = typeof body.desktopLabel === 'string' ? body.desktopLabel : null
  if (desktopDir && !desktopLabel) {
    const inst = (await listInstances()).find((i) => i.dir === desktopDir)
    if (!inst) return c.json({ error: `unknown desktop instance '${desktopDir}'` }, 404)
    desktopLabel = inst.label ?? inst.name
  }
  const result = linkCliInstanceToDesktop(c.req.param('id'), desktopDir, desktopLabel)
  // Linked to a signed-in desktop instance with no login of its own: it takes the desktop's now
  // (core/desktop-cli-feed.ts), so the caller need not open a sign-in.
  const cli = result.ok && desktopDir ? getCliInstance(c.req.param('id')) : null
  const feed = cli ? await feedCliFromDesktop(cli).catch(() => null) : null
  return c.json(
    feed
      ? {
          ...result,
          data: {
            ...result.data,
            signedInFromDesktop: feed === 'fed' || feed === 'current',
            // The desktop login holds no Claude Code grant to share (its Code tab was never used,
            // or not in the last weeks): the caller signs the CLI in the usual way and says why.
            desktopHasNoCodeLogin: feed === 'no-desktop-login',
          },
        }
      : result,
  )
})

app.get('/api/cli-instances/:id/usage', async (c) => {
  const id = c.req.param('id')
  const inst = getCliInstance(id)
  if (!inst) return c.json({ error: 'CLI instance not found' }, 404)
  if (!wantsRefresh(c) && inst.lastUsageCheck)
    return c.json({
      snapshot: inst.lastUsageCheck,
      cached: true,
      key: `cli:${id}`,
      reason: 'ok',
    } satisfies UsageCheckResult)
  // The credential chain (own login → associated account → LINKED desktop token) lives in
  // usage-service.ts; mirror the snapshot onto the record so the list view renders it without a check.
  const result = await checkUsageForCliInstance(id)
  if (!result) return c.json({ error: 'CLI instance not found' }, 404)
  setCliInstanceUsage(id, result.snapshot)
  return c.json(result)
})

// --- Codex CLI instances ----------------------------------------------------
app.get('/api/codex-instances', async (c) => c.json(await listCodexInstances()))
app.get('/api/codex-instances/:id/move-chats', async (c) => {
  const targetId = c.req.query('targetId')
  if (!targetId) return c.json({ error: 'targetId is required' }, 400)
  try {
    return c.json(await planCodexChatMove(c.req.param('id'), targetId))
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Could not list Codex chats.' },
      400,
    )
  }
})
app.post('/api/codex-instances/:id/move-chat', async (c) => {
  const body = await jsonBody(c)
  if (
    typeof body.targetId !== 'string' ||
    typeof body.threadId !== 'string' ||
    typeof body.updatedAt !== 'number' ||
    !Number.isFinite(body.updatedAt) ||
    !(typeof body.sourceAccountId === 'string' || body.sourceAccountId === null) ||
    !(typeof body.targetAccountId === 'string' || body.targetAccountId === null)
  ) {
    return c.json({ error: 'A reviewed source chat and destination account are required.' }, 400)
  }
  return c.json(
    await moveCodexChat(c.req.param('id'), {
      targetId: body.targetId,
      threadId: body.threadId,
      updatedAt: body.updatedAt,
      sourceAccountId: body.sourceAccountId,
      targetAccountId: body.targetAccountId,
    }),
  )
})
// Identity, on demand. The LIST already carries a local identity for every row (auth.json is plain
// JSON, so that read is nearly free), so this route exists for the LIVE refresh: it re-reads the
// plan from the server-computed value rather than the token's mint-time claim.
app.get('/api/codex-instances/:id/account', async (c) => {
  const inst = await findCodexInstance(c.req.param('id'))
  if (!inst) return c.json({ error: 'Codex instance not found' }, 404)
  const noNetwork = c.req.query('noNetwork')
  const { account } = await resolveCodexAccount(inst.codexHome, {
    noNetwork: noNetwork === '1' || noNetwork === 'true',
  })
  return c.json(account)
})
// Quota. One call answers identity AND usage on the OpenAI side, so unlike the Claude routes there
// is no second probe to run — the snapshot is a by-product of resolving the account.
app.get('/api/codex-instances/:id/usage', async (c) => {
  const id = c.req.param('id')
  const inst = await findCodexInstance(id)
  if (!inst) return c.json({ error: 'Codex instance not found' }, 404)
  return c.json(await checkUsageForCodex(inst.codexHome, id, wantsRefresh(c)))
})
app.post('/api/codex-instances', async (c) => {
  const body = await jsonBody(c)
  if (typeof body.name !== 'string' || !body.name.trim())
    return c.json({ error: 'name is required' }, 400)
  return c.json(createCodexInstance(body.name))
})
app.post('/api/codex-instances/:id/launch', async (c) => {
  const body = await jsonBody(c)
  const optionError = launchOptionError(body, CODEX_LAUNCH_EFFORTS)
  if (optionError) return c.json({ error: optionError }, 400)
  return c.json(
    launchCodexInstance(c.req.param('id'), {
      model: typeof body.model === 'string' ? body.model : undefined,
      effort: typeof body.effort === 'string' ? body.effort : undefined,
    }),
  )
})
app.post('/api/codex-instances/:id/login', (c) =>
  c.json(launchCodexInstance(c.req.param('id'), { login: true })),
)
// Sign a stored Codex instance out (removes auth.json) — see core/codex-logout.ts for why it
// refuses while the desktop runs. On success the cached quota is dropped: it belongs to the old login.
app.post('/api/codex-instances/:id/logout', async (c) => {
  const id = c.req.param('id')
  const result = await logoutCodexInstance(id)
  if (result.ok) dropCachedUsage(codexKey(id), { keepLastKnown: true })
  return c.json(result)
})
app.post('/api/codex-instances/:id/desktop/open', async (c) =>
  c.json(await openCodexDesktopInstance(c.req.param('id'))),
)
app.post('/api/codex-instances/:id/desktop/focus', async (c) =>
  c.json(await focusCodexDesktopInstance(c.req.param('id'))),
)
app.post('/api/codex-instances/:id/desktop/quit', async (c) =>
  c.json(await quitCodexDesktopInstance(c.req.param('id'))),
)
// Redeem one banked `/usage reset` credit — see core/codex-account.ts's redeemCodexResetCredit.
// `{force: true}` in the body bypasses the "busiest window isn't fully used" guard. On a genuine
// reset (result.ok), the cached quota is force-refreshed so the row's chip reflects the reset
// windows immediately rather than waiting for the next poll.
app.post('/api/codex-instances/:id/redeem-reset-credit', async (c) => {
  const id = c.req.param('id')
  const inst = await findCodexInstance(id)
  if (!inst) return c.json({ error: 'Codex instance not found' }, 404)
  const body = await jsonBody(c)
  const result = await redeemCodexResetCredit(inst.codexHome, { force: body.force === true })
  if (result.ok) {
    const usage = await checkUsageForCodex(inst.codexHome, id, true)
    return c.json({ ...result, usage: usage.snapshot })
  }
  return c.json(result)
})
app.post('/api/codex-instances/:id/rename', async (c) => {
  const body = await jsonBody(c)
  if (typeof body.name !== 'string') return c.json({ error: 'name is required' }, 400)
  return c.json(renameCodexInstance(c.req.param('id'), body.name))
})
app.delete('/api/codex-instances/:id', async (c) => {
  const body = await jsonBody(c)
  const confirmName = typeof body.confirmName === 'string' ? body.confirmName : undefined
  return c.json(await deleteCodexInstance(c.req.param('id'), confirmName))
})

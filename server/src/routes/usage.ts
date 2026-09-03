import type { Context } from 'hono'
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
  setCliInstanceUsage,
} from '../core/cli-instances'
import { codexUsageSnapshot, resolveCodexAccount } from '../core/codex-account'
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
import { resolveInstance, resolveInstanceError } from '../core/instance-ref'
import { listInstances } from '../core/instances'
import {
  CLAUDE_LAUNCH_EFFORTS,
  CODEX_LAUNCH_EFFORTS,
  launchOptionError,
} from '../core/launch-options'
import { db } from '../db'
import { app } from '../http-app'
import { jsonBody } from '../route-helpers'
import type { UsageCheckResult } from '../types'
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
import { lastAutoRefreshAt, sweepUsage } from '../usage-refresh'
import {
  checkUsageForAccount,
  checkUsageForCliInstance,
  checkUsageForDesktop,
  codexKey,
  surveyUsage,
} from '../usage-service'

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

/** A Codex instance's quota, cache-aware. Extracted from the route so `/api/usage?instance=N` can
 *  reach the Codex family through the same code the Codex route uses, rather than a second copy of
 *  the "signed out vs read failed" reasoning that would inevitably drift from it. */
async function codexUsageResult(
  codexHome: string,
  id: string,
  refresh: boolean,
): Promise<UsageCheckResult> {
  const key = codexKey(id)
  if (!refresh) {
    const cached = getCachedUsage(key)
    if (cached) return { snapshot: cached, cached: true, key, reason: 'ok' }
  }
  const { account, usage } = await resolveCodexAccount(codexHome)
  if (!usage) {
    // Distinguish "not signed in" from "signed in but the read failed", exactly as the Claude
    // routes do — a bare "—" with no reason reads as a bug.
    const reason: UsageCheckResult['reason'] =
      account.status === 'loggedout' ? 'not_logged_in' : 'check_failed'
    // codexUsageSnapshot(null, …) is the all-null shape — the same "checked, nothing to report"
    // snapshot the Claude paths return, so the chip renders "—" with a reason rather than "0%".
    return { snapshot: codexUsageSnapshot(null, account.label), cached: false, key, reason }
  }
  setCachedUsage(key, usage)
  return { snapshot: usage, cached: false, key, reason: 'ok' }
}

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
          : await codexUsageResult(hit.configDir, hit.handle, refresh)
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
app.get('/api/usage/cache', (c) =>
  c.json({ cache: allCachedUsage(), lastAutoRefreshAt: lastAutoRefreshAt() }),
)

// Every instance's usage in ONE call: the whole-fleet survey. This is the endpoint an AI agent wants
// ("which of my accounts has headroom?") and what the auto-refresh sweep exposes on demand. Each row
// carries the advisory verdict too, so a caller never has to re-derive "is 98% bad".
app.get('/api/usage/survey', async (c) => {
  const rows = await surveyUsage()
  return c.json({
    rows: rows.map((r) => ({ ...r, advice: usageAdvice(r.result.snapshot) })),
    lastAutoRefreshAt: lastAutoRefreshAt(),
  })
})

// Force one background sweep now (the same pass the auto-refresh timer runs).
app.post('/api/usage/refresh', async (c) => c.json({ ok: true, checked: await sweepUsage() }))

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
        : await codexUsageResult(hit.configDir, hit.handle, true)
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
  const dir = decodeURIComponent(c.req.param('dir'))
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
  return c.json(listCliInstances())
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
  return c.json(linkCliInstanceToDesktop(c.req.param('id'), desktopDir, desktopLabel))
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
  return c.json(await codexUsageResult(inst.codexHome, id, wantsRefresh(c)))
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
app.post('/api/codex-instances/:id/desktop/open', async (c) =>
  c.json(await openCodexDesktopInstance(c.req.param('id'))),
)
app.post('/api/codex-instances/:id/desktop/focus', async (c) =>
  c.json(await focusCodexDesktopInstance(c.req.param('id'))),
)
app.post('/api/codex-instances/:id/desktop/quit', async (c) =>
  c.json(await quitCodexDesktopInstance(c.req.param('id'))),
)
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

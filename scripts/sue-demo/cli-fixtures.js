// The CLI tab's invented world, for a simulated visitor (scripts/sue-demo/serve.ts). Loaded after
// scripts/screenshots/page-fixtures.js, which answers every other /api/ call: this file answers
// the CLI tab's (accounts with token figures, Login sync, an empty CliMayte) and remembers what the
// visitor did, so a Join really fills the list and a switch really stays off. No daemon runs and
// nothing here is a real account, login or store.
//
// Two seats, chosen with ?seat= and kept for the browser tab:
//   main       the PC that owns the logins: six CLI accounts, Login sync set up and in sync.
//   second-pc  a PC that has one login of its own and has not joined Login sync. Joining with a
//              pairing code (anything the real check accepts in shape: `ahsync1:` and forty or more
//              characters) brings the other PC's logins in over the next few polls.
;(() => {
  const STORE = 'agenthydra.demo'
  const asked = new URLSearchParams(location.search).get('seat')
  let state = null
  try {
    state = JSON.parse(sessionStorage.getItem(STORE) || 'null')
  } catch {
    state = null
  }
  const seat = asked === 'second-pc' || asked === 'main' ? asked : (state?.seat ?? 'main')
  if (!state || state.seat !== seat)
    state = { seat, configured: seat === 'main', enabled: true, joinedAt: null, excluded: [] }
  const save = () => sessionStorage.setItem(STORE, JSON.stringify(state))
  save()
  // A visitor sent to look at the CLI tab starts on it (lib/app-view.ts reads this key).
  if (!sessionStorage.getItem('agenthydra.app.view'))
    sessionStorage.setItem('agenthydra.app.view', 'cli')

  const HOUR = 3_600_000
  const BOOT = Date.now()
  const iso = (ms) => new Date(ms).toISOString()

  // [number, id, name, plan, tokens in millions, 5-hour %, weekly %]
  const OTHER_PC = [
    [21, 'cli-21', 'maya@northwind.example (Pro)', 'Pro', 84.3, 12, 38],
    [22, 'cli-22', 'theo@northwind.example (Pro)', 'Pro', 212.9, 54, 71],
    [24, 'cli-24', 'ines@northwind.example (Pro)', 'Pro', 41.0, 0, 9],
    [27, 'cli-27', 'omar@northwind.example (Max 5×)', 'Max 5×', 367.5, 77, 46],
    [29, 'cli-29', 'lena@northwind.example (Pro)', 'Pro', 129.6, 31, 83],
    [31, 'cli-31', 'kofi@northwind.example (Pro)', 'Pro', 0, 0, 0],
  ]
  const THIS_PC = [[40, 'cli-40', 'sam@northwind.example (Pro)', 'Pro', 3.1, 5, 2]]
  // The other PC's desktop logins, in the store beside its CLI ones: [number, account id, name].
  const DESKTOPS = [
    [3, 'desk-3', 'studio'],
    [5, 'desk-5', 'client-work'],
    [8, 'desk-8', 'personal'],
  ]

  /** Most of a heavy account's volume is cache reads; the four parts add up to the total. */
  function tokens(millions) {
    const total = Math.round(millions * 1e6)
    const output = Math.round(total * 0.012)
    const input = Math.round(total * 0.003)
    const cacheWrite = Math.round(total * 0.025)
    return { input, output, cacheRead: total - output - input - cacheWrite, cacheWrite, total }
  }
  // Reset times are fixed at page load, so a row's reading does not change on every poll.
  const limit = (pct, inHours) => ({
    pct,
    resets: new Date(BOOT + inHours * HOUR).toLocaleString(),
    resetsAt: iso(BOOT + inHours * HOUR),
    severity: pct >= 90 ? 'critical' : pct >= 70 ? 'warning' : 'normal',
  })
  const snapshot = ([, , name, , , session, week]) => ({
    account: name,
    session: limit(session, 2.5),
    weekAll: limit(week, 96),
    weekModel: null,
    capturedAt: iso(BOOT),
    source: 'api',
  })
  const instance = (who, landedOnly) => ({
    num: who[0],
    id: who[1],
    name: who[2],
    configDir: `C:\\Users\\demo\\.agenthydra\\cli-instances\\${who[1]}`,
    associatedAccountId: null,
    associatedAccountLabel: null,
    associatedDesktopDir: null,
    associatedDesktopLabel: null,
    loggedIn: true,
    // The CLI table reads each row's quota from here (composables/useCliInstances.ts).
    lastUsageCheck: snapshot(who),
    createdAt: BOOT - 9 * 24 * HOUR,
    planLabel: who[3],
    movedAway: null,
    lastNudge: null,
    liveSessions: 0,
    // A login that just arrived from the other PC has run nothing on this one yet.
    tokens: tokens(landedOnly ? 0 : who[4]),
  })

  // Second PC: two logins land at each 4-second pass after the join, CLI ones first.
  const arriving = [...OTHER_PC.map((p) => ['cli', p]), ...DESKTOPS.map((d) => ['desktop', d])]
  const passes = () =>
    state.joinedAt === null ? 0 : Math.floor((Date.now() - state.joinedAt) / 4_000)
  const landedCount = () => Math.min(arriving.length, passes() * 2)

  // Four CliMayte tasks, one per mark a visitor may meet in the task list: on another round after
  // its check said no, failed and accepted anyway, failed and started again on a stronger model,
  // and that redo, done.
  function corchTasks() {
    const at = (minutesAgo) => BOOT - minutesAgo * 60_000
    const on = (name, outcome) => ({
      account: { id: name, num: null, name },
      outcome,
      notice: null,
    })
    const verdict = (minutesAgo, pass, by, note) => ({
      at: at(minutesAgo),
      verdict: pass ? 'pass' : 'fail',
      by,
      note,
      model: null,
      effort: null,
      pct: null,
    })
    const task = (id, title, minutesAgo, over) => ({
      id,
      group: 'demo',
      title,
      cwd: 'D:/Projects/northwind-shop',
      prompt: title,
      pending: [],
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      accounts: null,
      status: 'done',
      sessionId: null,
      accountId: null,
      account: null,
      attempts: [],
      result: null,
      error: null,
      lastActivity: null,
      costUsd: 0.42,
      turns: 14,
      moves: 0,
      retries: 0,
      notBefore: null,
      ranS: 310,
      createdAt: at(minutesAgo),
      updatedAt: at(minutesAgo - 5),
      kind: 'code',
      verdicts: [],
      ...over,
    })
    const checkSaidNo = 'The check `bun run check` failed (exit 1).'
    return [
      task('w-demo-1', 'Docs: links and claims to zero', 20, {
        status: 'running',
        attempts: [on('maya', 'done'), on('maya', 'running')],
        verdicts: [verdict(6, false, 'check', checkSaidNo)],
      }),
      task('w-demo-2', 'Checkout: totals on a phone', 95, {
        status: 'failed',
        judged: true,
        error:
          'The check still failed after 3 rounds; it needs the orchestrator. Last: 1 gating error.',
        attempts: [on('theo', 'done'), on('theo', 'done'), on('theo', 'done')],
        verdicts: [
          verdict(80, false, 'check', checkSaidNo),
          verdict(70, false, 'check', checkSaidNo),
          verdict(60, false, 'check', checkSaidNo),
          verdict(50, true, 'orchestrator', 'The one finding left is in another team’s file.'),
        ],
      }),
      task('w-demo-3', 'Search: the empty results state', 180, {
        status: 'failed',
        error:
          'This session’s transcript was not found on the account it last ran on, so it cannot move without losing its context. Start it again as a new task.',
        attempts: [on('ines', 'handoff'), on('ines', 'quota'), on('lena', 'auth')],
      }),
      task('w-demo-4', 'Search: the empty results state', 150, {
        model: 'claude-opus-5-5',
        effort: 'high',
        attempts: [on('omar', 'done')],
        verdicts: [verdict(140, true, 'check', null)],
        result: 'Done: an empty search now shows three tips and a link to all products.',
      }),
    ]
  }

  function cliInstances() {
    if (seat === 'main') return OTHER_PC.map((p) => instance(p, false))
    const landed = arriving
      .slice(0, state.configured ? landedCount() : 0)
      .filter(([kind]) => kind === 'cli')
      .map(([, p]) => instance(p, true))
    return [...THIS_PC.map((p) => instance(p, false)), ...landed]
  }

  function syncStatus() {
    if (!state.configured)
      return {
        configured: false,
        enabled: false,
        url: null,
        lastSyncAt: null,
        lastError: null,
        logins: [],
        events: [],
      }
    const excluded = new Set(state.excluded)
    const row = (kind, [num, id, name], here, extra) => ({
      id,
      kind,
      num,
      name,
      here,
      inStore: true,
      excluded: excluded.has(id),
      inSync: here,
      problem: null,
      note: null,
      ...extra,
    })
    if (seat === 'main') {
      const logins = [
        ...OTHER_PC.map((p) =>
          // The newest account's CLI login comes from its desktop instance, which is the one that syncs.
          p[1] === 'cli-31'
            ? row('cli', p, true, { inStore: false, inSync: false, note: 'fed' })
            : row('cli', p, true),
        ),
        ...DESKTOPS.map((d) => row('desktop', d, true)),
      ]
      return {
        configured: true,
        enabled: state.enabled,
        url: 'login-sync.northwind.example',
        lastSyncAt: Date.now() - 20_000,
        lastError: null,
        logins,
        events: [
          {
            at: Date.now() - 18 * 60_000,
            num: 27,
            action: 'pushed',
            note: 'Uploaded this PC’s newer login.',
          },
          {
            at: Date.now() - 18 * 60_000 - 2_000,
            num: 22,
            action: 'pushed',
            note: 'Uploaded this PC’s newer login.',
          },
          {
            at: Date.now() - 3 * HOUR,
            num: 8,
            action: 'pushed',
            note: 'Uploaded this PC’s newer desktop login.',
          },
        ],
      }
    }
    const n = landedCount()
    const logins = [
      ...arriving.map(([kind, who], i) => row(kind, who, i < n)),
      // This PC's own login, on its way up to the store at the first pass.
      ...THIS_PC.map((p) => row('cli', p, true, { inStore: passes() >= 1, inSync: passes() >= 1 })),
    ]
    const events = arriving
      .slice(0, n)
      .map(([, who], i) => ({
        at: state.joinedAt + (Math.floor(i / 2) + 1) * 4_000,
        num: who[0],
        action: 'created',
        note: 'Added this login from the store.',
      }))
      .reverse()
    return {
      configured: true,
      enabled: state.enabled,
      url: 'login-sync.northwind.example',
      lastSyncAt: passes() >= 1 ? state.joinedAt + passes() * 4_000 : null,
      lastError: null,
      logins,
      events,
    }
  }

  function join(code) {
    const text = String(code ?? '').trim()
    if (!text.startsWith('ahsync1:')) return { ok: false, message: 'That is not a pairing code.' }
    if (text.length < 40)
      return { ok: false, message: 'That pairing code is cut short or changed.' }
    Object.assign(state, { configured: true, enabled: true, joinedAt: Date.now(), excluded: [] })
    save()
    return { ok: true, message: 'Joined. This PC now syncs its logins with the store.' }
  }

  /** The CorchMayte tab's answers; undefined = not ours. */
  function answerCorch(path, method) {
    if (path === '/api/corch/workers' && method === 'GET') return corchTasks()
    if (path.startsWith('/api/corch/workers/') && method === 'GET') {
      const id = decodeURIComponent(path.split('/')[4] ?? '')
      const hit = corchTasks().find((w) => w.id === id)
      return hit ? { ...hit, events: [] } : null
    }
    if (path === '/api/corch/journal') return []
    if (path === '/api/corch/scorecard') return { unitsPerPercent: 0, rows: [] }
    if (path === '/api/corch/totals')
      return {
        tasks: 0,
        sessions: 0,
        runsByOutcome: {},
        cliSessions: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        costUsd: 0,
        unmeasured: 0,
        since: null,
        limitHits: 0,
        ceilingStops: 0,
        ceilingStopList: [],
        limitHitList: [],
        peaks: [],
      }
    return undefined
  }

  /** The CLI tab's answers. undefined = not ours, the fixtures under this one answer it. */
  function answer(url, method, body) {
    const path = new URL(url, location.origin).pathname
    if (path === '/api/cli-instances/sync') return syncStatus()
    if (path === '/api/cli-instances/sync/join') return join(body.code)
    if (path === '/api/cli-instances/sync/setup') {
      Object.assign(state, { configured: true, enabled: true, joinedAt: Date.now() })
      save()
      return { ok: true, message: 'Login sync is on. Copy the pairing code to your other PC.' }
    }
    if (path === '/api/cli-instances/sync/run')
      return { result: { ok: true, problems: [] }, status: syncStatus() }
    if (path === '/api/cli-instances/sync/enabled') {
      state.enabled = !!body.enabled
      save()
      return {
        ok: true,
        message: state.enabled ? 'Login sync is on.' : 'Login sync is paused on this PC.',
      }
    }
    if (path === '/api/cli-instances/sync/exclude') {
      const set = new Set(state.excluded)
      if (body.excluded) set.add(body.id)
      else set.delete(body.id)
      state.excluded = [...set]
      save()
      return syncStatus()
    }
    if (path === '/api/cli-instances/sync/pairing')
      return { code: 'ahsync1:ZGVtby1wYWlyaW5nLWNvZGUtbm90LWEtcmVhbC1zdG9yZQ' }
    if (path === '/api/cli-instances/sync/disconnect') {
      Object.assign(state, { configured: false, joinedAt: null, excluded: [] })
      save()
      return { ok: true, message: 'This PC no longer syncs logins. The store still holds them.' }
    }
    if (path.startsWith('/api/cli-instances/quick-add'))
      return method === 'GET' ? [] : { error: 'Quick add is off in the demo.' }
    const usage = /^\/api\/cli-instances\/([^/]+)\/usage$/.exec(path)
    if (usage) {
      const who = [...OTHER_PC, ...THIS_PC].find((p) => p[1] === decodeURIComponent(usage[1]))
      return {
        key: `cli:${usage[1]}`,
        snapshot: who ? snapshot(who) : null,
        reason: who ? 'ok' : 'logged_out',
      }
    }
    if (path === '/api/cli-instances' && method === 'GET') return cliInstances()
    // Launch, rename, log out, delete and the rest: answered, and nothing changes.
    if (path.startsWith('/api/cli-instances'))
      return { ok: true, message: 'Done (a demo: nothing real was changed).' }
    return answerCorch(path, method)
  }

  const json = (value) =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  const under = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || ''
    if (!url.includes('/api/')) return under(input, init)
    const method = (init?.method || 'GET').toUpperCase()
    let body = {}
    try {
      body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    } catch {
      body = {}
    }
    const mine = answer(url, method, body)
    if (mine !== undefined) return json(mine)
    const res = await under(input, init)
    const path = new URL(url, location.origin).pathname
    // Two shared answers get this seat's accounts added to them.
    if (path === '/api/usage/cache') {
      const base = await res.json()
      const cache = { ...(base?.cache ?? {}) }
      for (const who of [...OTHER_PC, ...THIS_PC]) cache[`cli:${who[1]}`] = snapshot(who)
      return json({ ...base, cache })
    }
    if (path === '/api/settings' && method === 'GET')
      return json({ ...(await res.json()), keepaliveEnabled: true, keepaliveWeeklyFloorPct: 90 })
    return res
  }
})()

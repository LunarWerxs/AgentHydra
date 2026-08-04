/**
 * Synthetic API, injected into the page before the SPA boots (see capture.mjs).
 *
 * This file is read as TEXT and evaluated in the browser — it is not imported as a module.
 *
 * Every string in here is invented. The README screenshots are public, so no session title,
 * account address, project name or filesystem path from a real machine may appear in them.
 * Stubbing `fetch` rather than pointing a daemon at a synthetic home directory is the stricter
 * option: no daemon runs, so there is nothing live to accidentally read. Anything that slips
 * through the route table is recorded in `window.__fixtureEscapes`, which capture.mjs asserts is
 * empty before it will keep the images.
 */
;(() => {
  const now = Date.now()
  const ago = (m) => now - m * 60000
  const iso = (m) => new Date(now - m * 60000).toISOString()

  const proj = (n) => `C:\\Projects\\${n}`
  const projKey = (n) => `C--Projects-${n}`

  // Where each provider's transcript actually lives, so the raw-file affordances in the UI line
  // up with the badge on the row. OpenCode has no per-session file: CLI and Desktop share one
  // SQLite store, which is why its row points at the database.
  const transcriptPath = (source, p, i) =>
    source === 'codex'
      ? `C:\\Users\\dev\\.codex\\sessions\\2026\\08\\04\\rollout-2026-08-04T09-14-22-s${i}.jsonl`
      : source === 'opencode'
        ? 'C:\\Users\\dev\\.local\\share\\opencode\\opencode.db'
        : `C:\\Users\\dev\\.claude\\projects\\${projKey(p)}\\s${i}.jsonl`

  // A mixed list is the point of the shot: the app reads all three providers, and the badge
  // column is the only thing that says so. The fields the server nulls out for non-Claude rows
  // (instance, queue_status, and git_branch for OpenCode, which parses no repo metadata) are
  // nulled here too — a fixture that fills them would photograph a UI the daemon cannot produce.
  const sessions = [
    ['Refactor checkout validation', 'acme-storefront', 'main', 128, 2, 'work', 'claude'],
    ['Fix flaky upload test', 'atlas-api', 'main', 64, 18, null, 'codex'],
    [
      'Add pagination to search results',
      'acme-storefront',
      'feat/search',
      212,
      63,
      'personal',
      'claude',
    ],
    ['Friendlier parser error messages', 'pico-cli', 'feat/parser', 48, 184, null, 'opencode'],
    ['Audit log retention policy', 'atlas-api', 'main', 91, 300, 'research', 'claude'],
    ['Dark mode token pass', 'acme-storefront', 'main', 156, 480, 'personal', 'claude'],
    ['Rate limiter backoff', 'atlas-api', 'main', 73, 1500, 'work', 'claude'],
    ['Tidy up CLI help output', 'pico-cli', 'main', 39, 2900, 'work', 'claude'],
  ].map(([title, p, branch, count, mins, instance, source], i) => ({
    session_id: `s${i}0000000-0000-4000-8000-00000000000${i}`,
    source,
    title,
    cwd: proj(p),
    project: projKey(p),
    git_branch: source === 'opencode' ? null : branch,
    message_count: count,
    created_at: ago(mins + 240),
    last_activity_at: ago(mins),
    last_role: 'assistant',
    last_text_preview: 'Updated the module and re-ran the suite; everything passes locally.',
    size_bytes: count * 3200,
    transcript_path: transcriptPath(source, p, i),
    queue_status: null,
    instance: source === 'claude' ? instance : null,
    archived: false,
    done: i === 7,
  }))
  /** The queue only ever holds `claude` runs, so its rows may only point at Claude sessions. */
  const claudeSessions = sessions.filter((s) => s.source === 'claude')

  const turns = [
    {
      role: 'user',
      kind: 'text',
      text: 'The checkout form accepts an empty postcode. Can you tighten the validation and add a test?',
      tool_name: null,
      timestamp: iso(9),
    },
    {
      role: 'assistant',
      kind: 'text',
      text: 'Found it: the postcode field is validated with a regex that allows an empty match, so a blank value passes. I tightened the pattern, made the field required at the schema level rather than only in the UI, and added a case covering the empty and whitespace-only inputs.',
      tool_name: null,
      timestamp: iso(8),
    },
    {
      role: 'user',
      kind: 'text',
      text: 'Does that break the international addresses we allow?',
      tool_name: null,
      timestamp: iso(5),
    },
    {
      role: 'assistant',
      kind: 'text',
      text: 'No. The rule only rejects empty or whitespace-only values; the format check stays permissive for non-UK addresses, which is what the existing international tests assert. Full suite is green: 214 passed.',
      tool_name: null,
      timestamp: iso(4),
    },
  ]

  const instDir = (n) => `C:\\Users\\dev\\.claude-instances\\${n}`
  const account = (name, email, tier) => ({
    status: 'live',
    email,
    name,
    plan: tier.startsWith('Max') ? 'max' : 'pro',
    rateLimitTier: tier,
    planLabel: tier,
    accountUuid: null,
    orgUuid: null,
    orgName: null,
    source: 'live',
    label: `${name} <${email}> · ${tier}`,
  })
  const loggedOut = {
    status: 'loggedout',
    email: null,
    name: null,
    plan: null,
    rateLimitTier: null,
    planLabel: null,
    accountUuid: null,
    orgUuid: null,
    orgName: null,
    source: 'loggedout',
    label: '(not logged in)',
  }

  const instances = [
    {
      name: 'work',
      isRunning: true,
      pid: 8412,
      up: 214,
      mem: 2_684_354_560,
      account: account('Alex Rivera', 'alex@example.com', 'Max 20×'),
      icon: 'rocket',
      color: 'blue',
    },
    {
      name: 'personal',
      isRunning: true,
      pid: 6120,
      up: 51,
      mem: 1_476_395_008,
      account: account('Sam Chen', 'sam@example.com', 'Pro'),
      icon: 'heart',
      color: 'violet',
    },
    {
      name: 'research',
      isRunning: false,
      pid: null,
      up: null,
      mem: null,
      account: account('Dana Woods', 'dana@example.com', 'Max'),
      icon: 'flask',
      color: 'teal',
    },
    {
      name: 'ci-runner',
      isRunning: false,
      pid: null,
      up: null,
      mem: null,
      account: loggedOut,
      icon: 'bot',
      color: 'slate',
    },
  ].map((i) => ({
    name: i.name,
    dir: instDir(i.name),
    isRunning: i.isRunning,
    pid: i.pid,
    startTime: i.up == null ? null : iso(i.up),
    sizeBytes: null,
    memoryBytes: i.mem,
    account: i.account,
    isExternal: false,
    label: null,
    icon: i.icon,
    color: i.color,
  }))

  const snap = (pct, model) => ({
    account: null,
    session: { pct: Math.max(4, pct - 22), resets: 'in 2h 40m', limit: null, used: null },
    weekAll: { pct, resets: 'Sat 9:00am', limit: null, used: null },
    weekModel: model
      ? { pct: model, resets: 'Sat 9:00am', label: 'Opus', limit: null, used: null }
      : null,
    capturedAt: iso(3),
    source: 'api',
  })
  const noData = {
    account: null,
    session: null,
    weekAll: null,
    weekModel: null,
    capturedAt: iso(3),
    source: 'api',
  }
  /** Per instance, so the on-load refresh cannot stamp one number across every row. */
  const usageFor = (dir) => {
    const d = dir.toLowerCase()
    if (d.includes('work')) return snap(72, 55)
    if (d.includes('personal')) return snap(26, null)
    if (d.includes('research')) return snap(55, 31)
    return null
  }

  const usageCache = {
    cache: {
      [`desktop:${instDir('work').toLowerCase()}`]: snap(72, 55),
      [`desktop:${instDir('personal').toLowerCase()}`]: snap(26, null),
      [`desktop:${instDir('research').toLowerCase()}`]: snap(55, 31),
      'cli:cli-1': snap(41, null),
    },
    lastAutoRefreshAt: iso(3),
  }

  const queue = [
    ['Refactor checkout validation', 'acme-storefront', 'running'],
    ['Regenerate API client', 'atlas-api', 'queued'],
    ['Audit log retention policy', 'atlas-api', 'queued'],
    ['Dark mode token pass', 'acme-storefront', 'queued'],
    ['Tidy up CLI help output', 'pico-cli', 'completed'],
  ].map(([title, p, status], i) => ({
    id: `q${i}0000000-0000-4000-8000-00000000000${i}`,
    session_id: claudeSessions[i % claudeSessions.length].session_id,
    title,
    cwd: proj(p),
    prompt: 'resume',
    model: i % 2 ? 'sonnet' : 'opus',
    effort: i % 2 ? 'medium' : 'high',
    permission_mode: null,
    account_id: null,
    new_chat: false,
    fork: false,
    status,
    pid: status === 'running' ? 9004 : null,
    position: i + 1,
    started_at: status === 'running' ? iso(6) : status === 'completed' ? iso(120) : null,
    finished_at: status === 'completed' ? iso(112) : null,
    exit_code: status === 'completed' ? 0 : null,
    created_at: ago(200 - i * 10),
    // One scheduled item, so the drawer shows a "runs at" chip.
    not_before: i === 3 ? iso(-180) : null,
    instance_ref: null,
    retry_attempts: 0,
  }))

  const cliInstances = [
    {
      id: 'cli-1',
      name: 'sandbox (CLI)',
      configDir: 'C:\\Users\\dev\\.claude-cli\\sandbox',
      loggedIn: true,
      associatedAccountId: null,
      associatedAccountLabel: null,
      associatedDesktopDir: null,
      lastUsageCheck: null,
    },
  ]
  const codexInstances = [
    {
      id: 'codex-1',
      name: 'work (Codex)',
      codexHome: 'C:\\Users\\dev\\.agenthydra\\codex-instances\\codex-1',
      desktopUserDataDir: 'C:\\Users\\dev\\.agenthydra\\codex-instances\\codex-1\\desktop',
      isDesktopRunning: true,
      desktopPid: 48216,
      loggedIn: true,
      createdAt: ago(4_320),
    },
  ]

  const dirFromUsageUrl = (url) => {
    const m = url.match(/\/api\/instances\/([^/]+)\/usage/)
    try {
      return m ? decodeURIComponent(m[1]) : ''
    } catch {
      return m ? m[1] : ''
    }
  }

  const routes = [
    [
      /\/api\/sessions\/[^/]+\/tail/,
      () => ({
        session_id: sessions[0].session_id,
        title: sessions[0].title,
        cwd: sessions[0].cwd,
        events: turns,
      }),
    ],
    [/\/api\/sessions\/search/, () => []],
    [/\/api\/sessions/, () => sessions],
    [/\/api\/instances\/[^/]+\/account/, () => instances[0].account],
    [
      /\/api\/instances\/[^/]+\/usage/,
      (url) => {
        const dir = dirFromUsageUrl(url)
        const s = usageFor(dir)
        return {
          key: `desktop:${dir.toLowerCase()}`,
          snapshot: s ?? noData,
          reason: s ? 'ok' : 'logged_out',
        }
      },
    ],
    [/\/api\/instances/, () => instances],
    [
      /\/api\/cli-instances\/[^/]+\/usage/,
      () => ({ key: 'cli:cli-1', snapshot: snap(41, null), reason: 'ok' }),
    ],
    [/\/api\/cli-instances/, () => cliInstances],
    [/\/api\/codex-instances/, () => codexInstances],
    [/\/api\/usage\/cache/, () => usageCache],
    [/\/api\/usage/, () => ({ key: 'acct:1', snapshot: snap(72, 55), reason: 'ok' })],
    [/\/api\/queue/, () => queue],
    [
      /\/api\/scheduler/,
      () => ({ enabled: true, running: false, nextRunAt: null, intervalMin: 15 }),
    ],
    [/\/api\/settings\/sync/, () => ({ enabled: false, connected: false, email: null })],
    [
      /\/api\/settings/,
      () => ({
        autoRefresh: true,
        autoRefreshIntervalMin: 15,
        showDesktopInstances: true,
        showCliInstances: true,
        codexDesktopEnabled: true,
        codexCliEnabled: true,
        chatGptHandoffEnabled: true,
        transcriptEditor: '',
        transcriptEditorResolved: 'VS Code',
        theme: 'dark',
        tooltips: true,
      }),
    ],
    [
      /\/api\/desktop-install/,
      () => ({
        platform: 'win32',
        directPath: 'C:\\ok\\Claude.exe',
        msixDetected: false,
        msixSignals: [],
        manageable: true,
      }),
    ],
    [/\/api\/accounts/, () => []],
    [/\/api\/monitor/, () => ({ accounts: [], enabled: false })],
    [/\/api\/update/, () => ({ status: 'idle', distribution: 'compiled' })],
  ]

  window.__fixtureEscapes = []

  const realFetch = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || ''
    if (url.includes('/api/')) {
      for (const [pattern, build] of routes) {
        if (pattern.test(url)) {
          return new Response(JSON.stringify(build(url)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
      }
      // No fixture matched. Answer emptily rather than letting it hit a real daemon, and record
      // it so the capture fails loudly instead of quietly shipping whatever a live API returned.
      window.__fixtureEscapes.push(url)
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return realFetch(input, init)
  }

  // The queue drawer opens an EventSource for live runs; keep it inert rather than erroring.
  window.EventSource = class {
    constructor() {
      this.readyState = 0
    }
    close() {}
    addEventListener() {}
    removeEventListener() {}
  }
})()

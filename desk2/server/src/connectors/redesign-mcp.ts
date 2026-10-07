// Desk's own small stdio MCP server for the ReDesign connector (defs/redesign.ts starts it with Desk's bun for
// every chat while ReDesign runs). Two tools, so a chat can get design options before it builds a UI:
//
//   design_options { brief, screenshot?, url?, count?, mock?, ask_owner? } -> one ReDesign run, every option as an image on disk
//   design_pick    { run, option }                              -> that option's design spec (DESIGN.md) to build to
//
// How it reaches ReDesign: its HTTP API at REDESIGN_URL (loopback), not by spawning `redesign mcp`: that child is
// a thin proxy to the same API, and it has no tool to add an input image and none to render an output to a picture.
// ReDesign's mutating routes only refuse a request whose Origin/Sec-Fetch-Site marks it as a browser page from
// elsewhere; a client that sends neither (this one) is accepted, so no change to ReDesign is needed.
//   input:  `screenshot` (an absolute path) is POSTed to /api/inputs/upload as base64; `url` is captured to a PNG
//           with headless Edge or Chrome and uploaded the same way; with neither, a 1x1 placeholder goes in and the
//           brief alone steers the models.
//   run:    POST /api/run (the brief, plus a style hint for a second or third job on the same model) for the models
//           redesign-plan.ts ranks as working (recent success, keys not cooling, no socket cut-off); `count` jobs, a model
//           repeated when fewer work; polled on GET /api/runs/:id. A failed or stalled job is replaced on another working
//           model until `count` options landed or the ~5 minute budget ends; the answer then says what is missing. A thin
//           pool (under 6 working keys) is first topped up from HSwarm (redesign-keys.ts, each key checked live).
//   images: ReDesign's outputs are HTML pages; each is rendered by GET /api/output/screenshot (ReDesign's own
//           headless browser) and written to <DESIGN_OPTIONS_DIR>/<run>/option-N.png.
// Real runs need provider keys the person adds in ReDesign itself; this server never asks for or sees a key.
// No dependency on @modelcontextprotocol/sdk: newline-delimited JSON-RPC 2.0 over stdio, written by hand.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { CHECK_LIMIT, copyHswarmKeys } from './redesign-keys'
import { MIN_WORKING_KEYS, designHint, designName, failureKind, listsToRefill, loadHealth, planJobs, rankModels, saveHealth, styledBrief, type Health, type KeyEntry, type KeyPool, type ModelInfo, type Ranked } from './redesign-plan'

/** A run is given about this long to reach `count` options, replacing failed jobs on other models as it goes. */
const BUDGET_MS = 5 * 60_000
/** A replacement job takes up to ReDesign's 2-minute job limit, so none is started with less than this left. */
const MIN_START_MS = 100_000
/** A job still unanswered after this long is given up on (ReDesign's own limit is 2 minutes, yet a job can hang far past it while it retries other keys) and replaced; if it answers later it still counts. */
const STALL_MS = 135_000
/** How long past the budget a job already running is still waited for. */
const GRACE_MS = 20_000
const KEY_HINT =
  'ReDesign has no working provider key yet. Tell the person to add one in ReDesign: Settings → Connectors → ReDesign → Open, then the Keys page. Do not ask for the key in chat. (A mock run also needs some key present in ReDesign, but spends nothing.)'

/** A 1x1 PNG: the input when the chat gave neither a screenshot nor a url. */
const PLACEHOLDER_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' }

export interface RedesignMcpOptions {
  /** ReDesign's loopback address. */
  baseUrl: string
  /** Where option images are written: <outDir>/<run>/option-N.png. */
  outDir: string
  fetchImpl?: typeof fetch
  /** Poll interval while a run is in flight (ms). */
  pollMs?: number
  /** Turns a web page into a PNG file; default is headless Edge or Chrome. */
  captureUrl?: (url: string, png: string) => Promise<void>
  /** Time budget for one design_options call (default 5 min). */
  budgetMs?: number
  minStartMs?: number
  graceMs?: number
  stallMs?: number
  /** Tops up ReDesign's key pools from HSwarm for these lists; default copyHswarmKeys (value-blind, each key checked live). */
  refill?: (lists: string[]) => Promise<string>
}

interface RpcMessage {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

interface Job {
  id: string
  status: string
  modelId?: string
  file?: string | null
  error?: string | null
}

interface Manifest {
  status: string
  jobs?: Job[]
  error?: string | null
}

/** A pool whose every key's last word was an error (no success since its last use). Unknown (no entries): not failing. */
export function poolFailing(p: KeyPool | undefined): boolean {
  const entries = p?.entries ?? []
  const good = (e: KeyEntry) => !e.lastError || (e.lastSuccessAt != null && e.lastSuccessAt >= (e.lastUsedAt ?? 0))
  return entries.length > 0 && !entries.some(good)
}

interface ToolResult {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })
const ok = (value: unknown, lead?: string): ToolResult => ({
  content: [{ type: 'text', text: `${lead ? `${lead}\n\n` : ''}${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}` }]
})

const TOOLS = [
  {
    name: 'design_options',
    description:
      'Get several design options for a user interface BEFORE building or restyling it. Gives ReDesign a brief and what exists today (a screenshot file or a URL), waits for it, and returns 3-6 options, each with a ready markdown image line to paste into your reply so the person sees them inline. Takes 1-10 minutes for a real run. The chat shows the options to the person as a ReDesign card either way. Set ask_owner true when the person asked to see or choose options, or the look is a matter of their taste: the card then lets them pick one, add notes or ask for more, and you end your turn and wait for their reply. Leave it false (the default) to decide yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        brief: { type: 'string', description: 'What is being designed and the feel wanted, in a few sentences.' },
        screenshot: { type: 'string', description: 'Absolute path of a screenshot of the current UI (png, jpg, webp).' },
        url: { type: 'string', description: 'A page to capture instead of a screenshot (http/https, e.g. a localhost dev server).' },
        count: { type: 'number', description: 'How many options, 3 to 6 (default 4).' },
        ask_owner: {
          type: 'boolean',
          description: 'true: the person chooses (they asked to see or choose options, or the look is their taste). false (default): you pick the option yourself and say why.'
        },
        mock: { type: 'boolean', description: 'Placeholder pages and no spend (ReDesign still wants a key in its pool): only to test the flow.' }
      },
      required: ['brief'],
      additionalProperties: false
    }
  },
  {
    name: 'design_pick',
    description: 'After the option is chosen: its design spec (DESIGN.md: colors, type, radii, spacing, components) to build to, plus its image path.',
    inputSchema: {
      type: 'object',
      properties: {
        run: { type: 'string', description: 'The run id design_options returned.' },
        option: { type: 'number', description: 'The option number (1-based).' }
      },
      required: ['run', 'option'],
      additionalProperties: false
    }
  }
]

/** Headless Edge or Chrome, the way ReDesign itself finds one: the first that exists. */
function findBrowser(): string | null {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean) as string[]
  const rel = ['Microsoft/Edge/Application/msedge.exe', 'Google/Chrome/Application/chrome.exe']
  for (const r of rel) for (const root of roots) if (existsSync(join(root, r))) return join(root, r)
  for (const p of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) if (existsSync(p)) return p
  return null
}

/** Deletes a temp folder, retrying while Windows still holds a file in it (EBUSY/EPERM); never throws, a leftover folder in tmp is harmless. */
export async function removeQuietly(dir: string, rm: (dir: string) => void = (d) => rmSync(d, { recursive: true, force: true }), tries = 10, delayMs = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      rm(dir)
      return
    } catch {
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
}

async function captureWithBrowser(url: string, png: string): Promise<void> {
  const exe = findBrowser()
  if (!exe) throw new Error('no Edge or Chrome found to capture the url: pass a screenshot file instead')
  const profile = mkdtempSync(join(tmpdir(), 'desk-shot-'))
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(exe, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${profile}`, '--window-size=1440,900', '--virtual-time-budget=8000', `--screenshot=${png}`, url], {
        stdio: 'ignore',
        windowsHide: true
      })
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('capturing the url timed out'))
      }, 45_000)
      child.on('error', reject)
      child.on('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  } finally {
    await removeQuietly(profile)
  }
  if (!existsSync(png)) throw new Error('the browser did not produce a screenshot of the url')
}

export function createRedesignMcp(o: RedesignMcpOptions) {
  const doFetch = o.fetchImpl ?? fetch
  const base = o.baseUrl.replace(/\/+$/, '')
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response
    try {
      res = await doFetch(`${base}${path}`, init)
    } catch (err) {
      throw new Error(`ReDesign is not answering at ${base}: start it from Settings → Connectors → ReDesign (${err instanceof Error ? err.message : String(err)})`)
    }
    const text = await res.text()
    if (!res.ok) throw new Error(`ReDesign answered ${res.status}: ${text.slice(0, 300)}`)
    return (text ? JSON.parse(text) : {}) as T
  }
  const post = <T>(path: string, body: unknown) => api<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  async function uploadInput(name: string, mime: string, bytes: Buffer | string): Promise<string> {
    const data = typeof bytes === 'string' ? bytes : bytes.toString('base64')
    const res = await post<{ addedIds?: string[]; inputs?: { id: string; name: string }[] }>('/api/inputs/upload', { images: [{ name, mime, data }] })
    const id = res.addedIds?.[0]
    if (!id) throw new Error('ReDesign did not take the input image')
    return id
  }

  /** Why a run made nothing, and what to do; for a cooled pool, when its first key comes back and the provider's last error. */
  async function noOptionsMessage(runId: string, manifest: Manifest): Promise<string> {
    const errors = (manifest.jobs ?? []).map((j) => (j as Job & { error?: string }).error).filter(Boolean) as string[]
    const why = errors[0] ?? manifest.error ?? manifest.status
    const cooled = [...new Set(errors.map((e) => /cooling down \(([A-Z_]+)\)/.exec(e)?.[1]).filter(Boolean) as string[])]
    if (!cooled.length) return `Run ${runId} made no options: ${String(why).slice(0, 300)}. If a key is the problem, tell the person to check it in ReDesign (Settings → Connectors → ReDesign → Open).`
    let pools: KeyPool[] = []
    try {
      pools = (await api<{ pools?: KeyPool[] }>('/api/keys')).pools ?? []
    } catch {
      // the message below still says what to do
    }
    const lines = cooled.map((name) => {
      const p = pools.find((x) => x.pool === name)
      const until = Math.min(...(p?.entries ?? []).map((e) => e.cooldownUntil ?? 0).filter((t) => t > Date.now()))
      const last = (p?.entries ?? []).map((e) => e.lastError).find(Boolean)
      const when = Number.isFinite(until) ? `its first key is free again at ${new Date(until).toLocaleTimeString()} (in ${Math.ceil((until - Date.now()) / 1000)} s)` : 'its cooldown has already ended'
      return `${name}: ${when}${last ? `; the provider's last answer was "${String(last).slice(0, 160)}"` : ''}`
    })
    return [
      `Run ${runId} made no options: every key of ${cooled.join(', ')} was cooling down after the provider refused or dropped its requests.`,
      ...lines.map((l) => `- ${l}`),
      `What to do: call design_options again after that time; or ask the person to press "Use HSwarm's keys" on the ReDesign card (or add keys of another provider in ReDesign: Settings → Connectors → ReDesign → Open) so the next run has fresh keys. A key refused with 429 for quota needs a different key, not a wait. Never ask for a key in chat.`
    ].join('\n')
  }

  /** The finished options of a run, in the order ReDesign wrote them. */
  const okJobs = (m: Manifest): Job[] => (m.jobs ?? []).filter((j) => j.status === 'ok' && j.file)

  const healthFile = join(o.outDir, 'model-health.json')

  async function planInputs(): Promise<{ models: ModelInfo[]; pools: KeyPool[] }> {
    const boot = await api<{ models?: ModelInfo[]; keys?: { pools?: KeyPool[] } }>('/api/bootstrap')
    return { models: boot.models ?? [], pools: boot.keys?.pools ?? [] }
  }

  /**
   * Copies keys from HSwarm into the thin pools (counts only, never a value); a line for the run's note. Keys whose live check
   * failed in the last 6 hours are remembered by fingerprint and not tried again, so each pass walks further down HSwarm's list
   * (a list can hold 170 keys of which most answer 429); up to 3 passes while a pool is still under MIN_WORKING_KEYS.
   */
  async function topUp(lists: string[]): Promise<string> {
    if (o.refill) return o.refill(lists)
    const file = join(o.outDir, 'key-checks.json')
    const failed: Record<string, number> = loadHealth(file) as unknown as Record<string, number>
    const now = Date.now()
    for (const [fp, at] of Object.entries(failed)) if (now - Number(at) > 6 * 3_600_000) delete failed[fp]
    const added: Record<string, number> = {}
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = new Promise<null>((r) => (timer = setTimeout(() => r(null), 150_000)))
    try {
      for (let pass = 0; pass < 3; pass++) {
        const res = await Promise.race([copyHswarmKeys({ redesignUrl: base, lists, fetchImpl: doFetch, skip: new Set(Object.keys(failed)) }), stop])
        if (!res) return `the HSwarm key top-up was still checking keys after 2.5 minutes, so the run went on without it${summary(added)}`
        if (!res.ok) return `key top-up skipped: ${res.error}`
        for (const fp of res.failed ?? []) failed[fp] = Date.now()
        for (const p of res.pools) added[p.pool] = (added[p.pool] ?? 0) + p.added
        const thin = res.pools.some((p) => p.before + p.added < MIN_WORKING_KEYS)
        const exhausted = Object.values(res.checked ?? {}).every((n) => n < CHECK_LIMIT)
        if (!thin || exhausted) break
      }
    } finally {
      clearTimeout(timer)
      saveHealth(file, failed as unknown as Health)
    }
    return summary(added).trim() || 'no HSwarm key passed the live check'
  }
  const summary = (added: Record<string, number>): string => {
    const parts = Object.entries(added).filter(([, n]) => n > 0).map(([pool, n]) => `${pool} +${n}`)
    return parts.length ? ` topped up ReDesign's keys from HSwarm (${parts.join(', ')})` : ''
  }

  const reason = (error: string): string => {
    const kind = failureKind(error)
    return kind === 'cutoff' ? 'the provider cut the connection off' : kind === 'stalled' ? 'no answer in time' : kind === 'recitation' ? 'an empty or blocked reply' : kind === 'cooling' ? 'its keys were cooling down' : kind === 'quota' ? 'rate limited' : error.slice(0, 80)
  }

  async function designOptions(args: Record<string, unknown>, progress: (done: number, total: number, msg: string) => void): Promise<ToolResult> {
    const brief = typeof args.brief === 'string' ? args.brief.trim() : ''
    if (!brief) return fail('design_options needs a brief: what is being designed and the feel wanted.')
    const mock = args.mock === true
    const askOwner = args.ask_owner === true
    const count = Math.max(3, Math.min(6, Math.round(Number(args.count) || 4)))
    let { models, pools } = await planInputs()
    const health: Health = loadHealth(healthFile)
    let ranked = rankModels(models, pools, health)
    if (!ranked.length) return fail(KEY_HINT)
    const notes: string[] = []
    // Enough working keys behind the models we are about to use: top thin pools up from HSwarm (each key checked live there).
    const lists = listsToRefill(ranked, planJobs(ranked, count), pools)
    if (lists.length) {
      try {
        notes.push(await topUp(lists))
        ;({ models, pools } = await planInputs())
        ranked = rankModels(models, pools, health)
      } catch {
        notes.push('the HSwarm key top-up failed')
      }
      if (!ranked.length) return fail(KEY_HINT)
    }

    // The input image.
    let inputId: string
    if (typeof args.screenshot === 'string' && args.screenshot) {
      const ext = extname(args.screenshot).toLowerCase()
      if (!MIME[ext]) return fail(`screenshot must be a png, jpg, webp, gif or bmp file, got ${ext || 'no extension'}.`)
      if (!existsSync(args.screenshot)) return fail(`No file at ${args.screenshot}.`)
      inputId = await uploadInput(basename(args.screenshot), MIME[ext] as string, readFileSync(args.screenshot))
    } else if (typeof args.url === 'string' && args.url) {
      if (!/^https?:\/\//i.test(args.url)) return fail('url must start with http:// or https://')
      const dir = mkdtempSync(join(tmpdir(), 'desk-design-'))
      try {
        const png = join(dir, 'page.png')
        await (o.captureUrl ?? captureWithBrowser)(args.url, png)
        inputId = await uploadInput('page.png', 'image/png', readFileSync(png))
      } catch (err) {
        return fail(`Could not capture ${args.url}: ${err instanceof Error ? err.message : String(err)}. Pass a screenshot file instead.`)
      } finally {
        await removeQuietly(dir)
      }
    } else {
      inputId = await uploadInput('brief-only.png', 'image/png', PLACEHOLDER_PNG)
    }

    const label = (id: string) => models.find((m) => m.id === id)?.label ?? id
    interface RunState {
      id: string
      expected: number
      /** The style direction this run carries; it names its option. */
      instance: number
      handled: Set<string>
      /** Jobs given up on as unanswered; they no longer count as on their way. */
      stalled: Set<string>
      startedAt: number
      ended: boolean
    }
    const runs: RunState[] = []
    const taken = new Map<string, number>() // jobs started per model
    const blocked = new Set<string>()
    const strikes = new Map<string, number>()
    const failedJobs: Job[] = []
    const why: string[] = []
    const options: { option: number; name: string; model: string; description: string; image: string | null; markdown: string | null; page: string; run: string; job: string }[] = []
    let primary = ''
    let dir = ''

    /** One ReDesign run per job: ReDesign takes one prompt per run, and every option gets its own style direction (its name). */
    const startJobs = async (ids: string[]): Promise<void> => {
      for (const id of ids) {
        taken.set(id, (taken.get(id) ?? 0) + 1)
        const instance = runs.length
        const { runId } = await post<{ runId: string }>('/api/run', {
          inputs: [inputId],
          models: [id],
          prompts: { presets: [], custom: styledBrief(brief, instance) },
          modelQuantities: { [id]: 1 },
          mock,
          label: 'design-options'
        })
        runs.push({ id: runId, expected: 1, instance, handled: new Set(), stalled: new Set(), startedAt: Date.now(), ended: false })
        if (!primary) {
          primary = runId
          dir = join(o.outDir, runId)
          mkdirSync(dir, { recursive: true })
        }
      }
    }

    const onFailure = (job: Job, error: string) => {
      const id = job.modelId ?? ''
      const kind = failureKind(error)
      why.push(`${label(id)}: ${reason(error)}`)
      failedJobs.push({ ...job, error })
      health[id] = { ...health[id], failAt: Date.now(), why: kind }
      const pool = models.find((m) => m.id === id)?.keyEnv
      if (kind === 'cutoff' || kind === 'cooling') for (const m of models) if (m.keyEnv === pool) blocked.add(m.id)
      if (kind === 'recitation' || kind === 'stalled') blocked.add(id)
      const n = (strikes.get(id) ?? 0) + 1
      strikes.set(id, n)
      if (n >= 2) blocked.add(id)
    }

    /** A finished job becomes option N: its picture is rendered now, while the other jobs run on. */
    const land = async (run: RunState, job: Job): Promise<void> => {
      const n = options.length + 1
      const name = label(job.modelId ?? '')
      const imagePath = join(dir, `option-${n}.png`).replace(/\\/g, '/')
      let image: string | null = imagePath
      try {
        const res = await doFetch(`${base}/api/output/screenshot?file=${encodeURIComponent(job.file as string)}`)
        if (!res.ok) throw new Error(`answered ${res.status}`)
        writeFileSync(imagePath, Buffer.from(await res.arrayBuffer()))
      } catch {
        image = null
      }
      // A name is unique within the result: a repeat takes its option number.
      const given = designName(run.instance)
      const dup = options.some((x) => x.name.toLowerCase() === given.toLowerCase())
      options.push({
        option: n,
        name: dup ? `${given} ${n}` : given,
        model: name,
        description: designHint(run.instance) || `${name}, the brief as written`,
        image,
        markdown: image ? `![Option ${n}: ${name}](${image})` : null,
        page: `${base}/output/${job.file}`,
        run: run.id,
        job: job.id
      })
      health[job.modelId ?? ''] = { ...health[job.modelId ?? ''], okAt: Date.now() }
      // design_pick finds option N's real run and job here, since replacements live in other ReDesign runs.
      writeFileSync(join(dir, 'options.json'), JSON.stringify(options.map((x) => ({ option: x.option, run: x.run, job: x.job }))))
      progress(n, count, ['Option ' + n + ' of ' + count + ' is ready', ...options.map((x) => x.name)].join(' · '))
    }

    const started = Date.now()
    const budget = o.budgetMs ?? BUDGET_MS
    const inflight = () => runs.reduce((n, r) => n + (r.ended ? 0 : r.expected - r.handled.size - r.stalled.size), 0)
    await startJobs(planJobs(ranked, count))
    let replacements = 0
    for (;;) {
      for (const r of runs) {
        if (r.ended) continue
        let m: Manifest
        try {
          m = await api<Manifest>(`/api/runs/${encodeURIComponent(r.id)}`)
        } catch {
          continue // one missed poll is not a failure
        }
        for (const job of m.jobs ?? []) {
          if (r.handled.has(job.id)) continue
          if (job.status === 'ok' && job.file) {
            r.handled.add(job.id)
            r.stalled.delete(job.id)
            if (options.length < count) await land(r, job)
          } else if (job.status === 'error' || job.status === 'skipped' || job.status === 'cancelled') {
            r.handled.add(job.id)
            r.stalled.delete(job.id)
            onFailure(job, String(job.error ?? job.status))
          } else if (!r.stalled.has(job.id) && Date.now() - r.startedAt > (o.stallMs ?? STALL_MS)) {
            r.stalled.add(job.id)
            onFailure(job, `no answer within ${Math.round((Date.now() - r.startedAt) / 1000)} s`)
          }
        }
        if (m.status !== 'queued' && m.status !== 'running') r.ended = true
      }
      if (options.length >= count) break
      const elapsed = Date.now() - started
      const need = count - options.length - inflight()
      if (need > 0 && replacements < count * 3 && budget - elapsed >= (o.minStartMs ?? MIN_START_MS)) {
        // A job failed: start replacements on other models that still work, until `count` options exist or the budget is spent.
        const next = planJobs(rankModels(models, pools, health, blocked), need, taken, 1)
        if (next.length) {
          replacements += next.length
          await startJobs(next)
          progress(options.length, count, `Started ${next.length} replacement job(s) after a failure`)
        } else if (!inflight()) break
      } else if (!inflight()) break
      if (elapsed >= budget + (o.graceMs ?? GRACE_MS)) break
      progress(options.length, count, `ReDesign is making options (${options.length}/${count})`)
      await sleep(o.pollMs ?? 1500)
    }
    for (const r of runs) if (!r.ended) await post(`/api/runs/${encodeURIComponent(r.id)}/cancel`, {}).catch(() => {})
    saveHealth(healthFile, health)

    if (!options.length) return fail(await noOptionsMessage(primary, { status: 'failed', jobs: failedJobs }))
    const seconds = Math.round((Date.now() - started) / 1000)
    if (options.length < count) notes.push(`Only ${options.length} of ${count} options came back after ${seconds} s${why.length ? ` (${[...new Set(why)].join('; ')})` : ''}. Say so to the person; call design_options again later for more.`)
    const shown = options.map(({ run: _run, job: _job, ...rest }) => rest)
    const missing = shown.some((x) => !x.image)
    return ok(
      { run: primary, mock, ask_owner: askOwner, requested: count, ...(notes.length ? { note: notes.join(' ') } : {}), options: shown },
      (askOwner
        ? 'The options are now shown to the person in the chat as a ReDesign card, where they can choose one by its name, ask for more or reply in words. Do not paste the images and do not call design_pick yet: end your turn and wait. Their reply arrives as their next message, starting with ReDesign: (I pick option 2, Card stack. / more options please. / or their own words). Refer to options by number and name, e.g. option 2, Card stack. Then call design_pick for the option they chose, or call design_options again if they want more.'
        : 'The options are shown to the person in the chat as a ReDesign card. Say which one you pick and why (you decide; do not wait for them), then call design_pick with it.') +
        (missing ? ' (Some options have no picture: ReDesign could not render them, give the page link instead.)' : '')
    )
  }

  async function designPick(args: Record<string, unknown>): Promise<ToolResult> {
    const run = typeof args.run === 'string' ? args.run : ''
    const n = Math.round(Number(args.option))
    if (!run || !(n >= 1)) return fail('design_pick needs run (the id design_options gave) and option (1 or more).')
    // Options of a run with replacements live in several ReDesign runs: the sidecar written at landing says where option N is.
    let from = { run, job: '' }
    let known = 0
    const sidecar = join(o.outDir, run, 'options.json')
    if (existsSync(sidecar)) {
      const rows = JSON.parse(readFileSync(sidecar, 'utf8')) as { option: number; run: string; job: string }[]
      known = rows.length
      from = rows.find((r) => r.option === n) ?? from
    } else {
      const jobs = okJobs(await api<Manifest>(`/api/runs/${encodeURIComponent(run)}`))
      known = jobs.length
      from = { run, job: jobs[n - 1]?.id ?? '' }
    }
    if (!from.job) return fail(`Run ${run} has ${known} option(s); there is no option ${n}.`)
    const spec = await doFetch(`${base}/api/runs/${encodeURIComponent(from.run)}/design-md?job=${encodeURIComponent(from.job)}`)
    if (!spec.ok) return fail(`ReDesign could not write the spec: ${spec.status} ${(await spec.text()).slice(0, 200)}`)
    const image = join(o.outDir, run, `option-${n}.png`).replace(/\\/g, '/')
    return ok({ run, option: n, image: existsSync(image) ? image : null, spec: await spec.text() }, `Build to this spec (option ${n}).`)
  }

  /** One JSON-RPC message in; the reply to send, or null for a notification. `notify` sends progress to the client. */
  async function handle(msg: RpcMessage, notify: (m: unknown) => void = () => {}): Promise<unknown | null> {
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result })
    const error = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } })
    if (msg.id === undefined || msg.id === null) return null
    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'redesign', version: '1.0.0' }
        })
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({ tools: TOOLS })
      case 'tools/call': {
        const name = msg.params?.name
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
        const token = (msg.params?._meta as { progressToken?: string | number } | undefined)?.progressToken
        const progress = (done: number, total: number, message: string) => {
          if (token !== undefined) notify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: done, total, message } })
        }
        try {
          if (name === 'design_options') return reply(await designOptions(args, progress))
          if (name === 'design_pick') return reply(await designPick(args))
          return error(-32602, `unknown tool ${String(name)}`)
        } catch (err) {
          return reply(fail(err instanceof Error ? err.message : String(err)))
        }
      }
      default:
        return error(-32601, `method not found: ${String(msg.method)}`)
    }
  }

  return { handle }
}

/** The stdio loop: one JSON message per line in, one per line out. stdout carries nothing else. */
export async function serveStdio(server: ReturnType<typeof createRedesignMcp>): Promise<void> {
  const send = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`)
  let buf = ''
  const pending = new Set<Promise<void>>()
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    buf += chunk
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let msg: RpcMessage
      try {
        msg = JSON.parse(line) as RpcMessage
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
        continue
      }
      // A long design_options must not block the next message, so each one runs on its own.
      const p = server.handle(msg, send).then((r) => {
        if (r) send(r)
      })
      pending.add(p)
      void p.finally(() => pending.delete(p))
    }
  }
  await Promise.all(pending)
}

if (import.meta.main) {
  const baseUrl = process.env.REDESIGN_URL?.trim() || `http://127.0.0.1:${process.env.PORT || 5178}`
  const outDir = process.env.DESIGN_OPTIONS_DIR?.trim() || join(tmpdir(), 'hydra-desk-design-options')
  await serveStdio(createRedesignMcp({ baseUrl, outDir }))
}

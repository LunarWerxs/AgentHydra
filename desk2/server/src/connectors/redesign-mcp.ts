// Desk's own small stdio MCP server for the ReDesign connector (defs/redesign.ts starts it with Desk's bun for
// every chat while ReDesign runs). Two tools, so a chat can get design options before it builds a UI:
//
//   design_options { brief, screenshot?, url?, count?, mock? }  -> one ReDesign run, every option as an image on disk
//   design_pick    { run, option }                              -> that option's design spec (DESIGN.md) to build to
//
// How it reaches ReDesign: its HTTP API at REDESIGN_URL (loopback), not by spawning `redesign mcp`: that child is
// a thin proxy to the same API, and it has no tool to add an input image and none to render an output to a picture.
// ReDesign's mutating routes only refuse a request whose Origin/Sec-Fetch-Site marks it as a browser page from
// elsewhere; a client that sends neither (this one) is accepted, so no change to ReDesign is needed.
//   input:  `screenshot` (an absolute path) is POSTed to /api/inputs/upload as base64; `url` is captured to a PNG
//           with headless Edge or Chrome and uploaded the same way; with neither, a 1x1 placeholder goes in and the
//           brief alone steers the models.
//   run:    POST /api/run with the brief as the one custom prompt, `count` outputs spread over the models that have
//           a key (a mock run skips the network but ReDesign still takes a key from the pool first), polled on GET /api/runs/:id until it ends (10 min cap).
//   images: ReDesign's outputs are HTML pages; each is rendered by GET /api/output/screenshot (ReDesign's own
//           headless browser) and written to <DESIGN_OPTIONS_DIR>/<run>/option-N.png.
// Real runs need provider keys the person adds in ReDesign itself; this server never asks for or sees a key.
// No dependency on @modelcontextprotocol/sdk: newline-delimited JSON-RPC 2.0 over stdio, written by hand.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'

const MAX_WAIT_MS = 10 * 60_000
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
  maxWaitMs?: number
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
  caption?: string | null
}

interface Manifest {
  status: string
  jobs?: Job[]
  error?: string | null
}

interface ModelInfo {
  id: string
  label?: string
  keyEnv?: string
  vision?: boolean
  enabled?: boolean
  starred?: boolean
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
      'Get several design options for a user interface BEFORE building or restyling it. Gives ReDesign a brief and what exists today (a screenshot file or a URL), waits for it, and returns 3-6 options, each with a ready markdown image line to paste into your reply so the person sees them inline. Takes 1-10 minutes for a real run.',
    inputSchema: {
      type: 'object',
      properties: {
        brief: { type: 'string', description: 'What is being designed and the feel wanted, in a few sentences.' },
        screenshot: { type: 'string', description: 'Absolute path of a screenshot of the current UI (png, jpg, webp).' },
        url: { type: 'string', description: 'A page to capture instead of a screenshot (http/https, e.g. a localhost dev server).' },
        count: { type: 'number', description: 'How many options, 3 to 6 (default 4).' },
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
    rmSync(profile, { recursive: true, force: true })
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

  /** The models a run should use: enabled vision models with a key in their pool (a mock run needs one too). Null: none. */
  async function pickModels(): Promise<ModelInfo[] | null> {
    const boot = await api<{ models?: ModelInfo[]; keys?: { pools?: { pool: string; available: number }[] } }>('/api/bootstrap')
    const live = new Set((boot.keys?.pools ?? []).filter((p) => p.available > 0).map((p) => p.pool))
    const usable = (boot.models ?? []).filter((m) => m.enabled !== false && m.vision !== false && (m.keyEnv && live.has(m.keyEnv)))
    if (!usable.length) return null
    return usable.sort((a, b) => Number(b.starred === true) - Number(a.starred === true))
  }

  /** The finished options of a run, in the order ReDesign wrote them. */
  const okJobs = (m: Manifest): Job[] => (m.jobs ?? []).filter((j) => j.status === 'ok' && j.file)

  async function designOptions(args: Record<string, unknown>, progress: (done: number, total: number, msg: string) => void): Promise<ToolResult> {
    const brief = typeof args.brief === 'string' ? args.brief.trim() : ''
    if (!brief) return fail('design_options needs a brief: what is being designed and the feel wanted.')
    const mock = args.mock === true
    const count = Math.max(3, Math.min(6, Math.round(Number(args.count) || 4)))
    const models = await pickModels()
    if (!models) return fail(KEY_HINT)

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
        rmSync(dir, { recursive: true, force: true })
      }
    } else {
      inputId = await uploadInput('brief-only.png', 'image/png', PLACEHOLDER_PNG)
    }

    // One output per option: the first `count` models once each, wrapping round when there are fewer models.
    const quantities: Record<string, number> = {}
    for (let i = 0; i < count; i++) {
      const id = (models[i % models.length] as ModelInfo).id
      quantities[id] = (quantities[id] ?? 0) + 1
    }
    const { runId } = await post<{ runId: string }>('/api/run', {
      inputs: [inputId],
      models: Object.keys(quantities),
      prompts: { presets: [], custom: brief },
      modelQuantities: quantities,
      mock,
      label: 'design-options'
    })

    // Wait for it.
    const deadline = Date.now() + (o.maxWaitMs ?? MAX_WAIT_MS)
    let manifest: Manifest
    for (;;) {
      manifest = await api<Manifest>(`/api/runs/${encodeURIComponent(runId)}`)
      if (manifest.status !== 'queued' && manifest.status !== 'running') break
      progress(okJobs(manifest).length, count, `ReDesign is making options (${okJobs(manifest).length}/${count})`)
      if (Date.now() >= deadline) return fail(`Run ${runId} was still going after 10 minutes. Ask for it later with design_pick once it is done, or tell the person.`)
      await sleep(o.pollMs ?? 1500)
    }
    const jobs = okJobs(manifest).slice(0, count)
    if (!jobs.length) {
      const why = (manifest.jobs ?? []).map((j) => (j as Job & { error?: string }).error).find(Boolean) ?? manifest.error ?? manifest.status
      return fail(`Run ${runId} made no options: ${String(why).slice(0, 300)}. If a key is the problem, tell the person to check it in ReDesign (Settings → Connectors → ReDesign → Open).`)
    }

    // Each option to a picture on disk.
    const dir = join(o.outDir, runId)
    mkdirSync(dir, { recursive: true })
    const options = []
    for (const [i, job] of jobs.entries()) {
      const n = i + 1
      const label = models.find((m) => m.id === job.modelId)?.label ?? job.modelId ?? 'model'
      const imagePath = join(dir, `option-${n}.png`).replace(/\\/g, '/')
      let image: string | null = imagePath
      try {
        const res = await doFetch(`${base}/api/output/screenshot?file=${encodeURIComponent(job.file as string)}`)
        if (!res.ok) throw new Error(`answered ${res.status}`)
        writeFileSync(imagePath, Buffer.from(await res.arrayBuffer()))
      } catch {
        image = null
      }
      const caption = await caption_(job)
      options.push({
        option: n,
        model: label,
        description: caption ?? `${label}, from the brief`,
        image,
        markdown: image ? `![Option ${n}: ${label}](${image})` : null,
        page: `${base}/output/${job.file}`
      })
      progress(n, jobs.length, `Rendered option ${n}`)
    }
    const missing = options.some((x) => !x.image)
    return ok(
      { run: runId, mock, options },
      `Show every option inline by pasting its markdown line, say which you would pick and why, let the person choose when they are present, then call design_pick.${missing ? ' (Some options have no picture: ReDesign could not render them, give the page link instead.)' : ''}`
    )
  }

  async function caption_(job: Job): Promise<string | null> {
    if (job.caption) return job.caption
    try {
      const meta = await api<{ caption?: string | null }>(`/output-raw/${String(job.file).replace(/\.html$/i, '.meta.json')}`)
      return meta.caption ?? null
    } catch {
      return null
    }
  }

  async function designPick(args: Record<string, unknown>): Promise<ToolResult> {
    const run = typeof args.run === 'string' ? args.run : ''
    const n = Math.round(Number(args.option))
    if (!run || !(n >= 1)) return fail('design_pick needs run (the id design_options gave) and option (1 or more).')
    const jobs = okJobs(await api<Manifest>(`/api/runs/${encodeURIComponent(run)}`))
    const job = jobs[n - 1]
    if (!job) return fail(`Run ${run} has ${jobs.length} option(s); there is no option ${n}.`)
    const spec = await doFetch(`${base}/api/runs/${encodeURIComponent(run)}/design-md?job=${encodeURIComponent(job.id)}`)
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

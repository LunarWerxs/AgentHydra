// Compose-managed dependencies (ported from DevWebUI's manager/compose.ts): a server's optional `compose` block brings
// its docker compose stack (Postgres, Redis, a mail catcher) up BEFORE the server spawns, waits until the healthchecks
// pass and every published port serves, and hands the server connection env derived from each service's image
// (postgres:* gives DATABASE_URL). Everything with a side effect (`run`, `probe`) is a parameter so it is testable
// without a Docker daemon; the manager decides when to call it and who holds a started stack.

import { type ChildProcess, spawn } from 'node:child_process'
import net from 'node:net'

export interface ComposeSpec {
  /** Absolute once loaded (relative to the .devwebui file as written); omitted, compose finds compose.yaml in the server's folder. */
  file?: string
  mode?: 'none' | 'start-only' | 'start-and-stop'
  skipIfRunning?: boolean
  readinessTimeoutMs?: number
  services?: string[]
  injectEnv?: boolean
}

/** A service carrying this label (any value but "false") is left alone: not started, probed or mapped. */
export const COMPOSE_IGNORE_LABEL = 'devwebui.ignore'
const READINESS_TIMEOUT_MS = 60_000
const QUERY_TIMEOUT_MS = 30_000
// `up -d` may pull images on first use.
const UP_TIMEOUT_MS = 10 * 60_000
const STOP_TIMEOUT_MS = 60_000
const READINESS_POLL_MS = 500
const PROBE_CONNECT_MS = 300
const PROBE_READ_MS = 200

export interface DockerResult {
  code: number | null
  stdout: string
  stderr: string
}

export type DockerRunner = (args: string[], cwd: string, timeoutMs: number) => Promise<DockerResult>
export type PortProbe = (port: number, host: string) => Promise<boolean>

interface PublishedPort {
  host: string
  target: number
  published: number
}

interface ComposeService {
  name: string
  image: string
  environment: Record<string, string>
  labels: Record<string, string>
  running: boolean
  /** Exited with code 0: a one-shot job (migrations) that finished its work. */
  completed: boolean
  /** The compose healthcheck state; empty when none is defined. */
  health: string
  ports: PublishedPort[]
}

export type ComposeOutcome =
  | { ok: true; env: Record<string, string>; started: string[]; /** Which service each injected key came from (keys only: values carry passwords). */ sources: Record<string, string> }
  | { ok: false; reason: string; /** Services `up` started before a later step failed, so the caller can still stop them. */ started?: string[] }

/** A compose block is active unless it is absent or `mode: "none"`. */
export function composeActive(spec: ComposeSpec | undefined): spec is ComposeSpec {
  return !!spec && (spec.mode ?? 'start-only') !== 'none'
}

/** Identity of a stack, so servers sharing one file share one hold. */
export function composeKey(spec: ComposeSpec, cwd: string): string {
  return spec.file ? `file|${spec.file}` : `cwd|${cwd}`
}

const baseArgs = (spec: ComposeSpec): string[] => (spec.file ? ['compose', '-f', spec.file] : ['compose'])

/** Runs the docker CLI directly (no shell) and collects its output; never rejects. */
export const runDocker: DockerRunner = (args, cwd, timeoutMs) =>
  new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (r: DockerResult) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(r)
    }
    let child: ChildProcess
    try {
      child = spawn('docker', args, { cwd, windowsHide: true })
    } catch (err) {
      finish({ code: null, stdout, stderr: (err as Error).message })
      return
    }
    timer = setTimeout(() => {
      child.kill()
      finish({ code: null, stdout, stderr: `${stderr}\ndocker ${args.join(' ')} timed out` })
    }, timeoutMs)
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('error', (err) => finish({ code: null, stdout, stderr: err.message }))
    child.on('close', (code) => finish({ code, stdout, stderr }))
  })

/** `KEY=VALUE` list or `{KEY: VALUE}` map (compose accepts both) as a string map. */
function toStringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string') continue
      const eq = item.indexOf('=')
      if (eq > 0) out[item.slice(0, eq)] = item.slice(eq + 1)
    }
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (v != null) out[k] = String(v)
  }
  return out
}

type ConfigMap = Map<string, Pick<ComposeService, 'image' | 'environment' | 'labels'>>

/** `docker compose config --format json` as per-service image, env and labels. */
export function parseComposeConfig(stdout: string): ConfigMap {
  const parsed = JSON.parse(stdout) as { services?: Record<string, Record<string, unknown>> }
  const out: ConfigMap = new Map()
  for (const [name, svc] of Object.entries(parsed.services ?? {})) out.set(name, { image: typeof svc.image === 'string' ? svc.image : '', environment: toStringMap(svc.environment), labels: toStringMap(svc.labels) })
  return out
}

interface PsRow {
  Service?: string
  State?: string
  Health?: string
  ExitCode?: number
  Publishers?: Array<{ URL?: string; TargetPort?: number; PublishedPort?: number; Protocol?: string }>
}

/** `docker compose ps --format json`: a JSON array on older Compose, NDJSON on newer. */
export function parseComposePs(stdout: string): PsRow[] {
  const text = stdout.trim()
  if (!text) return []
  if (text.startsWith('[')) return JSON.parse(text) as PsRow[]
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as PsRow)
}

/** A wildcard bind is reached through loopback; a specific bind address is used as it is. */
const reachableHost = (url: string | undefined): string => (!url || url === '0.0.0.0' || url === '::' || url === '[::]' ? '127.0.0.1' : url)

export function mergeServices(config: ConfigMap, ps: PsRow[]): ComposeService[] {
  const rows = new Map<string, PsRow>()
  for (const row of ps) if (row.Service) rows.set(row.Service, row)
  return [...config].map(([name, svc]) => {
    const row = rows.get(name)
    const ports: PublishedPort[] = []
    for (const p of row?.Publishers ?? []) {
      if (!p.PublishedPort || !p.TargetPort || (p.Protocol && p.Protocol !== 'tcp')) continue
      const port = { host: reachableHost(p.URL), target: p.TargetPort, published: p.PublishedPort }
      if (!ports.some((x) => x.published === port.published)) ports.push(port)
    }
    const state = (row?.State ?? '').toLowerCase()
    return { name, ...svc, running: state === 'running', completed: state === 'exited' && row?.ExitCode === 0, health: (row?.Health ?? '').toLowerCase(), ports }
  })
}

const isIgnored = (svc: Pick<ComposeService, 'labels'>): boolean => {
  const v = svc.labels[COMPOSE_IGNORE_LABEL]
  return v !== undefined && v.toLowerCase() !== 'false'
}

/** `docker.io/library/postgres:16-alpine` or `bitnami/postgresql@sha256:..` as `postgres` / `postgresql`. */
export function imageName(image: string): string {
  const last = (image.split('@')[0] ?? '').split('/').pop() ?? ''
  return last.split(':')[0]?.toLowerCase() ?? ''
}

const enc = encodeURIComponent
const auth = (user: string, password: string | undefined) => (password ? `${enc(user)}:${enc(password)}@` : `${enc(user)}@`)

interface ImageKind {
  match: RegExp
  port: number
  env: (e: Record<string, string>, host: string, port: number) => Record<string, string>
}

// One entry per well-known dependency image: the container port it serves on and the env var an app reads to reach it.
// Credentials come from the service's own compose environment, with each image's documented defaults.
const IMAGE_KINDS: ImageKind[] = [
  {
    match: /^(postgres|postgresql|postgis|pgvector|timescaledb.*)$/,
    port: 5432,
    env: (e, host, port) => {
      const user = e.POSTGRES_USER ?? e.POSTGRESQL_USERNAME ?? 'postgres'
      const db = e.POSTGRES_DB ?? e.POSTGRESQL_DATABASE ?? user
      return { DATABASE_URL: `postgres://${auth(user, e.POSTGRES_PASSWORD ?? e.POSTGRESQL_PASSWORD)}${host}:${port}/${enc(db)}` }
    },
  },
  {
    match: /^(mysql|mariadb|percona.*)$/,
    port: 3306,
    env: (e, host, port) => {
      const user = e.MYSQL_USER ?? e.MARIADB_USER ?? 'root'
      const password = user === 'root' ? (e.MYSQL_ROOT_PASSWORD ?? e.MARIADB_ROOT_PASSWORD) : (e.MYSQL_PASSWORD ?? e.MARIADB_PASSWORD)
      return { DATABASE_URL: `mysql://${auth(user, password)}${host}:${port}/${enc(e.MYSQL_DATABASE ?? e.MARIADB_DATABASE ?? '')}` }
    },
  },
  {
    match: /^(redis|redis-stack|redis-stack-server|valkey|keydb)$/,
    port: 6379,
    env: (e, host, port) => ({ REDIS_URL: `redis://${e.REDIS_PASSWORD ? `:${enc(e.REDIS_PASSWORD)}@` : ''}${host}:${port}` }),
  },
  {
    match: /^(mongo|mongodb|mongodb-community-server)$/,
    port: 27017,
    env: (e, host, port) => {
      const user = e.MONGO_INITDB_ROOT_USERNAME
      const creds = user ? auth(user, e.MONGO_INITDB_ROOT_PASSWORD) : ''
      return { MONGODB_URI: `mongodb://${creds}${host}:${port}/${enc(e.MONGO_INITDB_DATABASE ?? '')}${user ? '?authSource=admin' : ''}` }
    },
  },
  {
    match: /^rabbitmq$/,
    port: 5672,
    env: (e, host, port) => ({ AMQP_URL: `amqp://${auth(e.RABBITMQ_DEFAULT_USER ?? 'guest', e.RABBITMQ_DEFAULT_PASS ?? 'guest')}${host}:${port}${e.RABBITMQ_DEFAULT_VHOST ? `/${enc(e.RABBITMQ_DEFAULT_VHOST)}` : ''}` }),
  },
  { match: /^(mailhog|mailpit|maildev)$/, port: 1025, env: (_e, host, port) => ({ SMTP_HOST: host, SMTP_PORT: String(port) }) },
]

/** Connection env for every running, non-ignored service of a known image with its port published; the first to claim a key keeps it. */
function connectionEnv(services: ComposeService[]): { env: Record<string, string>; sources: Record<string, string> } {
  const env: Record<string, string> = {}
  const sources: Record<string, string> = {}
  for (const svc of services) {
    if (!svc.running || isIgnored(svc)) continue
    const name = imageName(svc.image)
    const kind = IMAGE_KINDS.find((k) => k.match.test(name))
    const port = kind && svc.ports.find((p) => p.target === kind.port)
    if (!kind || !port) continue
    for (const [key, value] of Object.entries(kind.env(svc.environment, port.host, port.published))) {
      if (key in env) continue
      env[key] = value
      sources[key] = svc.name
    }
  }
  return { env, sources }
}

/**
 * Readiness of a published port. A plain connect is not enough: the host end is docker-proxy, which accepts as soon as
 * the container exists and then drops the connection while the server inside still boots. So after connecting it
 * listens briefly: an EOF or reset means nothing serves yet; data, or a quiet open socket (Postgres and Redis wait for
 * the client to speak first), means ready.
 */
export const composePortReady: PortProbe = (port, host) =>
  new Promise((resolve) => {
    const sock = new net.Socket()
    let connected = false
    const done = (v: boolean) => {
      sock.removeAllListeners()
      sock.destroy()
      resolve(v)
    }
    sock.setTimeout(PROBE_CONNECT_MS)
    sock.once('connect', () => {
      connected = true
      sock.setTimeout(PROBE_READ_MS)
    })
    sock.once('data', () => done(true))
    sock.once('end', () => done(false))
    sock.once('close', () => done(false))
    sock.once('timeout', () => done(connected))
    sock.once('error', () => done(false))
    try {
      sock.connect(port, host)
    } catch {
      done(false)
    }
  })

function failure(step: string, r: DockerResult): { ok: false; reason: string } {
  const detail = r.stderr.trim().split(/\r?\n/).slice(-3).join(' ').trim()
  const hint = r.code === null && /ENOENT/i.test(r.stderr) ? 'docker was not found on PATH' : detail
  return { ok: false, reason: `docker compose ${step} failed${hint ? `: ${hint}` : ''}` }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Ctx {
  spec: ComposeSpec
  cwd: string
  args: string[]
  run: DockerRunner
  probe: PortProbe
  pollMs: number
}

async function listServices(ctx: Ctx, config: ConfigMap): Promise<ComposeService[] | string> {
  // --all: an exited one-shot job must show up with its exit code, not vanish.
  const ps = await ctx.run([...ctx.args, 'ps', '--all', '--format', 'json'], ctx.cwd, QUERY_TIMEOUT_MS)
  if (ps.code !== 0) return failure('ps', ps).reason
  try {
    return mergeServices(config, parseComposePs(ps.stdout))
  } catch {
    return 'docker compose ps did not return JSON'
  }
}

/** Polls until no wanted service has a pending healthcheck; the live services, or why not. */
async function waitForHealthy(ctx: Ctx, config: ConfigMap, wanted: Set<string>, deadline: number): Promise<ComposeService[] | string> {
  for (;;) {
    const after = await listServices(ctx, config)
    if (typeof after === 'string') return after
    const live = after.filter((s) => wanted.has(s.name))
    // A container that exited straight after `up` would otherwise pass readiness vacuously: it publishes no ports.
    const down = live.filter((s) => !s.running && !s.completed).map((s) => s.name)
    if (down.length) return `compose service(s) not running: ${down.join(', ')}`
    const unhealthy = live.filter((s) => s.health === 'starting' || s.health === 'unhealthy').map((s) => s.name)
    if (!unhealthy.length) return live
    if (Date.now() >= deadline) return `compose service(s) not healthy in time: ${unhealthy.join(', ')}`
    await pause(ctx.pollMs)
  }
}

async function waitForPorts(ctx: Ctx, live: ComposeService[], deadline: number): Promise<string | null> {
  for (const svc of live)
    for (const port of svc.ports)
      for (;;) {
        if (await ctx.probe(port.published, port.host)) break
        if (Date.now() >= deadline) return `compose service "${svc.name}" did not accept connections on ${port.host}:${port.published} in time`
        await pause(ctx.pollMs)
      }
  return null
}

/**
 * Brings a server's compose stack up and waits for it: reads the resolved config, lists what runs, `up -d` the wanted
 * services unless every one already runs (skipIfRunning, default on), then waits for every healthcheck and each
 * published port, or the readiness timeout. A service that exited 0 (a one-shot init job) is done, not down.
 */
export async function prepareCompose(spec: ComposeSpec, cwd: string, deps: { run?: DockerRunner; probe?: PortProbe; pollMs?: number } = {}): Promise<ComposeOutcome> {
  const ctx: Ctx = { spec, cwd, args: baseArgs(spec), run: deps.run ?? runDocker, probe: deps.probe ?? composePortReady, pollMs: deps.pollMs ?? READINESS_POLL_MS }
  const cfg = await ctx.run([...ctx.args, 'config', '--format', 'json'], cwd, QUERY_TIMEOUT_MS)
  if (cfg.code !== 0) return failure('config', cfg)
  let config: ConfigMap
  try {
    config = parseComposeConfig(cfg.stdout)
  } catch {
    return { ok: false, reason: 'docker compose config did not return JSON (Compose v2 needed)' }
  }
  const before = await listServices(ctx, config)
  if (typeof before === 'string') return { ok: false, reason: before }
  const wanted = before.filter((s) => !isIgnored(s) && (!spec.services?.length || spec.services.includes(s.name)))
  const notRunning = wanted.filter((s) => !s.running && !s.completed).map((s) => s.name)
  const skip = (spec.skipIfRunning ?? true) && notRunning.length === 0
  if (!skip && wanted.length) {
    const up = await ctx.run([...ctx.args, 'up', '-d', ...wanted.map((s) => s.name)], cwd, UP_TIMEOUT_MS)
    if (up.code !== 0) return failure('up', up)
  }
  // From here `up` has run: every failure hands back what it started, so a start-and-stop caller can still stop it.
  const started = skip ? [] : notRunning
  const fail = (reason: string): ComposeOutcome => ({ ok: false, reason, started })
  const deadline = Date.now() + (spec.readinessTimeoutMs ?? READINESS_TIMEOUT_MS)
  const live = await waitForHealthy(ctx, config, new Set(wanted.map((s) => s.name)), deadline)
  if (typeof live === 'string') return fail(live)
  const portFailure = await waitForPorts(ctx, live, deadline)
  if (portFailure) return fail(portFailure)
  const { env, sources } = spec.injectEnv === false ? { env: {}, sources: {} } : connectionEnv(live)
  return { ok: true, env, sources, started }
}

/** Stops only the services this service started (never a stack that was already running). Null on success, else why not. */
export async function stopComposeServices(spec: ComposeSpec, cwd: string, services: string[], run: DockerRunner = runDocker): Promise<string | null> {
  if (!services.length) return null
  const r = await run([...baseArgs(spec), 'stop', ...services], cwd, STOP_TIMEOUT_MS)
  return r.code === 0 ? null : failure('stop', r).reason
}

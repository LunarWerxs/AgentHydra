// Compose-managed dependencies: a process's optional `compose` block brings its
// docker compose stack (Postgres, Redis, a mail catcher...) up BEFORE the process
// spawns, waits until its healthchecks pass and every published port serves, and hands the
// process connection env derived from each service's image (postgres:* gives
// DATABASE_URL). WHY: a dev server started before its database is up fails in a
// confusing way, and hand-copying DATABASE_URL out of a compose file drifts.
//
// The idea follows Spring Boot's docker-compose lifecycle (skip `up` when already
// running, TCP readiness probes, an ignore label, image-based connection details);
// this is a fresh TypeScript implementation, no code copied.
//
// Everything here is pure or takes its side effects (`run`, `probe`) as parameters,
// so the orchestration is testable without a Docker daemon. The Manager wiring
// (when to call it, who holds a started stack) lives in lifecycle.ts.
import { type ChildProcess, spawn } from "node:child_process";
import net from "node:net";
import type { ProcessCompose, ProcessDef } from "../types";

/** A service carrying this label (any value but "false") is left alone: not started, probed or mapped. */
export const COMPOSE_IGNORE_LABEL = "devwebui.ignore";
export const COMPOSE_READINESS_TIMEOUT_MS = 60_000;
const COMPOSE_QUERY_TIMEOUT_MS = 30_000;
// `up -d` may pull images on first use; give it far longer than a query.
const COMPOSE_UP_TIMEOUT_MS = 10 * 60_000;
const COMPOSE_STOP_TIMEOUT_MS = 60_000;
const READINESS_POLL_MS = 500;
const PROBE_CONNECT_MS = 300;
// How long a connected probe listens for an EOF before calling the port ready.
const PROBE_READ_MS = 200;

export interface DockerResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type DockerRunner = (
  args: string[],
  cwd: string,
  timeoutMs: number,
) => Promise<DockerResult>;
export type PortProbe = (port: number, host: string) => Promise<boolean>;

export interface PublishedPort {
  host: string;
  target: number;
  published: number;
}

export interface ComposeService {
  name: string;
  image: string;
  environment: Record<string, string>;
  labels: Record<string, string>;
  running: boolean;
  /** Exited with code 0: a one-shot job (migrations, bucket setup) that finished its work. */
  completed?: boolean;
  /** Compose healthcheck state ("starting", "healthy", "unhealthy"); empty when none is defined. */
  health?: string;
  ports: PublishedPort[];
}

export type ComposeOutcome =
  | {
      ok: true;
      env: Record<string, string>;
      /** Services that were NOT running before this call and were started by it. */
      started: string[];
      /** Which service each injected env key came from (keys only; values carry passwords). */
      sources: Record<string, string>;
    }
  | {
      ok: false;
      reason: string;
      /** Services `up` started before a later step failed, so the caller can still stop them. */
      started?: string[];
    };

/** A compose block is active unless it is absent or explicitly `mode: "none"`. */
export function composeActive(spec: ProcessCompose | undefined): spec is ProcessCompose {
  return !!spec && (spec.mode ?? "start-only") !== "none";
}

/**
 * Identity of a compose stack, so processes sharing one file share one hold. A set
 * `file` is already absolute (file-store.ts resolves it), so it alone names the stack:
 * two processes with different cwds on one file must not hold it separately, or the
 * first to stop in start-and-stop mode would stop the other's database.
 */
export function composeKey(def: ProcessDef): string {
  return def.compose?.file ? `file|${def.compose.file}` : `cwd|${def.cwd}`;
}

function baseArgs(spec: ProcessCompose): string[] {
  return spec.file ? ["compose", "-f", spec.file] : ["compose"];
}

/** Run the docker CLI directly (no shell) and collect its output; never rejects. */
export const runDocker: DockerRunner = (args, cwd, timeoutMs) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (r: DockerResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    let child: ChildProcess;
    try {
      child = spawn("docker", args, { cwd, windowsHide: true });
    } catch (err) {
      finish({ code: null, stdout, stderr: (err as Error).message });
      return;
    }
    timer = setTimeout(() => {
      child.kill();
      finish({ code: null, stdout, stderr: `${stderr}\ndocker ${args.join(" ")} timed out` });
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => finish({ code: null, stdout, stderr: err.message }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });

/** `KEY=VALUE` list or `{KEY: VALUE}` map (compose accepts both) to a string map. */
function toStringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== "string") continue;
      const eq = item.indexOf("=");
      if (eq > 0) out[item.slice(0, eq)] = item.slice(eq + 1);
    }
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      if (v != null) out[k] = String(v);
  }
  return out;
}

/** Parse `docker compose config --format json` into per-service image/env/labels. */
export function parseComposeConfig(
  stdout: string,
): Map<string, Pick<ComposeService, "image" | "environment" | "labels">> {
  const parsed = JSON.parse(stdout) as { services?: Record<string, Record<string, unknown>> };
  const out = new Map<string, Pick<ComposeService, "image" | "environment" | "labels">>();
  for (const [name, svc] of Object.entries(parsed.services ?? {})) {
    out.set(name, {
      image: typeof svc.image === "string" ? svc.image : "",
      environment: toStringMap(svc.environment),
      labels: toStringMap(svc.labels),
    });
  }
  return out;
}

interface PsRow {
  Service?: string;
  State?: string;
  Health?: string;
  ExitCode?: number;
  Publishers?: Array<{
    URL?: string;
    TargetPort?: number;
    PublishedPort?: number;
    Protocol?: string;
  }>;
}

/** Parse `docker compose ps --format json`: a JSON array on older Compose, NDJSON on newer. */
export function parseComposePs(stdout: string): PsRow[] {
  const text = stdout.trim();
  if (!text) return [];
  if (text.startsWith("[")) return JSON.parse(text) as PsRow[];
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as PsRow);
}

/** A wildcard bind is reached through loopback; a specific bind address is used as-is. */
function reachableHost(url: string | undefined): string {
  if (!url || url === "0.0.0.0" || url === "::" || url === "[::]") return "127.0.0.1";
  return url;
}

export function mergeServices(
  config: ReturnType<typeof parseComposeConfig>,
  ps: PsRow[],
): ComposeService[] {
  const rows = new Map<string, PsRow>();
  for (const row of ps) if (row.Service) rows.set(row.Service, row);
  return [...config].map(([name, svc]) => {
    const row = rows.get(name);
    const ports: PublishedPort[] = [];
    for (const p of row?.Publishers ?? []) {
      if (!p.PublishedPort || !p.TargetPort || (p.Protocol && p.Protocol !== "tcp")) continue;
      const port = { host: reachableHost(p.URL), target: p.TargetPort, published: p.PublishedPort };
      if (!ports.some((x) => x.published === port.published)) ports.push(port);
    }
    const state = (row?.State ?? "").toLowerCase();
    return {
      name,
      ...svc,
      running: state === "running",
      completed: state === "exited" && row?.ExitCode === 0,
      health: (row?.Health ?? "").toLowerCase(),
      ports,
    };
  });
}

export function isIgnored(svc: Pick<ComposeService, "labels">): boolean {
  const v = svc.labels[COMPOSE_IGNORE_LABEL];
  return v !== undefined && v.toLowerCase() !== "false";
}

/** `docker.io/library/postgres:16-alpine` or `bitnami/postgresql@sha256:..` to `postgres` / `postgresql`. */
export function imageName(image: string): string {
  const noDigest = image.split("@")[0] ?? "";
  const last = noDigest.split("/").pop() ?? "";
  return last.split(":")[0]?.toLowerCase() ?? "";
}

const enc = encodeURIComponent;
const auth = (user: string, password: string | undefined) =>
  password ? `${enc(user)}:${enc(password)}@` : `${enc(user)}@`;

type EnvMapper = (e: Record<string, string>, host: string, port: number) => Record<string, string>;

interface ImageKind {
  match: RegExp;
  port: number;
  env: EnvMapper;
}

// One entry per well-known dependency image: the container port it serves on and the
// conventional env var(s) an app reads to reach it. Credentials come from the
// service's own compose environment, with each image's documented defaults.
const IMAGE_KINDS: ImageKind[] = [
  {
    match: /^(postgres|postgresql|postgis|pgvector|timescaledb.*)$/,
    port: 5432,
    env: (e, host, port) => {
      const user = e.POSTGRES_USER ?? e.POSTGRESQL_USERNAME ?? "postgres";
      const password = e.POSTGRES_PASSWORD ?? e.POSTGRESQL_PASSWORD;
      const db = e.POSTGRES_DB ?? e.POSTGRESQL_DATABASE ?? user;
      return { DATABASE_URL: `postgres://${auth(user, password)}${host}:${port}/${enc(db)}` };
    },
  },
  {
    match: /^(mysql|mariadb|percona.*)$/,
    port: 3306,
    env: (e, host, port) => {
      const user = e.MYSQL_USER ?? e.MARIADB_USER ?? "root";
      const password =
        user === "root"
          ? (e.MYSQL_ROOT_PASSWORD ?? e.MARIADB_ROOT_PASSWORD)
          : (e.MYSQL_PASSWORD ?? e.MARIADB_PASSWORD);
      const db = e.MYSQL_DATABASE ?? e.MARIADB_DATABASE ?? "";
      return { DATABASE_URL: `mysql://${auth(user, password)}${host}:${port}/${enc(db)}` };
    },
  },
  {
    match: /^(redis|redis-stack|redis-stack-server|valkey|keydb)$/,
    port: 6379,
    env: (e, host, port) => {
      const password = e.REDIS_PASSWORD;
      return { REDIS_URL: `redis://${password ? `:${enc(password)}@` : ""}${host}:${port}` };
    },
  },
  {
    match: /^(mongo|mongodb|mongodb-community-server)$/,
    port: 27017,
    env: (e, host, port) => {
      const user = e.MONGO_INITDB_ROOT_USERNAME;
      const db = e.MONGO_INITDB_DATABASE ?? "";
      const creds = user ? auth(user, e.MONGO_INITDB_ROOT_PASSWORD) : "";
      const query = user ? "?authSource=admin" : "";
      return { MONGODB_URI: `mongodb://${creds}${host}:${port}/${enc(db)}${query}` };
    },
  },
  {
    match: /^rabbitmq$/,
    port: 5672,
    env: (e, host, port) => {
      const user = e.RABBITMQ_DEFAULT_USER ?? "guest";
      const password = e.RABBITMQ_DEFAULT_PASS ?? "guest";
      const vhost = e.RABBITMQ_DEFAULT_VHOST ? `/${enc(e.RABBITMQ_DEFAULT_VHOST)}` : "";
      return { AMQP_URL: `amqp://${auth(user, password)}${host}:${port}${vhost}` };
    },
  },
  {
    match: /^(mailhog|mailpit|maildev)$/,
    port: 1025,
    env: (_e, host, port) => ({ SMTP_HOST: host, SMTP_PORT: String(port) }),
  },
];

/**
 * Connection env for every running, non-ignored service whose image is a known
 * dependency and whose container port is published to the host. The first service
 * to claim a key keeps it, so two Postgres services never silently swap.
 */
export function connectionEnv(services: ComposeService[]): {
  env: Record<string, string>;
  sources: Record<string, string>;
} {
  const env: Record<string, string> = {};
  const sources: Record<string, string> = {};
  for (const svc of services) {
    if (!svc.running || isIgnored(svc)) continue;
    const name = imageName(svc.image);
    const kind = IMAGE_KINDS.find((k) => k.match.test(name));
    const port = kind && svc.ports.find((p) => p.target === kind.port);
    if (!kind || !port) continue;
    const mapped = kind.env(svc.environment, port.host, port.published);
    for (const [key, value] of Object.entries(mapped)) {
      if (key in env) continue;
      env[key] = value;
      sources[key] = svc.name;
    }
  }
  return { env, sources };
}

/**
 * Readiness probe for a published compose port. A plain connect is not enough: the
 * host end is docker-proxy (or the Docker Desktop backend), which accepts as soon as
 * the container exists and then drops the connection while the server inside is
 * still booting. So after connecting, listen briefly: an EOF or reset means nothing
 * is serving yet; data, or a quiet open socket (Postgres and Redis wait for the
 * client to speak first), means ready. Idea from Spring Boot's TCP readiness check.
 */
export const composePortReady: PortProbe = (port, host) =>
  new Promise((resolve) => {
    const sock = new net.Socket();
    let connected = false;
    const done = (v: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(PROBE_CONNECT_MS);
    sock.once("connect", () => {
      connected = true;
      sock.setTimeout(PROBE_READ_MS);
    });
    sock.once("data", () => done(true));
    sock.once("end", () => done(false));
    sock.once("close", () => done(false));
    sock.once("timeout", () => done(connected));
    sock.once("error", () => done(false));
    try {
      sock.connect(port, host);
    } catch {
      done(false);
    }
  });

/** A defined healthcheck that has not yet passed; services without one never wait here. */
function healthPending(svc: ComposeService): boolean {
  return svc.health === "starting" || svc.health === "unhealthy";
}

function failure(step: string, r: DockerResult): { ok: false; reason: string } {
  const detail = r.stderr.trim().split(/\r?\n/).slice(-3).join(" ").trim();
  const hint =
    r.code === null && /ENOENT/i.test(r.stderr) ? "docker was not found on PATH" : detail;
  return { ok: false, reason: `docker compose ${step} failed${hint ? `: ${hint}` : ""}` };
}

type ComposeConfig = ReturnType<typeof parseComposeConfig>;

/** Everything one prepareCompose call threads through its steps. */
interface ComposeRun {
  spec: ProcessCompose;
  cwd: string;
  args: string[];
  run: DockerRunner;
  probe: PortProbe;
  pollMs: number;
}

function pause(ms: number): Promise<unknown> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Read the resolved compose config, or the failure to hand back. */
async function loadComposeConfig(
  ctx: ComposeRun,
): Promise<ComposeConfig | { ok: false; reason: string }> {
  const cfg = await ctx.run(
    [...ctx.args, "config", "--format", "json"],
    ctx.cwd,
    COMPOSE_QUERY_TIMEOUT_MS,
  );
  if (cfg.code !== 0) return failure("config", cfg);
  try {
    return parseComposeConfig(cfg.stdout);
  } catch {
    return { ok: false, reason: "docker compose config did not return JSON (Compose v2 needed)" };
  }
}

/** Every configured service with its live state, or the reason listing failed. */
async function listComposeServices(
  ctx: ComposeRun,
  config: ComposeConfig,
): Promise<ComposeService[] | string> {
  // --all: an exited one-shot job must show up with its exit code, not vanish.
  const ps = await ctx.run(
    [...ctx.args, "ps", "--all", "--format", "json"],
    ctx.cwd,
    COMPOSE_QUERY_TIMEOUT_MS,
  );
  if (ps.code !== 0) return failure("ps", ps).reason;
  try {
    return mergeServices(config, parseComposePs(ps.stdout));
  } catch {
    return "docker compose ps did not return JSON";
  }
}

/**
 * `up -d` the wanted services unless skipIfRunning says every one already runs.
 * Returns the wanted services and the names this call started, or the `up` failure.
 */
async function upWantedServices(
  ctx: ComposeRun,
  before: ComposeService[],
): Promise<{ wanted: ComposeService[]; started: string[] } | { ok: false; reason: string }> {
  const { spec } = ctx;
  const wanted = before.filter(
    (s) => !isIgnored(s) && (!spec.services?.length || spec.services.includes(s.name)),
  );
  const notRunning = wanted.filter((s) => !s.running && !s.completed).map((s) => s.name);
  const skip = (spec.skipIfRunning ?? true) && notRunning.length === 0;
  if (!skip && wanted.length) {
    const names = wanted.map((s) => s.name);
    const up = await ctx.run([...ctx.args, "up", "-d", ...names], ctx.cwd, COMPOSE_UP_TIMEOUT_MS);
    if (up.code !== 0) return failure("up", up);
  }
  return { wanted, started: skip ? [] : notRunning };
}

/** Poll until no wanted service has a pending healthcheck; the live services, or why not. */
async function waitForHealthy(
  ctx: ComposeRun,
  config: ComposeConfig,
  wantedNames: Set<string>,
  deadline: number,
): Promise<ComposeService[] | string> {
  for (;;) {
    const after = await listComposeServices(ctx, config);
    if (typeof after === "string") return after;
    const live = after.filter((s) => wantedNames.has(s.name));
    // A container that exited straight after `up` (bad config, port clash) would
    // otherwise pass readiness vacuously: it publishes no ports to probe.
    const down = live.filter((s) => !s.running && !s.completed).map((s) => s.name);
    if (down.length) return `compose service(s) not running: ${down.join(", ")}`;
    // A defined healthcheck is the stack's own word on readiness: wait it out first.
    const unhealthy = live.filter(healthPending).map((s) => s.name);
    if (!unhealthy.length) return live;
    if (Date.now() >= deadline)
      return `compose service(s) not healthy in time: ${unhealthy.join(", ")}`;
    await pause(ctx.pollMs);
  }
}

/** Probe one published port until it serves; null when ready, else the timeout reason. */
async function waitForPort(
  ctx: ComposeRun,
  svc: ComposeService,
  port: PublishedPort,
  deadline: number,
): Promise<string | null> {
  for (;;) {
    if (await ctx.probe(port.published, port.host)) return null;
    if (Date.now() >= deadline)
      return `compose service "${svc.name}" did not accept connections on ${port.host}:${port.published} in time`;
    await pause(ctx.pollMs);
  }
}

/** Wait for every published port of every live service, in order; the first timeout wins. */
async function waitForPorts(
  ctx: ComposeRun,
  live: ComposeService[],
  deadline: number,
): Promise<string | null> {
  for (const svc of live) {
    for (const port of svc.ports) {
      const reason = await waitForPort(ctx, svc, port, deadline);
      if (reason) return reason;
    }
  }
  return null;
}

/**
 * Bring a process's compose stack up and wait for it. Steps: read the resolved
 * config (images, env, labels), list what is running, `up -d` the wanted services
 * unless every one is already running (skipIfRunning, default on), then wait until
 * every defined healthcheck passes and each published port serves (composePortReady),
 * or the readiness timeout passes. A service that exited 0 (a one-shot init job) is
 * done, not down: it neither triggers an `up` nor fails the start.
 */
export async function prepareCompose(
  spec: ProcessCompose,
  cwd: string,
  deps: { run?: DockerRunner; probe?: PortProbe; pollMs?: number } = {},
): Promise<ComposeOutcome> {
  const ctx: ComposeRun = {
    spec,
    cwd,
    args: baseArgs(spec),
    run: deps.run ?? runDocker,
    probe: deps.probe ?? composePortReady,
    pollMs: deps.pollMs ?? READINESS_POLL_MS,
  };

  const config = await loadComposeConfig(ctx);
  if (!(config instanceof Map)) return config;

  const before = await listComposeServices(ctx, config);
  if (typeof before === "string") return { ok: false, reason: before };
  const plan = await upWantedServices(ctx, before);
  if ("reason" in plan) return plan;

  // From here on `up` has run: every failure hands back what it started, so a
  // start-and-stop caller can still stop it.
  const { wanted, started } = plan;
  const fail = (reason: string): ComposeOutcome => ({ ok: false, reason, started });
  const wantedNames = new Set(wanted.map((s) => s.name));
  const deadline = Date.now() + (spec.readinessTimeoutMs ?? COMPOSE_READINESS_TIMEOUT_MS);
  const live = await waitForHealthy(ctx, config, wantedNames, deadline);
  if (typeof live === "string") return fail(live);
  const portFailure = await waitForPorts(ctx, live, deadline);
  if (portFailure) return fail(portFailure);

  const { env, sources } =
    spec.injectEnv === false ? { env: {}, sources: {} } : connectionEnv(live);
  return { ok: true, env, sources, started };
}

/** Stop only the services this daemon started (never a stack the user had running already). */
export async function stopComposeServices(
  spec: ProcessCompose,
  cwd: string,
  services: string[],
  run: DockerRunner = runDocker,
): Promise<string | null> {
  if (!services.length) return null;
  const r = await run([...baseArgs(spec), "stop", ...services], cwd, COMPOSE_STOP_TIMEOUT_MS);
  return r.code === 0 ? null : failure("stop", r).reason;
}

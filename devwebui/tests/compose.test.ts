// Compose-managed dependencies (manager/compose.ts): pins the contract a `.devwebui`
// `compose` block promises without needing a Docker daemon: `up` is skipped when the
// stack already runs, services labelled devwebui.ignore are never started or mapped,
// only services this call started are reported for a later stop, and a published
// Postgres/Redis yields DATABASE_URL/REDIS_URL pointing at the HOST port.
import { expect, test } from "bun:test";
import net from "node:net";
import {
  type ComposeService,
  composeKey,
  composePortReady,
  connectionEnv,
  type DockerResult,
  imageName,
  parseComposePs,
  prepareCompose,
} from "../server/src/manager/compose";
import type { ProcessDef } from "../server/src/types";

const CONFIG = JSON.stringify({
  services: {
    db: {
      image: "postgres:16-alpine",
      environment: {
        POSTGRES_USER: "app",
        POSTGRES_PASSWORD: "p@ss word",
        POSTGRES_DB: "appdb",
      },
    },
    cache: { image: "docker.io/library/redis:7" },
    tool: { image: "adminer", labels: { "devwebui.ignore": "true" } },
  },
});

const row = (service: string, target: number, published: number) =>
  JSON.stringify({
    Service: service,
    State: "running",
    Publishers: [{ URL: "0.0.0.0", TargetPort: target, PublishedPort: published }],
  });

/** A fake docker CLI: `ps` answers from `running`, `up` marks every named service running. */
function fakeDocker(initiallyRunning: string[]) {
  const running = new Set(initiallyRunning);
  const calls: string[][] = [];
  const ports: Record<string, [number, number]> = { db: [5432, 55432], cache: [6379, 56379] };
  const run = async (args: string[]): Promise<DockerResult> => {
    calls.push(args);
    if (args.includes("config")) return { code: 0, stdout: CONFIG, stderr: "" };
    if (args.includes("ps")) {
      const lines = [...running].map((s) => row(s, ...(ports[s] ?? ([80, 8080] as const))));
      return { code: 0, stdout: lines.join("\n"), stderr: "" };
    }
    if (args.includes("up")) {
      for (const s of args.slice(args.indexOf("-d") + 1)) running.add(s);
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  return { run, calls };
}

const probe = async () => true;

test("prepareCompose: an already-running stack is not brought up again", async () => {
  const docker = fakeDocker(["db", "cache"]);
  const res = await prepareCompose({}, ".", { run: docker.run, probe });
  expect(res.ok).toBe(true);
  expect(docker.calls.some((a) => a.includes("up"))).toBe(false);
  if (res.ok) expect(res.started).toEqual([]);
});

test("prepareCompose: starts only the stopped, non-ignored services and reports them", async () => {
  const docker = fakeDocker(["cache"]);
  const res = await prepareCompose({}, ".", { run: docker.run, probe });
  const up = docker.calls.find((a) => a.includes("up"));
  expect(up).toEqual(["compose", "up", "-d", "db", "cache"]);
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.started).toEqual(["db"]);
  // Built from parts: the WHATWG URL setters percent-encode the fixture password
  // independently of the encodeURIComponent the code under test uses.
  const expectedDbUrl = new URL("postgres://127.0.0.1:55432/appdb");
  expectedDbUrl.username = "app";
  expectedDbUrl.password = "p@ss word";
  expect(res.env.DATABASE_URL).toBe(expectedDbUrl.href);
  expect(res.env.REDIS_URL).toBe("redis://127.0.0.1:56379");
  expect(res.sources).toEqual({ DATABASE_URL: "db", REDIS_URL: "cache" });
});

test("prepareCompose: a port that never opens fails the start instead of spawning", async () => {
  const docker = fakeDocker(["db"]);
  const spec = { services: ["db"], readinessTimeoutMs: 1 };
  const deps = { run: docker.run, probe: async () => false, pollMs: 1 };
  const res = await prepareCompose(spec, ".", deps);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.reason).toContain("55432");
});

// Regression: readiness once passed on the first TCP connect, which docker-proxy accepts
// before the database inside listens. The start must wait out every "not yet" answer.
test("prepareCompose: keeps probing until the port serves, then succeeds", async () => {
  const docker = fakeDocker(["db"]);
  let calls = 0;
  const probe = async () => ++calls > 3;
  const deps = { run: docker.run, probe, pollMs: 1 };
  const res = await prepareCompose({ services: ["db"] }, ".", deps);
  expect(res.ok).toBe(true);
  expect(calls).toBe(4);
});

test("prepareCompose: waits while a defined healthcheck is still starting", async () => {
  let psCalls = 0;
  const run = async (args: string[]): Promise<DockerResult> => {
    if (args.includes("config")) return { code: 0, stdout: CONFIG, stderr: "" };
    if (args.includes("ps")) {
      psCalls++;
      const health = psCalls < 4 ? "starting" : "healthy";
      const stdout = JSON.stringify({ Service: "db", State: "running", Health: health });
      return { code: 0, stdout, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  const res = await prepareCompose({ services: ["db"] }, ".", { run, probe, pollMs: 1 });
  expect(res.ok).toBe(true);
  expect(psCalls).toBe(4);
});

// Regression: an init job (migrations, bucket setup) exits after `up` and used to be
// reported "not running", failing every start of a stack that has one.
test("prepareCompose: a one-shot job that exited 0 neither triggers up nor fails", async () => {
  const docker = fakeDocker(["db"]);
  const run = async (args: string[]): Promise<DockerResult> => {
    const r = await docker.run(args);
    if (!args.includes("ps")) return r;
    const init = JSON.stringify({ Service: "cache", State: "exited", ExitCode: 0 });
    return { ...r, stdout: `${r.stdout}\n${init}` };
  };
  const res = await prepareCompose({}, ".", { run, probe });
  expect(res.ok).toBe(true);
  expect(docker.calls.some((a) => a.includes("up"))).toBe(false);
});

test("prepareCompose: a readiness failure after up still reports what up started", async () => {
  const docker = fakeDocker([]);
  const spec = { services: ["db"], readinessTimeoutMs: 1 };
  const deps = { run: docker.run, probe: async () => false, pollMs: 1 };
  const res = await prepareCompose(spec, ".", deps);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.started).toEqual(["db"]);
});

test("composeKey: one compose file is one stack whatever the process cwd", () => {
  const def = (cwd: string, file?: string) => ({ cwd, compose: { file } }) as ProcessDef;
  const file = "/repo/compose.yaml";
  expect(composeKey(def("/a", file))).toBe(composeKey(def("/b", file)));
  expect(composeKey(def("/a"))).not.toBe(composeKey(def("/b")));
});

/** Listen on an ephemeral loopback port; `onConn` decides what each accepted socket gets. */
async function withServer(onConn: (s: net.Socket) => void, body: (port: number) => Promise<void>) {
  const server = net.createServer(onConn);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await body((server.address() as net.AddressInfo).port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// Contract of the real probe: a connection the host end drops at once (docker-proxy with
// nothing behind it) is NOT ready; one held open quietly (Postgres, Redis) or greeted is.
test("composePortReady: accept-then-close is not ready; held open or greeting is", async () => {
  await withServer(
    (s) => s.destroy(),
    async (port) => expect(await composePortReady(port, "127.0.0.1")).toBe(false),
  );
  const held: net.Socket[] = [];
  await withServer(
    (s) => held.push(s),
    async (port) => {
      expect(await composePortReady(port, "127.0.0.1")).toBe(true);
      for (const s of held) s.destroy();
    },
  );
  await withServer(
    (s) => s.end("greeting\n"),
    async (port) => expect(await composePortReady(port, "127.0.0.1")).toBe(true),
  );
});

test("connectionEnv: ignored, stopped or unpublished services inject nothing", () => {
  const svc = (over: Partial<ComposeService>): ComposeService => ({
    name: "db",
    image: "postgres:16",
    environment: {},
    labels: {},
    running: true,
    ports: [{ host: "127.0.0.1", target: 5432, published: 5432 }],
    ...over,
  });
  expect(connectionEnv([svc({ labels: { "devwebui.ignore": "" } })]).env).toEqual({});
  expect(connectionEnv([svc({ running: false })]).env).toEqual({});
  expect(connectionEnv([svc({ ports: [] })]).env).toEqual({});
  expect(connectionEnv([svc({})]).env.DATABASE_URL).toBe(
    "postgres://postgres@127.0.0.1:5432/postgres",
  );
});

test("imageName and parseComposePs accept every shape Compose emits", () => {
  expect(imageName("ghcr.io/org/postgres:16@sha256:abc")).toBe("postgres");
  expect(imageName("localhost:5000/redis")).toBe("redis");
  const one = { Service: "db", State: "running" };
  expect(parseComposePs(JSON.stringify([one]))).toEqual([one]);
  expect(parseComposePs(`${JSON.stringify(one)}\n${JSON.stringify(one)}\n`)).toHaveLength(2);
  expect(parseComposePs("")).toEqual([]);
});

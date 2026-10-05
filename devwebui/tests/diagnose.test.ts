// ───────────────────────────────────────────────────────────────────────────────
// Incident Autopilot: fabricate error records/exit states per heuristic and assert
// the diagnosis. Each heuristic is exercised in isolation (net/fs are real — a
// temp dir + a real listening socket — everything else is a plain in-memory
// ProcessDef/ErrorEvent fixture, following the ports/scan test idioms).
// ───────────────────────────────────────────────────────────────────────────────
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { diagnose } from "../server/src/diagnose";
import type { ErrorEvent } from "../server/src/errors";
import type { ProcessDef } from "../server/src/types";

function def(overrides: Partial<ProcessDef> = {}): ProcessDef {
  return {
    id: "project.web",
    localId: "web",
    name: "Web",
    command: "npm run dev",
    cwd: path.join(import.meta.dir, ".."),
    projectId: "project",
    projectName: "Project",
    ...overrides,
  };
}

function errorEvent(sample: string, overrides: Partial<ErrorEvent> = {}): ErrorEvent {
  return {
    fingerprint: "fp",
    processId: "project.web",
    localId: "web",
    processName: "Web",
    projectId: "project",
    projectName: "Project",
    source: "crash",
    sample,
    count: 1,
    firstSeen: Date.now(),
    lastSeen: Date.now(),
    ...overrides,
  };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "devwebui-diagnose-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function listenOn(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(port, () => resolve(srv));
  });
}
function close(srv: net.Server): Promise<void> {
  return new Promise((r) => srv.close(() => r()));
}
function portOf(srv: net.Server): number {
  return (srv.address() as net.AddressInfo).port;
}

// ---- heuristic 1: port-in-use ---------------------------------------------

// The two tests below are the only ones here that reach portOwners(), and on Windows that shells
// out to `powershell -NoProfile -Command` running Get-NetTCPConnection + Get-Process +
// Get-CimInstance. The first such call on a cold machine pays PowerShell startup AND the
// autoloading of the NetTCPIP and CimCmdlets modules, which locally is ~1.5s but on a loaded
// windows-latest runner repeatedly blew past bun's 5s default and failed CI on `main` — with the
// late assertion then surfacing as a confusing "unhandled error between tests" rather than as the
// timeout it was. The product is not slow in a way anybody feels (a diagnosis runs once, after a
// crash), so the honest fix is to stop holding a real process-enumeration round trip to a timeout
// meant for in-memory tests. Matches the 10s explicit timeouts already used in links.test.ts and
// errors-current.test.ts, with more headroom because this path spawns a shell.
//
// DO NOT raise this number when it goes red again. That was tried (5s → 20s) and it went red at
// ~20014ms on 2026-08-15, because the real defect was never the allowance: collectStdout resolves
// with partial output on timeout, so a slow PowerShell returned "" and portOwners reported the
// port as unowned, dropping a plainly-occupied port to low confidence. ports.ts now falls back to
// `netstat -ano` for the PID, which is a native binary with nothing to autoload, so the answer no
// longer depends on this allowance at all — worst case is ~8s (the probe) plus a few hundred ms.
// A failure here now means something real.
const PORT_OWNER_TIMEOUT_MS = 30_000;

test(
  "diagnose: port-in-use names the squatter with high confidence",
  async () => {
    const holder = await listenOn(0);
    const port = portOf(holder);
    try {
      const result = await diagnose({
        def: def({ port }),
        status: "crashed",
        exitCode: 1,
        errors: [],
      });
      expect(result.confidence).toBe("high");
      expect(result.rootCause).toContain(`port ${port}`);
      expect(result.rootCause).toContain("already in use");
      expect(result.remediation?.suggestedTool).toBe("start_process");
      expect(result.remediation?.params).toMatchObject({ port, id: "project.web" });
      expect(result.evidence.some((e) => e.includes(String(port)))).toBe(true);
    } finally {
      await close(holder);
    }
  },
  PORT_OWNER_TIMEOUT_MS,
);

test(
  "diagnose: a free declared port does not trigger the port-in-use heuristic",
  async () => {
    const probe = await listenOn(0);
    const port = portOf(probe);
    await close(probe); // free again

    const result = await diagnose({
      def: def({ port }),
      status: "crashed",
      exitCode: 1,
      errors: [],
    });
    expect(result.rootCause).not.toContain("already in use");
  },
  PORT_OWNER_TIMEOUT_MS,
);

// ---- heuristic 2: known exit-code / error-pattern table --------------------

test("diagnose: EADDRINUSE in the error log is recognized even without a live squatter", async () => {
  const result = await diagnose({
    def: def({ port: undefined }),
    status: "crashed",
    exitCode: 1,
    errors: [errorEvent("Error: listen EADDRINUSE: address already in use :::5173")],
  });
  expect(result.confidence).toBe("high");
  expect(result.rootCause).toContain("EADDRINUSE");
  expect(result.remediation?.suggestedTool).toBe("restart_process");
});

test.each([
  [
    "ECONNREFUSED names the port of the refused dependency",
    1,
    "Error: connect ECONNREFUSED 127.0.0.1:5432",
    [/5432/, /running\?/i],
  ],
  [
    "MODULE_NOT_FOUND / Cannot find module is recognized",
    1,
    "Error: Cannot find module 'lodash'\nrequire stack: ...",
    [/lodash/, /MODULE_NOT_FOUND/],
  ],
  [
    "command-not-found (unix) is recognized",
    127,
    "/bin/sh: 1: turbo: not found",
    [/turbo/, /not found on path/i],
  ],
  [
    "command-not-found (windows) is recognized",
    1,
    "'nonexistent-cli' is not recognized as an internal or external command",
    [/nonexistent-cli/],
  ],
  [
    "missing env var pattern is recognized",
    1,
    "Error: DATABASE_URL is not defined",
    [/DATABASE_URL/],
  ],
])("diagnose: %s", async (_name, exitCode, sample, rootCause) => {
  const result = await diagnose({
    def: def(),
    status: "crashed",
    exitCode,
    errors: [errorEvent(sample)],
  });
  expect(result.confidence).toBe("high");
  for (const pattern of rootCause) expect(result.rootCause).toMatch(pattern);
});

test("diagnose: exitCode 0 does not trigger the known-error heuristic even with matching text in old logs", async () => {
  const result = await diagnose({
    def: def(),
    status: "stopped",
    exitCode: 0,
    errors: [errorEvent("Error: Cannot find module 'lodash'")],
  });
  expect(result.rootCause).not.toContain("MODULE_NOT_FOUND");
});

// ---- Time-Travel Log Vault integration: logTail as a fallback evidence source -----

test("diagnose: an empty de-duped error log falls back to the log-vault tail for the known-error match", async () => {
  const result = await diagnose({
    def: def(),
    status: "crashed",
    exitCode: 1,
    errors: [], // nothing recorded by ErrorRecorder (e.g. its own filters didn't trip)
    logTail: ["some setup output", "Error: connect ECONNREFUSED 127.0.0.1:5432", "more output"],
  });
  expect(result.confidence).toBe("high");
  expect(result.rootCause).toContain("5432");
  expect(result.evidence.some((e) => e.includes("recent log tail"))).toBe(true);
});

test("diagnose: logTail is ignored when the de-duped error log already has a sample", async () => {
  const result = await diagnose({
    def: def(),
    status: "crashed",
    exitCode: 1,
    errors: [errorEvent("Error: Cannot find module 'lodash'")],
    logTail: ["Error: connect ECONNREFUSED 127.0.0.1:5432"], // should NOT be consulted
  });
  expect(result.rootCause).toContain("lodash");
  expect(result.evidence.some((e) => e.includes("recent log tail"))).toBe(false);
});

test("diagnose: omitting logTail entirely changes nothing (backward compatible)", async () => {
  const result = await diagnose({
    def: def(),
    status: "crashed",
    exitCode: 1,
    errors: [],
  });
  expect(result.rootCause).toBe("unknown");
  expect(result.confidence).toBe("low");
});

// ---- heuristic 3: missing/invalid script -----------------------------------

test("diagnose: missing package.json script falls back to the script-check heuristic", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "app", scripts: { build: "vite build" } }),
    );
    const result = await diagnose({
      def: def({ command: "npm run dev", cwd: dir }),
      status: "crashed",
      exitCode: 1,
      errors: [],
    });
    expect(result.confidence).toBe("medium");
    expect(result.rootCause).toContain("doesn't resolve");
    expect(result.evidence.some((e) => e.includes('no "dev" script'))).toBe(true);
    expect(result.remediation?.suggestedTool).toBe("restart_process");
  });
});

test("diagnose: missing package.json entirely is reported", async () => {
  await withTempDir(async (dir) => {
    const result = await diagnose({
      def: def({ command: "pnpm dev", cwd: dir }),
      status: "crashed",
      exitCode: 1,
      errors: [],
    });
    expect(result.confidence).toBe("medium");
    expect(result.rootCause).toContain("no package.json");
  });
});

test("diagnose: a script that DOES exist doesn't trip the script-check heuristic", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "app", scripts: { dev: "vite" } }),
    );
    const result = await diagnose({
      def: def({ command: "npm run dev", cwd: dir }),
      status: "crashed",
      exitCode: 1,
      errors: [],
    });
    expect(result.rootCause).toBe("unknown"); // no other heuristic matched either
  });
});

// ---- fallback ---------------------------------------------------------------

test("diagnose: falls back to unknown with low confidence and gathered evidence when nothing matches", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "app", scripts: { dev: "vite" } }),
    );
    const result = await diagnose({
      def: def({ command: "npm run dev", cwd: dir }),
      status: "running",
      exitCode: null,
      errors: [],
    });
    expect(result.rootCause).toBe("unknown");
    expect(result.confidence).toBe("low");
    expect(result.remediation).toBeNull();
    expect(result.evidence.length).toBeGreaterThan(0);
  });
});

// Tests for the shared running-instance pointer (SHARED LunarWerx server-lib — source of truth:
// lunarwerx-ui/src/server-lib/instance-pointer.test.ts, synced by sync.mjs into each app's
// `serverTests` dir under a `server-lib/` subdir next to the app's server tree). The
// `../../src/instance-pointer.mjs` import resolves only from that synced location — sync.mjs
// validates the placement — so this file is NOT runnable inside the kit repo itself.
//
// The daemon records the port it ACTUALLY bound in <configDir>/runtime.json so launchers can
// reconnect. These tests pin the file round-trip, the core-fields-win merge rule, the update /
// clear semantics, and that a missing/dead pointer reads as "nothing running".
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInstancePointer } from "../../src/instance-pointer.mjs";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "lunarwerx-instance-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }
});

test("writeInstanceInfo → readInstanceInfo round-trips the bound port, url, and pid", () => {
  const configDir = tempDir();
  const ptr = createInstancePointer({ configDir, serviceName: "testapp" });
  ptr.writeInstanceInfo(4321);

  const info = ptr.readInstanceInfo();
  expect(info?.port).toBe(4321);
  expect(info?.url).toBe("http://127.0.0.1:4321");
  expect(info?.pid).toBe(process.pid);
  expect(typeof info?.startedAt).toBe("number");
});

test("instanceFilePath points at runtime.json inside the config dir", () => {
  const configDir = tempDir();
  const ptr = createInstancePointer({ configDir });
  expect(ptr.instanceFilePath()).toBe(join(configDir, "runtime.json"));
});

test("a custom host is reflected in the recorded url", () => {
  const configDir = tempDir();
  const ptr = createInstancePointer({ configDir, host: "0.0.0.0" });
  ptr.writeInstanceInfo(8080);
  expect(ptr.readInstanceInfo()?.url).toBe("http://0.0.0.0:8080");
});

test("extra launcher fields are persisted, but core fields win on a key collision", () => {
  const configDir = tempDir();
  const ptr = createInstancePointer({ configDir });
  // `port` here must be ignored (the real bound port wins); `portableMode` must survive.
  ptr.writeInstanceInfo(5000, { portableMode: true, port: 9999 });

  const info = ptr.readInstanceInfo();
  expect(info?.port).toBe(5000);
  expect(info?.portableMode).toBe(true);
});

test("updateInstanceInfo merges into an existing pointer and leaves core fields intact", () => {
  const configDir = tempDir();
  const ptr = createInstancePointer({ configDir });
  ptr.writeInstanceInfo(6000);
  ptr.updateInstanceInfo({ portableMode: true });

  const info = ptr.readInstanceInfo();
  expect(info?.port).toBe(6000);
  expect(info?.portableMode).toBe(true);
});

test("updateInstanceInfo is a no-op when no pointer exists yet", () => {
  const configDir = tempDir();
  const ptr = createInstancePointer({ configDir });
  ptr.updateInstanceInfo({ portableMode: true });
  expect(ptr.readInstanceInfo()).toBeNull();
});

test("clearInstanceInfo removes the pointer", () => {
  const configDir = tempDir();
  const ptr = createInstancePointer({ configDir });
  ptr.writeInstanceInfo(7000);
  ptr.clearInstanceInfo();
  expect(ptr.readInstanceInfo()).toBeNull();
});

test("clearInstanceInfo leaves ANOTHER process's pointer alone", () => {
  // The 2026-07-14 stale-daemon incident: a second daemon boots, loses the single-instance race,
  // and its exit handler deletes the RUNNING daemon's pointer — leaving the survivor invisible to
  // every launcher and restart script. Deletion is owner-only, so a foreign pid must survive.
  const configDir = tempDir();
  const ptr = createInstancePointer({ configDir });
  ptr.writeInstanceInfo(7000);
  const foreign = { ...ptr.readInstanceInfo(), pid: process.pid + 1 };
  writeFileSync(join(configDir, "runtime.json"), JSON.stringify(foreign));

  ptr.clearInstanceInfo();

  expect(ptr.readInstanceInfo()).not.toBeNull();
  expect(ptr.readInstanceInfo()?.pid).toBe(process.pid + 1);
});

test("clearInstanceInfo removes a legacy pointer that records no pid", () => {
  // Ownership is unprovable without a pid, so the old unconditional behavior is the fallback:
  // better to clear a pointer we can't attribute than to leave one nobody will ever remove.
  const configDir = tempDir();
  const ptr = createInstancePointer({ configDir });
  writeFileSync(join(configDir, "runtime.json"), JSON.stringify({ port: 7000 }));
  ptr.clearInstanceInfo();
  expect(ptr.readInstanceInfo()).toBeNull();
});

test("readInstanceInfo returns null for a missing or corrupt pointer", () => {
  const configDir = tempDir();
  const ptr = createInstancePointer({ configDir });
  expect(ptr.readInstanceInfo()).toBeNull(); // missing

  writeFileSync(join(configDir, "runtime.json"), "{ not valid json");
  expect(ptr.readInstanceInfo()).toBeNull(); // corrupt
});

test("findLiveInstance resolves null when no pointer is recorded (no network probe)", async () => {
  const configDir = tempDir();
  const ptr = createInstancePointer({ configDir, serviceName: "testapp" });
  expect(await ptr.findLiveInstance()).toBeNull();
});

test("findLiveInstance resolves null for a stale pointer whose port answers nothing", async () => {
  const configDir = tempDir();
  const ptr = createInstancePointer({ configDir, serviceName: "testapp" });
  // Port 1 is privileged and never hosts an app daemon → the health probe is refused fast.
  ptr.writeInstanceInfo(1);
  expect(await ptr.findLiveInstance(300)).toBeNull();
});

// --- retry semantics (the duplicate-daemon guard) ------------------------------------------
// A single probe is a coin flip: a live-but-busy daemon that misses one probe reads as "nothing
// running", and a caller deciding whether to SPAWN then starts a second daemon that hops to
// PORT+1. These pin that `attempts` absorbs a transient miss, that the default stays a single
// cheap probe, and that a foreign service is answered definitively without burning retries.

test("findLiveInstance retries a transient failure and succeeds when attempts > 1", async () => {
  const configDir = tempDir();
  let hits = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      hits++;
      // Two "busy" replies, then healthy — a daemon that was alive the whole time.
      if (hits < 3) return new Response("busy", { status: 503 });
      return Response.json({ ok: true, service: "testapp" });
    },
  });
  try {
    const ptr = createInstancePointer({ configDir, serviceName: "testapp" });
    const port = server.port ?? 0;
    ptr.writeInstanceInfo(port);

    // Default (single probe) sees only the 503 and wrongly concludes "nothing running".
    expect(await ptr.findLiveInstance(500)).toBeNull();
    expect(hits).toBe(1);

    // With retries the daemon is correctly found, so no duplicate would be spawned.
    const live = await ptr.findLiveInstance(500, 3);
    expect(live?.port).toBe(port);
    expect(hits).toBe(3);
  } finally {
    server.stop(true);
  }
});

test("findLiveInstance gives up after exactly `attempts` probes", async () => {
  const configDir = tempDir();
  let hits = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      hits++;
      return new Response("busy", { status: 503 });
    },
  });
  try {
    const ptr = createInstancePointer({ configDir, serviceName: "testapp" });
    const port = server.port ?? 0;
    ptr.writeInstanceInfo(port);
    expect(await ptr.findLiveInstance(500, 3)).toBeNull();
    expect(hits).toBe(3);
  } finally {
    server.stop(true);
  }
});

test("findLiveInstance does not retry a service mismatch — a foreign server is definitive", async () => {
  const configDir = tempDir();
  let hits = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      hits++;
      return Response.json({ ok: true, service: "some-other-app" });
    },
  });
  try {
    const ptr = createInstancePointer({ configDir, serviceName: "testapp" });
    const port = server.port ?? 0;
    ptr.writeInstanceInfo(port);
    expect(await ptr.findLiveInstance(500, 5)).toBeNull();
    expect(hits).toBe(1); // answered on the first probe; retrying it would be pointless
  } finally {
    server.stop(true);
  }
});

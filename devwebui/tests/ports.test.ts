// ───────────────────────────────────────────────────────────────────────────────
// Port helpers back two shipped behaviors: the daemon "hops" to the next free port
// instead of crashing on a busy one (findFreePort), and the launcher probes whether
// an instance is already listening (isPortListening). Exercised against real local
// sockets so the cross-platform bind/connect path is what's actually tested.
// ───────────────────────────────────────────────────────────────────────────────
import { test, expect } from "bun:test";
import net from "node:net";
import {
  findFreePort,
  isPortListening,
  parseNetstatPids,
  parseTasklistName,
} from "../server/src/ports";

// Bind with the SAME defaults findFreePort uses (no explicit host) so an occupied
// port genuinely collides with its bind attempt.
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

test("isPortListening reflects whether something is bound", async () => {
  const probe = await listenOn(0); // OS picks a free port
  const port = portOf(probe);
  await close(probe);
  expect(await isPortListening(port)).toBe(false); // nothing there now

  const srv = await listenOn(port);
  try {
    expect(await isPortListening(port)).toBe(true);
  } finally {
    await close(srv);
  }
});

test("findFreePort returns the preferred port when it is free", async () => {
  const probe = await listenOn(0);
  const port = portOf(probe);
  await close(probe); // free again
  expect(await findFreePort(port)).toBe(port);
});

test("findFreePort steps past an occupied port to the next free one", async () => {
  const srv = await listenOn(0);
  const port = portOf(srv);
  try {
    const got = await findFreePort(port);
    expect(got).toBeGreaterThan(port); // hopped over the busy port to a bindable one
  } finally {
    await close(srv);
  }
});

// ---- the netstat fallback --------------------------------------------------
// portOwners' primary Windows probe is a PowerShell one-liner, and collectStdout resolves with
// whatever it has when that times out, so a slow shell and a free port are indistinguishable to
// the caller. That put "port in use" diagnoses on the wrong side of a race twice (red on main at
// ~5010ms, then again at ~20014ms after the timeout was raised). netstat now answers the PID
// question on its own; these cover the parse, which is the only part of that a test can stage.

const NETSTAT_SAMPLE = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:5173           0.0.0.0:0              LISTENING       4242
  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       4242
  TCP    [::]:5173              [::]:0                 LISTENING       4242
  TCP    0.0.0.0:15173          0.0.0.0:0              LISTENING       9999
  TCP    127.0.0.1:5173         127.0.0.1:60123        ESTABLISHED     7777
  TCP    127.0.0.1:60123        127.0.0.1:5173         ESTABLISHED     8888
  UDP    0.0.0.0:5173           *:*                                    5555
`;

test("parseNetstatPids finds the listener, deduping its IPv4/IPv6/loopback rows", () => {
  expect(parseNetstatPids(NETSTAT_SAMPLE, 5173)).toEqual([4242]);
});

test("parseNetstatPids reports listeners only, matching the primary probe's -State Listen", () => {
  // pid 7777's local port IS 5173, but it is an accepted connection, not the listener. Admitting
  // it would give the two code paths different answers about which PID to name as the squatter.
  expect(parseNetstatPids(NETSTAT_SAMPLE, 5173)).not.toContain(7777);
  // …and a client dialling OUT to 5173 is never an owner of it either.
  expect(parseNetstatPids(NETSTAT_SAMPLE, 5173)).not.toContain(8888);
});

test("parseNetstatPids does not let 5173 match 15173", () => {
  expect(parseNetstatPids(NETSTAT_SAMPLE, 15173)).toEqual([9999]);
});

test("parseNetstatPids ignores UDP rows, which carry no state column", () => {
  // The UDP row above is on port 5173 with pid 5555 — a four-column row, so it must not appear.
  expect(parseNetstatPids(NETSTAT_SAMPLE, 5173)).not.toContain(5555);
});

test("parseNetstatPids reads a LOCALISED state column, since it never looks at one", () => {
  // German Windows prints "ABHÖREN". Matching the English word would return nothing here, which
  // is precisely the silent-empty failure this fallback exists to prevent.
  const german = "  TCP    0.0.0.0:5173           0.0.0.0:0              ABHÖREN         4242\n";
  expect(parseNetstatPids(german, 5173)).toEqual([4242]);
});

test("parseNetstatPids returns nothing for a genuinely free port", () => {
  expect(parseNetstatPids(NETSTAT_SAMPLE, 8080)).toEqual([]);
});

test("parseNetstatPids skips pid 0, which is the idle process rather than a squatter", () => {
  const idle = "  TCP    0.0.0.0:5173           0.0.0.0:0              LISTENING       0\n";
  expect(parseNetstatPids(idle, 5173)).toEqual([]);
});

test("parseTasklistName takes the image name and drops .exe, matching Get-Process", () => {
  expect(parseTasklistName('"node.exe","4242","Console","1","118,364 K"')).toBe("node");
});

test("parseTasklistName reports nothing when tasklist matched no process", () => {
  expect(
    parseTasklistName("INFO: No tasks are running which match the specified criteria."),
  ).toBeUndefined();
});

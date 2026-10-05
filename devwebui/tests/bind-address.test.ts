// Regression guard for a single security-critical literal: server/src/index.ts's real
// Bun.serve() call MUST bind loopback only. Bun.serve defaults `hostname` to 0.0.0.0 when the
// option is omitted, which would put the daemon's unauthenticated, command-spawning API on
// every network interface (see the comment right above the serve() call in index.ts).
//
// index.ts is the daemon's actual entrypoint: importing it for real runs the WHOLE boot
// sequence (the single-instance guard's network probe, materializeSettings, a real Bun.serve
// on a real port, opening a browser tab...) as top-level side effects with nothing exported to
// stub. That's too heavy and too flaky for a unit test, so — per the task brief — this asserts
// against the SOURCE TEXT instead: it reads the exact literal Bun.serve() passes at runtime, so
// it can't drift from what actually ships, and it fails loudly the moment `hostname` is ever
// dropped or changed to something non-loopback.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const indexSource = readFileSync(path.resolve(import.meta.dir, "../server/src/index.ts"), "utf8");

test("the daemon's Bun.serve() call pins a loopback hostname", () => {
  const serveCall = indexSource.match(/bunRuntime\.serve\(\{[\s\S]*?\}\);/);
  expect(serveCall).not.toBeNull();
  const hostnameMatch = serveCall![0].match(/hostname:\s*"([^"]+)"/);
  expect(hostnameMatch).not.toBeNull();
  const hostname = hostnameMatch![1];
  // Loopback, not "omitted" (which Bun defaults to 0.0.0.0) and not the wildcard itself.
  expect(["127.0.0.1", "::1", "localhost"]).toContain(hostname);
});

test("0.0.0.0 never appears as a string literal in index.ts — a stray edit can't silently reopen the bind", () => {
  // Quoted, not bare: the surrounding comment explains the 0.0.0.0-if-omitted default in prose,
  // which would trip a plain substring check without actually being the code path we're guarding.
  expect(indexSource).not.toContain('"0.0.0.0"');
});

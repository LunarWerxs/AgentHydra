// Alerts: PostHog-style threshold alerting adapted onto DevWebUI's existing CPU/memory
// sampler (metrics.ts / manager/monitoring.ts). Coverage for the two contracts that make
// this a real feature rather than a raw `value > threshold` check:
//   - SUSTAINED breach: "over threshold for 2 minutes" must not fire on the first
//     over-sample, must fire exactly once per contiguous breach, and must reset the
//     moment the metric drops back under threshold or the process stops.
//   - persistence: rules and fired events survive a restart (a fresh AlertStore reading
//     the same data dir), but the in-memory sustained-breach timer does NOT - the same
//     "current, never stale" contract errors.ts's isErrorActive() enforces for the error
//     log, extended to a live ticking condition instead of a one-shot log line.
import "./isolate"; // CWD-proof data-dir isolation - must load before any server/src import
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AlertStore, type AlertSample } from "../server/src/alerts";

// AlertStore persists to dataDir() (alerts-rules.json / alerts-events.ndjson). Every test
// below constructs several `new AlertStore()`s to exercise persistence across a simulated
// restart - so EACH test gets its own throwaway DEVWEBUI_HOME, not just the whole file's
// (./isolate only guarantees the suite avoids the REAL ~/.devwebui; tests in the same file
// still share that one directory unless each test isolates its own).
let home: string;
const originalHome = process.env.DEVWEBUI_HOME;
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "devwebui-alerts-test-"));
  process.env.DEVWEBUI_HOME = home;
});
afterEach(() => {
  process.env.DEVWEBUI_HOME = originalHome;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* best-effort - the suite-wide sweeper in ./isolate reclaims stragglers */
  }
});

function sample(over: Partial<AlertSample> = {}): AlertSample {
  return {
    processId: "p.web",
    processName: "Web",
    projectId: "p",
    projectName: "P",
    cpu: 0,
    memory: 0,
    ...over,
  };
}

test("evaluate: does not fire on the first over-threshold sample", () => {
  const store = new AlertStore();
  store.addRule({ processId: "p.web", metric: "cpu", threshold: 80, forMs: 120_000 });
  expect(store.evaluate([sample({ cpu: 95 })], 1_000)).toHaveLength(0);
  expect(store.listEvents()).toHaveLength(0);
});

test("evaluate: fires once the breach has been continuous for forMs", () => {
  const store = new AlertStore();
  store.addRule({ processId: "p.web", metric: "cpu", threshold: 80, forMs: 120_000 });
  expect(store.evaluate([sample({ cpu: 95 })], 0)).toHaveLength(0);
  expect(store.evaluate([sample({ cpu: 90 })], 60_000)).toHaveLength(0); // still under forMs
  const fired = store.evaluate([sample({ cpu: 92 })], 120_000);
  expect(fired).toHaveLength(1);
  expect(fired[0].metric).toBe("cpu");
  expect(fired[0].value).toBe(92);
  expect(fired[0].processId).toBe("p.web");
  expect(store.listEvents()).toHaveLength(1);
});

test("evaluate: does not re-fire every tick while the same breach continues", () => {
  const store = new AlertStore();
  store.addRule({ processId: "p.web", metric: "cpu", threshold: 80, forMs: 1000 });
  store.evaluate([sample({ cpu: 90 })], 0);
  expect(store.evaluate([sample({ cpu: 90 })], 1000)).toHaveLength(1);
  expect(store.evaluate([sample({ cpu: 90 })], 2000)).toHaveLength(0); // already fired for this breach
  expect(store.evaluate([sample({ cpu: 90 })], 3000)).toHaveLength(0);
  expect(store.listEvents()).toHaveLength(1);
});

test("evaluate: dropping back under threshold resets the breach so it can fire again later", () => {
  const store = new AlertStore();
  store.addRule({ processId: "p.web", metric: "cpu", threshold: 80, forMs: 1000 });
  store.evaluate([sample({ cpu: 90 })], 0);
  expect(store.evaluate([sample({ cpu: 90 })], 1000)).toHaveLength(1);
  store.evaluate([sample({ cpu: 50 })], 1500); // drops back under → breach resets
  expect(store.evaluate([sample({ cpu: 90 })], 1600)).toHaveLength(0); // fresh breach, not yet sustained
  expect(store.evaluate([sample({ cpu: 90 })], 2600)).toHaveLength(1); // sustained again → fires again
  expect(store.listEvents()).toHaveLength(2);
});

test("evaluate: a stopped/missing process resets the breach rather than freezing it", () => {
  const store = new AlertStore();
  store.addRule({ processId: "p.web", metric: "cpu", threshold: 80, forMs: 1000 });
  store.evaluate([sample({ cpu: 90 })], 0);
  store.evaluate([], 500); // process stopped mid-breach - absent from this tick's samples
  // If the old breach start survived the gap this would already have fired. It must not.
  expect(store.evaluate([sample({ cpu: 90 })], 1000)).toHaveLength(0);
  expect(store.evaluate([sample({ cpu: 90 })], 2000)).toHaveLength(1);
});

test("evaluate: a disabled rule never fires, and enabling it starts a fresh breach window", () => {
  const store = new AlertStore();
  const rule = store.addRule({
    processId: "p.web",
    metric: "cpu",
    threshold: 80,
    forMs: 500,
    enabled: false,
  });
  store.evaluate([sample({ cpu: 95 })], 0);
  expect(store.evaluate([sample({ cpu: 95 })], 1000)).toHaveLength(0);
  store.updateRule(rule.id, { enabled: true });
  store.evaluate([sample({ cpu: 95 })], 1100);
  // Must NOT fire instantly off the disabled period's elapsed time.
  expect(store.evaluate([sample({ cpu: 95 })], 1200)).toHaveLength(0);
  expect(store.evaluate([sample({ cpu: 95 })], 1700)).toHaveLength(1);
});

test("evaluate: a memory rule compares the memory sample, not cpu", () => {
  const store = new AlertStore();
  store.addRule({ processId: "p.web", metric: "memory", threshold: 500_000_000, forMs: 0 });
  const fired = store.evaluate([sample({ cpu: 5, memory: 600_000_000 })], 0);
  expect(fired).toHaveLength(1);
  expect(fired[0].metric).toBe("memory");
  expect(fired[0].value).toBe(600_000_000);
});

test("rule CRUD: add/update/remove, clamped inputs, and removeRulesForProcess", () => {
  const store = new AlertStore();
  const rule = store.addRule({ processId: "p.web", metric: "cpu", threshold: -5, forMs: -100 });
  expect(rule.threshold).toBe(0); // a negative threshold/duration is nonsensical - clamp to 0
  expect(rule.forMs).toBe(0);
  expect(rule.enabled).toBe(true); // default
  expect(store.listRules()).toHaveLength(1);

  const updated = store.updateRule(rule.id, { threshold: 75 });
  expect(updated?.threshold).toBe(75);
  expect(updated?.metric).toBe("cpu"); // untouched fields survive a partial update

  expect(store.updateRule("no-such-rule", { threshold: 1 })).toBeNull();

  store.removeRulesForProcess("p.web");
  expect(store.listRules()).toHaveLength(0);
  expect(store.removeRule(rule.id)).toBe(false); // already gone
});

test("persistence: rules and fired events survive a restart, but the breach timer does not", async () => {
  const store = new AlertStore();
  store.addRule({ processId: "p.web", metric: "cpu", threshold: 80, forMs: 1000 });
  store.evaluate([sample({ cpu: 90 })], 0);
  expect(store.evaluate([sample({ cpu: 90 })], 1000)).toHaveLength(1);

  // Flush the debounced NDJSON event write before "restarting" (a fresh store reads disk).
  await new Promise((r) => setTimeout(r, 1100));
  const reopened = new AlertStore();
  expect(reopened.listRules()).toHaveLength(1);
  expect(reopened.listEvents()).toHaveLength(1);
  // A breach already sustained for 1000ms before the "restart" must NOT fire the instant
  // the daemon comes back - it starts over, exactly like a store that never saw it.
  expect(reopened.evaluate([sample({ cpu: 90 })], 5000)).toHaveLength(0);
  expect(reopened.evaluate([sample({ cpu: 90 })], 6000)).toHaveLength(1);
}, 10000);

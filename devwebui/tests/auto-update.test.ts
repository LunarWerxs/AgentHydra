import { test, expect, afterEach } from "bun:test";
import {
  runAutoUpdateOnce,
  setAutoUpdateHooks,
  setAutoUpdateEnabled,
  setUpdateNotifyEnabled,
  setAutoUpdateBroadcast,
  stopAutoUpdate,
} from "../server/src/auto-update.ts";
import {
  clampAutoUpdateInterval,
  AUTO_UPDATE_INTERVAL_MIN_S,
  AUTO_UPDATE_INTERVAL_MAX_S,
  AUTO_UPDATE_INTERVAL_DEFAULT_S,
} from "../server/src/auto-update-interval.ts";
import type { UpdateApplyResult, UpdateStatus } from "../shared/dto.ts";

// The auto-update orchestrator's decision logic, driven through injected hooks so nothing actually
// pulls git / spawns / exits. Gates applying strictly on updateAvailable && canApply, and only
// relaunches after a successful apply that reports restartRequired.
//
// Two settings share this pass and they are NOT the same consent:
//   · updateNotify (on by default) — announce an available update (SSE `update_available`); install
//     nothing.
//   · autoUpdate   (opt-in)        — additionally apply it and relaunch, unattended.
// So the apply-path cases above enable autoUpdate explicitly: without it, "nothing was applied"
// would pass for the wrong reason (the setting was off) rather than the reason under test.

// Reset the module's hooks + timer + broadcast state after each case so they don't bleed across tests.
afterEach(() => {
  setAutoUpdateEnabled(false);
  setUpdateNotifyEnabled(true); // module default
  stopAutoUpdate();
  setAutoUpdateHooks({}); // restore the real hooks
  setAutoUpdateBroadcast(() => {}); // restore the no-op sink
});

// A full UpdateStatus with sensible defaults; overrides tweak the fields under test.
function status(over: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    ok: true,
    service: "devwebui",
    currentVersion: "0.1.0",
    currentCommit: "aaaa",
    remoteCommit: "bbbb",
    branch: "main",
    upstream: "origin/main",
    remote: "origin",
    dirty: false,
    updateAvailable: false,
    canApply: false,
    checkedAt: 0,
    reason: null,
    ...over,
  };
}
function applyResult(over: Partial<UpdateApplyResult> = {}): UpdateApplyResult {
  return {
    ok: true,
    message: "updated",
    restartRequired: true,
    status: status({}),
    output: [],
    ...over,
  };
}

test("applies + relaunches when an update is available and applicable", async () => {
  let applied = 0;
  let relaunched = 0;
  setAutoUpdateEnabled(true); // testing the apply path
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: true, canApply: true }),
    apply: async () => {
      applied++;
      return applyResult({ restartRequired: true });
    },
    relaunch: () => {
      relaunched++;
    },
  });
  const r = await runAutoUpdateOnce();
  expect(r.applied).toBe(true);
  expect(r.relaunched).toBe(true);
  expect(applied).toBe(1);
  expect(relaunched).toBe(1);
});

test("does nothing when already up to date", async () => {
  let applied = 0;
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: false }),
    apply: async () => {
      applied++;
      return applyResult({});
    },
    relaunch: () => {},
  });
  const r = await runAutoUpdateOnce();
  expect(r.applied).toBe(false);
  expect(r.reason).toBe("up-to-date");
  expect(applied).toBe(0);
});

test("never applies on a dirty tree (canApply false)", async () => {
  let applied = 0;
  let relaunched = 0;
  setAutoUpdateEnabled(true); // testing the apply path
  setAutoUpdateHooks({
    check: async () =>
      status({
        updateAvailable: true,
        canApply: false,
        dirty: true,
        reason: "local changes must be committed or stashed before updating",
      }),
    apply: async () => {
      applied++;
      return applyResult({});
    },
    relaunch: () => {
      relaunched++;
    },
  });
  const r = await runAutoUpdateOnce();
  expect(r.applied).toBe(false);
  expect(applied).toBe(0);
  expect(relaunched).toBe(0);
});

test("does not relaunch when the apply fails", async () => {
  let relaunched = 0;
  setAutoUpdateEnabled(true); // testing the apply path
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: true, canApply: true }),
    apply: async () => applyResult({ ok: false, message: "build failed" }),
    relaunch: () => {
      relaunched++;
    },
  });
  const r = await runAutoUpdateOnce();
  expect(r.applied).toBe(false);
  expect(r.relaunched).toBe(false);
  expect(relaunched).toBe(0);
});

test("reports the reason when the check itself fails", async () => {
  setAutoUpdateHooks({
    check: async () => status({ ok: false, reason: "no update remote configured" }),
    apply: async () => applyResult({}),
    relaunch: () => {},
  });
  const r = await runAutoUpdateOnce();
  expect(r.applied).toBe(false);
  expect(r.reason).toBe("no update remote configured");
});

test("clampAutoUpdateInterval bounds the cadence", () => {
  expect(clampAutoUpdateInterval(10)).toBe(AUTO_UPDATE_INTERVAL_MIN_S);
  expect(clampAutoUpdateInterval(9_999_999)).toBe(AUTO_UPDATE_INTERVAL_MAX_S);
  expect(clampAutoUpdateInterval(Number.NaN)).toBe(AUTO_UPDATE_INTERVAL_DEFAULT_S);
  expect(clampAutoUpdateInterval(3600)).toBe(3600);
});

// ── notify half: an update is announced, never installed ──────────────────────────────────

test("with auto-apply OFF it announces instead of installing, and broadcasts update_available", async () => {
  let applied = 0;
  let relaunched = 0;
  const broadcasts: Array<{ event: string; data: unknown }> = [];
  setUpdateNotifyEnabled(true);
  setAutoUpdateBroadcast((event, data) => broadcasts.push({ event, data }));
  setAutoUpdateHooks({
    check: async () =>
      status({
        updateAvailable: true,
        canApply: true,
        currentCommit: "aaaa",
        remoteCommit: "bbbb",
      }),
    apply: async () => {
      applied++;
      return applyResult({});
    },
    relaunch: () => {
      relaunched++;
    },
  });
  const r = await runAutoUpdateOnce();
  expect(r.reason).toBe("notified");
  expect(r.applied).toBe(false);
  expect(r.relaunched).toBe(false);
  // The whole point: being told costs nothing and touches nothing.
  expect(applied).toBe(0);
  expect(relaunched).toBe(0);
  expect(broadcasts).toEqual([
    { event: "update_available", data: { from: "aaaa", to: "bbbb", canApply: true, reason: null } },
  ]);
});

test("announces even when the update cannot be applied (dirty tree)", async () => {
  // "An update is waiting, commit your work to take it" is exactly the useful thing to know.
  // auto-apply is off (default), so this takes the same "notified" branch as any other notify —
  // the blocked (dirty) case is only visible in the broadcast payload, not r.reason.
  const broadcasts: Array<{ event: string; data: unknown }> = [];
  setUpdateNotifyEnabled(true);
  setAutoUpdateBroadcast((event, data) => broadcasts.push({ event, data }));
  setAutoUpdateHooks({
    check: async () =>
      status({ updateAvailable: true, canApply: false, dirty: true, reason: "local changes" }),
    apply: async () => applyResult({}),
    relaunch: () => {},
  });
  const r = await runAutoUpdateOnce();
  expect(r.applied).toBe(false);
  expect(r.reason).toBe("notified");
  expect(broadcasts).toHaveLength(1);
  expect(broadcasts[0]).toEqual({
    event: "update_available",
    data: { from: "aaaa", to: "bbbb", canApply: false, reason: "local changes" },
  });
});

test("auto-apply ON but blocked (dirty tree) still notifies, reporting the check's own reason", async () => {
  // With autoUpdate ALSO on, a blocked update reaches the separate canApply hard-gate instead of
  // the "notified" short-circuit above — it still announces, but r.reason surfaces the concrete
  // blocker (what the auto-apply path itself would have hit) rather than the generic "notified".
  let applied = 0;
  const broadcasts: Array<{ event: string; data: unknown }> = [];
  setAutoUpdateEnabled(true);
  setUpdateNotifyEnabled(true);
  setAutoUpdateBroadcast((event, data) => broadcasts.push({ event, data }));
  setAutoUpdateHooks({
    check: async () =>
      status({ updateAvailable: true, canApply: false, dirty: true, reason: "local changes" }),
    apply: async () => {
      applied++;
      return applyResult({});
    },
    relaunch: () => {},
  });
  const r = await runAutoUpdateOnce();
  expect(r.applied).toBe(false);
  expect(r.reason).toBe("local changes");
  expect(applied).toBe(0);
  expect(broadcasts).toEqual([
    {
      event: "update_available",
      data: { from: "aaaa", to: "bbbb", canApply: false, reason: "local changes" },
    },
  ]);
});

test("with both halves off it does nothing at all", async () => {
  let applied = 0;
  const broadcasts: unknown[] = [];
  setAutoUpdateEnabled(false);
  setUpdateNotifyEnabled(false);
  setAutoUpdateBroadcast((event, data) => broadcasts.push({ event, data }));
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: true, canApply: true }),
    apply: async () => {
      applied++;
      return applyResult({});
    },
    relaunch: () => {},
  });
  const r = await runAutoUpdateOnce();
  expect(r.reason).toBe("notify-off");
  expect(r.applied).toBe(false);
  expect(applied).toBe(0);
  expect(broadcasts).toHaveLength(0);
});

test("nothing is announced or applied when already up to date", async () => {
  const broadcasts: unknown[] = [];
  setUpdateNotifyEnabled(true);
  setAutoUpdateBroadcast((event, data) => broadcasts.push({ event, data }));
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: false }),
    apply: async () => applyResult({}),
    relaunch: () => {},
  });
  const r = await runAutoUpdateOnce();
  expect(r.reason).toBe("up-to-date");
  expect(broadcasts).toHaveLength(0);
});

test("when autoUpdate is also on, an applicable update applies silently without a notify broadcast", async () => {
  // The two settings are not additive on the happy apply path — an owner who opted into BOTH
  // gets the unattended apply, not an announcement first (the apply's own broadcasts —
  // auto_update_applying / auto_update_restarting — are the "notification" in that case).
  let applied = 0;
  const broadcasts: Array<{ event: string; data: unknown }> = [];
  setAutoUpdateEnabled(true);
  setUpdateNotifyEnabled(true);
  setAutoUpdateBroadcast((event, data) => broadcasts.push({ event, data }));
  setAutoUpdateHooks({
    check: async () => status({ updateAvailable: true, canApply: true }),
    apply: async () => {
      applied++;
      return applyResult({ restartRequired: false });
    },
    relaunch: () => {},
  });
  const r = await runAutoUpdateOnce();
  expect(r.applied).toBe(true);
  expect(applied).toBe(1);
  expect(broadcasts.map((b) => b.event)).toEqual(["auto_update_applying"]);
});

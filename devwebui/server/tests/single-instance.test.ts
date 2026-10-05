import { describe, expect, it } from "bun:test";
import { skipSingleInstanceGuard } from "../src/single-instance";

describe("skipSingleInstanceGuard", () => {
  it("runs the single-instance probe on a normal launch", () => {
    expect(skipSingleInstanceGuard({})).toBe(false);
  });

  it("skips the probe for the auto-update relaunch successor (DEVWEBUI_RELAUNCH=1)", () => {
    // Regression guard for the zero-instances relaunch race: the successor must NOT
    // probe /api/health here (its predecessor is still alive and answering it during
    // the handoff), or it would conclude "already running" and exit, leaving no daemon.
    expect(skipSingleInstanceGuard({ DEVWEBUI_RELAUNCH: "1" })).toBe(true);
  });

  it("skips the probe when the dev launcher pins the port (DEVWEBUI_PORT_FIXED=1)", () => {
    expect(skipSingleInstanceGuard({ DEVWEBUI_PORT_FIXED: "1" })).toBe(true);
  });

  it('treats only exactly "1" as set', () => {
    expect(skipSingleInstanceGuard({ DEVWEBUI_RELAUNCH: "0" })).toBe(false);
    expect(skipSingleInstanceGuard({ DEVWEBUI_PORT_FIXED: "true" })).toBe(false);
  });
});

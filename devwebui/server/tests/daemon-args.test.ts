// The daemon's own flags vs. the CLI. index.ts hands ANY argv beyond the program name to the CLI,
// which answers and exits without starting a server — so if these flags were ever mis-parsed as a
// CLI invocation, an auto-update would relaunch into a process that prints something and quits,
// leaving ZERO daemons. That is the failure these tests exist to prevent, and it is silent: the
// spawn succeeds and the successor dies in another process.
import { expect, test } from "bun:test";
import { parseDaemonArgs, stripFlagPair } from "../src/daemon-args";

test("a bare launch is daemon mode with nothing set", () => {
  expect(parseDaemonArgs([])).toEqual({ port: null, relaunch: false, resume: [] });
});

test("the relaunch handover parses", () => {
  expect(parseDaemonArgs(["--port", "4000", "--relaunch"])).toEqual({
    port: 4000,
    relaunch: true,
    resume: [],
  });
});

// A shortcut or tray entry launching `devwebui --safe-mode` must boot the daemon quietly, not
// fall into the CLI and exit; and it must not be mistaken for the auto-update handover.
test("--safe-mode is a daemon flag, distinct from --relaunch", () => {
  expect(parseDaemonArgs(["--safe-mode"])).toEqual({
    port: null,
    relaunch: false,
    resume: [],
    safeMode: true,
  });
});

test("resume ids come across as a list", () => {
  const parsed = parseDaemonArgs(["--relaunch", "--resume", "a.1,b.2 , c.3"]);
  expect(parsed?.resume).toEqual(["a.1", "b.2", "c.3"]);
});

test("every CLI verb still reaches the CLI, not the daemon", () => {
  // The whole point: unrecognised tokens mean "this is a CLI invocation, hands off".
  for (const argv of [
    ["start"],
    ["list"],
    ["mcp"],
    ["--version"],
    ["--help"],
    ["-h"],
    ["stop-process", "x"],
  ]) {
    expect(parseDaemonArgs(argv)).toBeNull();
  }
});

test("a daemon flag mixed with a CLI verb belongs to the CLI", () => {
  expect(parseDaemonArgs(["start", "--port", "4000"])).toBeNull();
});

test("a malformed or missing port is refused outright, never silently defaulted", () => {
  // Booting on the wrong port is worse than not booting: the tray, the pointer and the open tab
  // would all disagree about where the daemon is.
  expect(parseDaemonArgs(["--port"])).toBeNull();
  expect(parseDaemonArgs(["--port", "notanumber"])).toBeNull();
  expect(parseDaemonArgs(["--port", "0"])).toBeNull();
  expect(parseDaemonArgs(["--port", "70000"])).toBeNull();
  expect(parseDaemonArgs(["--resume"])).toBeNull();
});

test("stripFlagPair removes the flag and its value, leaving everything else", () => {
  expect(stripFlagPair(["--port", "4000", "--relaunch", "--resume", "a,b"], "--resume")).toEqual([
    "--port",
    "4000",
    "--relaunch",
  ]);
  expect(stripFlagPair(["--relaunch"], "--resume")).toEqual(["--relaunch"]);
});

test("stripFlagPair keeps a trailing flag that has no value", () => {
  // Nothing to consume, so it is left for the parser to reject rather than silently swallowed.
  expect(stripFlagPair(["--relaunch", "--resume"], "--resume")).toEqual(["--relaunch", "--resume"]);
});

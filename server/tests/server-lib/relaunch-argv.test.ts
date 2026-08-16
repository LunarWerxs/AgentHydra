// Tests for the shared relaunch-argv builder (SHARED LunarWerx server-lib — source of truth:
// lunarwerx-ui/src/server-lib/relaunch-argv.test.ts, synced by sync.mjs into each app's
// `serverTests` dir under a `server-lib/` subdir next to the app's server tree). The
// `../../src/relaunch-argv.mjs` import resolves only from that synced location — sync.mjs
// validates the placement — so this file is NOT runnable inside the kit repo itself.
//
// Every failure locked down here is SILENT in production: spawn() succeeds, the SUCCESSOR dies in
// another process milliseconds later, and the caller's "never shut down without a successor" guard
// sees a child object and steps aside. The user sees the app vanish after an update, with nothing
// in any log. That is why these are unit tests on a pure function rather than a note in a comment.
import { expect, test } from "bun:test";
import { buildRelaunchArgv } from "../../src/relaunch-argv.mjs";

const EXE = "C:\\Apps\\Thing\\thing.exe";
const BUN = "C:\\Users\\me\\.bun\\bin\\bun.exe";
const SCRIPT = "D:\\code\\thing\\src\\index.ts";

/** What a compiled `bun build --compile` binary really reports (verified, Bun 1.3.14). */
const compiledArgv = (...args: string[]) => ["bun", "B:/~BUN/root/thing.exe", ...args];
const sourceArgv = (...args: string[]) => [BUN, SCRIPT, ...args];

/** Re-parse a built argv the way a daemon entry does, so these assert what the SUCCESSOR
 *  concludes rather than merely the token order. */
function dispatch(
  argv: string[],
  isCompiled: boolean,
  opts: { hasVerb: boolean; valueFlags?: string[] },
): { verb: string | null; port: number | null; relaunch: boolean } {
  const cli = argv.slice(isCompiled ? 1 : 2); // [exe, ...cli] compiled; [exe, script, ...cli] source
  const verb = opts.hasVerb ? (cli[0] ?? null) : null;
  const rest = opts.hasVerb ? cli.slice(1) : cli;
  let port: number | null = null;
  for (let i = 0; i < rest.length; i++) {
    if ((opts.valueFlags ?? []).includes(rest[i]!) && rest[i + 1]) i++;
    else if (rest[i] === "--port" && rest[i + 1]) port = Number(rest[++i]);
  }
  return { verb, port, relaunch: rest.includes("--relaunch") };
}

test("compiled: never respawns the placeholder argv pair", () => {
  const out = buildRelaunchArgv(compiledArgv(), { execPath: EXE, isCompiled: true, boundPort: 7172 });
  expect(out[0]).toBe(EXE);
  expect(out.join(" ")).not.toContain("B:/~BUN/root");
  expect(out).not.toContain("bun");
});

test("compiled + bare launch: an implicit verb is named, so a flag never lands in the verb slot", () => {
  // The regression: a double-clicked release .exe has NO args, so the verb is implicit. Appending
  // flags to that empty list used to put --relaunch in the verb slot; the successor exited 1 on
  // `Unknown command: --relaunch`.
  const out = buildRelaunchArgv(compiledArgv(), {
    execPath: EXE,
    isCompiled: true,
    boundPort: 7172,
    command: "start",
  });
  expect(dispatch(out, true, { hasVerb: true })).toEqual({ verb: "start", port: 7172, relaunch: true });
});

test("an explicit verb already present is preserved, not duplicated", () => {
  const out = buildRelaunchArgv(sourceArgv("serve", "--port", "5178"), {
    execPath: BUN,
    isCompiled: false,
    boundPort: 5179,
    command: "serve",
  });
  expect(out.filter((a) => a === "serve")).toHaveLength(1);
  expect(dispatch(out, false, { hasVerb: true })).toEqual({ verb: "serve", port: 5179, relaunch: true });
});

test("a bare daemon entry (no verb) gets flags only", () => {
  const out = buildRelaunchArgv(compiledArgv(), { execPath: EXE, isCompiled: true, boundPort: 7788 });
  expect(out).toEqual([EXE, "--port", "7788", "--relaunch"]);
  expect(dispatch(out, true, { hasVerb: false }).port).toBe(7788);
});

test("source: keeps the real script path as the runtime's argument", () => {
  const out = buildRelaunchArgv(sourceArgv("start", "--port", "7171"), {
    execPath: BUN,
    isCompiled: false,
    boundPort: 7172,
    command: "start",
  });
  expect(out[0]).toBe(BUN);
  expect(out[1]).toBe(SCRIPT);
});

test("the successor gets the BOUND port; an inherited one is dropped, not left to last-wins", () => {
  const out = buildRelaunchArgv(sourceArgv("start", "--port", "7171"), {
    execPath: BUN,
    isCompiled: false,
    boundPort: 7172,
    command: "start",
  });
  expect(out.filter((a) => a === "--port")).toHaveLength(1);
  expect(out).not.toContain("7171");
  expect(dispatch(out, false, { hasVerb: true }).port).toBe(7172);
});

test("a value flag's value is never mistaken for a flag", () => {
  // The app's own parse loop consumes --root's value; this must too, or a path that happens to
  // read like a flag would be dropped and its neighbour silently eaten.
  const out = buildRelaunchArgv(sourceArgv("start", "--root", "--port", "--tunnel"), {
    execPath: BUN,
    isCompiled: false,
    boundPort: 7172,
    command: "start",
    valueFlags: ["--root"],
  });
  expect(out.slice(out.indexOf("--root"), out.indexOf("--root") + 2)).toEqual(["--root", "--port"]);
  expect(out).toContain("--tunnel");
  expect(dispatch(out, false, { hasVerb: true, valueFlags: ["--root"] }).port).toBe(7172);
});

test("the build is a fixed point, so argv cannot grow across successive updates", () => {
  const opts = { execPath: BUN, isCompiled: false, boundPort: 7172, command: "start" };
  const gen1 = buildRelaunchArgv(sourceArgv("start", "--port", "7171"), opts);
  const gen2 = buildRelaunchArgv(gen1, opts);
  const gen3 = buildRelaunchArgv(gen2, opts);
  expect(gen2).toEqual(gen1);
  expect(gen3).toEqual(gen1);
  expect(gen3.filter((a) => a === "--relaunch")).toHaveLength(1);
});

test("a daemon that hopped again hands over its NEW port", () => {
  const opts = { execPath: BUN, isCompiled: false, command: "start" };
  const gen1 = buildRelaunchArgv(sourceArgv("start", "--port", "7171"), { ...opts, boundPort: 7172 });
  const gen2 = buildRelaunchArgv(gen1, { ...opts, boundPort: 7173 });
  expect(dispatch(gen2, false, { hasVerb: true }).port).toBe(7173);
  expect(gen2).not.toContain("7172");
});

test("custom flag names are honoured", () => {
  const out = buildRelaunchArgv(compiledArgv(), {
    execPath: EXE,
    isCompiled: true,
    boundPort: 4000,
    portFlag: "--daemon-port",
    relaunchFlag: "--from-update",
  });
  expect(out).toEqual([EXE, "--daemon-port", "4000", "--from-update"]);
});

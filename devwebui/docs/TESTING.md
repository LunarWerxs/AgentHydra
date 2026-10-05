# Testing

Notes on running DevWebUI's automated tests and a throwaway dev daemon without
disturbing your real `~/.devwebui` state (registry of loaded projects, `state.json`,
settings, error/log vault).

## Running the suite

```bash
bun test
```

The suite isolates itself from your real `~/.devwebui` by setting `DEVWEBUI_HOME` to
a temp directory. That's wired as a `bunfig.toml` `[test] preload` (`tests/setup.ts`),
and bun resolves `bunfig.toml` **relative to the current working directory**. If you
invoke `bun test <path>` from a directory above the repo root, the preload is skipped
and every test that writes through `Manager` / `writeSettings` / `appendLog` will write
its fixtures into your **real** `~/.devwebui` instead (piling up fixture logs in
`~/.devwebui/logs`, or clobbering the real `settings.json`). Always run `bun test`
with the repo as your working directory.

As a second line of defense, `tests/isolate.ts` sets `DEVWEBUI_HOME` at *import* time
(so it isolates regardless of CWD). Every test file that touches a data-writing module
(`manager`, `log-vault`, `runtime`, `state`, `instance`, `connections`, or `http`) must
`import "./isolate"` before anything else. `tests/data-dir-isolation.test.ts` enforces
this: it fails if any test that value-imports one of those writer modules omits the
`./isolate` import.

### A test that spawns must state its own timeout

`bun run check:spawntimeout` fails a test, **or a lifecycle hook**, that reaches a subprocess while
inheriting bun's 5s default. Pass one explicitly: `test(name, fn, 20_000)`, or for a hook, where the
timeout is the second argument, `beforeAll(fn, 20_000)`. Any value counts; the point is that someone
chose it. Prefer a named constant with a comment recording the measured local cost, so the next
reader can tell a deliberate allowance from a guess.

The rule exists because such a test times the machine, not its own assertions, and a cold loaded
Windows runner has been measured at roughly 10x a dev box on this exact class. That produces the
worst kind of red: a failure on a commit that changed nothing related, green again on re-run, and a
maintainer who learns to re-run CI instead of reading it. Hooks are worse still, since bun blames
the timeout on an unnamed test and never says which hook ran long.

The check resolves module-level helpers transitively, so a spawn two hops away through a `child()`
helper still counts. It does not follow imports into production code, and it ignores anything inside
a comment or a string.

If you see failures mentioning something like `Dependency cycle in waitForPort:
waitfor-test.a -> ...`, or a "first run" error report, in your **real** DevWebUI error
log, that's a test run that bypassed isolation, not a product bug. Those exact
messages are asserted by the wait-for-port and log-vault `Manager` tests as expected
fixture output; they should only ever land in the isolated temp `DEVWEBUI_HOME`.

## Running a throwaway daemon manually

To start a real `bun run dev` daemon against scratch state (instead of your real
projects), override `USERPROFILE` before launching. `USERPROFILE` is what
`os.homedir()` reads on Windows, and `server/src/data-dir.ts`'s `dataDir()` is the
single place all data-dir resolution goes through, so overriding the home directory
(or setting `DEVWEBUI_HOME` directly) is enough to isolate a manual test run the same
way the automated suite does. Before `data-dir.ts` existed, `DEVWEBUI_HOME` alone was
**not** sufficient (state.ts, the project registry, and the log vault read the raw
home directory independently); a source-invariant test,
`tests/data-dir-isolation.test.ts`, now forbids reintroducing a raw
`homedir()` + `".devwebui"` join anywhere in the codebase.

## Loopback binding is IPv6-only

The daemon binds loopback on IPv6 only. `http://[::1]:4000` works; `http://127.0.0.1:4000`
is connection-refused. When probing or curling a test daemon, use the `[::1]` form,
not `127.0.0.1` or `localhost` (which may resolve to the v4 address first on some
setups).

## Watch-restarts sever SSE: trust the API over the UI

`bun run dev` refuses to start if another DevWebUI instance is already live (it checks
an instance pointer first). Separately, `bun --watch` restarts the daemon whenever a
server-file changes, which severs any open SSE connection; a preview tab left open in
the background can then keep showing stale process statuses after a restart.

If the UI and reality disagree during test iteration, reload the page, and when in
doubt, check `GET /api/processes` directly rather than trusting a possibly-stale UI.

## Orphaned children on a hard kill

The `Manager` integration tests spawn real keep-alive child processes, e.g.
`"<bun path>" -e "setInterval(() => {}, 1000)"`. If a test daemon is killed hard
(rather than shut down cleanly) mid-run, it can leave those spawned children running
as orphans on Windows. If a test run behaves oddly or a port stays held after you
expected it to be free, check for leftover `bun.exe -e` processes and kill them by
their exact PID rather than assuming the daemon cleaned up after itself.

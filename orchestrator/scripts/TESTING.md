# Testing the orchestrator - three tiers, all runnable and confirmable by an AI

Every tier is a plain command with a meaningful exit code and JSON output on demand, so an
agent can run it, read it, and assert on it without a human watching a screen.

## Tier 1 - unit tests (no fleet, no daemon, no risk)

```sh
python -m unittest discover -s scripts/tests        # the whole suite
python -m unittest scripts.tests.test_archive_chat  # one script's suite
```

Every script has a dedicated test file. The daemon is a stub (`tests/stubdaemon.py`) serving
declared routes and RECORDING every POST, so tests assert not just exit codes but exactly what
an act script sent - and, just as important, that a refused act sent NOTHING. Transcripts are
real temp files with controlled mtimes, so the gate is tested over actual bytes, not mocks of
itself.

The stub answers `hydralib` IN-PROCESS: a test sets `hydralib.BASE = stub.url` as before, and
every hydralib call to that BASE is dispatched to the stub's routes without opening a socket
(`hydralib.INPROC`). The stub still listens on its ephemeral port for anything that speaks HTTP
itself (a subprocess handed `AGENTHYDRA_URL`, a test using urllib directly) and answers through
the same dispatcher. Why (measured 2026-09-05): one loopback connection per request left a
TIME_WAIT socket behind for about two minutes, so the 908-test suite held over a thousand of
Windows' 16,384 ephemeral ports at a time, and beside other socket-heavy work on the same machine
a random test could find the "daemon" unreachable and go red with nothing to say why. A test
that points BASE at a dead port still gets a real connection failure: only a registered stub's
own URL is answered in-process.

Every test class that runs a script or a state-keeping lib calls `isolate_state_dir(self)`
(`tests/util.py`) first in `setUp`: it points `ORCHESTRATOR_STATE_DIR` at a private temp dir.
Without it a test writes the CHECKOUT's own `state/`, which in the live checkout is the real
orchestrator's ledger, locks and usage-survey cache (measured 2026-09-05: a full run left the
stub's fake accounts in the cache, and four copies of the suite side by side collided on the
naming lock). `python scripts/tests/probe_state_dir.py` finds any module that still writes there
(about fifteen minutes; run it after adding a test that drives a script). A test file with no
`TestCase` is invisible to `unittest discover` - `test_chatwatch.py` was one until the same day -
so a script-style check file must carry a wrapper class that runs it.

The suite encodes the six inherited rules as regression tests - the Ghost "say the word" case,
the pending-restart honesty, the breaker cap, the deterministic one-strike stop, the
recheck-before-acting race, verify-before-claiming - so a change that re-opens a postmortem bug
fails a named test.

## Tier 2 - smoke (live daemon, READ-ONLY, safe any time)

```sh
python scripts/smoke.py
python scripts/dashboard.py --open   # the same read-only chain, as a browser page a human reads
```

The dashboard is the human-facing member of this tier: it draws the logic tree and dry-runs
the plan for every chat (state, verdict, why, account, and the terminal command that WOULD do
it). Its server defines no POST handler, so "this page cannot act" is a structural property -
and `test_dashboard.py` asserts exactly that, plus that a whole plan build sends zero POSTs.

Proves the whole observe chain against the real daemon: health, fleet shape, sessions shape,
dossier round-trip, a real gate over the newest chat's transcript, ledger readability. There is
no POST anywhere in the file, and the unit suite asserts that property against the stub.

## Tier 3 - drill (live daemon, ACTS, reversible by construction)

```sh
python scripts/drill.py --chat "<some retired junk chat>"          # archive round-trip
python scripts/drill.py --chat "<a visible chat>" --rename         # UI rename round-trip
```

The drill exercises the real WRITE path through the production scripts themselves and ends
where it started:

- **archive drill**: subject must be already-archived, writer-less, in a CLOSED instance.
  unarchive -> verify -> re-archive -> verify. A failure at any point leaves the chat merely
  visible, never lost, and the output names the exact command that restores it.
- **rename drill**: subject must be visible in a RUNNING instance. rename to `<title> [drill]`
  -> verify -> rename back -> verify. Two real UI clicks, landed and confirmed.

## How UI/UX manipulation is tested WITHOUT clicking around

The desktop app has no test API, but nothing here ever screen-clicks by coordinates or asks a
human to click. The mechanics, banked from AgentHydra's own work:

- **The daemon's actuator drives Windows UI-Automation** (UIA): sidebar kebab =
  `ExpandCollapse.Expand`, menu items = `Invoke`. Focus-free, cursor-free, and it VERIFIES its
  own click before reporting ok. Our scripts reach it over HTTP (`/api/chats/:id/rename`), so
  "clicking the app" is already a programmatic, assertable call - the drill just closes the
  loop by re-reading the dossier afterwards.
- **UIA reaches RENDERED rows only** - an archived chat has no sidebar row, which is why the
  rename drill refuses archived subjects instead of failing confusingly inside the actuator.
- **CDP (Chrome DevTools Protocol) is a dead end** - the app exits when started with a debug
  port, so browser-automation tooling cannot be the answer here. Do not rediscover this.
- **Disk flags are NOT UI** - `desktop-archive` writes metadata; under a running app the app's
  in-memory chat list wins until restart. That is why the archive drill demands a closed
  instance, and why `archive_chat.py` reports exit 7 ("written, not claiming success") instead
  of green when an app was running. AgentHydra's `misc/Manage-DesktopChat.ps1` is the UIA path
  for immediate archive-in-a-running-app; if the daemon ever exposes it over HTTP, it slots
  into `archive_chat.py` as the durable running-app path.

## What "confirmable by the AI" means here, concretely

- exit codes are a contract, documented per script in its docstring, distinct per refusal kind
  (gate / deterministic / live-writer / breaker / pending-restart), so an agent can branch on
  WHY without parsing prose;
- `--json` on every script emits the full decision record (gate verdict, breaker state, daemon
  response, verify result);
- nothing ever claims success it did not re-read from the daemon afterwards.

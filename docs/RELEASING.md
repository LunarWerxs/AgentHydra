# Releasing

## AgentHydra is 2.0: no 1.x release, and the notes open with a TL;DR

- **The 1.x line is closed** (owner, 2026-10-06: "why do we keep releasing updates to GitHub on the
  1.x path of Agent Hydra? ... when Agent Hydra became the new Hydra Desk UI, it was Agent Hydra
  2.0"). The next release is 2.0.0, and it ships Desk 2 (`desk2/`) as AgentHydra's window
  ([AGENTHYDRA-2-CUTOVER.md](AGENTHYDRA-2-CUTOVER.md)). A tag below 2.0.0 is refused by the pre-push
  hook and by `release.yml`, and a tag build whose Windows zip has no `desk2/` does not publish.
- **The release page reads like SageThumbs'** (owner, same day: "We always need to do it like Sage
  does. You have a TL;DR, bullet points ... then you have the details in, like, a read more").
  `scripts/release-notes.mjs` builds it from the version's CHANGELOG section: the icon, the TL;DR,
  every line of the section under "Read more", then the downloads. A section with more than two
  changes must open with its own TL;DR, or the hook and the workflow refuse the tag:

  ```md
  ## [2.0.0] - 2026-10-07

  **TL;DR**

  - **One short headline per change that matters**

  **Everything in 2.0.0**

  ### Added
  - **The headline.** One to three plain sentences a user cares about.
  ```

  `node scripts/release-notes.mjs 2.0.0` prints the page; `--check` only says whether it may ship.
  `--check-unreleased` holds `[Unreleased]` to the same rule before it has a version (exit 1, the
  reason on stderr; an empty or short section passes).
  Write each bullet for someone who uses AgentHydra: what changed for them, in a few sentences. The
  owner's quotes, measurements, endpoints and file names belong in the commit message and the docs.

## What a 2.0 bundle holds, and building one on a PC

Every bundle (`AgentHydra-<version>-<target>`, a `.zip` on Windows, a `.tar.gz` elsewhere) holds:

- the compiled daemon (`AgentHydra.exe` / `agenthydra`) and `orchestrator/`; on Windows also `misc/`
  (the tray) and the lone `.exe` beside the archive;
- `desk2/`, AgentHydra 2.0's window: its own bun in `desk2/runtime/` (the version the workflow
  compiles with), its server source, `shared/`, production `node_modules` (installed hoisted, for
  the target's OS and CPU), the built `web/dist` and `hydra/dist`, and on Windows `launcher/` with
  `HydraDesk2.exe`. Windows opens it in its native window; Linux and macOS run its server on the
  shipped bun and open the default browser. Desk 2's dev-servers service (for managing dev servers)
  runs as a hidden service started by Desk 2 itself.

No tests, e2e, `tmp/` or dev dependencies ship. `scripts/package-release.ts` stages and archives a
bundle and `scripts/smoke-release.ts` boots one; `release.yml` runs the same two scripts. On a PC
(Windows shown), build Desk 2 first, since the packager never builds it or writes into the checkout:

```sh
cd desk2 && bun install --frozen-lockfile && bun run build && cd ..
bun scripts/package-release.ts --target windows-x64 --out <dir>
bun scripts/smoke-release.ts --bundle-dir <dir> --port <free> --desk-port <free>
```

Pick two ports nothing on the PC uses (not 7787 or 7798, where the live daemon and Desk 2 run);
the smoke refuses a busy one. It starts the bundle's daemon and Desk 2's server on temp homes,
headless (never the launcher, window host or tray), checks them, and stops exactly what it started.

## Consolidating old releases

Periodically rewrite all previous release pages from CHANGELOG.md and fold patch releases into
their minor's release. This removes old patch releases and combines their changes with the minor
release, making the release list shorter and keeping patches visible without their own page.

`scripts/consolidate-releases.mjs` reads releases and CHANGELOG.md, groups them by minor version
(x.y), keeps x.y.0 (or the lowest version in a line if x.y.0 does not exist), and folds every
other release in the line into the one it keeps. The release marked latest is never folded.

A kept release with folded patches gets one body in `formatLineBody`'s layout (icon, ## TL;DR,
<details> Read more, ## Downloads, Discord) covering the whole line: the TL;DR is the kept
version's bullets then each folded version's, duplicates removed; Read more holds each version's
section, oldest first, each under its own `#### x.y.z` heading. Every other kept release gets
`formatReleaseBody`'s page.

Run the dry run first and read it:
```sh
node scripts/consolidate-releases.mjs
```

It prints a summary, writes every new body to `/tmp/consolidate-<timestamp>/bodies/<tag>.md` and
the plan to `/tmp/consolidate-<timestamp>/plan.json` ({ edit: [tags], fold: { <kept tag>: [patch tags] },
delete: [tags], missingSections: [versions] }). Review the bodies and plan, then apply only on the
owner's word:

```sh
node scripts/consolidate-releases.mjs --apply
```

The git tags stay; only the release pages change. Versions with no CHANGELOG section are listed in
the plan but not changed.

## Pushing `main` is the release

Auto-update (see the README's Auto-update section) applies each update as a `git pull --ff-only`
against `origin/main`. There is no separate publish step for that path: as soon as `main` moves,
every instance with auto-update enabled will fast-forward to it on its next check. Treat a push to
`main` as user-facing, not as a staging step.

## The pre-push gate

`.githooks/pre-push` (enabled by `core.hooksPath`, which `bun install`'s `prepare` sets) runs on
every push and enforces two rules that used to be memory only, then runs the host-only lane:

1. **A public remote is announced and refused.** The hook looks the remote up on GitHub; when it
   is public, or cannot be proven private (not GitHub, a timeout, a rate limit), it prints
   `# WARNING: THIS REPOSITORY IS **PUBLIC**` with the refs and stops. When the owner has decided
   the push goes out, re-run the same command with `AGENTHYDRA_PUSH_PUBLIC=1`: it prints the
   heading again and pushes. Announce, then do. Never `--no-verify`.
2. **A `v*.*.*` tag is refused while `docs/todo/TODO.md` has an open section.** Nothing pending
   ships past a release. There is no override: finish the item and delete its section, or the
   owner deletes it. The queue is gitignored, so this can only fire on a machine that holds it.
   A tag is also refused when `scripts/release-notes.mjs` would refuse it: below 2.0.0, no
   CHANGELOG section, or a long section with no TL;DR (read from the tagged commit).
3. **The kit check runs, and a release tag needs green CI on its commit.** On a machine with the
   private `../../lunarwerx-ui` checkout, every push runs `bun run check:local` (kit drift), the
   one lane GitHub structurally cannot run. With a `v*.*.*` tag in the push, the hook also asks
   `gh` for a `ci.yml` run on the exact commit the tag points to whose conclusion is success. If
   there is one, `check:local` is all that runs locally: every other lane of `bun run check:deep`
   (Biome, the i18n check, every typecheck, `bun test` with orchestrator/server's tests, the
   orchestrator Python suite) is a `ci.yml` step that already passed on that commit, so re-running
   them made every release wait on a duplicate 25-minute gate (measured on 1.7.0, 2026-10-02).
   If it cannot be confirmed (`gh` missing or not signed in, offline, no run on that commit, a run
   still going or not green), the hook prints one line saying why and runs the full
   `bun run check:deep`. A tag on a docs-only commit has no CI run (`ci.yml` ignores
   `docs/**` and `*.md`), so it takes that fallback; tag the version-bump commit, which CI runs.

A commit whose subject starts with `wip: bundle` must also list every file in it under `Mine:` and
`Swept:` (`.githooks/commit-msg`); `bun run save:bundle -- --mine <paths>` writes that message
from the dirty tree. Both hooks have suites under `.githooks/tests/`.

## Recipe

1. **Bump the version.** Update `version` in `package.json`.
2. **Update the changelog.** Move the relevant `[Unreleased]` entries in `CHANGELOG.md` into a new
   `## [X.Y.Z] - YYYY-MM-DD` heading, following the existing Keep a Changelog format already used
   in that file, and open it with its `**TL;DR**` block (above). Only entries for what this release
   ships: a change to `desk2/` rides only in a release that ships Desk 2.
   `node scripts/release-notes.mjs X.Y.Z` shows the page GitHub will get.
   **Then freeze the MCP API level:** `bun run mcp:api-level --write` commits the live tool surface
   as `server/mcp-api-levels/<version>.json`. `bun test` refuses a version with no level, and
   replays every level against the live tools, so a later release that drops a tool or makes an
   optional argument required fails there (see [REFERENCE.md](REFERENCE.md#frozen-api-levels)).
3. **Run local CI before pushing.** `.github/workflows/ci.yml` is the authoritative list; the
   commands below are a convenience copy and the workflow wins if the two ever disagree. Check
   the workflow rather than trusting this line when a step has been added recently.
   `bun install --frozen-lockfile`, `bun run typecheck`, `bun run check`, `bun run build`,
   `bun test`, then a bundle built and smoked as in "What a 2.0 bundle holds" above.
   Don't rely on pushing to find out one of these fails.

   Maintainers: also `bun run check:local`, which CI cannot run at all (see REFERENCE.md).

   A local pass is one leg of a two-leg matrix. CI runs `[ubuntu-latest, windows-latest]`, so a
   green run on Windows says nothing about Linux. Anything OS-shaped (path handling, filesystem
   watching, process spawning, line endings) needs a real runner before you call it verified.
4. **Commit** the version bump and changelog update.
5. **Push `main`, then wait for CI to go green.** Not the same step as tagging, deliberately: this
   push is the release (see above), so it is the last point at which a red run is still cheap.
   ```sh
   git push origin main
   gh run watch          # or: gh run list --limit 2
   ```
6. **Tag only once `main` is green:**
   ```sh
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```
   `git push --follow-tags` bundles both into one command, which is how v0.7.0 shipped to
   auto-update instances before anyone had looked at CI; it then failed the ubuntu leg on a
   win32-only path assertion. Prefer the two steps.

   **Name the tag in the push. Never `git push --tags`.** It pushes every local tag the remote is
   missing, not the one just created, and a `v*` tag is a release trigger. Releasing 0.19.3 that way
   also pushed a stale local `v0.8.0` and started a real Release build for a months-old commit; it
   was cancelled while still queued (`gh run cancel <id>`, then `git push --delete origin v0.8.0`),
   so nothing published. A minute later it would have been a public 0.8.0 sitting above 0.19.2 in
   the list that auto-update clients read. These trees accumulate stale local tags precisely because
   releases are normally pushed one at a time, so `--tags` looks harmless right up until it isn't.

   **If a tag does end up on a red commit,** do not move a published tag. Fix the failure, bump to
   the next patch version, and release that immutable version instead.
7. **Once the Release run is green, tell the site.** The download buttons on
   `agenthydra.github.io` link the versioned release FILES, and its static HTML (what crawlers,
   AI answer engines and no-JS visitors read) only moves when its sync workflow runs. It runs
   daily on its own; this makes it the same minute:
   ```sh
   gh workflow run sync-version.yml --repo AgentHydra/agenthydra.github.io
   ```
   The release job cannot do this itself - a cross-repo trigger from Actions needs a PAT the
   default token does not carry - but whoever pushed the tag has a `gh` login that can, which is
   how SageThumbs' `release.ps1` has always done it.

## The install script depends on SHA256SUMS.txt

`install.ps1` (repo root) is the documented one-liner install for Windows. It downloads the
`AgentHydra-<version>-windows-x64.zip` asset, downloads `SHA256SUMS.txt` from the SAME release, and
refuses to install on a mismatch or a missing entry. There is no skip switch, on purpose.

That makes the checksum file a **release contract, not a nicety**: the `Build checksums` step in
`release.yml` (`sha256sum out/* > out/SHA256SUMS.txt`) and its inclusion in the upload list must
both survive any edit to the release job. Drop either one and the installer stops working for
everyone on the next release, with a refusal rather than a silent downgrade in safety, which is the
right failure, but still a broken install path.

Two shapes to keep intact if the workflow is ever restructured:

* The ZIP is what gets installed, not the bare `.exe`. Only the ZIP carries `misc/` (the tray
  toolkit); a bundle without it can only run console-style, which is exactly the regression 0.11.2
  shipped.
* `sha256sum` writes `<hash>  out/<name>`, so the path field carries the `out/` prefix. The
  installer matches on the file's LEAF name for that reason; moving the build output to another
  directory is fine, renaming the assets is not.

**The install itself is transactional (AH-40).** After the checksum passes, `install.ps1` extracts
into a staging directory beside `-InstallDir` (same volume, so the real swap is a rename) and
validates the complete staged payload: exe present, `misc/` and `orchestrator/` present, and the
`--version` canary run **on the staged copy** before anything real is touched, then refuses to
proceed under a detected running instance (`AgentHydra`/`lunarwerx-tray` process, or a live pid in
`<config dir>\runtime.json`) unless `-Force` is passed. The three release-owned components
(`AgentHydra.exe`, `misc/`, `orchestrator/`) are then swapped one at a time: each is renamed aside (`<name>.old-<stamp>`),
the staged copy is moved into place, and orchestrator's user-owned `state/` directory is carried
across the swap rather than dropped. Any failure during the swap rolls every component processed
so far back to its `.old-` copy, so a disk-full, interrupted, or locked-file mid-copy can no longer
leave `misc/`, `orchestrator/`, and the exe at silently different versions. `-FromZip`, `-Sha256`,
`-InstallDir`, `-NoLaunch`, and `-Force` exist so this is testable offline (see
`tests/install-transactional.test.ts`) without touching a real install, the real daemon, or the
real tray; none of them change the default (no-arguments) behaviour a real user gets.

**The compiled self-updater owns the same three components (AH-08).** `server/src/github-updater.ts`
carries `RELEASE_COMPONENTS`, and a manual install and an in-app update can no longer disagree about
what a release IS: `orchestrator/` is swapped (renamed aside, the release copy moved in, the
user-owned `state/` carried across, a `.release-version` stamp written, retired files gone by
construction) and `misc/` is reconciled (release files copied in, retired files removed, a locked
file reported rather than silently skipped). Components go first, then the executable; any failure
rolls the executable AND every swapped component back as one unit, and the aside copies are
discarded only once everything has landed. A swap refuses to start while a toolbox script is running
through the daemon (`orchestratorBusy()`), and a bare-executable install acquires the toolbox on its
first update. `server/tests/github-updater-components.test.ts` pins `install.ps1`'s component list to
`RELEASE_COMPONENTS` by parsing the PowerShell, so the two lists cannot drift apart unnoticed.

**From 2.0.0 the self-updater also owns `desk2/`.** It stops Desk 2 before replacing `desk2/` and
starts it again after. Desk 2 includes its own dev-servers service that manages development servers
without requiring a separate daemon. `install.ps1` still swaps its three components; a compiled daemon
that finds no `desk2/` beside it (that install, a 1.x updater's, or the lone `.exe`) installs it from
its own version's release archive at boot, without a click.

## When a push doesn't trigger anything

GitHub's standard mitigation for an Actions incident is to **throttle webhook triggers**, which
fails in the most confusing possible way: `git push` succeeds, the commit and the tag are really on
`origin`, and no workflow run is ever created. Nothing is red; there is simply nothing. Both steps 5
and 6 above silently stall, because both wait on a run that will never exist.

Check <https://www.githubstatus.com/api/v2/components.json> for the `Actions` component before
assuming it's your fault:

```sh
curl -s https://www.githubstatus.com/api/v2/components.json | grep -A2 '"name": "Actions"'
```

`workflow_dispatch` is NOT throttled with the webhooks, so it is the way through. Both workflows
accept it:

```sh
gh workflow run ci.yml --ref main          # step 5's green gate
gh workflow run release.yml --ref vX.Y.Z   # step 6's publish
```

Dispatching `release.yml` **against the tag ref** is the important part. The publish job gates on
`github.ref_type == 'tag'`, not on the event that started the run, so a dispatch on a tag publishes
a real release exactly as a tag push would; a dispatch on a branch runs build + smoke and publishes
nothing. This is how v0.16.0 and v0.16.1 actually shipped on 2026-08-06.

Do NOT try to force the webhook by deleting and re-pushing the tag. Re-pushing an identical tag is
still a published tag moving, the failure mode this file warns about at the end of step 6, and it
buys nothing a dispatch doesn't already give you.

## What the tag push triggers

Pushing a tag matching `v*.*.*` triggers `.github/workflows/release.yml`. It builds one
self-contained executable for every supported OS (Windows x64, Linux x64/arm64, macOS x64/arm64),
boots every platform bundle **except darwin-x64**, verifies the health endpoint and an embedded
frontend asset, then publishes the GitHub Release automatically from the matching changelog
section. Windows exposes a direct icon-bearing GUI executable for people plus a one-executable ZIP
for the updater; Unix targets expose one-executable archives. `SHA256SUMS.txt` covers every asset.
`workflow_dispatch` runs the same build and smoke matrix without publishing a release.

**darwin-x64 (Intel mac) is build-only.** GitHub retired its Intel macOS runners, so the smoke job
has no honest way to boot that target: it is compiled and archived like every other target, but
never booted, and every other smoke assertion (tray inventory, orchestrator inventory,
`/api/health`) skips it too. This is a documented, deliberate gap until a native or self-hosted
Intel-mac runner exists, not a silent one.

## The orchestrator rides in the bundle (since 2026-09-03)

`orchestrator/` is the Python toolbox that decides what should happen to a chat (see
REFERENCE.md, "The orchestrator"). The release job stages its python half - `orch.py`,
`scripts/`, `docs/` - beside the executable as `orchestrator/`, which is where a compiled daemon
looks for it (`APP_ROOT/orchestrator`). Not staged: `state/` (runtime), `scripts/tests/`, and the
remote front-end (`orchestrator/server` + `orchestrator/web`), which need bun and are a source
checkout's business. Python 3 is the user's own; the daemon does not bundle it, and
`GET /api/orchestrator` reports whether it answers. `misc/rebuild_agenthydra.bat` is unaffected: it rebuilds
the daemon's own SPA, and the orchestrator's web dashboard is built separately with
`bun run --cwd orchestrator remote:build`.

**The smoke job asserts this inventory (AH-27), on every booted target.** Before boot, an "Assert
orchestrator payload" step unpacks the archive and checks: `orchestrator/orch.py` and
`orchestrator/scripts/lib/hydralib.py` are present, at least one `orchestrator/scripts/*.py` tool
exists, and none of `orchestrator/scripts/tests/`, any `__pycache__/` under `orchestrator/`, or a
non-empty `orchestrator/state/` made it into the archive. Without this, an archive that silently
lost `orchestrator/` would still pass every other smoke check (boot, `/api/health`, the SPA);
the daemon reports the tools unavailable rather than failing to start, so nothing else here would
ever notice.

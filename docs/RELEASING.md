# Releasing

## Pushing `main` is the release

Auto-update (see the README's Auto-update section) applies each update as a `git pull --ff-only`
against `origin/main`. There is no separate publish step for that path: as soon as `main` moves,
every instance with auto-update enabled will fast-forward to it on its next check. Treat a push to
`main` as user-facing, not as a staging step.

## Recipe

1. **Bump the version.** Update `version` in `package.json`.
2. **Update the changelog.** Move the relevant `[Unreleased]` entries in `CHANGELOG.md` into a new
   `## [X.Y.Z] - YYYY-MM-DD` heading, following the existing Keep a Changelog format already used
   in that file.
3. **Run local CI before pushing**, mirroring what CI runs: `bun install --frozen-lockfile`,
   `bun run typecheck`, `bun run check`, `bun run build`, `bun test`, `bun run dist`, and
   `bun run scripts/smoke-release.ts dist/AgentHydra.exe`. Don't rely on pushing to find
   out one of these fails.

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

   **If a tag does end up on a red commit,** do not move a published tag. Fix the failure, bump to
   the next patch version, and release that immutable version instead.

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
boots every platform bundle, verifies the health endpoint and an embedded frontend asset, then
publishes the GitHub Release automatically from the matching changelog section. Windows exposes a
direct icon-bearing GUI executable for people plus a one-executable ZIP for the updater; Unix
targets expose one-executable archives. `SHA256SUMS.txt` covers every asset. `workflow_dispatch`
runs the same build and smoke matrix without publishing a release.

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
   `bun run scripts/smoke-release.ts dist/CCManagerUI.exe`. Don't rely on pushing to find
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

## What the tag push triggers

Pushing a tag matching `v*.*.*` triggers `.github/workflows/release.yml`. It builds one
self-contained executable for every supported OS (Windows x64, Linux x64/arm64, macOS x64/arm64),
boots every platform bundle, verifies the health endpoint and an embedded frontend asset, then
publishes the GitHub Release automatically from the matching changelog section. Windows exposes a
direct icon-bearing GUI executable for people plus a one-executable ZIP for the updater; Unix
targets expose one-executable archives. `SHA256SUMS.txt` covers every asset. `workflow_dispatch`
runs the same build and smoke matrix without publishing a release.

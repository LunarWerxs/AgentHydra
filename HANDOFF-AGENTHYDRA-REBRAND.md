# Handoff: CC Manager UI to AgentHydra rebrand

Written 2026-08-02, updated the same day after the logo was replaced and the external surfaces
were done.

The rename is committed, pushed and live. No release has been cut.

- `LunarWerxs/AgentHydra` @ `366e292`, CI green on both windows-latest and ubuntu-latest.
- The shared kit, RepoYeti, ReDesign, DevWebUI and the LunarWerx catalog site are all committed
  and pushed too. The kit went first, and its own pre-commit hook re-verified all four apps in
  sync before it landed.

Still live:
- `LunarWerxs/CCManagerUI` is renamed to `LunarWerxs/AgentHydra`, with new description, homepage
  and topics.
- <https://agenthydra.lunarwerx.com/> serves the rebranded landing page, and
  <https://ccmanagerui.lunarwerx.com/> 301s to it with the path preserved.
- `edge-aliases` and `_org-avatars` are NOT git repositories, so their changes exist only on this
  machine. The Worker is deployed from that source; the brand art is hand-uploaded by design.

One web-UI step remains, in open item 2, plus the two image uploads in item 6.

Read this top to bottom before touching anything. The ordering constraints in "How to commit this"
and in open item 2 are real: the wrong order silently reverts other repos, or takes the live site
down.

---

## Why the name changed

The app manages Claude Code, Codex and OpenCode sessions, but "CC Manager UI" described a
Claude-Code-only tool. AgentHydra was picked for the many-heads image (many agent sessions, one
dashboard), and because it returns essentially nothing on Google and 1 repo on GitHub, so it does
not fight anything for search.

**One deliberate constraint:** the logo and copy use the **Greek myth** hydra, not Marvel's HYDRA.
Marvel's is a trademarked, in-universe-Nazi organisation. Same many-heads image, none of the
problems. Do not "improve" this by adding the Marvel skull-and-tentacles or "cut off one head" copy.

---

## What is done

### Naming, everywhere
446 occurrences across 91 files, done with a scripted case-aware replace
(`CC Manager UI`/`CCManagerUI` to `AgentHydra`, `CCMANAGERUI` to `AGENTHYDRA`, `ccmanagerui` to
`agenthydra`), then hand-fixed stragglers. Covers source, docs, workflows, tray/launcher scripts,
i18n copy, workspace package names (`@agenthydra/server`, `@agenthydra/web`), and the lockfile.

Two references intentionally keep the old name because they are historical statements:
- `.github/workflows/release.yml:19`: explains that the archive layout preserves the update path
  from older **CC Manager UI** releases. That is a fact about shipped artifacts.
- `CHANGELOG.md` entries at v0.13.0 and earlier. Those shipped under the old name. The changelog
  header now says so explicitly.

### Back-compat, so no existing install loses state
This is the part worth understanding before changing anything.

| Thing | New | Old still works? |
|---|---|---|
| Config dir | `~/.agenthydra` | Yes. Moved on first run; on any failure the app keeps reading `~/.ccmanagerui` in place. |
| Database | `server/data/agenthydra.db` | Yes. Renamed in place with its `-wal`/`-shm` sidecars; falls back to the old name if locked. |
| Env vars | `AGENTHYDRA_*` | Yes. Every one falls back to `CCMANAGERUI_*` via `appEnv()` in `server/src/config.ts`. |
| localStorage | `agenthydra.*` | Yes. Copied from `ccmanagerui.*` before the app mounts. |

**The single most load-bearing line in the whole rebrand** is the legacy fallback in
`server/src/single-instance.ts`. The last CC Manager UI release spawns its successor with
`CCMANAGERUI_RELAUNCH=1`. If the new build does not read that spelling, the successor probes
`/api/health`, sees its still-alive predecessor, and exits, leaving **zero daemons** on every
auto-update. Do not remove that fallback until at least one release has shipped under the new name.

Key files:
- `server/src/config.ts`: `appEnv()`, `resolveConfigDir()`, `resolveDbPath()`, `noAutoOpen()`.
- `server/src/single-instance.ts`: the relaunch fallback above.
- `server/src/updater.ts`: mirrors `CCMANAGERUI_UPDATE_REPO` forward, because the shared kit's
  updater engine accepts only one env-var name.
- `web/src/lib/storage-rebrand.ts`: localStorage carry-over, called first thing in `main.ts`.

### Logo
The final mark is in `misc/brand/icon.svg`, and that file is the **only** place it is authored:
a white three-headed hydra on a rounded tile split vertically, orange `#c15f3c` on the left and
sage `#70a597` on the right.

Everything else is derived from it, in this order:

```
copy misc\brand\icon.svg web\public\favicon.svg
magick -background none misc\brand\icon.svg -resize 1024x1024 -depth 8 PNG32:misc\AgentHydra-icon.png
powershell -File misc\Make-Icon.ps1          # -> misc\AgentHydra.ico (16/24/32/48 + 256)
copy misc\AgentHydra.ico web\public\favicon.ico
```

That chain is also written at the top of `misc/Make-Icon.ps1`.

`.github/og-image.png` is **not** in that chain, deliberately. It is a byte copy of
`_org-avatars/share-images/AgentHydra.png`, the house social card, generated by
`_org-avatars/tools/make-share-cards.py` from its `CARDS["AgentHydra"]` entry. That entry is the one
place the card is designed, and the same image serves as both the README banner and the GitHub
social preview, so the two cannot drift. Regenerate with:

```
python tools\make-share-cards.py AgentHydra    # run from D:\PublicProjects\_org-avatars
copy share-images\AgentHydra.png ..\ccmanagerui\.github\og-image.png
```

The banner was briefly rebuilt by a repo-local generator instead, `scripts/og-image.mjs`. That was
the wrong call twice over: it was a second design of the same artifact, and what it faithfully
reproduced was a plain logo-and-wordmark card that the house template already beats. The generator
has been deleted; do not reintroduce it.

**The app accent is still `#c15f3c` only.** The sage half of the tile is not wired into the theme,
so every badge and accent in the app still matches the orange. Introducing `#70a597` as a second
theme colour is a deliberate design decision nobody has made yet, not an oversight.

The mark reads clearly as a hydra at 256px. At 16px it is a legible two-tone tile with a white
glyph but the heads merge, and the same was true of the old figure mark, so this was accepted, not
missed.

### Rebrand notice
- **README**: a blockquote at the top explaining the rename and exactly what does and does not
  need user action.
- **CHANGELOG**: a full `### Changed` entry under Unreleased.
- **In-app**: a one-time toast, 30s, with a "Details" action linking to the changelog. It fires
  **only for upgraders**: `migrateLegacyStorageKeys` sets a sentinel when it actually finds
  pre-rename keys, and `App.vue` consumes it on mount. A fresh install never sees it.

### Shared kit (`D:\PublicProjects\lunarwerx-ui`)
The app key and accent file were renamed (`accent-ccmanagerui.css` to `accent-agenthydra.css`), and
five kit source files had the app's name updated in comments. `node sync.mjs` was then run, which
**also pushed comment-only changes into RepoYeti and ReDesign** (6 files each, 9 lines each,
comments only, verified). DevWebUI was unaffected.

`kit.config.json` still points at `D:/PublicProjects/ccmanagerui` because **the local folder was
deliberately not renamed**, see open items.

### Verification actually run
- `bun run check` (biome + i18n + kit sync): green.
- `bun run typecheck` (vue-tsc + tsc): green.
- `bun test`: **567 pass, 4 skip, 0 fail**, 571 tests across 61 files. The errors printed in that
  output are deliberate test fixtures, not failures.
- `bun run build`: green.
- **Live daemon on :7787**: `/api/health` returns `"service": "agenthydra"`, page title
  `AgentHydra`, header reads `AgentHydra`.
- **Live migration, real data**: the actual dev database `server/data/ccmanagerui.db` (1.6 MB) plus
  its `-wal` and `-shm` were renamed to `agenthydra.db*`. A seeded fake `~/.ccmanagerui` was moved
  to `~/.agenthydra` with contents intact.
- **Live localStorage carry-over**: seeded `ccmanagerui.sessions.sidebarWidth=415` and
  `period="7d"`, reloaded, confirmed both survived under `agenthydra.*`, that `lunarwerx-theme` was
  untouched, that the toast fired with the right copy, and that a second reload did **not** re-fire
  it.
- Both verification daemons were shut down and the comparison worktree removed. Nothing is left
  running.

New tests added: `server/tests/config-rebrand.test.ts` (12 cases over the dir/db resolvers) and
`web/tests/storage-rebrand.test.ts` (8 cases over the localStorage carry-over).

---

## Open items

### 1. Unexplained i18n console error: NOT resolved, do not assume it is pre-existing
The running app logs `SyntaxError: 17` twice from `vendor-i18n` at App mount. The UI works; nothing
visibly breaks.

What is established:
- All 570 static English messages compile cleanly. Verified offline by running every one through
  `@intlify/message-compiler` directly.
- `bun run check:i18n` passes, so every static `t("a.b")` resolves to a real key.
- So it is **not** a static catalog problem, and the prime suspect is a `t()` call receiving
  dynamic content (a session or queue string containing `{` or `}`), which would be pre-existing.

What is **not** established: I built a pre-rebrand worktree at HEAD and it logged no errors, but
**it ran against an empty database**, so the erroring code path never executed. That comparison is
invalid and I am not claiming it clears the rebrand.

**Next step to actually settle it:** copy `server/data/agenthydra.db` to a scratch path, run a
pre-rebrand worktree build with `CCMANAGERUI_DB` pointed at the copy, and compare consoles. If the
error appears there too, it predates the rename and is a separate bug.

### 2. The rename is LIVE. One web-UI step is left.
`LunarWerxs/CCManagerUI` is now **`LunarWerxs/AgentHydra`**, with its description, homepage
(`https://agenthydra.lunarwerx.com/`) and topics updated. GitHub redirects the old URL for both web
and git, so existing clones and the built-in updater keep working.

**The site host was the thing the earlier draft of this document got wrong.** The README and badges
pointed at `agenthydra.github.io`, which is not where any product in this family lives. The site is
GitHub Pages behind a `lunarwerx.com` subdomain, exactly like `sagethumbs`, `redesign`,
`quickdictate`, `devwebui` and `ytsort`.

Live and verified as of 2026-08-02:

| Hostname | Answers |
|---|---|
| `https://agenthydra.lunarwerx.com/` | 200, the rebranded page, HTTPS enforced. `icon.svg`, `og.png`, `favicon.ico`, `robots.txt` and `sitemap.xml` all 200. |
| `https://ccmanagerui.lunarwerx.com/` | 301 to the above, path preserved (`/sitemap.xml` lands on `/sitemap.xml`), served by the `lunarwerx-aliases` Worker. |

How it got there, because two of these are worth knowing:

- The Cloudflare DNS work went through the **Connections MCP vault credential**, not wrangler. The
  machine's wrangler OAuth token has `workers_routes:write` but no zone DNS scope: the DNS API
  answers `10000 Authentication error`, and `POST /accounts/.../workers/domains` answers
  `10405 Method not allowed for this authentication scheme`. Reach for the vault
  (`cloudflare_dns_records_for_a_zone_*`, `cloudflare_workers_domains_update`) for anything
  zone-level here.
- `override_existing_dns_record: true`, which `edge-aliases/README.md` documents as the way to claim
  a hostname that already has a record, **did not work**: both wrangler and the direct API returned
  `100117 already has externally managed DNS records`. What worked was deleting the old CNAME first
  and then attaching the Worker domain, which mints its own record. The old record was
  `CNAME ccmanagerui.lunarwerx.com -> ccmanagerui.github.io`, DNS-only, TTL auto, if it ever needs
  restoring.

**The one step left, which needs your account:** rename the org `ccmanagerui` to `agenthydra` at
<https://github.com/organizations/ccmanagerui/settings/profile>. It is web-UI only: GitHub's REST
API silently ignores a `login` field on `PATCH /orgs/{org}`, and no browser here is signed in to
GitHub. `agenthydra` was free on GitHub when checked.

Nothing is broken until you do it, because the site is deliberately wired to the **pre-rename** host.
Two things follow it, in this order:

1. Rename the repo `agenthydra/ccmanagerui.github.io` to `agenthydra.github.io`.
2. Repoint the DNS record: `agenthydra.lunarwerx.com` currently CNAMEs to `ccmanagerui.github.io`,
   which is correct only while the org still has that name. Change its content to
   `agenthydra.github.io`. Its Cloudflare record id is `1c5c3388e0acf5b1d751473d2c7cf5f5` and its
   comment already says so.

### 2b. Everything outside this repo that is already done
- **`D:\PublicProjects\ccmanagerui.github.io`**: full rebrand. Head/OG/Twitter copy, hero, footer,
  terminal replica, MCP snippet, canonical, sitemap, robots, CNAME, plus `icon.svg`, `favicon.ico`
  and `og.png` regenerated from the new mark. The copy also stopped describing a Claude-only tool,
  which was the whole reason for the rename.
- **LunarWerx site** (`LunarWerx/website/lunarwerx.website.v1.1`): the `companies.ts` card is
  renamed and rewritten for all three CLIs, with `logos/agenthydra.svg` and a new 1200x520
  `banners/agenthydra.jpg`. The `public/cnx/**` datasets still say `ccmanagerui`: they are
  **generated** from local folder names by `scripts/cnx/generate.mjs`, so they correct themselves on
  the next run after item 3 below.
- **`_org-avatars`**: new 512x512 avatar, new 1280x640 social card, README tables updated, both
  proof sheets regenerated. See item 6.
- **Sibling repos**: the present-tense references to this app by its old name in ReDesign, RepoYeti
  and DevWebUI are updated, as is `lunarwerx-ui/README.md`. Genuinely historical records were left
  alone on purpose: the v0.6.0 dirty-kit story in `sync.mjs`, the pre-commit hook comment, the
  leaked-codename incident note in the kit README, and `NEEDS_MICHAEL.md`'s release log.

### 3. Local folder is still `D:\PublicProjects\ccmanagerui`
Deliberate. Renaming it would break `kit.config.json` paths, desktop shortcuts, and any other Claude
session with that working directory. Do it when nothing else is open, then update the four paths in
`lunarwerx-ui/kit.config.json`.

### 4. Version number
Still `0.13.0`. A rename with a data migration probably deserves a minor bump before release.

### 5. Screenshots in the README: done
Regenerated with `bun run screenshots`. All three now show the new mark and the AgentHydra
wordmark in the header, and the run's own assertion held: every `/api/` response was synthetic, so
no daemon ran and no real session data was in scope.

### 6. Upload the two brand images by hand
`_org-avatars` is a hand-upload folder by design: nothing there is referenced by code, and GitHub
has no API for either target. Both are per-repository, so the pair has to be set twice, once on
`LunarWerxs/AgentHydra` and once on the site repo.

- **Org avatar**: `_org-avatars/AgentHydra.png` (512x512), at the `agenthydra` org's profile
  settings. It is the one split background in the family, because the two-colour tile IS the mark;
  `_org-avatars/README.md` now records that as a deliberate exception to the solid-background rule.
- **Social preview**: `_org-avatars/share-images/AgentHydra.png` (1280x640, 249 KB, well under
  GitHub's 1 MB cap), under repo Settings, Social preview.

The old `ccmanagerui` avatar and card are deleted, and both proof sheets are regenerated.

### 7. The share card's domain is right; the rest of the family's is not
`CARDS["AgentHydra"]` renders `agenthydra.lunarwerx.com`, which is where the site actually lives.
The other five cards still print `<name>.github.io`, and none of those is the real hostname either;
they all moved to `lunarwerx.com` subdomains. That is a pre-existing inaccuracy across the set, left
alone here rather than quietly widened into a five-project change.

---

## How this was committed, and what is still dirty

The order was load-bearing and was followed: **`lunarwerx-ui` first**, then **RepoYeti, ReDesign and
DevWebUI**, then **this repo**. The kit goes first because its check refuses a dirty kit on purpose:
apps are synced from source that exists only on this machine, so a fresh clone plus a sync would
revert every app to older copies. That guardrail is not theoretical, it is how ccmanagerui v0.6.0
shipped. The kit's own pre-commit hook re-ran the drift check across all four apps and reported
every one in sync before it landed.

### Seven files are still dirty here, on purpose

`server/src/core/accounts.ts`, `core/instances.ts`, `core/shared.ts`, `web/src/QuickInstancesApp.vue`,
`web/src/composables/useInstances.ts`, `web/src/lib/instance-appearance.ts`,
`web/tests/instance-appearance.test.ts`, plus an untracked
`server/tests/accounts-stale-login.test.ts`.

These are **unrelated in-flight work from other sessions**, and several of them ALSO carry rebrand
edits. Those edits are comments and one self-contained PowerShell namespace string, so they are
harmless to leave behind, and they should land with their owner's work rather than be torn out of
it. **Do not `git stash` or `git checkout --` anything here** to tidy up: several sessions share
this tree and that discards their work irreversibly. Stage by path.

### Verify a partial commit in a worktree, not in this tree

Splitting a shared tree produces a combination nobody has ever run. That is not a hypothetical: the
first attempt at this commit was green in the working tree and **broken as committed**, because
`web/tests/instance-appearance.test.ts` imports `loginChanged`, a symbol that exists only in the
uncommitted half of `instance-appearance.ts`. `bun test` in the working tree cannot see that, since
the working tree has both halves.

What catches it is checking out the commit itself:

```bash
git worktree add --detach <scratch>/verify <sha>
# junction node_modules, web/node_modules and server/node_modules in from the real repo
cd <scratch>/verify && bun test && bun run typecheck && bun run build
```

Remove the junctions with `rmdir` **before** `git worktree remove`: a recursive delete that walks a
Windows junction deletes the real target behind it.

## If you want to undo the rebrand

It is committed and pushed now, so reverting means `git revert 366e292`, not a checkout. A checkout
would also destroy the other sessions' in-flight work listed above. Note that a revert only touches
this repo: the GitHub rename, the live site and the DNS are separate and would each need undoing,
and open item 2 has the original values for the DNS records.

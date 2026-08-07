# Changelog

All notable changes to AgentHydra are documented here. Entries up to v0.13.0 were written when the
project was called CC Manager UI and are left in its name, because that is what shipped. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.18.0] - 2026-08-07

### Added

- **Quick Instances gets the quota columns and the usage filter, and remembers how you left them in
  the full manager.** The compact window showed a single weekly badge and no way to act on it. It
  now carries both readings (5h and week) behind the same usage-mode toggle the Instances tab uses,
  and the same "set aside the accounts I've used up" filter, with dim/hide and per-window
  thresholds. It is the same state, not a copy: both surfaces read one shared singleton, and the
  filter rule itself has only ever had one implementation.
  - **The state is mirrored through the daemon**, which is what makes "remembers" true. Quick
    Instances normally opens on the running daemon's port, but with no daemon it starts its own
    server on a *different* port, and a browser scopes `localStorage` per origin, port included. So
    the window that ran standalone landed on a blank slate every time. A small store
    (`~/.agenthydra/ui-prefs.json`, served by both daemons) now holds the handful of keys; the
    server wins on load and `localStorage` stays as the instant-paint cache. A first run seeds the
    store from whatever the browser already had, so existing settings carry over rather than
    trickling in as controls are touched.
- **The app checks for updates on its own, and says so where you can see it.** Auto-*apply* is off
  by default because it restarts the daemon, but that flag also gated the *check*, and the only
  other code that ever asked was the Settings screen's own mount. Run an older build and never open
  Settings, and nothing ever told you. Checking and applying are now separate: the loop always
  checks, applying stays opt-in and unchanged, and a newer version puts a dot on the Settings
  button. A manual check feeds the same signal, so the hint is never staler than what you have
  already been shown.
- **The update tells you what it is doing.** Clicking the version to update bound a spinner to one
  request that legitimately covers minutes on a source checkout (a pull, then a dependency reinstall,
  then a web build), and reported nothing until it finished, so a healthy slow update and a hung one
  looked identical. The compiled path now streams its download and reports real progress
  (`Downloading v0.17.0… 62% (22/36 MB)`), then extraction, verification and install; the source
  path reports its phase and says why it takes a few minutes. The apply request is also bounded at
  20 minutes, so the spinner always ends: a daemon that restarts itself mid-apply (which a compiled
  apply does on purpose) used to leave it turning until the user reloaded the page.

### Fixed

- **Clicking update on a downloaded release no longer spins forever after the update has already
  succeeded.** This was the actual cause, and it is not slowness: a compiled apply is only a few
  seconds of work (measured on the real v0.17.0 asset: 2.3 s to download, 0.5 s to extract). But the
  daemon deliberately restarts itself afterwards, and it began that restart 250 ms after writing the
  response, exiting about a second later. A browser that had not finished reading by then lost the
  socket, the request failed, and the spinner turned on an update that had in fact completed. The
  restart now waits three seconds, and the page independently recovers by polling the daemon's
  health and reporting the version that comes back, so the outcome is reported either way.

- **Toasts have a close button.** `<Toaster>` was mounted without `close-button`, and vue-sonner
  defaults it off, so no toast in the app could be dismissed except by waiting. It showed worst on
  the plain ones ("Auto-updates enabled"), which carry no action button either and so had no
  controls at all. The kit's wrapper already shipped the glyph and pinned it top-right; it was
  simply never switched on.
- **Opening the app no longer resolves every instance over the network.** The sessions list, the
  queue drawer and the composer all pull the shared instance singleton just to put a name on a chip,
  and each one triggered a full identity resolve of every instance. Measured on a 15-instance
  install: 15 profile calls, 4-wide, ~1.4 seconds of continuous requests, to label chips the on-disk
  cache answers in about 25 ms. Those callers now read the cache; only the Instances tab, the
  screen that is *about* accounts, resolves for real, and a login that provably changed is still
  corrected immediately. Now 1 network resolve, done in under 0.6 s.
- **The Instances tab no longer probes every account's quota at once on open.** It fired one forced
  probe per instance from a single unbounded `Promise.all` the moment the lists arrived. Measured
  at 14 simultaneous requests, the slowest taking 8.8 seconds, on every open. The server already
  keeps a usage cache that survives restarts and re-sweeps on its own timer, so the table has
  numbers immediately; only readings that have aged out are re-checked now, two at a time with a
  stagger. Now 2 probes instead of 14.
- **A crashed daemon no longer costs half a second on the next boot.** The single-instance guard
  re-probes three times before concluding nothing is running, which is right when a daemon might be
  alive but busy, and pointless when `runtime.json` names a process that no longer exists. The
  tombstone case is now detected directly. Boot after a hard kill: ~1,420 ms → ~920 ms.
- The full manager's toast stylesheet loaded on its own round trip after the app and i18n chunks,
  rather than alongside them.

## [0.17.0] - 2026-08-07

### Added

- **Every instance now has a permanent number, and you can talk to the MCP server in numbers.**
  Until now nothing an instance carried was usable as a spoken or written handle: a Claude Desktop
  instance is identified by its folder path, a Claude CLI or Codex instance by a random uuid. Worse,
  the folder name is not even reliable: sign a profile into a different account than the one it was
  named after and it keeps showing the old name (this machine has exactly that, the folder
  `3claude` is signed into the account labelled `4claude`, and vice versa). So "check instance 7's
  usage" was a sentence with nothing behind it. Now `#7` is a real identifier.
  - **One sequence across all three families** (Desktop, CLI, Codex), so a bare `7` never needs a
    kind beside it. Assigned on first sight and **never reused**: a number retired by a deleted
    instance stays retired, because the whole value of the handle is that a note saying "instance 7"
    still means the same account next month. A cold start numbers the fleet in sorted-ref order, so
    the same set of instances numbers identically on any machine.
  - **Visible where you read it**: a `#N` chip on every row of all three instance tables, and a
    header on every row's ⋯ menu naming which instance the menu belongs to. Both copy on click.
  - **Accepted where you act**: every MCP tool that addresses an instance takes `instance`, which
    accepts the number (`7`, `#7`), the dir/id, a `desktop:<dir>`/`cli:<id>` ref, or an unambiguous
    name. The legacy `dir` / `id` parameters are unchanged, so nothing that already worked broke.
  - **Three new MCP tools**: `list_instance_numbers` (the whole fleet, one flat numbered list with
    each account's email and plan), `resolve_instance` (confirm which account a reference means
    before spending its quota; its errors distinguish an unknown number from a retired one),
    and `whoami` (which numbered instance THIS process is, matched from its own
    `CLAUDE_CONFIG_DIR`/`CODEX_HOME`).
  - `check_my_usage` now reports `instance` alongside the numbers, so an agent can say "instance #7
    is at 84% weekly" instead of an unattributed percentage. `list_usage` rows carry `num` too.
  - `usage_budget` gained the `instance` form, which incidentally **fixes a gap**: it previously
    only accepted a desktop dir or a dispatch account, so a CLI or Codex login could not get a
    budget at all. A CLI instance's token spend is now measured against its own config dir rather
    than defaulting to the `~/.claude` login, which belongs to a different account.
  - A queue item's `instance_ref` accepts a number too; it is expanded to a real ref before the item
    is stored, so a pinned run can never fail to resolve later, at dispatch time, with nobody
    watching.
  - New REST routes: `GET /api/instance-numbers`, `/api/instance-numbers/resolve?ref=`,
    `/api/instance-numbers/whoami?configDir=`, plus `instance=` on `/api/usage` and
    `/api/usage/budget`.
- **The usage filter can now set aside an account for its 5-hour window as well, on its own
  threshold.** A spent 5-hour session means you cannot use an account *right now*; a spent weekly
  cap means you cannot use it *at all*. Those are different questions, and the filter could only ask
  one of them at a time: the old "Measure against Weekly / 5h / Either" tri-toggle shared a single
  number across both windows, so "set it aside at 80% of the week, but already at 50% of this
  session" was not expressible (owner-reported).
  - Each window is now its own switch with its own threshold, and a row is set aside when **either**
    line is crossed. **Weekly** stays on by default; **Also 5-hour usage** is opt-in, because that
    window refills the same day and filtering on it by default had rows leaving the table and coming
    back over an afternoon.
  - A stored `Weekly` / `5h` / `Either` choice carries over to the pair of switches that behaves
    identically, so nobody's filter silently re-points at a different window on upgrade. An
    unreadable or missing threshold lands on the default rather than on 0, which as a threshold
    would have meant "set aside every account that has any reading at all".
  - The toolbar button says the whole rule (`80% · 5h 65%`), so a dimmed table explains itself
    without opening the flyout.
  - **Fixed**: the "every instance is filtered" empty state told you to *lower* the threshold, which
    hides more rows, not fewer.

### Changed

- **The usage flyout is laid out as labelled sections over cards** rather than one run of
  hairline-divided rows. With two windows, each carrying a switch and a threshold, an
  undifferentiated list left no way to see which threshold belonged to which switch. Each window is
  now a card that visibly contains its own controls, its threshold reads as a value display, and a
  slider sits beside the presets for setting a figure that isn't one of the four.

## [0.16.2] - 2026-08-06

### Added

- **A Codex Desktop you didn't create through this app is now listed.** The table only ever showed
  instances created here, so someone running a perfectly normal Codex Desktop saw "No Codex
  instances found" (owner-reported). The default install is now always listed, running or not,
  because its identity lives in CODEX_HOME on disk and is readable either way; a Codex Desktop found
  running from any other unrecognized profile is listed too. Both are flagged external and offer no
  actions, mirroring `isExternal` on the Claude side, since they have no store row to act on.
  - The default install could never have matched before: its profile is the shipped app's own
    Electron path (`%APPDATA%\Codex\web\Codex` on Windows), not the `<CODEX_HOME>/desktop` layout
    this app imposes on instances it creates. A running instance is matched on the path its own
    process announces, so no platform guessing is involved when it counts.
- **Codex / ChatGPT instances now have a real identity, a plan, and a quota reading.** Until now a
  Codex row carried exactly one identity signal, `loggedIn`, which was literally "does auth.json
  exist", so every row looked alike no matter which account or plan was behind it. The table now
  has **Account**, **Usage** and **Plan** columns, matching the Claude tables.
  - Identity comes from `<CODEX_HOME>/auth.json`, which is plain JSON rather than a safeStorage
    blob, so there is no decrypt step: the email, name, plan, account id, org and subscription end
    date are read straight from the id_token's claims. That read is cheap enough to attach to every
    row on every list, so the Account column fills in on first paint with no per-row request.
  - Quota comes from the endpoint the Codex CLI's own status screen uses
    (`GET /backend-api/codex/usage`), which answers identity AND rate limits in one call. The
    windows are mapped onto the SAME `UsageSnapshot` the Claude rows use, so Codex inherits the
    whole existing quota surface: the chip, the countdowns, the usage filter, the superseded-window
    rule below. Windows are filed by their reported LENGTH, never by primary/secondary: a Plus
    account reports its single 7-day window as `primary_window`, so position would have mislabelled
    an entire plan tier as a 5-hour session.
  - The live `plan_type` wins over the token's `chatgpt_plan_type` claim, which is a mint-time
    snapshot. This is the same evidence rule the Claude-side fix below arrives at, applied from the
    start rather than after a regression.
  - An `OPENAI_API_KEY` login is labelled "API key" rather than rendered as a broken ChatGPT login:
    it is a valid Codex auth with no subscription and therefore no plan or quota to report.

### Changed

- **A 5-hour reset no longer notifies for an account you have filtered out.** The weekly cap is what
  actually blocks an account, so a session window coming back while weekly is still spent announces
  a change you cannot act on. Reset notifications now skip a 5-hour rollover when that account's
  weekly usage is at or above a threshold, defaulting to 80, the same line the Instances usage
  filter uses to set a row aside. Weekly resets are never skipped, an unknown weekly figure never
  silences anything, and the threshold is its own control in Settings › Notifications.

### Fixed

- **A free account no longer shows as "Max 20×".** Owner-reported: an account that is
  `organization_type: "claude_free"`, `billing_type: "none"`, `has_claude_max: false` was labelled
  Max 20×. The cause was the previous release's own fix, which promoted the OAuth grant to top
  evidence on the premise that Anthropic re-mints it on every token refresh. It does not. Measured
  by decrypting all eleven local token caches and diffing each against its live profile, the grant
  is a snapshot from whenever it was minted and is stale in **both** directions: the free account
  carried three unexpired grants all still claiming `subscriptionType: "max"` /
  `rateLimitTier: "default_claude_max_20x"`, while two genuinely-paid accounts carried a `max_5x`
  grant tier against an org reporting `max_20x`.
  - The plan now comes from `organization.organization_type`, which the profile API recomputes on
    every call. It settles the plan family outright; the rate-limit tier only refines a `claude_max`
    family into 5× or 20×, and the grant is demoted to an offline fallback.
  - Both prior findings still hold and are still respected: a paid Pro account really does report
    the generic `default_claude_ai` tier (0.16.1), and `has_claude_max` / `has_claude_pro` really do
    stay true after an account lapses (2026-07-22). Neither can decide the label any more, so
    neither can be wrong about it.
  - `organization_type` is cached alongside the rest of the identity, so the offline/no-network path
    reaches the same answer instead of falling back to the stale grant.
- **The account one-liner no longer leaks a raw tier string.** The Quick view showed
  `Michael <blogitech@gmail.com> · default_claude_ai` for any account whose tier is the generic
  value. It now shows the same reconciled label the Plan column does.
- **A usage reading whose window has already reset no longer poses as current.** The same instance
  sat at "100% · resets now" from an eleven-day-old cached snapshot: the countdown said *now*
  (formally true, the instant had passed) and the percentage kept asserting a window that had rolled
  over days earlier. A limit whose reset is more than a couple of minutes past is now treated as
  superseded: the chip reads as no-data, the countdown blanks rather than saying "now", and the usage
  filter counts it as unknown so a fully-reset account can never stay hidden behind a number that no
  longer applies. This is distinct from the existing 30-minute "stale" dimming, which still shows
  the last known reading because it is still a reading of the current window.

## [0.16.1] - 2026-08-06

### Fixed

- **A paid account no longer shows as "Free".** Two independent faults in the same evidence chain,
  both owner-reported and both verified against real accounts:
  - The rate-limit tier was read from the profile's ORGANIZATION (`organization.rate_limit_tier`),
    which for a personal org is routinely the generic `default_claude_ai` even on a paid plan. That
    generic value was preferred unconditionally over the OAuth grant's own tier, so a Max 20x
    account whose grant plainly said `default_claude_max_20x` had its only specific answer thrown
    away and rendered as Free. A specific tier now wins wherever it comes from, and the generic
    value is only settled for when nothing better exists.
  - A generic tier was itself treated as proof of a free account. It is not: an actively-paid Pro
    account reports `default_claude_ai` on its grant too (confirmed by decrypting the token cache:
    subscriptionType `pro`, unexpired). A generic tier now means "this signal knows nothing" and
    falls through to the grant's subscription type; it only resolves to Free when there is no
    subscription evidence behind it at all, which is the genuine free-account shape.
  - The 2026-07-22 finding that motivated the old behaviour still stands, because it was about a
    different field: the profile's `has_claude_max` / `has_claude_pro` booleans stay true for an
    account that lapsed back to free. Those are entitlement history rather than current state, and
    they can no longer overwrite a grant that says otherwise; they are consulted only when there is
    no grant to ask.

## [0.16.0] - 2026-08-06

### Added

- **Usage filter.** With the quota columns on, a funnel button appears in the Instances toolbar:
  set a percentage and the instances at or above it are dimmed, so the accounts you can still work
  on are the ones that read clearly. A **Hide instead of dim** switch drops them from the table
  outright; both tables then say "4 of 11 · 7 hidden" in their heading, because an instance that
  silently stopped being listed reads as a bug rather than as the filter working.
  - **Measure against** picks the window the threshold applies to. It defaults to *Weekly*, the
    Usage column: that is the cap that decides whether an account is worth starting on. *5h* reads
    the shorter session window and *Either* takes whichever of the two is closest to its cap, both
    of which are opt-in, since a 5-hour reading comes back the same day and would otherwise have
    rows dropping out and back in over an afternoon.
  - An instance that has never been checked is never filtered. An unknown reading is not a full one,
    and treating it as one would quietly remove a perfectly usable account from the table.
  - The filter lives and dies with usage mode: switching back to the process columns restores a
    plain table, so a dimmed row always has the control that explains it visible in the same toolbar.
- **Expanding and collapsing a section animates.** The two instance tables, the Codex table and the
  queue card's run viewer used to appear and vanish between frames, with a rotating chevron as the
  only sign anything had happened. They now open and close over 0.22s, matching the speed the kit's
  collapsibles already used elsewhere in the app, and honour `prefers-reduced-motion`.
  - This needed a component of its own rather than the kit's `ExpandTransition`, which keeps
    `overflow: hidden` on its wrapper permanently. An element with a non-visible overflow becomes
    the scrollport that `position: sticky` resolves against, so wrapping a table in it silently
    stops the header sticking, which is exactly why these tables had no animation to begin with.
    The local one clips only while the transition is actually running, i.e. the one moment nothing
    is being scrolled. Popovers and focus rings inside an expanded block stop being cut off at its
    edge as a side effect.

### Fixed

- **Reset toasts no longer deal themselves into the wrong slots, or jitter under the pointer.**
  vue-sonner (2.0.9, the current release) positions its stack from a heights array it keeps beside
  the rendered toasts, and each toast measures itself in an effect that awaits a tick. Raise two in
  the same tick and those measurements come back in the reverse of the raise order while the array
  blindly prepends each one, so every card's offset is attributed to a different card. Measured
  here with three at once: the front toast got the middle card's offset and the middle one got zero.
  With a backlog of ten it threw the front toast ~817px up, past the top of the window and out from
  under the pointer, which collapses the stack, puts the toast back under the pointer and re-expands
  it: the up-down-up-down jitter, at hover speed. Toasts are now raised one macrotask apart, which
  is enough for each measurement to land before the next card mounts.
- **A backlog of resets is one toast, not ten.** Above three at once (the window was closed while
  several accounts rolled over) they collapse into a single "N quota windows reset" card whose
  action acknowledges the batch. Ten 20-second cards timed out before they could be read, and the
  stack's expanded height is the sum of all of them, so a hover unfurled something taller than the
  window. Every event is still in the list the header badge counts.
- **The Instances tab stopped starting a PowerShell process every few seconds.** Listing instances
  needs each Claude process's command line, which on Windows means
  `powershell -NoProfile -Command "Get-CimInstance Win32_Process ..."`: measured here at ~490ms, of
  which ~130ms is the shell starting and ~260ms is the WMI query. That ran per request, and the tab
  polls every 4 seconds, with the Codex table running a near-identical second query on its own 5s
  timer. So for as long as the app was open it was starting shells, forever, and every one of those
  half-seconds sat on the request path, first paint included. `GET /api/instances` went from ~490ms
  to ~5ms on the same machine and the same data.
  - The scan is now one shared snapshot. Concurrent callers join a single in-flight query instead of
    each starting a shell; a result under 3s old is reused outright; an older one is returned
    immediately while a refresh runs behind it, so the tick that pays for the scan is never the tick
    that waits for it. Nothing here holds a timer, so closing the UI stops the scanning dead.
  - Everything that ACTS on the answer still enumerates for real: launching, quitting, focusing, and
    the guard that refuses to delete a running instance. Launching and quitting also drop the
    snapshot, so the row you just clicked updates on the next poll rather than when a TTL expires.
- **The account column fills at page load instead of a second and a half later.** Every instance's
  identity was resolved over the network, one strictly after another, and on a fresh load nothing is
  resolved yet, so eleven accounts meant eleven serial round trips. The locally cached identity is
  now painted first (25ms for all eleven, against ~1.5s for the same eleven over the network) and
  the live resolve follows behind it, a few at a time, correcting anything that has changed.

### Changed

- **The Instances tab opens on the quota columns.** "How much have I got left" is the question the
  table gets opened for; PID, uptime and memory answer "is the process healthy", which is the rarer
  follow-up. The toolbar toggle still swaps back in one click. This is a genuine default change
  rather than a flipped flag: `useStorage` writes its default on first read, so every install that
  had ever rendered the tab already carried an explicit `false` on disk and changing the default
  alone would have reached nobody. The mode moved to a new key, leaving the old one as a dead
  entry, on the same reasoning as the usage filter's `scope2`.
- **Inter is served by the app, not fetched from Google.** The shared kit's base stylesheet opens
  with an `@import` of `fonts.googleapis.com`, and a remote `@import` at the head of a
  render-blocking stylesheet blocks first paint on a round trip to the internet. Free on a warm HTTP
  cache, which is why it went unnoticed, but dead time on a first run or after a cache eviction and
  an outright stall with no network, on a local desktop app that otherwise never needs to be online.
  The two Latin subsets of Inter's variable woff2 now ship under `web/public/fonts/`. Same typeface,
  no flash of fallback text, and the app renders offline.
  - The kit copy is left byte-identical (its sync tool compares and rewrites synced files as text,
    so it cannot carry font binaries without being reworked first); the remote import is stripped
    from this app's CSS at build time instead. Any sibling app can adopt the same two files and
    stylesheet block, and if they all do, that is the point to teach the kit about binaries.

- **Settings that belong to a screen now live on that screen.** Usage auto-refresh (and its
  interval) moved into the new usage flyout, and the provider switches that decide which instance
  tables are drawn moved into a **Sections** flyout beside them. Both are still in Settings; these
  are the same components rendered twice over the same state, not copies, so flipping either surface
  moves the other. A setting nobody can find is a setting nobody knows exists.

## [0.15.0] - 2026-08-05

### Added

- **Reset notifications.** The app already kept every instance's quota percentage warm; it now
  tells you the moment a window rolls over. The detection does not poll for a percentage that
  dropped: the usage endpoint reports the reset instant *in advance*, so a rollover is a wall-clock
  comparison against a timestamp already on record, and a timer is armed for that exact instant
  rather than waiting on the next 15-minute sweep. Percentages are integers and can sit still for
  an hour, which is why a delta-based detector would be both late and ambiguous here.
  - Native OS notifications (a Windows toast under AgentHydra's own registered app identity, so it
    appears in Windows' Notifications settings like any other app; `osascript` on macOS,
    `notify-send` on Linux). These fire from the daemon, so they reach you with the app in the tray.
  - **Keep reminding me** re-raises an unacknowledged reset on an interval and makes the toast
    sticky instead of letting it fade after a few seconds. Bounded by a repeat cap and a hard
    expiry, so a forgotten toggle cannot outlive its usefulness.
  - Optional **email**, through your own SMTP server (implicit TLS or STARTTLS, AUTH LOGIN/PLAIN).
    The password is DPAPI-sealed at rest and is never returned by the settings API.
  - Pending resets survive a restart. The one notification most worth having is the one that fires
    at 3am, which is exactly when an auto-update restart is most likely to have cycled the process.
  - Settings → Notifications, with a **Send a test notification** button so the plumbing can be
    proven now rather than five hours from now.

- **Usage mode** in the Instances tab. One toolbar toggle swaps the process columns (PID, uptime,
  memory) for the quota ones across every table on the tab. Each window renders as a bar of the
  WAIT: its length is how much of the window is still to run, its colour bands that same fraction
  (green, amber, red), and the time remaining is written inside it. Length and colour are one number
  rendered twice, so a short green bar reads as "nearly back" without being decoded. The bands are
  proportional rather than absolute: on the weekly window they land where the intuitive day
  boundaries are (under a day green, one to two days amber, beyond that red), and the 5-hour session
  window gets the same scale instead of reading green throughout and carrying no signal. The burn
  percentage keeps its own column and rides under each bar as a caption. The per-model weekly
  sub-limit is not given a column of its own (it shares the weekly reset instant, so its bar would
  be a copy of the weekly one); it is still in the usage badge's breakdown.

### Changed

- The usage badge now opens its breakdown on **hover** as well as on click, and the breakdown
  carries live "resets in" countdowns alongside the raw reset times. Hovering never steals focus.
- Usage chips in the instances tables read `92%` rather than `92% wk`: the column heading already
  names the window, so the suffix was repeating it once per row. The quick-instances window keeps
  its suffix, having no headings to carry it.
- An instance's folder moved out of a permanent second line under its name and into the row's
  tooltip, halving the height of every row. The tooltip is now on every row rather than only
  running ones, since the folder is what it is mostly for.
- The Instances/Sessions tab you were last on is remembered across reloads.

### Fixed

- **A CLI instance carried across the CC Manager UI rename lost its login.** Each record stored its
  `CLAUDE_CONFIG_DIR` as an absolute path written once at creation. The rename moved the folder but
  nothing rewrote that string, so the record pointed at a directory that no longer existed: it read
  as permanently signed out, and a re-login would have written fresh credentials back under the dead
  `~/.ccmanagerui` folder. The path is now re-derived on read, persisted once at startup, and any
  credentials still sitting at the old location are carried across.
- The CLI instances heading showed a bare `(0)` when every CLI instance was linked to a desktop
  instance and therefore rendered on that account's row instead. It now reads `(0 of 1)`, so the
  shortfall explains itself even while the section is collapsed.

## [0.14.0] - 2026-08-04

### Changed

- **CC Manager UI is now AgentHydra.** The old name described a Claude Code manager, and the app
  has read Codex and OpenCode sessions for several releases. The upgrade is designed to be
  uneventful:
  - `~/.ccmanagerui` is moved to `~/.agenthydra` the first time the new build starts, carrying the
    run queue, settings, instance labels and the accounts cache. The move only runs when the new
    directory does not exist yet, and any failure (a pre-rename daemon still holding the pointer
    file, a permission problem) falls back to reading the old directory where it stands rather than
    starting from empty state.
  - `server/data/ccmanagerui.db` is renamed to `agenthydra.db` in place, with its `-wal`/`-shm`
    sidecars, and falls back to the old filename if the file is locked.
  - Every `CCMANAGERUI_*` environment variable is still accepted as a fallback for its
    `AGENTHYDRA_*` replacement. This is load-bearing for exactly one upgrade: the last CC Manager UI
    release spawns its successor with `CCMANAGERUI_RELAUNCH=1`, and without the fallback that
    auto-update would land in the zero-daemons race the relaunch flag exists to prevent.
  - Saved UI preferences (`ccmanagerui.*` in localStorage) are copied to the `agenthydra.*`
    namespace before the app mounts, so sidebar width, provider scope, collapse state and locale
    all survive.
  - The Windows executable, tray script and icon are renamed to `AgentHydra.*`. Release archives
    keep their existing wrapper-directory layout so the updater in older builds still recognises
    them. Desktop shortcuts pointing at the old exe need re-creating once.
- **New logo.** A three-headed hydra replaces the figure mark, on a tile split between the existing
  orange and a new sage green. The app's accent colour and the rest of the theme are unchanged.

### Fixed

- Deleting a dispatch account no longer leaves CLI instances pointing at it. The association is a
  copy of the account's id and label kept in the CLI instances file rather than a database link, so
  removing the account left both behind: the instance kept showing a badge naming an account that
  was gone, and its usage check quietly failed because the id no longer resolved to anything. The
  account is now detached from every CLI instance that used it when it is deleted, and any instance
  already pointing at a missing account is shown as unassociated the next time the list loads.
- Deleting a dispatch account now also clears the rest of what was kept under its name: its last
  usage reading, its stored usage history, and its per-account auto-resume setting. Only the queue's
  reference to an account was ever cleaned up automatically, so the others accumulated with every
  account removed and could be re-applied to a new account that happened to reuse the same id.
- An instance signed into a different account kept showing the previous account's email, name and
  plan. Resolved identities were cached per instance folder and treated as final: nothing compared
  them against the account the profile was actually signed into, and nothing re-checked them once
  resolved, so the old identity survived every offline read and every poll until someone pressed
  Refresh. Identity is now checked against the instance's current login, a cached identity that
  belongs to another account is discarded rather than displayed, and a sign-in change is picked up
  on its own within seconds. A resolved identity is also re-checked periodically, so an email, name
  or plan changed at claude.ai catches up without a restart.
- An open Codex or OpenCode session showed no reply box and no reason for it. Only the `claude` CLI
  can be handed a prompt, so the composer is deliberately dropped for the other two sources, but
  nothing stood in its place and the gap read as a failed render rather than a boundary. Those
  sessions now say they are read-only here and name the tool to carry the conversation on in.

## [0.13.0] - 2026-07-30

### Added

- **Quick instance mode** opens a compact Claude/Codex instance launcher without starting the
  session scanner, database, queue, scheduler, monitor, usage refresh, settings sync, or updater.
  Launch it with `CCManagerUI.exe --instances`, `bun run instances`, the generated
  **CCManagerUI Instances** shortcut, or the shortcut action in Settings.

### Fixed

- The Sessions list no longer stalls the app on first load. Every transcript it showed was being
  read and parsed from scratch on each daemon start, all of them at once. On a store of ~1,100
  transcripts that meant a 4.6-second wait for the first list and a jump from 101 MB to 3.1 GB of
  memory. Parsed transcript metadata is now cached on disk, so a restart is warm; the list reads at
  most a dozen transcripts at a time instead of two hundred; and the daemon warms the newest ones in
  the background at startup. Same store, same list: 0.35 seconds and a bounded footprint.
- Sessions list latency no longer grows with the size of your transcript folder. Building the file
  index globs the whole store and stats every file, and that ran inside requests, so each refresh
  paid a folder-sized tax (145 ms for 1,255 transcripts, and rising). The index is now served from
  the last snapshot and re-swept in the background, which takes routine refreshes from ~150 ms to
  ~3 ms. Looking up a session that is genuinely missing still re-sweeps, at most once every two
  seconds, so a newly created transcript is still found straight away.

## [0.12.2] - 2026-07-28

### Changed

- Resuming a Claude Desktop chat now automatically uses the desktop instance that owns that chat,
  rather than an unrelated ambient CLI login. The composer makes that default visible and lets you
  deliberately choose the ambient login, another signed-in desktop or CLI instance, or a saved
  credential account.
- Archived conversations are shown by default, session source badges are easier to distinguish,
  and the composer makes scheduling the primary Queue action while keeping immediate queueing one
  click away.

### Fixed

- Weekly Claude quota walls are now recognized from the CLI's structured rate-limit event and
  human notice, so affected runs are parked as rate-limited and can be resumed after reset instead
  of being reported as ordinary failures.
- Composer and queue-builder option menus no longer render empty model, effort, or permission
  entries.

## [0.12.1] - 2026-07-26

### Added

- **Codex Desktop instances can now run side by side.** Each managed Codex instance launches the
  desktop app with its own `CODEX_HOME` and `CODEX_ELECTRON_USER_DATA_PATH`, so work, personal, and
  client OpenAI logins have independent windows and local state. The Instances view reports which
  desktops are running and can open, focus, or quit each one; CLI launch/login remains available on
  the same row.
- **Provider settings and manual ChatGPT handoff.** Claude Desktop, Claude CLI, Codex Desktop, and
  Codex CLI surfaces can be shown independently. An opt-in composer action creates a bounded,
  secret-screened repository context attachment, copies the task prompt, and opens ChatGPT without
  automating the user's account or submission.

### Changed

- Version tags now publish their tested platform bundles automatically using the matching
  versioned changelog section. Release retries update the existing release in place instead of
  deleting it or leaving another unpublished draft.
- Windows releases now expose an icon-bearing, single-file GUI executable while retaining a
  compact ZIP for automatic updates. The web UI is embedded, so no loose `web` or `node_modules`
  folders are needed beside the executable.
- Connections settings sync now uses the multi-device-safe 1.2 engine, with atomic first-account
  seeding, conflict-safe nested patches, token-isolated caching, and a five-second final flush that
  cancels a stuck token or network request instead of delaying shutdown indefinitely.

### Fixed

- Codex sessions now match the chats shown by Codex Desktop: canonical sidebar titles come from
  `session_index.jsonl`, while subagent rollout files no longer appear as separate sessions with
  duplicated titles and forked chat history. Child-agent rollouts remain implementation details of
  their parent chat.
- Release builds now honor both spaced and `--option=value` arguments, so every platform compiler
  writes into the versioned one-executable bundle that the smoke and publication jobs validate.

## [0.11.1] - 2026-07-23

### Changed

- Completed session-sharing research and the obsolete CLI/monitor handoff were consolidated into
  the live reference and source safety comments; their standalone Markdown notes were removed.

### Fixed

- The Windows shortcut integration test now allows cold PowerShell/COM startup the same bounded
  time as the equivalent launcher test, preventing a correct run from failing at the five-second
  default by a few milliseconds.

## [0.11.0] - 2026-07-23

### Added

- **Claude, Codex, and OpenCode conversations now share one Sessions view.** Every row is
  source-tagged and the list, full-body search, transcript tail, done marks, REST API, and MCP
  session tools all understand provider identity. Codex reads active and archived rollout JSONL;
  OpenCode CLI and Desktop are both covered through the SQLite store they share. Injected Codex
  runtime blocks and provider reasoning records stay out of the human transcript.
- **Codex CLI instances can be managed alongside Claude instances.** Create an isolated
  `CODEX_HOME`, open `codex login` for the user, launch it in a terminal, rename it, or delete it
  with exact-name confirmation. The REST API and MCP expose the same lifecycle.

### Changed

- **Provider browsing cannot leak into Claude execution.** Queue/session composers, rate-limit
  discovery, and Desktop-instance filtering remain explicitly Claude-only, while Codex and
  OpenCode are read-only conversation sources. OpenCode's database is never offered as a raw
  transcript download.
- **OpenCode full-body search now filters and extracts text inside SQLite.** Large tool payloads
  are no longer loaded and parsed in JavaScript; against the 260 MB local store this reduced the
  measured search allocation from roughly 49 MiB to 5 MiB.
- **Development now uses Bun's native parallel workspace runner.** Removing `concurrently`
  eliminates a redundant dependency and its shell-command dependency chain. Biome, Hono, Vue,
  Tailwind, Lucide, and other compatible dependencies move to their current non-breaking releases.
- **Manually added dispatch credentials remain portable SQLite values.** The app briefly sealed
  this one column with Windows DPAPI during the pre-release hardening pass, but that added
  machine/user coupling without changing the local database threat model enough to justify it.
  A compatibility migration converts any such rows back when the same Windows user can decrypt
  them; the per-user state directory and database still receive restrictive filesystem modes.
- The completed Codex/ChatGPT/OpenCode research note and the original merge plan were removed after
  their work was implemented and verified.

### Fixed

- Session metadata caching now replaces an active transcript's previous parse instead of retaining
  one cache entry for every appended turn.
- Scheduler and monitor numeric settings are finite and bounded, and changing the scheduler poll
  interval now updates the live timer immediately rather than waiting for a restart.
- Filesystem containment uses resolved path components instead of string prefixes, preventing a
  sibling such as `instances-elsewhere` from being treated as a child of `instances`.
- Queue writes reject malformed statuses, booleans, positions, account references, and launch
  options before they can create invalid persisted state or reach a terminal command.
- A selected dispatch account that cannot be read now fails the run instead of silently falling
  back to the ambient login.
- Child-process tests use the exact Bun executable running the suite, avoiding Windows `bun.cmd`
  quote loss in updater fixtures.

### Security

- The passwordless daemon now refuses every non-loopback bind host, and OAuth callback origins are
  restricted to the same loopback set. API bodies are capped at 2 MiB.
- User-supplied session-search regular expressions are length-bounded and structurally checked
  before execution, preventing synchronous catastrophic backtracking from bypassing the search
  deadline.
- Terminal launch model and effort values are allowlisted before crossing the shell boundary.
- GitHub Actions defaults to read-only repository contents; only the release job receives write
  access.

## [0.10.0] - 2026-07-23

### Added

- **A session's original file location can be copied as text.** The transcript header and the
  session row's right-click menu now include **Copy the session file location to the clipboard**.
  It resolves the original file server-side, so the copied value is the exact absolute `.jsonl`
  path rather than a path reconstructed from the session id.
- **Settings can shut down the complete app.** A two-click power control beside the Settings close
  button exits the daemon and signals the tray host to quit too. Previously, stopping the daemon
  from the web UI left the tray watchdog running, so it could immediately start the daemon again.
- **Codex, ChatGPT and OpenCode support has a concrete scoping document.** The new research note
  records the session-store formats found on this machine, the Claude-specific seams in the current
  architecture, the feasibility of Codex transcript support, and the remaining OpenCode storage
  blocker so future implementation can start from verified evidence.
- **`bun run screenshots` regenerates the README images.** They used to be taken by hand against a
  throwaway daemon, which is why they sat two releases out of date showing a theme the app no longer
  had. The command starts its own web server on a private port, drives headless Chrome, and writes
  one PNG per view at a viewport sized to that view's shell. Since the images are public, it does
  not point a daemon at a synthetic home directory; it replaces `fetch` before the SPA boots so every
  `/api/` response is invented and no daemon runs at all. A request that finds no fixture is
  recorded and **fails the run**, so a fixture gap cannot quietly put live data into a committed
  image, and each shot carries a predicate that must hold before the shutter fires, so a stale
  fixture fails loudly instead of producing a screenshot of empty loading skeletons.
- **The shared tray launcher can forward dropped files and folders.** Paths dropped onto a shortcut
  are passed to adapters through an opt-in environment variable, without changing ordinary launches
  or breaking apps whose adapters do not consume drops.

### Changed

- **Settings puts the everyday controls up front.** Theme selection moves into the panel header,
  beside the new shutdown control. Tooltip visibility and the transcript-editor override move under
  an Appearance **Advanced** disclosure, leaving portable mode, tray visibility and instance-table
  visibility as the immediately visible choices.
- **The version number is now the update status and control.** It is green when current, amber when
  an update can be applied, and red when checking is blocked or no update source exists. Hovering
  explains the state; clicking checks again or applies an available update. This replaces the
  separate status rows and update buttons.
- **Generic Anthropic tiers are treated as Free.** `default_claude_ai` is the active free/default
  tier even when historical `has_claude_max` or `has_claude_pro` flags remain true after a paid plan
  expires. The Instances Plan column now trusts a specific live tier first, treats a generic tier as
  Free, and uses the historical plan flags only when no tier is available.
- **The README screenshots now match the current interface.** Sessions, Instances and Queue were
  recaptured against synthetic data on the Claude-aligned theme; their captions now include the
  Plan column and the finished-run state actually shown.

## [0.9.0] - 2026-07-21

### Changed

- **The interface follows Claude's own surfaces.** The window used to be a single near-black sheet:
  every region painted the same token and leaned on hairline borders for structure, so there was
  effectively one shade on screen. There are now three grounds, using Claude's values directly: the
  top bar and session list as the darkest chrome, the working area a step above it, and cards,
  popovers and table headers raised above that. The accent moves from magenta to Claude's dusty rose.
  The greys are deliberately neutral; an earlier revision of this work derived them and landed a
  visible brown cast on every surface instead.
- **The accent is no longer used as a background wash.** The selected session row and your own chat
  bubbles were tinted with the accent at 10–15%, which composites over a dark ground into a muddy
  maroon rather than reading as a highlight. Both are the neutral raised grey now, and the accent is
  kept for things that are actually accents (Send, Queue, checked states).
- **Text fields paint their own surface.** The kit draws them at 30% alpha, so the token never
  reached its real value: the search and composer boxes came out darker than intended and had no
  visible edge, and the composer additionally drew a filled field inside its own filled box. Text
  fields now paint the surface outright and carry a real outline, while outline buttons and badges
  keep the translucent fill that suits them.

### Fixed

- The release workflow no longer trips GitHub's Node 20 deprecation warning: `upload-artifact`,
  `download-artifact` and `setup-qemu-action` move to their current majors.

## [0.8.0] - 2026-07-21

### Added

- **The Instances table has a Plan column.** The account type (Free, Pro, Max, Max 20×, …) now has
  its own sortable column to the right of Usage, instead of being tucked on the end of the account
  cell. The value is worked out server-side from two signals, because neither is reliable alone: an
  account's rate-limit tier is sometimes a generic passthrough even for a paid plan (a real Max
  account can arrive labelled `default_claude_ai`), so the normalized plan is used as the fallback
  and a raw internal string is never shown; the column reads as a bare dash only when the plan
  genuinely can't be determined.

### Changed

- **Usage refreshes on load.** Opening the Instances view now re-checks every desktop and CLI
  instance's usage right away, instead of showing the last cached numbers until you pressed "Refresh
  all usage". Reading quota does not consume any, so this costs nothing.
- **The account cell shows a name, not an address.** It used to print the full email (and the tier);
  it now shows the account's short name, reveals the email on hover, and hands the tier to the new
  Plan column.
- **The README now shows the app.** It had no screenshots at all, so the only way to find out what
  the thing looked like was to install it. There are now three, one per view, captured from a
  throwaway daemon pointed at a synthetic home directory so no real session titles, account
  addresses or filesystem paths ship in a public image. The surrounding copy is organised around
  those views rather than around the architecture.
- Biome no longer walks `.claude/`, which holds generated local artifacts, the same exclusion
  `.arkitect/reports` already had. A stale codemap stamp file could fail `bun run lint` locally
  while CI, which checks out fresh, stayed green.
- **0.5.0 has its own section again.** Its entries had been written into 0.6.0's, so the changelog
  described two releases as one and no `[0.5.0]` heading existed. Each entry is now filed under the
  tag that actually shipped it, checked against the commit that introduced the code rather than
  against where the prose sat. Wording is unchanged; two changes that had never been recorded at all
  (the scheduler status chip becoming a link, and the vendored-library export-drift guard) are now
  listed.

## [0.7.0] - 2026-07-18

### Added

- **The session list now has a time window, set to the last 24 hours.** This list answers "what am
  I working on", and a transcript store that has been filling up for months answers that question
  worse the further back it reaches. The `...` menu gains a **Time period** filter (24 hours, 7
  days, 30 days, all time). Like the instance and archived filters, it is applied before the
  newest-N cap rather than after, so widening the window genuinely reaches further back instead of
  reshuffling the same rows. If the list comes up empty because of the window, it says so and
  offers a one-click switch to all time, rather than looking broken.
- **Finished runs can be cleared out of the queue.** The queue accumulated every completed,
  failed and cancelled run forever, and the only way to get rid of them was to delete each card by
  hand. The finished-runs disclosure now carries a Clear button, with a two-click confirm (the
  same pattern Settings uses for Disconnect) since it is a bulk delete.
- **The scheduler indicators are now the way to reach the scheduler.** The on/off indicator in the
  queue drawer was the one place you would notice the scheduler was off, and it was not clickable.
  Both it and the header chip now open Settings at the scheduler section, and the section pulses
  briefly on arrival, because a scroll that lands mid-page on a column of near-identical cards
  otherwise leaves you guessing which one you were sent to.
- **Instances and CLI instances are collapsible.** Plenty of people use only the desktop app or
  only the CLI, and had to keep scrolling past the other table. Each heading is now a toggle, and
  the choice is remembered.
- **Queueing a run for later uses the same picker as the chat composer.** "Run at" in the queue
  builder was a bare date-and-time box, so saying "in a few hours" meant working out and typing a
  full wall-clock date. It now opens the composer's picker (in 5 hours, tomorrow at your configured
  time, hour and 10-minute steppers, or an exact date), and the two surfaces share one component
  instead of two copies of the same idea. It has also moved out of Advanced options and up beside
  Account, for the same reason Account sits there: when a run happens is a decision people make up
  front, not a tuning knob.

### Changed

- **The instance editor applies as you type.** It used to show a miniature preview of the row
  inside the dialog, which is a worse answer to "what will this look like" than the real row
  sitting right behind the dialog. Name, icon and colour now persist as you change them and the
  table updates live; the preview and its explanatory paragraph are gone, and the button says Done
  rather than Save, because there is nothing left for it to save.
- **The transcript editor setting hides its input until you want it.** Auto-detect already picks
  the right editor for anyone with VS Code, Cursor, Notepad++ or Sublime installed, so the setting
  showed an empty box asking for an absolute path to solve a problem most people did not have. The
  row now states which editor will actually open a transcript; the path field, a Custom badge and a
  "back to auto-detect" action appear only if you go looking.
- **The two create buttons are icons until you hover them.** "Create instance" in both tables now
  shows a plus and expands to its label on hover or focus, matching the queue drawer's New run
  button, so one long label no longer sets the width of a toolbar of icons.
- **Settings no longer has an Accounts section.** It only ever listed leftover manually pasted
  credentials, which is nobody's normal path since accounts arrived by signing an instance in, so
  in practice it rendered as an empty box telling you to go to the Instances tab. A section whose
  content is a redirect is not a setting. Accounts are still managed on the Instances tab, and the
  per-account auto-resume overrides still list them where they mean something.

### Fixed

- **Most sessions were named after a warning notice instead of their contents.** The list showed
  the same string over and over: "&lt;local-command-caveat&gt;Caveat: The messages below were
  generated by the user while running local commands. DO NOT respond...". On this machine that was
  103 of the newest 200 sessions. A session's title falls back to its first user message, and
  nothing checked whether that message was the CLI talking to itself. Claude Code writes that
  caveat as an ordinary user turn flagged `isMeta`, and the code that knows how to drop such turns
  was already there, applied to the transcript preview but not to the title. The title now goes
  through the same filter. A session whose real prompt arrives wrapped in a tag, such as a
  scheduled task, is unwrapped to its name rather than dropped.
- **The list was full of sessions that were never conversations.** Checking your remaining quota
  sometimes has to launch the real `claude` binary to ask, and that launch opens a session and
  writes a transcript: roughly 3 KB holding a caveat, a `/usage` command line and nothing else. On
  this machine 127 of the newest 300 sessions were these. Three fixes, because one was not enough:
  transcripts with no substantive turn are no longer listed at all; the quota probe now runs in a
  directory of its own so its transcripts never land among real work; and it deletes them after
  itself. Sessions with real content are unaffected, whatever their size.
- **The auto-resume monitor listed work that was long finished.** Rows were written when a resume
  was scheduled and then never revisited, so a resume that had completed, been cancelled, or whose
  queue entry had since been deleted still reported "Scheduled, resumes ~09:14" indefinitely, and
  the Done state the interface could display was one the daemon had no way to reach. Rows are now
  reconciled against what actually happened to the resume, and the list shows only what still needs
  something to happen. A failed resume is kept and asks for attention, rather than being quietly
  filed away. Sessions you have archived are also excluded, and auto-resume no longer picks them
  up at all: archiving is you saying you are finished with it.
- **Advanced options in the queue builder was quietly broken.** Each of the Model, Effort and
  Permission dropdowns offered a "Default" entry with an empty value, which throws in the
  underlying component, and the failure took out everything rendered after it in that section. It
  went unnoticed because the visible casualties were the very dropdowns causing it, so the section
  looked sparse rather than broken. The account picker beside them had hit this same trap earlier
  and been fixed; the other three had been missed.
- **Settings had one seam with no gap, and one list with no separators.** The auto-resume monitor
  sat flush against the scheduler card above it, because a wrapper element added to support a deep
  link broke the page's spacing chain. The per-account rows inside the monitor lost their dividing
  lines for a closely related reason. Both are fixed, and the rest of the app was swept for the
  same pattern.
- **A single instance could occupy several rows in the usage cache.** The cache keyed each entry
  by the instance's directory as spelled by the caller, and on Windows one folder can be spelled
  several ways, so `C:\Users\...`, `c:\users\...` and `C:/Users/...` each opened their own entry. A
  reading stored under one spelling was invisible to a lookup using another, so a warm cache still
  missed and re-ran the check. Keys are normalized now.

## [0.6.0] - 2026-07-17

### Fixed

- **"Filter by instance" opened nothing and froze the whole app.** Clicking it appeared to do
  nothing, and then no other control responded until you pressed Escape. Both halves were the same
  bug. reka positions a popup by walking the Vue component tree for the nearest popper root, and the
  menu was wrapped AROUND its own tooltip, so the tooltip claimed the anchor and the menu's popper
  never got one. The menu really did open; it just rendered at floating-ui's unpositioned
  `translate(0, -200%)`, which is off-screen above the window. Being a modal menu, it also set
  `pointer-events: none` on the page while it was "open", which is what made everything else stop
  responding. The popper root now lives inside the tooltip, so each anchors to its own element. The
  advanced-search popover next to it was broken in exactly the same way and had simply been failing
  in silence, because a popover is not modal and so froze nothing; it is fixed too. A repo guardrail
  now fails the build on that nesting, and it is tested against both the broken and the fixed shape,
  because the previous guard for this encoded the wrong cause and crashed on import without ever
  running.
- **"Open the session file" asked which app to use instead of just opening.** `.jsonl` has no file
  association on a stock Windows machine, so handing the path to the OS default handler made Windows
  pop its "How do you want to open this file?" picker. The app now names an editor itself: it uses
  the first one it finds (VS Code, Cursor, Notepad++, Sublime) and falls back to Notepad, which
  always exists, so the picker can never appear. macOS opens the default text editor. A new
  **Transcript editor** setting overrides the choice, and a path that points at nothing falls back to
  auto-detect rather than leaving the button silently dead.

### Added

- **Right-click a session.** The sidebar list now has its own context menu: mark as done, open the
  transcript, open or copy the session file, and copy the title, folder or id. Right-clicking acts
  on the row under the pointer without selecting it, so it never loads a transcript you did not ask
  for.
- **Mark a session as done.** A way to say "I have dealt with this" without losing it: the row keeps
  its place in the list and just stops competing for attention (a check, a struck-through title, and
  dimmed). Marks are stored by the app itself rather than in the browser, so they survive a cleared
  browser store. Deliberately not a filter. "Clear all done marks" appears in the list menu once
  anything is marked.
- **Archived sessions are recognised, and hidden by default.** The app now reads Claude's own archive
  flag. Archived is the large majority of a real transcript store, so including them buries the live
  work; that same ratio is why the control is three-way (Hidden, Shown, Only archived) rather than a
  checkbox, since finding one archived session in a mixed list is hopeless. The scope is applied
  before the newest-N cap, so hiding archived returns a full list of live sessions instead of the
  handful that survived the cap.
- **One list-options menu.** The sessions toolbar had grown a row of icon buttons, and each new
  toggle squeezed the search field. Refresh, multi-select, the instance filter and the archive scope
  now live in a single "⋯" menu, which lights up whenever something is narrowing the list, so a
  filter set once and forgotten can no longer read as an empty list with no visible cause.
- **A CI guard against vendored-library export drift**, so the break this release had to
  fix cannot recur silently.

## [0.5.0] - 2026-07-16

### Fixed

- **Stray console windows could flash on an ordinary click.** Spawning a console program on Windows
  allocates a console unless the spawn says otherwise, and nothing here said otherwise. It stayed
  invisible only because the tray happens to launch the daemon with a window-less console that child
  processes inherit; started any other way (from a terminal, from Explorer, as the portable exe) the
  same clicks flashed a real window. Every such spawn now states the intent explicitly, so the
  outcome no longer depends on how the app was started. The worst of them was the periodic usage
  check: it runs `claude` on a timer, and where the packaged `claude.exe` is missing that resolves to
  a `.cmd` batch file, which runs through `cmd.exe`. On those machines it was a CMD window blinking
  on a schedule with no click to blame it on. A guardrail now enforces both directions of the rule,
  since hiding a *graphical* program instead hides the window it was supposed to open.
- **A run could be stuck "running" forever after a crash, and cancelling it could kill an unrelated
  program.** When CC Manager UI restarts, it re-adopts runs that outlived it, and it is careful not
  to trust a dead runner's recorded process id (Windows recycles those numbers, so it may now belong
  to something else entirely). That care never actually happened: the liveness probe searched running
  processes for the run's spec file *by command line*, and the search itself carried that text in its
  own command line, so it always found itself and always answered "still alive". Every Windows
  reattach therefore trusted a stale id. If that id had been recycled by a live program, the run
  waited on it forever (a session stuck "busy" with nothing running), and pressing Cancel would have
  killed that innocent program. The probe now excludes itself, and the tail loop no longer re-adopts
  the id the reattach deliberately refused; it fails the run cleanly instead, with the work it did
  manage still on disk.
- **A 529 overload was treated as your rate limit, so the run died instead of retrying.** `529
  Overloaded` means Anthropic's servers are saturated and it clears in seconds; a session limit
  means your own 5-hour allowance is spent and only time fixes it. Both wear the word "limit", and
  `dispatch.ts` matched them with ONE pattern list, so a run killed by a few-second server hiccup
  was filed `rate_limited` and parked against a reset that had nothing to do with it, while the same
  message sent from the desktop app (which just retries) went straight through. They are now told
  apart (`rate-limit-signal.ts`), and a transient overload is **retried automatically**: three
  tries over ~35s, backing off, before it gives up as its own new `overloaded` status, which is
  neither `failed` (nothing is wrong with the run) nor `rate_limited` (your quota is fine). The
  retry only fires when the run produced no output first, so it can never silently re-do work you
  already paid for; it is DB-backed, so a daemon restart mid-backoff resumes rather than forgets;
  and it is deliberately not behind the scheduler or monitor switches, which are off by default and
  govern hours-scale autonomy, this just finishes the run you started ten seconds ago.
  Ambiguous text still classifies as a quota wall, the conservative default. A migration relabels
  rows already mis-filed by the old detector. The auto-resume monitor now only ever sees a genuine
  quota stop, so it can no longer park a 529 against a five-hour reset that was never coming.
- **The composer claimed "this session is busy" the moment you hit send, with nothing running.**
  `submit()` awaits a queue refresh, and the server doesn't answer until the run is already marked
  `running`, so sending a message flipped the banner on within the very same click, and it then
  announced that the message "will queue and start on its own" about one that had just started
  running immediately. The hint now only shows while there is actually a draft it could apply to,
  which is the only time it says anything useful.
- **The auto-resume monitor was blind to every session it hadn't launched itself.** It only ever
  looked at `queue_items` rows with status `rate_limited`, and the only thing that can set that
  status is a run the daemon spawned and tailed, so a session you started yourself (a bare `claude`
  in a terminal, or the desktop app) that died on a 5-hour limit had a transcript on disk, no queue
  row, and no path to the resume list at all. The list said "Nothing to resume right now" while real
  sessions sat at the wall, and hand-queueing them was the only recourse. The monitor now also
  *finds* stops on disk (`rate-limit-discovery.ts`): it checks transcripts touched in the last 12
  hours for the CLI's own limit notice sitting at the tail with nothing after it, which is exactly
  what "still stopped" looks like. Found stops go through the same rails as any other, the weekly
  usage gate, the per-session attempt cap, the resume buffer, the idempotency check, and carry a
  **Found** badge so a session the app went looking for never reads as one you queued. Detection
  reuses `dispatch.ts`'s existing `isApiErrorEvent` gate unchanged, so the 2026-07-15 false-positive
  class (a run that merely *mentions* "quota" or "529") cannot come back at machine scale. Still
  behind the monitor's off-by-default switch.
- **A downloaded transcript was named after the session's UUID, not the session.** `Save a copy` now
  writes `<session title>.jsonl`, falling back to the id only when a title has nothing
  filesystem-safe left in it. One shared `safeTranscriptFilename` (new
  `@ccmanagerui/server/filenames` export) backs both the download link and the server's
  `Content-Disposition`, because the browser honours the link's name only same-origin and the header
  only cross-origin, so fixing one alone would have left the other broken. It strips the characters
  Windows rejects, refuses the reserved device names (`CON`, `COM1`…), trims the trailing dots
  Windows drops silently, and sends the header as RFC 5987 `filename*` so an emoji or non-Latin
  title names the file properly instead of throwing on an invalid header value.

### Added

- **CI actually typechecks now, and it covers the tests too.** The job had been named
  "lint · typecheck · build · test" since day one while never running a typecheck, and something
  had already slipped through: the portable-window exports (`appWindowPlacementKey`,
  `hasRememberedBounds`, `quoteWinArg`) went undeclared for two commits, which nothing noticed
  because nothing looked. `tests/` was outside every tsconfig for the same reason, so a test could
  only fail at runtime; wiring it in immediately caught a real error in a new fixture. All 34 test
  files across the three test directories are covered now.
- **Copy the session file to the clipboard.** A new button beside "save a copy" puts the `.jsonl`
  FILE on the clipboard, not its text, so Ctrl+V into a folder, a chat or an email pastes the
  actual file, named after the session rather than its uuid. A web page cannot do this at all (no
  clipboard type maps to a native file-drop, by design), so the daemon does it; Windows and macOS
  only, since Linux has no cross-desktop convention for it.
- **A 10-minute stepper in the composer's "queue for later".** The hours stepper now sits next to a
  minutes one that steps in 10s, and a single button queues the combined delay ("In 1h 30m"). With
  both, the fixed **In 15 min** and **In 1 hour** presets were redundant, 1h is the stepper's
  default and anything shorter is a couple of taps, so they are gone; **In 5 hours** and
  **Tomorrow** remain.
- **The scheduler status chip in the header is now a link** to the setting it reports on.

### Changed

- **Pink means "you can click this now".** In the composer's "queue for later" popover, **Queue
  for then** was pink even before a date was picked, when it did nothing. It is now grey until
  you pick one. The hours/minutes button beside it had the same flaw at 0h 0m and follows the
  same rule.
## [0.4.0] - 2026-07-16

### Added

- **The portable window opens at a usable size instead of filling the screen.** A window the
  dedicated Chromium profile had never seen opened at roughly the whole work area, about
  1905x2092 on a 4K display. Both open paths, the daemon and the tray, now ask for 1060x800 on a
  first run and yield to the profile's saved placement ever after, so a size you picked yourself
  always wins. The width is measured rather than guessed: the binding constraint is not the
  1000px shell but the sessions sidebar, which rail-collapses below a 1024px viewport, so
  1024 plus about 16px of window frame is the floor and 1060 clears it with slack.
- **A launch onto an already-running portable profile now sizes correctly too.** Chromium ignores
  both `--window-size` and the saved placement when an instance is already running on that
  profile: the forwarded `--app` window simply inherits the running window's geometry. The daemon
  cannot fix that from outside, so it now tags the window's URL with the size it should have
  (`POST /api/portable-window`) and the page corrects itself once at startup, before first paint.
  Gated to real `--app` windows and a no-op on an un-hinted URL, so an ordinary browser tab is
  untouched. A maximized window deliberately sends no hint.

### Changed

- **The loopback guard is now one shared, audited implementation.** The guard that stops a
  malicious web page from driving the local API was the app's own copy. It now consumes the same
  primitive as the other LunarWerx daemons, so a security-critical decision lives in one reviewed
  place instead of four drifting ones. Behaviour is unchanged for real clients. The shared version
  additionally allows a request carrying no `Host` header, which a browser always sends, so this
  only affects non-browser tools.

### Fixed

- **The release build was broken while the typecheck passed.** The vendored copy of the
  portable-window helper was a stale snapshot missing an export that the code importing it already
  declared, so `tsc` was satisfied and `bun build --compile` failed with "No matching export". The
  vendored file is back in sync, and the window-size applier now has behavioural test coverage
  rather than type-only coverage.

## [0.3.0] - 2026-07-16

### Security

- **Fixed a drive-by remote-code-execution hole in the local API.** The daemon binds localhost and
  its API had no cross-site protection, so any web page you visited while it was running could quietly
  POST to it, queuing a `claude` run with `--permission-mode bypassPermissions`, an attacker-chosen
  prompt and directory, using your own logged-in credentials with no approval prompt, or read your
  session transcripts. The daemon now rejects browser cross-site requests (via `Sec-Fetch-Site` /
  `Origin` / `Host`, which also defeats the "simple request" CORS bypass and DNS rebinding) while
  still allowing the app's own UI, the dev server, and non-browser tools (the tray, MCP clients).
  `permission_mode` is now validated server-side before it can ever reach the CLI.

### Added

- **Real executables on every release.** A tag push cross-compiles self-contained binaries (Bun
  embedded, no install step) for Windows x64, Linux x64/arm64, and macOS x64/arm64, smoke-tests each
  on real hardware for its OS, and attaches them to a draft GitHub release. The binary carries every
  process mode as a subcommand (`--version`, `--mcp`, the detached dispatch runner), keeps state under
  `~/.ccmanagerui/`, serves the SPA from a sidecar `web/dist/`, and the Windows zip ships the tray
  toolkit (no Bun on PATH required).
- **Packaged builds now self-update.** A compiled build checks GitHub Releases, downloads the newer
  platform bundle, verifies the new binary runs before swapping it in place, and relaunches, the
  same Settings check/apply/auto-update controls the source build has. (Source builds still self-update
  via `git`.)
- **Run queued work as any signed-in instance, no token pasting.** The queue's "Run as" picker lists
  every signed-in desktop/CLI instance; the runner extracts that instance's own OAuth token at spawn
  time and fails the run with a clear "signed out?" message rather than silently falling back to the
  ambient login. Signing in on the Instances tab is now how accounts get added, the Settings
  paste-a-token form is gone (existing credentials still work; the raw API remains for headless use).
- **CLI sign-in on every instance row**, from the row's actions menu (create-on-demand when no CLI
  login is linked yet), replacing the single inline table sub-line.

### Fixed

- **Quitting could kill your real Claude Desktop chat.** The External row (the regular,
  non-isolated Claude Desktop) can no longer be quit with one click: the server refuses the
  default profile dir without an explicit confirmation (`confirmExternal`, the quit-side analog
  of Delete's existing guard), and the UI routes it through a warning dialog. The "Browser
  Dance" copy now names ISOLATED instances and says outright that your regular Claude Desktop
  should stay open, the old "quit every other running instance" wording steered a user into
  closing a real conversation.
- **The MSIX warning banner could be flat wrong.** `manageable` now also accepts a LIVE running
  Claude process (carrying `--user-data-dir`) as proof of a working classic install, the
  authoritative `Get-AppxPackage` probe runs (and overrides) when filesystem leftovers from an
  uninstalled MSIX would otherwise pin the verdict forever, the classic binary resolves via the
  stable Squirrel stub first (versioned `app-<ver>` dirs are replaced on every update), and the
  banner re-verifies fresh after any successful open/create and every 60s while visible, so
  "install the classic build" actually clears it once you do.
- **A run pinned to a specific account could silently run as the wrong one.** A queued run pinned to
  an instance whose sign-in had expired, been deleted, or whose reference was malformed used to fall
  back to the ambient login without a word; auto-resuming such a run dropped the pin entirely. Both
  now fail loudly (or carry the pin forward) instead of quietly using different credentials.
- **A queued run's account wasn't shown on its card**, and editing a run whose pinned account had been
  deleted silently reverted it to ambient on save. The card now shows the instance it will run as (or
  "deleted instance"), and the editor shows a clear disabled "deleted instance" option instead of
  quietly changing the run.
- **Deleting a desktop instance could orphan its linked CLI login** into an invisible, unmanageable
  state; a failed "Sign in CLI" left a stray CLI instance behind. Both are cleaned up now.
- **A run recovered after a restart could briefly be double-dispatched**: the scheduler and
  auto-resume monitor could fire before the daemon finished re-adopting runs that survived the
  restart. They now wait for that to complete.

- **A run that merely TALKED about rate limits was marked rate-limited.** The detector matched its
  patterns against every event of a run, tool inputs and tool results included, so an agent that
  grepped for "session limit", or read a file whose line 529 scrolled past, finished as
  `rate_limited` despite exiting 0 with the job done. (Both such rows in the shipped database were
  this; `\b529\b` had matched a line number.) Only the CLI's own report counts now: a synthetic
  API-error message, an errored terminal `result`, or stderr, never model prose, tool inputs, or
  tool results. Runs already mislabeled this way are repaired on startup, along with the auto-resume
  bookkeeping that existed only to babysit them.
- **The auto-resume monitor did nothing at all unless you had added an account.** A run with no
  dispatch account, the default, since the accounts table is empty until you paste a token in, was
  parked at "needs you, no dispatch account on the run" on sight, on the grounds that its usage
  couldn't be gated and its auth couldn't be injected. Neither was true: an ambient run uses the
  login `claude` already has, which needs no injection to resume and whose quota reads straight from
  its config dir (the same read `check_my_usage` already did). Ambient runs now go through the usage
  gate like any other, so the monitor actually resumes them.
- **Sending a message opened a console window that stayed on screen for the whole run.** The detached
  runner is created through WMI, which applies default startup info, so `bun` (a console app) got a
  real, visible window; the daemon's own `windowsHide` only ever covered the short-lived PowerShell.
  Beyond the eyesore, closing that stray window killed the runner and `claude` mid-turn, and the run
  then finalized as a bare "failed, exit -1". It is created hidden now.
- **The session view showed conversation the CLI was having with itself.** Resuming a session whose
  last turn died on an API error makes `claude` append a canned "Continue from where you left off." /
  "No response requested." pair, same millisecond, no model call. Rendered as real turns they read
  as though a prompt had been sent and refused. They're filtered; the rate-limit notice, the one
  synthetic message that explains anything, still shows.
- **"exit -1" now says what it means.** It is our own code for "the process vanished before it
  finished", never something `claude` reported, and the paths that produce it recorded nothing to
  say so. They now explain themselves, and the badge reads "interrupted" instead of a number nobody
  can look up. Transcribing an event can also no longer throw and take the tail loop down with it.

### Changed

- **Finished runs fold away in the queue.** Completed, failed, canceled, and rate-limited items move
  behind a "Show N finished" disclosure instead of crowding the list, and the header counts what is
  still pending rather than the all-time total. The per-item card moved to `QueueItemCard.vue`.
- **The composer's busy warning says what will happen to your message.** It stated a rule ("a session
  with a run in progress gets its message queued instead of sent") and left you to guess whether the
  message was about to run or stuck. It now says which, start on its own when the current run
  finishes, or wait for you to press Run when the scheduler is off, and why two runs can't share a
  session.
- **Queuing a run resumes a session from a searchable list instead of a pasted UUID.** The run
  builder's "session to resume" field is now a searchable picker over the same session list the
  sidebar shows (sorted most-recently-active first), each row carrying the friendly title, its
  folder/branch/last-activity, and the opaque id tucked to the side (click it to copy). It supports
  multi-select: pick several sessions and one queued run is created per session, sharing the same
  prompt and options. A new `SessionPicker.vue` backs it.
- **The run builder leads with three fields, not thirteen.** Model, effort, permission, account,
  run-at, fork, and the resume title/folder overrides now live behind an "Advanced options"
  disclosure; the common path is just the session (or new-chat title + folder) and the prompt. The
  "New chat from scratch" toggle is hidden when editing an existing item (editing never converts a
  run's kind). Long prompts no longer push the dialog off-screen, the prompt box caps its height and
  every dialog now scrolls instead of overflowing the viewport.
- **Settings is one scrolling page.** The General / Scheduler / Accounts tabs were merged: Accounts
  is now a section rather than a tab, and Scheduler folds in with everything else. "Show desktop /
  CLI instances" moved from Usage to Appearance (it's a display choice). The auto-resume monitor's
  tuning numbers (max attempts, resume buffer) moved behind an Advanced disclosure and, along with
  the monitored-runs list and per-account overrides, collapse away entirely when the monitor is off.
  The monitor's empty state now explains that a run only appears there after it stops on a rate limit
  (an empty list doesn't mean monitoring is off). A deep link (the composer's "tomorrow" gear) now
  scrolls to the Scheduler section instead of switching a tab.
- **The queue toolbar's scheduler indicator is an icon with a hover, not a text pill**, and shows
  both on and off states at a glance. The redundant "Queue resume" button was removed, "New run"
  already opens the builder in resume mode.

### Added

- **A quota percentage is now quantified into something you can plan with.** "98% used" is not a
  decision: 98% with a reset in 20 minutes is fine, while 98% with a reset in four days at 1%/hour
  means being cut off mid-task in about two hours. Same number, opposite action. Anthropic publishes
  no quota size (`limit_dollars` / `used_dollars` / `remaining_dollars` are all null on a
  subscription, and there are no token counts anywhere in the response), so the numbers are derived
  instead. `server/src/usage-history.ts` keeps the readings the background sweep already takes and
  differentiates them into a burn rate, an hours-of-headroom figure, and `exhaustsBeforeReset`, the
  one field that actually decides anything. `server/src/usage-tokens.ts` counts what was really spent
  from the Claude Code transcripts (which do carry exact per-turn token counts and the model), and
  `server/src/usage-budget.ts` divides one by the other to MEASURE the size of one percent in tokens,
  reported as "~N more assistant turns" because an agent can reason about turns but cannot predict its
  own raw token totals. New `usage_budget` MCP tool and `GET /api/usage/budget`.
- **The usage MCP tools now work with the app closed.** `check_my_usage`, `list_usage` and
  `usage_budget` need nothing the daemon uniquely owns (the OAuth tokens are files on disk, the quota
  endpoint is a plain HTTPS GET, the transcripts are local JSONL), so when the daemon is not running
  they execute in-process instead of failing. The queue and dispatch tools deliberately do not get
  this: they mutate shared sqlite state and supervise real processes, where a second uncoordinated
  executor would be a correctness bug, so they still fail loudly and say why.
- **Usage checks now hit the quota endpoint directly instead of spawning `claude`.** The CLI's own
  `/usage` screen is just a GET against `https://api.anthropic.com/api/oauth/usage`, Bearer-authenticated
  with an OAuth access token; calling it ourselves (`server/src/usage-api.ts`) skips booting the
  ~250 MB Bun-compiled `claude` binary entirely. Measured on one machine: the old spawn path took
  9,353 / 9,262 / 9,218ms per check, the direct GET took 372 / 424 / 169ms, roughly 25 to 50x faster.
  It is also richer than the text screen: `resets_at` is a real ISO-8601 timestamp (the text screen
  prints a yearless human string like "Jul 19, 3:59am"), `severity` (normal/warning/critical) is
  computed server-side instead of guessed from a threshold, and a per-model weekly sub-limit carries
  its own name via `scope.model.display_name`. Reading usage costs no quota: it is a read, not an
  inference call. The `claude -p "/usage"` spawn remains as a fallback for the cases the direct path
  can't serve: no OAuth token in hand, an account configured with an API key instead (the endpoint is
  OAuth-only), or the server rejecting the token with 401 (expired); the daemon deliberately does not
  refresh the token itself, since rotating the user's refresh token could break their real login, so an
  expired token falls back to the CLI's own refresh instead.
- **CLI instances can be linked to a desktop instance.** `CliInstance.associatedDesktopDir` records
  that a CLI instance and a desktop instance are the same Anthropic account under two independent
  logins, so each can serve as the other's usage-check fallback when one token is expired or missing:
  a desktop instance's chain is its own token, then a linked CLI instance's login, then a dispatch
  account matching the email; a CLI instance's chain is its own login, then an associated dispatch
  account, then a linked desktop instance's token. New `link_cli_instance_to_desktop` MCP tool.
- **Background auto-refresh of usage, on by default.** A staggered sweep keeps every instance's usage
  number warm without a manual refresh, skipping any instance with no usable credential up front. Each
  check costs about 300ms and no quota, so polling on a loop is no longer the liability it was when it
  meant spawning `claude`. Toggle and interval live in Settings → General, alongside separate toggles to
  show or hide the desktop and CLI instances tables.
- **Usage responses carry an `advice` verdict.** Every usage check (`check_usage`, `check_my_usage`,
  `list_usage`, the UI's usage cell) now includes `{ severity, bindingPct, shouldOffload, safeToFanOut,
  advice }` alongside the raw percentages, so a caller does not have to re-derive "is this bad" from
  thresholds itself. `shouldOffload: true` means the caller is close to being cut off mid-task.
- **`check_my_usage` now works from a normal Claude Code session, not only a CLI instance.** It falls
  back to the default `~/.claude` login when `CLAUDE_CODE_CONFIG_DIR` / `CLAUDE_CONFIG_DIR` is unset,
  which previously made the self-check error out for the everyday case of the session the user is
  actually talking to. New `list_usage` MCP tool surveys every managed instance (desktop and CLI) at
  once, each with its own `advice` verdict, for picking an account with headroom before routing heavy
  work.
- **A CLI login is now a usable usage-check source in its own right.** `<CLAUDE_CONFIG_DIR>/.credentials.json`
  is plain JSON (`claudeAiOauth.accessToken` plus `.scopes`, no DPAPI/safeStorage layer), so a CLI
  instance that has run `/login` gives a usage-capable token directly, independent of any desktop
  instance.
- **CLI instances.** A CLI instance is a `CLAUDE_CONFIG_DIR` associated with an account and logged in
  once, the command-line counterpart to a desktop instance (which isolates via `--user-data-dir`).
  The Instances view now manages them alongside desktop instances: create one (the app makes its
  config dir), open a terminal to use it, a one-click "Log in" helper that opens a terminal for you to
  run `/login` (the app never performs the login itself), associate it with a dispatch account, rename,
  and a guarded delete. Persisted as plain JSON under `~/.ccmanagerui`, never a token.
- **Usage-check subsystem.** Read an account's remaining Claude subscription quota (session 5-hour %,
  weekly all-models %, and per-model weekly %) by running `claude -p "/usage"` with the account's auth
  injected. A DESKTOP instance is polled using its OWN decrypted OAuth token (never persisted), so it
  works with no dispatch account and no CLI login; a registered dispatch account or a logged-in CLI
  instance also work. The desktop token cache holds two grants (a full CLI grant and a profile-only
  grant); the usage path deliberately selects the `user:inference`-scoped grant, since the profile
  grant runs `/usage` but returns no numbers. The probe also sets `CLAUDE_CODE_OAUTH_SCOPES` from
  that grant: without it `claude` quietly stops treating `/usage` as a command and prints a cost
  summary with no percentages, which only shows up when the daemon runs outside a Claude Code
  session (for example the tray, launched from Explorer). Surfaced three ways: a per-row usage cell in the
  Instances table (the binding weekly % color-coded, with a hover breakdown), a `check_usage` MCP
  tool, and a `check_my_usage` self-check any agent can call. Checks are on demand (each spawns a real
  `claude`) and cached with an age; a no-data result shows ", " with a reason rather than silently.
- **AI self-check guidance.** `docs/AI_USAGE_SELFCHECK.md` plus a README note teach agents that they
  can read their own quota and that the weekly all-models % is the binding cap to pace by.
- **Auto-resume monitor (opt-in, off by default).** A session killed mid-work by a 5-hour rate limit
  can auto-resume once the window clears, gated on the weekly cap not being maxed. Detection reuses the
  existing structured `rate_limited` run status; a resume is a normal queued `--resume` run scheduled
  for just after the reset. Safety rails: a per-session resume cap, idempotent scheduling, a global
  switch plus per-account overrides, and a status chip ("resumes ~HH:MM" / "blocked: weekly maxed" /
  "needs human"). Settings and `get_monitor` / `set_monitor` MCP tools expose it.

## [0.2.0] - 2026-07-13

### Added

- **Per-instance icon and color.** Every row in the Instances table now shows a customizable glyph
  in place of the old green status dot. An "Edit" action (in the row's ⋮ menu) lets you pick an icon
  from a curated set and a color from a fixed palette, with a live preview; a running instance keeps
  a small pulsing badge on the icon's top-right corner, and a stopped one dims. Instances you have
  not customized get a stable, distinct default derived from their folder, so the table reads at a
  glance.

### Changed

- **An instance is named after the account it is signed into, not the folder it lives in.** The
  folder name was only ever a guess at the identity, and it stops being true the moment a profile is
  signed into an account other than the one it was named after, nothing prevents that drift and
  nothing corrects it. On the machine this was built against, the folder called `claude` was signed
  into `6claude@lunarwerx.com` and had been reading as "claude" the whole time, while two other
  instances had been hand-relabelled to their accounts precisely to paper over the same problem. So
  the resolved account's name (its profile name, else the local part of its email) is now the
  default, ahead of the folder name; an explicit label you set still wins over both, and the folder
  name remains the last resort for an instance with no resolved identity. The dir is still shown
  under each name, so two profiles on one account stay distinguishable. `SessionsView` reads the
  same shared instance list rather than fetching its own, so a session's instance chip and the
  Instances table can no longer disagree about what the same instance is called.
- **Accounts resolve themselves; the "Resolve" button is gone.** Resolving reads `config.json` and
  the token cache off disk, so a stopped instance resolves exactly as well as a running one, but
  auto-resolution was gated on `isRunning`, which meant a stopped instance sat there offering a
  button that would have worked on the first click, every time. That is a chore, not a choice. Every
  instance now resolves on its own, running or not, and an instance with no identity yet (logged
  out, offline) is retried once a minute so signing one in surfaces without a restart. The inline
  button and its ⋮ entry are both removed; the toolbar's Refresh now force-re-resolves every account
  live, which is the only case a manual action was ever good for (a stale cached identity). Resolving
  no longer marks the row busy, it changes nothing about the instance, and flagging it made the
  row's buttons flicker un-clickable whenever a background resolve was in flight.
- **The Instances table's quota numbers stay current while you watch them.** The background sweep
  refreshes the server's usage cache every 15 minutes, but the UI only ever pulled that cache once,
  on mount, so an open Instances tab kept showing its first reading and went quietly stale for as
  long as you left it open. It now pulls on the same 4-second cycle the instance list already
  refreshes on, measured firing in lockstep with it. This is a read of the server's own cache: no
  probe, no `claude`, no request to Anthropic, and no quota spent, so there was no reason to do it
  once and hope. The "Refresh all usage" tooltip no longer claims each check "spawns a real claude
  process", which stopped being true when checks became a direct ~300ms API read.
- **Fewer rules on the Instances screen.** The two tables abutted, separated only by a hairline
  sitting flush against the desktop table's last row, which read as one continuous table whose last
  rows happened to have different columns. They are now separated by space instead, and both section
  toolbars lost their bottom border, the sticky table header immediately below each one already
  draws that line, so the second rule was weight for nothing. This matches Sessions, Queue, and the
  app header, which were borderless already. The row separators stay; they are the ones doing work.
- **Renaming an instance is now instant and works while it is running.** A rename used to move the
  instance's on-disk profile folder, which Windows will not allow while Claude Desktop holds it open.
  The name is now a display label kept as UI metadata (`~/.ccmanagerui/instance-meta.json`, never a
  secret) that overlays the folder name wherever it is shown; the folder keeps its original name as
  the stable id that sessions are tagged by. The old `POST /api/instances/:dir/rename` folder-rename
  route was replaced by `POST /api/instances/:dir/meta` (display label, icon, and color in one call).
- **A running instance's row leads with Focus.** For a running instance the primary button is now
  "Focus" (bring its window to the front); "Quit" moved into the ⋮ menu, so the common action is one
  click and the destructive one is deliberate. The ⋮ menu was widened so "Create desktop shortcut"
  no longer wraps.
- **Header and panel cleanup.** Removed the redundant "New run" button from the app header (it
  already lives in the queue drawer), and dropped two divider lines (below the queue drawer's toolbar
  and below the sessions search box). The sessions list and its instance filter now show each
  instance's display label.

### Fixed

- **A burn rate of "zero" no longer means "work freely".** The reported percentage is an INTEGER, so a
  burn of 0.8%/hour does not tick the number for over an hour. The first cut of the forecast measured
  that flat stretch, concluded the burn was zero, and reported "you will never hit the cap" while
  sitting at 98% used. That is a false green light, the single most expensive way the feature can be
  wrong, since an agent keeps working and is cut off mid-task holding unsaved context. The burn rate is
  now a RANGE: a measured delta of `d` could truly be as much as `d + 1` given integer rounding, so the
  upper bound is `(d + 1) / hours`, which is always above zero. Every derived figure (`headroomHours`,
  `exhaustsAt`, `exhaustsBeforeReset`, and the token budget's denominator) is computed from that upper
  bound, making the forecast deliberately pessimistic. The asymmetry is the point: a needless warning
  costs a moment of caution, a false green light costs the whole task. The measurement floor also rose
  from a 20-minute to a 45-minute span, below which an integer percentage simply cannot resolve a slow
  burn and the answer is honestly reported as unknown rather than as zero.
- **Rebuild.bat could leave a STALE daemon serving old code while reporting success.** It found the
  daemon solely by the port recorded in `~/.<app>/runtime.json`; with that pointer missing it printed
  "App does not appear to be running", killed nothing, and relaunched the shortcut, which no-ops
  against the tray's single-instance mutex. Nothing then checked the outcome, so the build was fresh on
  disk while the process serving it was hours old (found in the wild at 10h39m). The pointer is now
  only a hint: `misc/Restart-Daemon.ps1` probes every bun/node listener's `/api/health` and stops only
  processes that identify themselves as this app (`service` === package.json `name`, the same contract
  the single-instance guard uses), which both finds an orphan the pointer forgot and cannot kill a
  sibling app. `misc/Wait-Daemon.ps1` then asserts the daemon now answering actually started AFTER the
  restart, because "the daemon is up" proves nothing when the stale one was up the whole time.
- **Mutating API routes no longer 500 on an odd request body.** A body that is valid JSON but not an
  object (a bare `null`, a number, or a string) used to crash the handler with a 500; every mutating
  route now runs the body through a shared object guard and degrades gracefully. Creating a new
  instance also starts it with a clean appearance, so reusing a name never resurrects a deleted
  instance's old label, icon, or color.

## [0.1.0] - 2026-07-13

### Added

- **Queued `claude` runs now survive quitting (or auto-updating) CC Manager UI.** A dispatched run
  used to be a direct child of the daemon, so a tray Quit (which force tree-kills the daemon) or an
  auto-update relaunch killed the run mid-flight and left it stuck marked "running". Now the daemon
  launches each run through a detached supervisor (`server/src/dispatch-runner.ts`) that owns the
  `claude` process and streams its output to a per-run log file the daemon tails; the run keeps
  executing to completion even with the daemon gone. On the next launch the daemon **reattaches** , 
  rebuilds the run's events from its log and resumes the live view, or records the final status if it
  finished while the daemon was down (`reattachRuns`, `server/src/dispatch.ts`). On Windows the
  supervisor is created via WMI (`Win32_Process.Create`) so it escapes the daemon's job object;
  verified end-to-end that a run survives a `taskkill /T /F` of the daemon and a graceful shutdown,
  then reattaches and completes. The run's account secret is read from the DB by the supervisor (never
  written to disk), and cancel still works (it kills `claude`; the run finalizes as "canceled").
- **Auto-update waits for the queue to go idle.** Auto-update relaunches the daemon; even though runs
  now survive that, it now defers applying an update while any dispatch run is in flight (rechecked
  the next interval), so a relaunch never churns a live run's stream (`server/src/auto-update.ts`).
- **Per-instance desktop shortcuts.** Each row's ⋮ menu on the Instances tab gained
  **Create desktop shortcut**, which drops a launcher on the desktop that opens that one
  instance directly (`Claude --user-data-dir=<dir>`) without going through the manager. On
  Windows it writes a `.lnk` (via `WScript.Shell`) whose target is the STABLE root
  `claude.exe` Squirrel stub, so the shortcut keeps working after Claude Desktop updates to a
  new versioned build, and it takes its icon from the stable `app.ico`; macOS gets a
  `.command` script and Linux a `.desktop` entry. Values are passed to PowerShell through the
  environment (never string-interpolated), and the failure path reuses the same MSIX-aware
  message as Open (`POST /api/instances/:dir/shortcut`, `server/src/core/shortcut.ts`).
- **Rename an instance.** Each row's ⋮ menu on the Instances tab gained **Rename**, which opens a
  dialog (prefilled with the current name) to give a stopped instance a new name, renaming its
  profile folder in place. It runs through the same guards as delete: refused while the instance
  is running, for the protected default profile, for external instances, and on an invalid or
  colliding name (`POST /api/instances/:dir/rename`, `server/src/core/lifecycle.ts`).
- **Live per-instance memory and uptime.** The Instances table's Uptime column now fills in from
  each running instance's process start time, and the former (always-empty) Size column is
  replaced by **Memory**, the summed working set across the instance's whole Electron process
  tree (main plus renderer/gpu/utility children). Both are read from the same `Win32_Process`
  snapshot the table already takes each poll (`WorkingSetSize` plus `CreationDate`), so there is
  no extra process scan.
- **Brand icon everywhere.** The orange CC Manager UI mark is now the browser favicon
  (`web/public/favicon.svg` + a `favicon.ico` fallback) and the tray/taskbar icon. The old
  `misc/Make-Icon.ps1` drew a placeholder violet ">_" tile programmatically; it now rebuilds
  `misc/CCManagerUI.ico` from the committed `misc/CCManagerUI-icon.png` master (re-rendered from
  the favicon), matching the sibling apps' icon-generator convention.
- **Sessions across every Claude Desktop instance, with an instance filter.** Each desktop
  instance keeps per-session metadata whose `cliSessionId` names the CLI transcript in the
  shared `~/.claude/projects` store; the daemon now scans those to label every session with
  its instance (`instance`: an `~/.claude-instances` dir name, "default" for the main
  install, or null for plain CLI). The sidebar shows the instance on each row and gained a
  filter dropdown (All / Default / each instance / CLI-other) that scopes the list
  SERVER-side, before the newest-200 cap, so a quiet instance's older sessions finally
  surface (`GET /api/sessions?instance=`).
- **Open / save the raw session file.** Two transcript-header buttons: one opens the
  session's `.jsonl` with the OS default handler on the daemon's machine
  (`POST /api/sessions/:id/open-file`), the other downloads a copy through the browser
  (`GET /api/sessions/:id/file`, works over remote access too).
- **Favicon.** The app finally has one (`web/public/favicon.svg`).
- **Update remote wired up.** Repository published at `LunarWerxs/ccmanagerui`, so the
  Settings Updates panel checks against something real instead of reporting that updates
  can't be checked.
- **Chat composer on the Sessions tab.** An open transcript now has a message box at the
  bottom, like a chat: type, press Enter, and the message is dispatched to that session
  immediately (a queue item is created and run in one step). Option chips under the input
  (model, effort, permissions, account, working directory) all default to "inherit" and only
  need touching for an override; the working directory defaults to the session's own. A
  Queue button adds the message to the queue instead, and a clock button offers "queue for
  later" presets (15 min / 1 h / 4 h / tomorrow 9:00) plus a date-time picker. Sessions with
  a run already in progress queue new messages instead of double-resuming.
- **Multi-select messaging.** A select toggle above the session list turns rows into
  checkboxes (with select-all over the current filter); the composer then targets every
  checked session, so "send `resume` to five chats" is one message and one click, creating
  one queue item per session, each in its own working directory.
- **Scheduled queue items.** Queue items gained an optional "Run at" time (`not_before`
  column): the scheduler skips them until the time passes, without blocking later items.
  Scheduled cards show a "runs HH:MM" badge; manual Run still fires immediately.
- **Edit queued items.** Non-running queue cards now have an edit button that opens the
  builder dialog prefilled (including the new Run-at field) and saves via PATCH.
- **Live transcript follow.** While the selected session has an active queue run, the
  transcript refreshes on its own (and once more when the run starts or finishes), so
  replies stream into the open chat without pressing Refresh.
- **Per-session run lock.** The daemon now refuses to start a second run against a session
  that already has one active (manual Run returns 409, the scheduler skips to the next
  eligible item), so two `claude --resume` children can never interleave writes to the
  same transcript. The composer treats that 409 as "queued" rather than "failed".
- **Run due (n) button in the queue drawer.** One click dispatches every currently-due
  queued item at once (`POST /api/queue/run-due`). Like the per-card Run button it ignores
  the scheduler's enabled/spacing/concurrency limits, but it honors the per-session lock:
  items whose session is (or just became) busy stay queued and are reported as skipped.

### Fixed

- **Quitting CC Manager UI no longer closes the Claude Desktop instances it launched.** The
  Windows tray host quits by tree-killing the daemon's whole process tree
  (`taskkill /PID <daemon> /T /F`), and instances were spawned as direct children of the daemon,
  so Quit dragged every open Claude instance down with it. Neither `.unref()` nor Bun's
  `detached: true` breaks the Windows process tree; the launch now goes through a `cmd /c start ""`
  hand-off that re-parents the instance out of the daemon's tree, so it survives Quit
  (`server/src/core/instances.ts` `buildInstanceLaunch`, `server/tests/instances-launch.test.ts`).
  macOS already detached via `open`; Linux now spawns with `detached: true` (setsid).
- **The Instances ⋮ "More actions" menu opens again.** Its trigger had been wrapped in a
  tooltip, and the nested `TooltipTrigger`/`DropdownMenuTrigger` (both `as-child`) swallowed the
  click so the menu never opened, while the zero-delay tooltip itself was intrusive. The kebab
  is now a bare dropdown trigger with an `aria-label`, it opens on click, with no tooltip.
- **The Instances refresh icon no longer spins on every poll.** The list silently re-polls every
  4 s and the spinner was tied to that `loading` flag, so it flickered constantly and read as a
  constant spin. Background poll ticks are now silent; the icon spins only on a first load or a
  user-initiated refresh.
- **Instance discovery no longer breaks on profile paths that contain a space.** When an
  instance's `--user-data-dir` has a space (a space in the Windows user name, or a space in the
  instance name itself), `Bun.spawn`/libuv wraps the whole `"--user-data-dir=C:\a b\c"` token in
  quotes, and the previous command-line parser truncated the path at the first space, so the
  running instance was mis-matched (it showed as "stopped" or as a stray external row). The
  `core/process.ts` parser now handles all three quotings (unquoted, value-quoted, and
  whole-token-quoted), see `tests/process-parse.test.ts`.
- **Composer toasts render as real toasts.** The "Queued N message(s)" confirmation showed as
  bare unstyled text lines: vue-sonner v2 ships its styling as a separate stylesheet that was
  never imported. `main.ts` now imports `vue-sonner/style.css`, so every toast gets its card,
  border, and shadow back.
- **Open drawers no longer cover the header buttons.** The top bar now shares the push-panel
  padding shift with the main content (plus its own 16px), so New run / Queue / theme /
  Settings slide left to stay clickable instead of disappearing under the settings or queue
  drawer.
- **Push panels no longer crush the centered shell (kit-wide).** The settings/queue drawers
  dock to the viewport's right edge, but the content shift now equals only the panel's
  actual overlap with the centered app shell (zero on a wide monitor) instead of the full
  panel width. This removes the dead band that squeezed the Instances table to half size
  and nudged the Sessions placeholder left whenever Settings was opened.
- Built SPA now talks to the daemon over same-origin relative URLs instead of a hardcoded
  `http://localhost:7787`, so the UI keeps working when the daemon port-hops off its preferred
  port. Dev (Vite) behavior is unchanged; `VITE_API_BASE` still overrides both.
- Free-port probe (`find-free-port`) is now loopback-aware: it no longer picks a port that's
  only bound on another interface, closing a race where the daemon could report itself bound to
  a port a different loopback-only process (e.g. `wrangler dev`) was already holding.

### Changed

- **The composer lost its top divider line** (the transcript column stays borderless).
- **Queue moved from a tab to a slide-in drawer.** The queue now opens as a right-side push
  drawer from a header button (with the running-count badge), so the list rides alongside
  the Sessions or Instances view instead of replacing it. Only one drawer (queue or
  settings) is open at a time.
- **Settings split into tabs.** The Settings panel now groups its sections under three tabs
  (General / Scheduler / Accounts) using the shared kit's segmented tab bar, instead of one
  long scroll. General holds appearance, updates, and auto-update; the "Save settings" footer
  stays visible on every tab and still flushes the scheduler form.
- **One Updates group, and it explains itself.** The separate Auto-update section merged into
  the Updates group (the auto-check toggle and interval sit right under the manual check).
  The cryptic "No update source" row now reads "Updates can't be checked" with a visible
  explanation (no Git remote linked; add one or set `CCMANAGERUI_UPDATE_REPO`), and the
  auto-update rows gray out while there is no source to check.
- **Queue resume lives in the queue drawer.** The transcript header's primary button now
  opens/closes the queue drawer; the "Queue resume" action (builder in resume mode) moved
  into the drawer's toolbar next to New run. "Show tool activity" shrank from a labeled
  switch to an icon toggle (pressed = tool events shown), matching the ID button beside it.
- **Multi-select banner is count-only.** "Sending to N sessions" no longer tries to list every
  target's title (they always truncated into noise).
- **Drawer headers/footers lost their divider lines (kit-wide).** The shared panel shell no
  longer draws a border under its title bar or above its footer.
- **Header cleanup**: the scheduler pill left the top bar (its toggle plus counts and interval
  controls already live in Settings → Scheduler); the Queue page now shows a small "Scheduler
  on" chip whenever it's enabled, so auto-dispatch is still visible where it matters. The
  "New run" header button is now a compact plus icon that expands on hover/keyboard focus to
  reveal its label (same pattern as DevWebUI's top bar), and the Queue page title gained an
  info hint explaining what the queue is and that nothing runs by itself while the scheduler
  is off.
- **Default port moved 8787 → 7787.** 8787 collided with both another local dev server and
  `wrangler dev`'s default. Set `PORT` to override; the daemon still hops to the next free port
  if its preferred one is busy and records where it landed in `~/.ccmanagerui/runtime.json`.

### Added

- **MSIX install warning (Instances tab)**: the daemon now detects which Claude Desktop build
  is installed on Windows (`GET /api/desktop-install`, `server/src/core/desktop-install.ts`).
  Anthropic's current download page ships a ~7 MB `ClaudeSetup.exe` bootstrapper that installs
  the MSIX package under the ACL-locked `C:\Program Files\WindowsApps`; that build can't be
  launched with `--user-data-dir`, so instance create/open can't work with it. When only the
  MSIX build (or no Claude Desktop at all) is present, the Instances tab shows a warning
  banner linking the classic ~217 MB Squirrel installer
  (`https://claude.ai/api/desktop/win32/x64/exe/latest/redirect`).
  `CCMANAGERUI_FAKE_DESKTOP_INSTALL` (msix-only | none | ok) forces the detection result for
  dev/testing.
- **Portable mode**: a server-persisted setting (Settings → Appearance → Portable window) that
  opens CC Manager UI in its own chromeless Chromium app window (`msedge`/`chrome --app=`, no
  tabs or address bar) instead of a browser tab. Applies both to the in-app toggle (`POST
  /api/portable-window`) and the desktop tray launcher, which now opens the UI through the
  portable-mode-aware `Open-AppUi` helper. The window gets its own dedicated Chromium profile
  (`~/.ccmanagerui/portable-profile`, `--user-data-dir`) so it remembers its size/position
  across launches instead of sharing the main browser profile; both open paths derive the same
  profile dir from `runtime.json`'s location.
- **MCP stdio server** (`server/src/mcp.ts`, `bun run mcp`), exposes CC Manager UI's
  sessions/queue/instances API over MCP stdio for use from Claude Code / Claude Desktop.
- **Background auto-update loop**: an opt-in daemon-wide timer that checks the update remote on
  a schedule and, when a newer commit is available and the working tree is clean, pulls +
  reinstalls + rebuilds + self-relaunches so the running daemon stays current unattended. Off by
  default; never touches a dirty working tree.
- Repo hygiene pass to bring the tree up to the standard of its LunarWerx siblings: CI
  (`.github/workflows/ci.yml`, lint + typecheck + build + test on ubuntu/windows), an Architect
  config (`.arkitect/`) with a gating bundle-weight-budget check, an MIT `LICENSE`,
  `.editorconfig`, `bunfig.toml`, and a documented `.env.example`.

# CLI limit reset

Using a Claude CLI account's limit reset from AgentHydra: the "Use limit reset" item in a CLI
row's menu, and the `cli_limit_reset` MCP tool. Code: `server/src/core/cli-limit-reset.ts`, route
`POST /api/cli-instances/:id/limit-reset` (`{ check?: boolean }`), UI
`desk2/hydra/src/components/CliLimitResetDialog.vue` and `CliLimitResetIcon.vue`.

## What a "reset" is here

Claude Code offers two kinds behind one command, `/limit-reset`:

- **A banked reset grant** (internal name `cedar_ember`, e.g. the Opus 5.5 launch grant). The CLI
  asks **"Use your reset?"** ("Yes, use my reset" / "No, keep it") before spending it.
- **The weekly session reset** (internal name `juniper_tide`): refills the 5-hour limit once a week
  and still counts toward the weekly one. It is an experiment, and the CLI asks **nothing**: if one
  is available, running the command uses it.

## Why AgentHydra drives the CLI instead of asking the API

`GET https://api.anthropic.com/api/oauth/usage` does carry both blocks (`?cedar_ember=1` and
`?at_wall=1`), but asked by AgentHydra they come back
`{"eligible": false, "ineligible_reason": "surface", ...}` (measured 2026-09-30 on #83 and #84):
the server only offers resets to certain apps. AgentHydra does not pose as another app to get past
that. So it runs the real CLI in a hidden terminal (Bun 1.4's PTY, `Bun.spawn({ terminal })`,
works on Windows), types `/limit-reset`, and reads the CLI's own answer off the screen.

## How a run goes

1. The account's `.claude.json` is prepared once: `hasCompletedOnboarding: true` (else the CLI
   opens its theme and login-method screens) and the scratch folder
   `<DATA_DIR>/cli-limit-reset` trusted (else "Is this a project you trust?" defaults to
   "No, exit").
2. Wait for the prompt (`Try "…"`), then 6 s more: keys typed while the start screen is still
   drawing are lost.
3. Type `/limit-reset`, confirm it shows in the input, press Enter.
4. Use: at "Use your reset?" press Enter. Check (`check: true`): press Escape and report
   `available`. The answer gets its own 40 s wait; a confirmed reset whose answer never arrives
   says it may have been used.
5. Ctrl+C twice, then kill the tree. One run per account at a time.

Answers (screen text loses spaces, so matching is loose; the message shown is a fixed sentence):
`reset`, `used` (with the date it comes back), `unavailable` ("A reset isn't available for this
account right now."), `available` (check only), `error`. The last real answer is kept on the
instance as `lastLimitReset` and drawn as an icon beside its name (green: used just now, or
available; grey: this week's already spent).

## The daily check

Read from Claude Code 2.1.286 (2026-10-03): the weekly session reset is claimed only when the CLI's
own rate-limit state is `rejected` with type `five_hour` and a future reset time. Below the 5-hour
limit `/limit-reset` cannot spend it; it only finds banked grants (a check backs out of the
question) and answers "A reset isn't available ..." when there is none.

So AgentHydra checks every signed-in CLI account once a day (`server/src/core/cli-reset-sweep.ts`:
first pass 10 minutes after start, then hourly; accounts one at a time) and stores the answer, so
each row shows it. An account is checked only when its last check is over 24 h old (or never) and
it has a 5-hour reading under 90% taken in the last 30 minutes. No reading, a stale one, or one
near the limit means no check: at the limit a check could spend the weekly reset. The reading is
re-read right before each run. Each run starts no MCP servers.

## Status (2026-10-03)

- Checked live: #83, #84, #88 and #90 all answered "A reset isn't available for this account right
  now"; nothing asked, nothing spent, about 10 s each, nothing left running.
- Not yet seen live: a reset actually going through, and the "Use your reset?" question (no
  account had a banked grant on the CLI).
- Background check: daily, only below the 5-hour limit (see above), never at it.

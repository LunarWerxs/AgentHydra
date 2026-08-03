# AI: check your own usage before you fan out

If you are an AI agent operating this repo, you can check your own remaining
Claude subscription quota right now, without asking the human. The fast path
is a direct read of the same endpoint the CLI's own `/usage` screen uses, no
`claude` process spawn, no boot of the ~250 MB Bun-compiled binary.

## How

- **Call `check_my_usage {}` first.** It is a self-check: it reads your own
  `CLAUDE_CONFIG_DIR`, falling back to the default `~/.claude` login when
  that is unset, so it works for a normal Claude Code session too, not only
  a dedicated CLI instance. It takes about 300ms and costs no quota (reading
  usage is not an inference call; nothing is billed). It returns an `advice`
  verdict alongside the raw percentages, see the next section, that verdict
  is the part you actually need to act on.
- Call `check_usage { account?, configDir? }` to check a different saved
  account or config dir instead of your own.
- Call `list_usage {}` to survey every managed instance (desktop and CLI) in
  one shot, each with its own `advice` verdict. Use it to answer "which of
  my accounts has headroom?" before routing heavy work, or to find the one
  about to hit its weekly cap.
- Call `usage_budget { dir }` when you need a **quantity** rather than a
  percentage: how fast the cap is being eaten, how long you have, and roughly
  how many more assistant turns fit. See "quantifying it" below.
- All of these are reads. None of them consume quota. They also work with the
  AgentHydra app **closed**: the tokens are files on disk, the quota endpoint
  is one HTTPS GET, and the transcripts are local, so the MCP server answers
  in-process when the daemon is not running. (The queue and dispatch tools do
  need the daemon, and will say so.)

## Quantifying it: a percentage alone cannot be acted on

`98% used` is not a decision. **98% with a reset in 20 minutes is fine. 98% with
a reset in four days, while burning 1%/hour, means you are cut off mid-task in
about two hours.** Same number, opposite action. Only the rate separates them.

Anthropic publishes no quota size (the endpoint's `limit_dollars`, `used_dollars`
and `remaining_dollars` are all null on a subscription, and there are no token
counts), so `usage_budget` derives what it can:

```
forecast: {
  burnPctPerHour:      number | null,  // point estimate. SEE THE WARNING BELOW.
  burnPctPerHourUpper: number | null,  // the honest upper bound. Decisions use THIS.
  headroomHours:       number | null,  // worst case, from the upper bound
  hoursToReset:        number | null,
  exhaustsBeforeReset: boolean | null, // <-- THE FIELD THAT DECIDES
}
budget: {
  remainingTurns:  number | null,  // ~how many more assistant turns fit
  confidence:      'good' | 'rough' | 'none',
  caveat:          string,         // ALWAYS read this
}
```

**`exhaustsBeforeReset` is the field to branch on.** False means the cap will not
bite before it resets, so work freely no matter how alarming the percentage looks.
True means you have `headroomHours` before you are cut off.

### Do NOT read `burnPctPerHour === 0` as "not burning"

The reported percentage is an **integer**. If you burn 0.8%/hour it will not tick
for over an hour, so a short window measures a delta of zero. Zero here means
"slower than these readings can resolve", *never* "idle". Treating it as idle is
how you tell someone at 98% to work freely minutes before they are cut off.

Every derived figure is therefore computed from `burnPctPerHourUpper`, the
quantization-safe upper bound, so `headroomHours` is the worst case and
`exhaustsBeforeReset` errs toward true. That asymmetry is deliberate: a needless
warning costs a moment of caution, a false green light costs the whole task.

### `remainingTurns` is an UPPER bound, so treat it as one

It is derived by measuring `(tokens you spent) / (percent you burned)`, counting
Claude Code transcripts **on this machine only**. If the same account is also used
from the Claude Desktop app, the web UI, or another machine, that usage burns the
same quota but is invisible here, and the estimate comes out **optimistically
high**. `confidence` and `caveat` say so. Believe the caveat.

## The `advice` verdict: when `shouldOffload` is true, save your work NOW

This is the single most important behavior in this document.

Every usage response carries an `advice` object:

```
advice: {
  severity: 'normal' | 'warning' | 'critical' | 'unknown',
  bindingPct: number | null,   // the weekly all-models %, see "the rule that matters" below
  shouldOffload: boolean,
  safeToFanOut: boolean,
  advice: string,              // a human-readable summary of the above
}
```

**If `shouldOffload` is `true`, you are close to being cut off mid-task.**
Before doing anything else: write your working context, findings, and next
steps to a file. Do not keep working on the assumption you'll finish first.
An agent that runs out of quota mid-task dies holding unsaved context, and
that is the expensive failure mode this whole subsystem exists to prevent.
Once the checkpoint is written, it is fine to keep going if there is quota
left; the point is that the file exists before you get cut off, not after.

`safeToFanOut` is the companion flag for the opposite decision: whether
starting a big multi-agent fan-out right now is reasonable. Check it (or
just call `check_my_usage` / `list_usage` before the fan-out) rather than
assuming headroom.

`severity: 'unknown'` (a failed or unreadable check) is NOT "plenty left".
Treat it the same as you would a low-headroom result: do not start a heavy
fan-out on an unverified read.

## The rule that matters

**The weekly (all-models) % is the binding cap.** Pace by it, not by the
session %. `bindingPct` in the `advice` object already is this number.

- A fresh 5-hour session % near 0 is a red herring if weekly is near 100;
  session resets every few hours, weekly does not.
- Switching the flagship model (e.g. Fable to Opus) does not dodge the
  all-models weekly bucket; they share it.
- Before a heavy multi-agent fan-out, check your own quota first. If weekly
  is near 100, do not blindly fan out: shrink the batch, route the work to an
  account with a lower weekly % (`list_usage` is how you find one), or wait
  for the reset.

## The CLI-spawn fallback

`check_my_usage` / `check_usage` / `list_usage` normally talk straight to
the usage endpoint with an OAuth access token already in hand. They only
fall back to spawning `claude -p "/usage"` when:

- no OAuth token is available for the account,
- the account is configured with an API key instead of an OAuth token (the
  direct endpoint is OAuth-only, an API key can't use it), or
- the server rejects the token with 401 (it has expired). The daemon
  deliberately does not refresh the token itself, since rotating the user's
  refresh token could break their real login; the CLI refreshes its own
  credentials properly, so the fallback defers to it.

This used to be the only path (and was ~25 to 50x slower: 9.2 seconds
measured versus 169 to 424ms for the direct read), so most of the traps
below were once everyone's problem. They now only bite when a check falls
back to spawning `claude`, which should be the exception, not the rule.

**Windows: the fallback runs via PowerShell or a direct binary spawn, never
via Git Bash.** MSYS mangles the `/usage` argument into a path like
`C:/Program Files/Git/usage`, and the probe silently returns nothing useful.

### What the fallback prints

`claude -p "/usage"` prints a block with (at least) three lines:

```
Current session: 0% used · resets Jul 13, 11:49pm (America/Chicago)
Current week (all models): 97% used · resets Jul 14, 2:59am (America/Chicago)
Current week (Fable): 89% used · resets Jul 14, 3am (America/Chicago)
```

One quirk to expect: at 0% a line may drop its `· resets …` clause (it prints
just `Current session: 0% used`). This is a yearless human string; the direct
endpoint gives a real ISO-8601 `resets_at` timestamp instead, which is one of
the reasons the direct path is preferred beyond raw speed.

### If you inject a token yourself for the fallback, READ THIS

Spawning `claude -p "/usage"` with your own `CLAUDE_CODE_OAUTH_TOKEN` has two
traps that both fail SILENTLY (exit 0, no error, no stderr):

1. **You must also set `CLAUDE_CODE_OAUTH_SCOPES`** to the grant's full scope
   string, e.g. `user:inference user:file_upload user:profile user:sessions:claude_code`.
   Without it, `claude` stops treating `/usage` as a slash command, runs it as a
   plain prompt, and prints a small cost summary with no percentages. A partial
   scope string (just `user:inference`) is NOT enough. This applies to any
   slash-command prompt, not only `/usage`.
2. **Pick the right grant.** A desktop instance's token cache holds two grants: a
   full CLI grant (`user:inference …`) and a profile-only grant (`user:profile`).
   Only the first can read usage; the profile one returns no numbers.

**Debugging note that will save you hours:** an agent's own session already has
`CLAUDE_CODE_OAUTH_SCOPES` set, so a spawned `claude` inherits it and appears to
work. A daemon launched outside that session (a tray started from Explorer, a
service) has a clean environment and fails. ALWAYS reproduce spawned-`claude`
bugs in a CLEAN env (strip `CLAUDECODE`, `CLAUDE_CODE_*`, `ANTHROPIC_*`) or your
own environment will mask the bug.

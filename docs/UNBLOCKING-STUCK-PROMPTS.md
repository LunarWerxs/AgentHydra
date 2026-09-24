# Clearing a chat stopped on a permission prompt

A chat that stops on **Allow / Accept / Continue** is not slow, it is **stopped**. Its engine is
still live and still reads as `working`, so nothing that *steers* a chat can restart it:
`fan_out_send` refuses a member whose engine is working, and more text would only queue behind a
turn that cannot finish. Until someone clicks, that chat is doing nothing, for as long as it takes
a person to notice.

The MCP tool **`unblock_prompts`** presses the button, mid-turn, without a human.

```jsonc
// The call a manager chat makes when a chat it is steering stalls.
{ "name": "unblock_prompts", "arguments": { "session": "<sessionId>" } }
```

## The one thing that must be true first

⛔ **Nothing is pressed unless the tray icon is up.** Check it, and say so, before expecting any
press to land:

```jsonc
{ "name": "orchestrator_switch", "arguments": { "action": "armed" } }
```

A disarmed fleet does not error. The script downgrades to plan-only and says so in its output -
which, read carelessly, looks exactly like a chat that was never stuck. `armed` is the only thing
that tells the two apart. Arming is a **person's** act (it is the owner's hand on the switch);
`force: true` is that same person's word to act once without it, and it is the only other way.

## What it will and will not press

Naming a session says **which** chat. It never says "press it regardless" - every rail survives:

| the rail | what it means |
| --- | --- |
| doctrine | pressed only where the chat's own mode is `bypassPermissions` (or the toolbox spawned it with bypass promised). Any other chat is genuinely a person's call, and is reported, not pressed |
| the pane | the chat's own last words must be visible in the window. A title is not an identity |
| a hold | a held chat is skipped |
| **the command itself** | the *pending* command is classified against `approval_policy.json`. Hardline-destructive (`rm -rf`, force-push, a credential path) is **DENIED** and left stuck however it was invoked. Anything the policy does not place is **ESCALATED** to the judgment queue rather than pressed on a guess |

`force: true` presses an escalated prompt after showing its command. It never presses a denied one:
a chat's bypass mode was consent to never being *asked*, not consent to any specific command.

## Reading the answer

`report` carries the script's own JSON:

- **`results`** - per press: `approved - the chat carries on`, `no prompt showing (it may have
  cleared)`, or `could not reach that chat's pane`.
- **`notFound`** - a chat you **named** that is not waiting on anything. This is how you tell *"I
  cleared it"* from *"it was never stuck"*; without it, both look like silence.
- **`denied`** / **`queuedForJudgment`** - what the gate refused, and why, with the command.
- **`stuck`** - every waiting chat found, with its verdict.

## Timing

A sweep ignores anything quiet for less than **4 minutes**, because an unanswered tool call that
recent is usually a command still running, and clicking at it would be worse than waiting. **A
named session defaults that wait to 0**: you have already looked at that chat. Override either way
with `min_wait_secs`.

## Two builds, one flag

The daemon runs whatever orchestrator copy is installed *beside it*, which is not necessarily this
checkout, and the script reads its arguments by lookup - so a copy that predates `--session`
**ignores** it and sweeps the whole fleet instead.

That is why a targeted act plans first: the script names the flags it understands
(`supports: ["session", "min-wait"]`), and the tool refuses to attach `--yes` to a run that would
have been fleet-wide. If you see that refusal, update the orchestrator beside the running daemon
(or point `AGENTHYDRA_ORCHESTRATOR_DIR` at a checkout that has it). Nothing is pressed either way.

## The path without the tool

The tool is a wrapper; the script is the capability, and it is reachable on any daemon:

```jsonc
{ "name": "orchestrator_run",
  "arguments": { "script": "unblock_prompts", "args": ["--session", "<id>", "--json", "--yes"] } }
```

Same rails, same output. Use it when the daemon answering you is older than the tool list you are
holding. On the command line it is `python orch.py unblock_prompts --session <id> --json`.

The unattended lane (`schedule_jobs.py`, every 5 minutes) runs the same script with no filter, and
presses only what classifies APPROVE. This tool is the on-demand half of that: the same act, aimed,
now, instead of on the next tick.

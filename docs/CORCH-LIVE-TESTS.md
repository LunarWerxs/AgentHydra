# Corch live tests

`scripts/corch-live.ts` runs Corch against the owner's real CLI accounts through the running
daemon's HTTP API. The unit tests (`server/tests/corch.test.ts`) pin the decisions with a fake CLI;
this script is the proof that the real CLI, the real accounts and a real daemon restart behave the
same way. Each turn is a one-line reply, but it spends real quota: moving a session to another
account costs one uncached prompt (about $0.50).

```bash
bun scripts/corch-live.ts handoff
```

```bash
bun scripts/corch-live.ts restart
```

```bash
bun scripts/corch-live.ts burst 10
```

`restart` restarts the daemon (other sessions see a short blip). Accounts are found, not named:
"live" accounts have a credential file, no signed-out wall and a working `claude auth status`.

## What each scenario proves

| Scenario | What it does | What must hold |
| --- | --- | --- |
| move-and-back | Turn 1 on account A; A kept busy, so turn 2 runs on B; B kept busy, so turn 3 runs on A again | Turn 3 knows the codeword given in turn 2 (only B's newer transcript had it, so A's stale copy was overwritten); the file it edits has all three lines |
| queued follow-ups | Two messages sent while the worker runs a command | Both arrive in order in the same session (`STEP3 STEP2 STEP1-…`) |
| cancel-and-revive | Stop during a command, then send a message | The CLI process is gone; the next turn resumes the session and still knows the codeword |
| follow-up on a dead login | A turn lands on an account whose login is dead | It fails `auth`, and the session finishes on the live account with the follow-up answered |
| daemon restart mid-run | Two workers in a command; restart unforced, then forced | Unforced is refused (409, names the Corch workers); forced, each worker is `interrupted`, resumes on the same account and finishes |
| burst | More tasks than the fleet runs at once | Every task finishes with its own output |

## Results, 2026-09-30 (#83, #84, #88, #90 signed in; #68, #69 expired)

- Every scenario passed. Burst: 10 of 10 in 16 s, spread over the four live accounts, none sent to
  the dead ones.
- Found and fixed (commit `0e87421`):
  - A daemon restart killed every running worker and each ended `failed` with its turn lost. On
    Windows the workers sit in the daemon's kill-on-close job. They are now resumed as
    `interrupted`, and a restart under running workers needs `force: true`.
  - The expired #68/#69 were handed a worker's attempt every 30 minutes. A signed-out wall now
    lifts only when `claude auth status` says the login works.
  - A usage reading from a window that had already reset still counted.
- Learned: the CLI writes a follow-up into the transcript before a dead login fails it, so the
  handoff prompt finds it. The CLI refuses a bare `sleep N` in its Bash tool, so the script waits
  with python's `time.sleep`.
- Not yet seen live: a real usage-limit (`quota`) handoff. The same move and resume path is proven
  by the dead-login and busy-account moves above, and the limit notice is pinned by the unit tests.

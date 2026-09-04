# Third-party notices

AgentHydra is MIT-licensed (see `LICENSE`). Some parts of it are adapted from other MIT-licensed
projects. The MIT licence requires that the original copyright and permission notice travel with
any substantial copy, so they are reproduced here, and each adapted file names its source in a
header comment.

## NousResearch/hermes-agent

Source: <https://github.com/NousResearch/hermes-agent> (MIT). Read while building the 2026-09-04
release. Hermes is an agent runtime; AgentHydra is a dashboard over agent runtimes, so nothing of
its core was taken, and the two projects do not overlap in what they do.

Every claim below was checked by comparing our file against the real upstream file, rather than
trusting what our own header comments said - an earlier pass over-attributed, and one header cited
an upstream function (`_confirm_adapter_delivery`) that does not exist in that repository at all.
Over-attribution is not a safe default: it misstates the authorship of our own work, and it
implies a copy where none happened.

**Close derivatives.** Our code follows the original's structure closely enough that the MIT notice
below travels with it:

- `server/src/incidents.ts` and `orchestrator/scripts/lib/incidentlib.py`, from `cron/incidents.py`
  (~302 lines): the failure-type classification table, the normalise / redact / signature / classify
  functions and the CRUD surface are close translations. The reopen-on-recurrence semantics, the
  placeholder scrubbing and the whole notification layer are ours.
- `server/src/core/codex-account.ts`, the reset-credit section only, from `agent/account_usage.py`:
  the backend URL derivation, window parsing and the refuse-below-full-use guard.

**Prior art, credited but not copied.** No upstream code is present in these; reading Hermes is what
prompted writing them, which is worth saying plainly and is not a licence obligation:

- `server/src/boot-watchdog.ts` - arm / renew / disarm against a deadline, a generic watchdog
  discipline their `hermes_startup_watchdog.py` also implements, independently and far more heavily.
- `server/src/dispatch.ts`, `server/src/types.ts`, `orchestrator/scripts/lib/ledgerlib.py` -
  "unverified" as an outcome, and the never-retry-on-UNKNOWN rule their `cron/delivery_queue.py`
  documents for its own queue.
- `orchestrator/scripts/lib/approvallib.py` - the APPROVE / DENY / ESCALATE tri-state, and the rule
  that operator policy never shares a channel with untrusted prompt text. Their `tools/approval.py`
  is a 1000+ line live gateway; ours is a small synchronous classifier and shares none of it.

**Interoperability, not derivation.** `server/src/hermes-sessions.ts` reads a Hermes install's own
`state.db` so AgentHydra can list those sessions, exactly as it already reads Codex and OpenCode.
The table and column names are facts about a file format; no upstream code or logic is used.

`orchestrator/scripts/lib/mutationlib.py` carried a Hermes credit in an earlier draft and no longer
does: on comparison it shares nothing with `tools/checkpoint_manager.py`, which snapshots repo files
through a shadow git repository. It is our own before/after ledger.

Nine skills under `home/skills/hermes-*` in the team's private skills repository ARE Hermes'
content, vendored and marked as such in each file. They are not part of this repository.

```
MIT License

Copyright (c) 2025 Nous Research

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## kenn-io/agentsview

The agent catalog (`server/src/agent-catalog.ts`) re-expresses the on-disk paths from the agent
registry in <https://github.com/kenn-io/agentsview> (MIT, Kenn Software LLC), as its header
states. Facts, not code, were taken; no source was copied.

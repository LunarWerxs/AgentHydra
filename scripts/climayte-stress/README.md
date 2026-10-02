# CliMayte stress scripts

Run these before and after a change to CliMayte to see what it costs and whether it breaks.

- `python scripts/climayte-stress/fuzz.py`: 26 malformed dispatches against the running daemon
  (`AGENTHYDRA_URL`, default `http://127.0.0.1:7787`). Every one must come back 4xx; any worker
  one creates is cancelled at once and named. Spends no quota. First run (2026-10-02): 4 were
  accepted (unknown or malformed accounts, the cap under its other spelling); all 26 are refused
  since.
- `python scripts/climayte-stress/history.py`: reads `~/.agenthydra/corch` (the task store and the
  journal) and prints where time and tokens went: start latency, gaps between attempts, cost by
  attempt outcome, what a move re-wrote against a same-account resume, the costliest tasks, and
  the recurring wait reasons. Read-only.

A live round is a group of real tasks through `climayte_run` (docs/CLIMAYTE.md). The 2026-10-02
round sent eight read-only reviews of CliMayte's own code to idle accounts, plus edge cases:
queueing and priority on two accounts, a check that fails first, and an oversized task.

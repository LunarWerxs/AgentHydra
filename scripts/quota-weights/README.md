# quota-weights: fit the token weights to the subscription meter

`server/src/usage-tokens.ts` weighs each kind of token (cache read, 5-minute and 1-hour cache
write, output, uncached input) and each model family before `usage_budget` divides weighted tokens
by percent burned. These scripts fit those weights to the meter and replay the budget's own
prediction on accounts the fit never saw, so a weight change is judged by how much it moves the
budget's error, not by R².

Run them on a machine that has both readings and transcripts (Python 3 with numpy and scipy):

```bash
python scripts/quota-weights/build.py
python scripts/quota-weights/fit.py
python scripts/quota-weights/eval_mult.py
python scripts/quota-weights/final.py
```

| Script | What it does |
| --- | --- |
| `build.py` | Reads every assistant request (deduplicated by message and request id) from each CLI instance's config dir and from `~/.claude/projects`, attributing desktop chats through each profile's `claude-code-sessions`. Reads meter readings from Corch stream logs (per request), AgentHydra's `usage-history.json` and each desktop profile's `plan-usage-history.json`. Writes `data.pkl` to `QUOTA_WEIGHTS_DATA` (default `~/.agenthydra/quota-weights`), never into the repo. About 3 minutes over 25 GB of transcripts. |
| `analyze.py` | Library: per-account cumulative spend, Corch intervals, whole 5-hour windows, the scaled non-negative least-squares fit (one free scale per account, so Pro and Max windows pool). |
| `fit.py` | Read, write and output ratios per source and per tier, to see whether the sources agree. |
| `evaluate.py` | The budget replay: calibrate on the last 6 hours, predict the next hour (5-hour meter) or 6 hours (weekly meter); leave-one-account-out and cross-group splits. |
| `eval_mult.py` | Model multipliers and the cache-write TTL split, compared on the same replay. |
| `final.py` | The shipped form's weights and its held-out error against the previous weights on every split. `ROUNDED=input,read,w5m,w1h,output` also scores fixed constants. |

## What the 2026-09-30 run found

75 Corch intervals and 299 whole 5-hour windows on 47 accounts (8 Pro, 7 Max 5x, 13 Max 20x and
19 whose plan AgentHydra has not recorded).

- Relative to a cache read, a 5-minute cache write fills the meter about 32 times as fast and an
  output token about 310 times; the price-list ratios the code used were 12.5 and 50.
- The meter charges Fable about 2.5x Opus, their list-price ratio; the old code charged them the
  same. Sonnet was about 4% of the weighted traffic, too little to tell its ratio to Opus.
- A 1-hour cache write at 1.6x a 5-minute one (their list-price ratio) predicted slightly better
  than one weight for both.
- Held out (each account scored by weights fitted without it), against the weekly meter the budget
  calibrates on: median miss 3.60 to 2.66 points per 6 hours, mean 13.0 to 9.5 (1,213
  predictions). On the 5-hour meter: median 3.06 to 1.68 points per hour, mean 6.4 to 5.1 (998).
- Fitting on one group and testing on another (desktop and Corch CLI, Max 5x and Max 20x, Pro and
  Max) improved the median in every split but one: Max to Pro on the 5-hour meter, 30 predictions,
  mean 5.9 to 6.9, median 2.9 to 2.8.

Limits: about 16% of desktop requests belong to chats whose session files are gone, so the
desktop windows carry usage the scripts cannot attribute (windows where the meter rose with no
recorded request are dropped). Corch Pro accounts burn a 5-hour window too fast for a 6-hour
calibration, so on the 5-hour meter they only train and never score.

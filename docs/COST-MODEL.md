# Cost model: API keys or a Claude subscription

HSwarm sends work to API-key models (DeepSeek, the Anthropic API, OpenRouter). CliMayte sends it to Claude Code
workers on the owner's Pro, Max 5x and Max 20x subscriptions. `server/src/routing-cost.ts` compares what the same
work costs on each side and picks one. The research numbers below are a dated snapshot (measured 2026-10-05); the
live figures come from `GET /api/routing/cost-model`.

## The research

CliMayte, since 2026-09-28: 1,834 tasks used 19,245.7 % of a Pro 5-hour window and had a list cost of $3,983.53 at
Anthropic's API prices. So one full Pro window holds about $20.70 of work at list price.

A week holds a fixed number of windows, measured from `usage_samples` over 21 days (week-% risen per session-%
risen inside one window): about 11.7 Pro windows on Pro (32 accounts), 9.8 of its own windows on Max 5x (5 accounts)
and 4.1 on Max 20x (2 accounts). A Max 5x window is 4.75 Pro windows, a Max 20x window 19.

At full use over 4.33 weeks a month, Pro ($20) buys about 50.7 Pro windows, about $1,049 at list (1.9 %). Max 5x
($100) buys about 202, about $4,170 (2.4 %). Max 20x ($200) buys about 337, about $6,980 (2.9 %).

So Claude on a subscription is about 34 to 50 times cheaper than the Claude API at list at full use of the plan. DeepSeek flash is 3 to 12 % of
Sonnet's list price, the same order as a subscription, and that is where the split below matters.

## How the numbers are measured

- **Dollars per Pro window** is the sum of CliMayte's `costUsd` over the sum of its `usedPct` / 100 for the last 14
  days (the same figures `GET /api/corch/totals` returns). Under 200 % of a window measured, it falls back to 20.70.
- **Windows per week** is per plan. Per account, over 21 days, the rises of session-% and week-% are summed between
  consecutive samples at most 30 minutes apart in the same session and week window (reset times within 15 minutes).
  Accounts with under 40 session points are dropped. The median of week-rise / session-rise per plan gives
  windows per week as its inverse. A plan with no qualifying account uses 11.7 / 9.8 / 4.1.
- The constants 20.7 (dollars per Pro window) and 11.7 / 9.8 / 4.1 (windows per week) in `routing-cost.ts` are
  fallbacks, used only when there is not enough measured data. Plan sizes (1 / 4.75 / 19) live in `server/src/plans.ts`,
  shared with CliMayte's placement.
- **Effective fraction** of a plan = price / (windows per week x size x 4.33 x dollars per Pro window): what a
  subscription costs as a share of list at full use.
- **Fleet fraction** weights the three plans by how many signed-in CLI instances each has.

## How a decision works

`decideRoute({ key, listUsd, api, subscriptionRoom })`:

- Subscription cost = `listUsd` x fleet fraction + the session overhead (a share of a Pro window, converted the
  same way). API cost = the API's list dollars less the provider's discount.
- Work on a signed-in account is priced at the plan's rate for the model it really runs on, never at another
  model's list price (owner, 2026-10-07: CliMayte gets the plan's discounted rate, and so does Haiku run inside an
  account). A caller that sends the task's `kind` and `tokens` (`{ input, output }`, HSwarm does) gets `listUsd`
  computed here, at the model CliMayte's scorecard picks for that kind now (Haiku 5.5 while its trial runs), and the
  answer names it as `subscriptionModel`. Free claude.ai accounts cost nothing, so HSwarm sends tool-free work to
  them before it asks this question at all (docs/CLIMAYTE.md, "Which route first").
- Routing off, no subscription room or no `listUsd`: the API. No API model fits: the subscription.
- If the dearer side costs more than `routing_close_ratio` times the cheaper, the cheaper wins.
- Otherwise the call is close. The key is hashed into 0..99; below `routing_api_preference_pct` it goes to the API.
  The same key always lands on the same side.

The split (`routing_api_preference_pct`) applies only inside the close band; outside it the cheaper side always wins.
The same key always lands on the same side. `subscriptionUsd` is not a bill: it is the list value of the quota the task
would use (list cost x fleet fraction + session overhead), for comparison with API dollars.

The answer carries the route, a one-sentence reason, both dollar figures and whether the call was close.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `routing_enabled` | true | Off sends everything to the API. |
| `routing_api_preference_pct` | 20 | Share of close calls sent to the API (0 to 100). |
| `routing_close_ratio` | 3 | Two costs within this factor are close. |
| `routing_session_overhead_pct` | 1 | % of a Pro window every subscription task pays to start a session. |
| `routing_discounts` | all 0 | JSON `{ anthropic, deepseek, openrouter, other }`, percent off list. |
| `routing_price_pro` / `_max5` / `_max20` | 20 / 100 / 200 | Monthly plan prices in USD. |

The owner's bulk API rate goes into `routing_discounts`: list prices overstate what the owner pays, so enter the
percent off per provider and the API side of every comparison drops by it.

How to choose it: a free-tier key is 100% off, and its allowance comes back, so spending it costs nothing later.
Credit that runs out and is never refilled is not free in the same way: every dollar spent now is one the pool no
longer has when the subscriptions are full. Leave such a provider at 0, so a tool task goes to a subscription (whose
weekly quota is lost if it is not used) and falls back to the key only when no account can start it in time.

The owner's setting since 2026-10-06: `other` 100 and `openrouter` 100 (the free-tier pools: Gemini, NVIDIA,
Mistral, Zhipu, Cohere, Hugging Face, Cerebras; every paid OpenRouter key is spent, so only `:free` models run
there), `anthropic` 0 and `deepseek` 0 (given credit that is never topped up: 34 of 45 Anthropic keys had run out of
credit that day, and the DeepSeek balance was below zero). A free-tier tool task now stays on its free key; a task
whose API leg is a Claude model goes to a subscription, about 50 times cheaper than list.

## Endpoints

- `GET /api/routing/cost-model`: measured numbers with sample sizes and fallback flags, the plan table, a model
  table (Claude and DeepSeek from `hswarm/data/prices.json` through `pricing.ts`) and the settings.
- `PUT /api/routing/settings`: validated and clamped; send any of `enabled`, `apiPreferencePct`, `closeRatio`,
  `sessionOverheadPct`, `discounts`, `planPrices`.
- `POST /api/routing/decide`: the body of `decideRoute`, plus `kind` and `tokens` to price the subscription side at
  CliMayte's pick; answers `{ route, why, apiUsd, subscriptionUsd, close, subscriptionModel }` (`subscriptionModel`
  null when no `kind` was sent). An unknown `kind`, or a `kind` without both token counts, is a 400.

## Where to change it

Hydra Desk 2: AgentHydra pane, HSwarm tab, Routing page. Or `PUT /api/routing/settings`. The settings are synced to
the other PC by login sync. The endpoint accepts numbers or numeric strings only: percents are clamped to 0..100,
`closeRatio` to 1..100, plan prices to 0..10000. A junk value leaves that field unchanged and the answer is a 400 naming
it. `POST /api/routing/decide` answers 400 when `api.usd` is not a finite number >= 0; a `listUsd` that is not one counts
as no list cost.

## Forcing a route

- All API: `enabled` false, or `apiPreferencePct` 100.
- More subscription: `apiPreferencePct` 0 and a higher `closeRatio` (more calls count as close, so the split decides them).

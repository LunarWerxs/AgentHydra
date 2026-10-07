## hswarm (HydraSwarm): hand cheap, wide work to other models

The `hswarm` MCP server runs tasks on cheaper models, many at once, and returns their answers as data.
Delegate wide, repetitive work (checking many files, per-item summaries, classification, extraction, grading, log and diff scans, second opinions) instead of doing it on your own model. Keep the plan, the hard calls and the final answer yourself.

- **Batch the questions, not the calls.** A task carries 20-100 small numbered items with a `schema` whose answer is an array keyed by item id. One task per item only when each needs its own tools or heavy reading.
- `hswarm_run`: a batch of tasks. Give every task an ABSOLUTE `cwd`, the `tools` it needs (`none`, `read`, `edit`, or `all` for a shell; web pages need `web` plus `web_hosts`), and a JSON `schema` whenever the answer is data.
- `hswarm_ask`: one tool-free call; several questions go as a numbered list with an array schema.
- Workers are cheap, not infallible: before relying on a finding, open the `file:line` it cites or re-run the command it quotes, and drop anything whose quote is not there.
- Leave `model` on `auto` (the cheapest model that meets the task's bar); `profile` (`code`, `decision`, `research`, `critical`) raises the bar.
- Keys are the user's, set in `hswarm ui`; `hswarm_doctor` shows what is ready. Never ask the user to paste a key.
- On `auto`, a task with tools and an absolute `cwd` may run on the owner's Claude subscription (CliMayte), and a tool-free one on the owner's Free accounts at no cost; `selection.route` shows which.
- **Model watch:** when `hswarm models --watch` or `hswarm doctor` reports benchmarked-but-unrouted or unbenchmarked models, register each route with its sourced price, or source its published scores into `data/published-models.json`, before other HSwarm work. Never guess a score or price.

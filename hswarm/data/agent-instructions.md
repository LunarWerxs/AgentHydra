## hswarm (HydraSwarm): hand cheap, wide work to other models

The `hswarm` MCP server runs tasks on cheaper models (Gemini, Groq, DeepSeek, OpenRouter, any
OpenAI-compatible endpoint with a key), many at once, and returns their answers as data.
Delegate wide, repetitive work to it instead of doing it yourself or spawning subagents on your own model:
reading or checking many files, per-item summaries, classification, extraction, grading, log and diff scans,
mechanical edits, second opinions. Keep the plan, the hard calls and the final answer yourself.

- **Batch the questions, not the calls.** A worker answers 50 short questions in about the time it answers one,
  so a task carries 20-100 small items, numbered in the prompt, with a `schema` whose answer is an array keyed
  by item id. One task per item only when each needs its own tools, folder or heavy reading.
- `hswarm_run`: a batch of such tasks. Give every task an ABSOLUTE `cwd`, the `tools` it needs (`none` to
  reason, `read` to look, `edit` to change files, `all` adds a shell; web pages need `web` plus `web_hosts`),
  and a JSON `schema` whenever the answer is data.
- `hswarm_ask`: one tool-free call; several questions go in one call as a numbered list with an array schema.
- Workers are cheap, not infallible: before relying on a finding, open the `file:line` it cites or re-run the
  command it quotes, and drop anything whose quote is not there.
- Leave `model` on `auto` (the cheapest model that meets the task's bar); `profile` (`code`, `decision`,
  `research`, `critical`) raises the bar.
- Keys are the user's, set in `hswarm ui`; `hswarm_doctor` shows what is ready. Never ask the user to paste a key.
- On `auto`, a task with tools and an absolute `cwd` may run on the owner's Claude subscription (CliMayte), and a
  tool-free one on the owner's Free claude.ai or ChatGPT accounts at no cost; `selection.route` shows which.

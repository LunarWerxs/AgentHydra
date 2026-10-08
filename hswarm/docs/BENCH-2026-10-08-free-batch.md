# Batched Free-account escalations for hswarm_decide: measured, not shipped (2026-10-08)

**TL;DR**

- **Asked:** can `hswarm_decide` send all the escalated questions about one state to a Free web account in ONE
  message (the state once, the questions numbered, a JSON object of answers back) instead of one message per question?
- **Result:** batching itself costs little: 1-2 points below the same Free models asked one question at a time,
  within noise. But it moves escalations from the paid route to the Free models, which scored 5-7 points lower on
  choice questions. Against the per-item escalation as it runs today (paid, whenever no Free account is idle), batches
  of 4 scored 6.1 points lower and batches of 40 scored 7.3 points lower (95% interval -13.9 to -1.2).
- **Decision:** not shipped. The owner's rule is that price never excuses less accurate work, and the gate was set
  before the run: within noise of per-item AND no worse than 3 points.

<details><summary>Method</summary>

Harness: `scripts/rsi/decide-free-batch.py` (it carries the exact `free_batch` code that was measured). Items: Dredd's
87 gold asks (Connections `tools/dredd/eval/asks.json`, hand-labelled, kept outside this repo) run through Dredd's own
`buildQuestions`: per ask, 4 choice/score questions (ask class, domain, scope, delegation) and 36 yes/no questions
(does instrument X belong here), all about the one ask. Graded: 165 choice/score questions with a gold label (ask class
83, domain 78, scope 2, delegation 2) and 393 yes/no questions with one (the ask's `must` = yes, `mustNot` = no).

Arms, all on the same questions, run 2026-10-08 from 08:45 to 09:00 UTC:

| arm | what it is |
| --- | --- |
| item-paid | one ask per question on the decision profile's paid route (`dispatch.ask_selected`), `SYSTEM` + `render()` |
| item-free | the same prompt on an idle Free account (`free_route.consult`), as `ask_routed` tries first today |
| batch4 | one Free message per ask with its 4 choice/score questions (Dredd's cascade group) |
| batch40 | one Free message per ask with all 40 questions (Dredd's whole ask while Jev is down) |

Jev could not be measured: TypeSafe has answered every call with HTTP 402 (no credit) since 2026-10-06 10:08 UTC, so
every decide item escalated that day and the escalated subset is all of them. (Later the same day, 6d3e0fef made
`escalate_below=0` escalate nothing, Jev failures included. Dredd asks its yes/no questions at 0, so with Jev down an
ask now escalates only its 4 choice/score questions, and batch40's case no longer happens.) Paired differences carry a 95% interval
from a bootstrap over asks (one ask's questions share a message). Every Free message was served (batches: 174 of 174, 172 on
the first try; one question each: 165 of 165). The paid arm cost $0.21 for 558 calls (DeepSeek V4.1 Flash on most, GPT-6.1 Sol on 7).

</details>

<details><summary>Results</summary>

Accuracy on the graded questions:

| arm | choice/score (165) | yes/no (393) |
| --- | --- | --- |
| item-paid | 87.9% | 93.1% |
| item-free | 83.0% | not run (about 800 more Free messages) |
| batch4 | 81.8% | not asked |
| batch40 | 80.6% | 95.7% |

Paired differences (new minus base, same questions):

| comparison | n | difference | 95% interval | only new right / only base right |
| --- | --- | --- | --- | --- |
| batch4 - item-paid, choice | 165 | -6.1 pts | -12.1 to 0.0 | 9 / 19 |
| batch40 - item-paid, choice | 165 | -7.3 pts | -13.9 to -1.2 | 10 / 22 |
| batch40 - item-paid, yes/no | 393 | +2.5 pts | -0.8 to +6.2 | 22 / 12 |
| batch4 - item-free, choice | 165 | -1.2 pts | -6.5 to +4.2 | 10 / 12 |
| batch40 - item-free, choice | 165 | -2.4 pts | -8.1 to +3.0 | 10 / 14 |
| item-free - item-paid, choice | 165 | -4.8 pts | -9.6 to 0.0 | 4 / 12 |

By Free model on choice questions: Claude Haiku 5.5 scored 83.5% one at a time, 77.5% in batches of 4 and 78.9% in
batches of 40; GPT-5.6 mini scored 82.4%, 86.8% and 82.0%.

</details>

<details><summary>What it means, and when to measure again</summary>

- Batching one state's questions is not what loses accuracy; the Free models are. A batched leg would mostly replace
  paid escalations (six Free accounts cannot keep up with a Dredd spike one question per message), so its real effect
  is the batch-versus-paid row.
- Yes/no questions held up in a batch of 40 (+2.5 points, interval across zero). A yes/no-only leg was not part of the
  plan set before the run, so it is a hypothesis for a fresh run, not a result.
- The per-item Free leg that `ask_routed` already takes for escalations is itself 4.8 points under paid on choice
  questions here (interval -9.6 to 0.0).
- Re-run the harness when the Free accounts' models change, or once Jev has credit again (then only Jev's unsure items
  escalate, and those are the ones to grade).

</details>

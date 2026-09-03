# The courier: what it is, in plain terms

**One sentence: the courier is the piece that types a reply into a chat for you.**

Everything the toolbox does today ends at *deciding*. `sweep.py` reads all 37 chats, sorts
them, archives the finished ones, lands the invisible ones, moves work between accounts, and
then hits a wall. Thirteen chats are sitting there having asked you a question or offered to
carry on, and the toolbox can say **"this one is waiting and here is what it asked"** but it
cannot say **"...so I told it to go ahead."** That last step is still you, opening each chat
and typing.

The courier is that last step, automated.

## What actually happens today, and where it stops

```
chat finishes → gate reads its last words → "waiting on a person" → LIST IT → ✋ you
```

The list is the judgment queue. It's correct, it's complete, and it's a dead end: every one of
those chats needs a human (or an AI) to read it and write a sentence back. With 13-17 chats in
that queue at any time, that's the bulk of the remaining manual work.

With a courier:

```
chat finishes → gate → "waiting" → an AI reads it and decides the reply
                                 → courier STAGES the reply → delivers it into the chat
                                 → verifies the chat actually received it and started working
```

## Why it isn't just "send a message"

Three things make it real work rather than a one-liner:

1. **There is no API for it.** The desktop app has no "send message to chat X" endpoint. The
   only way in is the same UI-Automation route the naming pass uses: find the chat's row, focus
   its composer, set the text, post Enter. AgentHydra already has a proven actuator for this
   (`misc/Deliver-DesktopChat.ps1`), and a hard-won lesson attached to it: *a window can show
   two conversations at once, so the composer must be found by climbing from the proof element,
   never by grabbing the first composer in the window.* Deliver into the wrong chat and you've
   put a stranger's instruction into live work.

2. **Staging must be separate from sending.** v1 died partly because it delivered things it
   had decided moments earlier against a world that had changed. The design that survives:
   *stage* a reply (write it down, with the chat it's for and the evidence it was based on),
   then *deliver* as a distinct act that re-checks the chat is still waiting, still idle, still
   the same chat, immediately before typing. A staged prompt nobody sent is visible and
   harmless; a sent prompt nobody checked is how work gets corrupted.

3. **Delivery has to be verified, and it can half-fail.** "The keystroke went somewhere" is not
   delivery. The courier must confirm the chat actually took the message and began a turn,
   and when it can't confirm, say so rather than mark it sent. Same rule as every other act
   here: never claim it landed without checking.

## What it would be, concretely

Two scripts plus one library, matching everything else in the toolbox:

| piece | job |
| --- | --- |
| `deliverylib.py` | the staging ledger: a reply, its target chat, who wrote it, the evidence, and its state (staged → delivered → verified / failed). Sits beside the attempt ledger and the holds file. |
| `stage_reply.py` | write a reply into the ledger for one chat. Pure state, sends nothing. This is where an AI's judgment gets recorded. |
| `courier.py` | deliver staged replies through the app's composer, one at a time: re-check the chat at T-0, drive the actuator, verify the chat started a turn, mark the ledger. Obeys holds, the breaker, and the live-writer rail like every other act. |

And the sweep gains a fourth lane: `--deliver`, which sends what's been staged, so the whole
loop finally becomes the one awaited command you asked for:

```
python scripts/sweep.py --json          # here is everything, including what's waiting on you
   (an AI reads the waiting ones and stages replies)
python scripts/sweep.py --all --yes     # archive, land, name, balance, AND deliver
```

## What it does not do

It does not decide *what to say*. Composing the reply is judgment: the AI's job under the
division of labor, exactly like naming a chat. The courier moves a decided reply from the
ledger into the chat and proves it arrived. If nobody staged a reply, the courier does nothing
at all.

## Why it's the biggest remaining piece

Every other lane is mechanical and already automated. This is the only one where the toolbox
currently hands work *back* to you, and it's the lane with the most items in it. Closing it
turns the orchestrator from "tells you what needs doing" into "does it."

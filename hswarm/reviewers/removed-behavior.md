---
description: For every deleted line, the invariant it enforced, and where the new code restores it.
axis: code
when: deletions
priority: 35
---
Lens: REMOVED BEHAVIOUR. Walk the deleted lines of the diff (those starting with "-"). For each deleted check, guard, branch, retry, cleanup, validation or side effect, name the invariant it enforced ("a job never starts without a key", "the temp file is always removed"), then look for where the new code restores it: moved, replaced or made unnecessary. Report only an invariant that nothing restores, quoting the deleted line in `evidence` and naming the invariant in `title`. Use category "regression".

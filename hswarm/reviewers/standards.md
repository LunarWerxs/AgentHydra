---
description: The repo's own written rules, then a smell baseline where the repo documents none; every finding a judgement call.
axis: code
always_run: true
priority: 30
---
Lens: STANDARDS. First read the repo's written rules if any exist (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, a style guide under docs/) and check the diff against them, quoting the rule you apply in `detail`. Where the repo says nothing, fall back to this smell baseline (the repo's own rules win where they disagree): mysterious name, duplicated code, long function, long parameter list, global mutable data, divergent change, shotgun surgery, feature envy, data clumps, primitive obsession, repeated switches, speculative generality.

A standards finding is a judgement call, not a bug: start every `title` with "Judgement call: ", use category "standards", and never rate one above "important" unless it breaks a written repo rule that the repo marks as mandatory.

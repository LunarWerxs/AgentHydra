# Hydra Desk (Jacob's private app)

This folder is Hydra Desk: Jacob's own Claude Code desktop. SPEC.md is the design and wins over
anything else; shared/protocol.ts is the contract between server/ and web/.

- Since 2026-10-04 this folder is part of the PUBLIC AgentHydra repo (Jacob's call); its earlier
  history, which carries real email addresses, stays private in `~/.hydra-desk/repo-history.git` and
  is never pushed. Everything committed here is published: no real emails, account addresses, keys or
  chat content in files, tests or screenshots. The parent AGENTS.md's public-repo rules apply; its
  release, changelog, i18n and kit-sync rules govern AgentHydra's own code, not this folder.
- Commit your own paths only, from the AgentHydra repo: `git add -- desk/<paths> && git commit -m
  "<what changed and why>"`. No push unless the brief says so. Never `reset --hard`, `stash`,
  `clean -f` or `checkout .`: other workers edit this tree at the same time.
- Bun for everything (`bun install`, `bun test`, `bun run`). Tests set `HYDRA_DESK_HOME` to a temp
  folder; never write to the real `~/.hydra-desk/` from a test.
- Never read or print a secret: the agenthydra MCP entry copied from `~/.claude.json` and any
  `.credentials.json` stay out of logs and output.
- Never open a visible console window: detached processes use `Start-Process -WindowStyle Hidden` with
  logs to files.

# Hydra Desk build plan (wave 1, 2026-10-03)

Source of truth for what is built is SPEC.md. This file only orders the work.

scaffold            root + server + web skeleton, plugin loader, tokens, ui primitives, health/settings/ws
engine-core         normalize, status reducer, input queue, store, SDK fixtures        (after scaffold)
bridge              AgentHydra client, accounts, external sessions, CliMayte, poller    (after scaffold)
git-folders         git status/diff, folder browse                                      (after scaffold)
engine-runtime      one live chat: SDK query, canUseTool, interrupt, queue              (after engine-core)
engine-manager      chat manager, chat routes, models, commands, import, hello         (after engine-runtime, bridge)
web-shell           store, App shell, sidebar with status glyphs, gallery, fixtures     (after scaffold)
web-transcript      transcript and every item card                                      (after web-shell)
web-composer        composer, menus, slash, attachments                                 (after web-shell)
web-panels          CliMayte panel, Elsewhere list and view                             (after web-shell)
web-diff-settings   diff pane, settings view, accounts popover                          (after web-shell)
launcher            start.ps1, shortcuts, icon, README                                  (after scaffold)
e2e-engine          real chat against a real account, every status                      (after engine-manager)
e2e-ui              real window in Edge/Chrome, compared to the references              (after all web, engine-manager, launcher)

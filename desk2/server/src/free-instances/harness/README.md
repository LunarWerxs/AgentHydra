Bundled ClaudFree 0.8.0 transport source, developed for this project. Desk's adapter uses its HTTP
clients for Claude Incognito and ChatGPT Temporary Chats. Manual login is the sole visible-browser
operation: it uses zendriver with the installed Chrome or Edge on a throwaway profile (no Camoufox fetch). `desk_entry.py` provides a structured login result and closes the owned window on success.
The shared JavaScript cache is selected with `CLAUDFREE_CACHE_DIR`; each account uses a separate
`CLAUDFREE_STATE_DIR`. The package can still be used through Python, its CLI, or MCP.

Dependencies are installed into Desk's data home. No credentials, runtime caches, virtual environments, diagnostics or recorded chats belong here.
ChatGPT's Node dependencies are local copies: setup rejects links into an external package store so
the restricted preparation process can read its dependencies without broader filesystem permissions.
Desk's ChatGPT sender uses GPT-5.6 Luna Instant only. `usage` verifies Free account access and model
availability over HTTP before reporting unlimited everyday text; tools retain separate limits.

The asset manifest hashes the original HTTPS bytes (LF line endings). Two modules previously cached
with Windows CRLF endings contain identical code; these hashes let a clean installation download and
verify the provider's original bytes directly.

---
description: Injection, auth and permission gaps, secrets in code or logs, unsafe deserialisation, path traversal, SSRF.
axis: code
priority: 40
paths: **/*auth*, **/*login*, **/*session*, **/*token*, **/*secret*, **/*crypt*, **/*perm*, **/api/**, **/routes/**, **/*.sql, **/Dockerfile, .github/workflows/**, **/*.env*, **/*upload*, **/*sandbox*, **/*shell*, **/*exec*
---
Lens: SECURITY. Look for: untrusted input reaching a shell, SQL, a template, a file path or a URL fetch without validation; a missing or weakened auth or permission check; a secret, key or token written to code, a log or an error message; unsafe deserialisation (pickle, yaml.load, eval); a sandbox or allow-list widened; a CI workflow that runs untrusted code with write tokens. Use category "security". Say who the attacker is and what they gain in `detail`.

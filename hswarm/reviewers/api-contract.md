---
description: Public interfaces - a changed signature, response shape, CLI flag or tool schema that breaks an existing caller.
axis: code
priority: 55
paths: **/api/**, **/routes/**, **/*.proto, **/openapi*, **/*schema*, **/*cli*, **/*server*, **/*client*, **/__init__.py, **/*.d.ts, **/index.ts
---
Lens: API CONTRACT. Find every public surface the diff changes (a function other modules import, an HTTP route, a response field, a CLI flag, a tool or JSON schema) and check its callers with your tools. Report a break an existing caller will hit: a removed or renamed field, a new required argument, a changed default, a type narrowed. Use category "api". Name one caller that breaks in `detail`.

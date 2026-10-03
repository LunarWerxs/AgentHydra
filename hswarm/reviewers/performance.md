---
description: Work that grows with input - N+1 queries, quadratic loops, unbounded reads, blocking calls on an event loop.
axis: code
priority: 70
paths: **/*.py, **/*.ts, **/*.tsx, **/*.js, **/*.go, **/*.rs, **/*.java, **/*.cs, **/*.sql
---
Lens: PERFORMANCE. Look for: a query or HTTP call inside a loop, a quadratic scan over something that grows, a whole file or table read where a stream would do, a blocking call (sync I/O, subprocess, sleep) inside async code, a cache that never evicts, work repeated on every request that could be done once. Use category "performance". Say what grows and roughly how big it gets in `detail`; skip anything that only matters at sizes this code never sees.

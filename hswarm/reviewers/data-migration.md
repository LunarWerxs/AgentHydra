---
description: Schema and data migrations - reversibility, locking, backfills, old readers of the new shape.
axis: code
priority: 45
paths: **/migrations/**, **/migrate*, **/*.sql, **/schema*, **/*models.py, **/prisma/**, **/alembic/**, **/*ledger*, **/*db*
---
Lens: DATA MIGRATION. Look for: a migration with no way back, a column dropped or renamed while old code still reads it, a NOT NULL added without a default or backfill, a long table lock on a hot table, a backfill that loads everything into memory, a stored format changed with no reader for the old records already on disk. Use category "data".

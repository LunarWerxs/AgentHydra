// Writes the tab ledger that ownership.ts reads, in the shape Connections' browser engine writes it. Both write the same
// file while both run, so every write re-reads the file, changes only its own row, and replaces the file atomically.

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TABS_LEDGER } from './ownership'

interface LedgerFile {
  v: 1
  tabs: Record<string, unknown>
}

function readLedger(file: string): LedgerFile {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed && parsed.v === 1 && parsed.tabs && typeof parsed.tabs === 'object') return { v: 1, tabs: parsed.tabs }
  } catch {
    // absent or half-written: start from empty
  }
  return { v: 1, tabs: {} }
}

function writeLedger(file: string, ledger: LedgerFile): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(ledger))
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, file)
        return
      } catch (err) {
        if (attempt >= 4) throw err
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
      }
    }
  } catch {
    rmSync(tmp, { force: true })
  }
}

/** Records `session` as the owner of the page `targetId` in the profile folder `dir`; a call without a session writes nothing. */
export function ownPage(dir: string, targetId: string, session: string | undefined): void {
  if (!session) return
  const file = join(dir, TABS_LEDGER)
  const ledger = readLedger(file)
  ledger.tabs[targetId] = { chat: session, at: new Date().toISOString() }
  writeLedger(file, ledger)
}

/** Removes the row of the page `targetId`; every other row stays as it is. */
export function dropPage(dir: string, targetId: string): void {
  const file = join(dir, TABS_LEDGER)
  const ledger = readLedger(file)
  if (!(targetId in ledger.tabs)) return
  delete ledger.tabs[targetId]
  writeLedger(file, ledger)
}

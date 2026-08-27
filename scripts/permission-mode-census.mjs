#!/usr/bin/env bun
/**
 * Census: what permission mode do this machine's desktop chats actually have?
 *
 * WHY THIS EXISTS. The approval-stall deadlock (a chat that is alive, idle, and silently waiting
 * on an approval prompt nobody can click) was understood from anecdotes. Anecdotes got the shape
 * BACKWARDS: the belief was that chats the desktop app creates itself land on `acceptEdits`. This
 * script measured the owner's real fleet on 2026-08-27 and the split is clean and the other way
 * round:
 *
 *     APP-CREATED  1331 / 1332  bypassPermissions   (the one exception is from July)
 *     IMPORTED       26 /   30  acceptEdits
 *
 * So chats the app makes for itself are fine, and every deadlock candidate is an IMPORT, which is
 * to say one of ours. `applyDesktopChatAutomation` stamps `bypassPermissions` at import time and
 * it usually does not survive: the app re-saves that metadata when the chat first boots and
 * re-asserts its own import default. The stamp held 4 times in 30. Same mechanism as the title
 * clobber, and the same cause: while an app is running, its metadata files are its own.
 *
 * Run it after changing anything in the import path, and before believing the stamp works.
 *
 *   bun scripts/permission-mode-census.mjs           summary
 *   bun scripts/permission-mode-census.mjs --list    plus every chat that is not unattended
 *
 * Reads only. Never writes to a chat.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LIST = process.argv.includes('--list')
const ROOT = join(homedir(), '.claude-instances')

/** An IMPORTED chat is filed under the CLI id (`local_<cliSessionId>.json`, and sessionId matches);
 *  a chat CREATED IN THE APP carries the app's own id with the CLI id inside. That distinction is
 *  the whole census: it separates chats AgentHydra placed from chats the owner started. */
const isImported = (m) => m.sessionId === `local_${m.cliSessionId}`

function readChats() {
  const out = []
  if (!existsSync(ROOT)) return out
  for (const inst of readdirSync(ROOT, { withFileTypes: true })) {
    if (!inst.isDirectory()) continue
    const store = join(ROOT, inst.name, 'claude-code-sessions')
    if (!existsSync(store)) continue
    for (const org of readdirSync(store, { withFileTypes: true })) {
      if (!org.isDirectory()) continue
      for (const user of readdirSync(join(store, org.name), { withFileTypes: true })) {
        if (!user.isDirectory()) continue
        const dir = join(store, org.name, user.name)
        for (const f of readdirSync(dir)) {
          if (!f.startsWith('local_') || !f.endsWith('.json')) continue
          try {
            const m = JSON.parse(readFileSync(join(dir, f), 'utf8'))
            out.push({
              instance: inst.name,
              imported: isImported(m),
              mode: m.permissionMode ?? '(none)',
              cwd: m.cwd ?? m.originCwd ?? '',
              createdAt: m.createdAt ?? 0,
              archived: !!m.isArchived,
            })
          } catch {
            // One unreadable metadata file must not stop the census.
          }
        }
      }
    }
  }
  return out
}

const tally = (rows) => {
  const b = {}
  for (const r of rows) b[r.mode] = (b[r.mode] ?? 0) + 1
  return b
}
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : 'n/a')

const rows = readChats()
if (rows.length === 0) {
  console.log('No desktop chats found under ~/.claude-instances. Nothing to census.')
  process.exit(0)
}

const imported = rows.filter((r) => r.imported)
const appMade = rows.filter((r) => !r.imported)
const unattended = (rs) => rs.filter((r) => r.mode === 'bypassPermissions').length

console.log(`desktop chats: ${rows.length}\n`)
console.log(`  APP-CREATED  n=${String(appMade.length).padStart(5)}  unattended ${pct(unattended(appMade), appMade.length)}  ${JSON.stringify(tally(appMade))}`)
console.log(`  IMPORTED     n=${String(imported.length).padStart(5)}  unattended ${pct(unattended(imported), imported.length)}  ${JSON.stringify(tally(imported))}`)

const stuck = imported.filter((r) => r.mode !== 'bypassPermissions' && !r.archived)
console.log(
  `\nLIVE DEADLOCK CANDIDATES (imported, not unattended, not archived): ${stuck.length}`,
)
console.log('Each one runs until its first shell command and then waits on a prompt nobody can')
console.log('click. Revive those with file tools only, or re-stamp after the chat has booted.')

if (LIST) {
  const notable = rows
    .filter((r) => r.mode !== 'bypassPermissions')
    .sort((a, b) => b.createdAt - a.createdAt)
  console.log(`\nevery chat that is not unattended (${notable.length}):`)
  for (const r of notable) {
    const when = r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 16) : '?'
    const flags = `${r.imported ? 'imported' : 'app     '}${r.archived ? ' archived' : ''}`
    console.log(`  ${r.mode.padEnd(18)} ${r.instance.padEnd(14)} ${flags.padEnd(18)} ${when}  ${r.cwd.slice(0, 50)}`)
  }
}

// Exit code is informational only: this reports on the owner's machine, it does not gate a build.
process.exit(0)

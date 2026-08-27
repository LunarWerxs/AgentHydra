// tests/usage-probe.test.ts — where the `/usage` fallback probe is allowed to leave its mess.
//
// `claude -p "/usage"` opens a real session and writes a real transcript keyed by the directory it
// ran in. Inheriting the daemon's cwd filed every quota check into whatever project folder that
// mapped to: measured 2026-07-18, 279 three-kilobyte stubs (a caveat, a `<command-name>/usage`
// line, nothing else) sitting among the user's actual sessions, 33 of them from the previous day
// alone. The probe now runs in a scratch directory of ours and sweeps up after itself.
//
// The invariant worth guarding is the SWEEP's blast radius. It deletes .jsonl files, so it must be
// impossible for it to aim at a folder holding real work.

import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLAUDE_PROJECTS_ROOT, DATA_DIR } from '../server/src/config'
import { scanMeta } from '../server/src/sessions'
import type { TranscriptFile } from '../server/src/transcript'
import { encodeCwdKey } from '../server/src/transcript'
import { usageProbeCwd } from '../server/src/usage'
import { desktopKey } from '../server/src/usage-service'

test('the probe runs inside our own data directory, never a project folder', () => {
  const dir = usageProbeCwd()
  expect(dir).not.toBeNull()
  expect(dir?.startsWith(DATA_DIR)).toBe(true)
  // Belt and braces: our scratch dir must not live inside the transcript store itself, or the
  // sweep's folder and a real project folder could coincide.
  expect(dir?.startsWith(CLAUDE_PROJECTS_ROOT)).toBe(false)
})

test('the swept folder is exactly the one our scratch dir encodes to', () => {
  const dir = usageProbeCwd() as string
  const swept = join(CLAUDE_PROJECTS_ROOT, encodeCwdKey(dir))
  // This is the whole safety story: the target is derived from a path we created, so it cannot
  // name a folder belonging to real sessions. A changed encoding just misses and deletes nothing.
  expect(swept.startsWith(CLAUDE_PROJECTS_ROOT)).toBe(true)
  expect(swept).not.toBe(CLAUDE_PROJECTS_ROOT)
  expect(encodeCwdKey(dir)).toContain('usage-probe')
})

test('the probe directory is stable across calls', () => {
  // Cached, because the sweep after every probe would otherwise re-stat it each time.
  expect(usageProbeCwd()).toBe(usageProbeCwd())
})

// --- one instance, one cache key ---------------------------------------------
//
// The same directory reaches desktopKey() spelled several ways depending on the call site. Keyed
// raw, each spelling opened its own cache row: the live usage-cache.json held THREE rows for
// 3claude (`C:\Users\…`, `c:\users\…`, `C:/Users/…`) and two for 5claude, so a reading taken under
// one spelling was invisible to a lookup using another and the check re-ran against a warm cache.

// Built rather than written out, so the literal backslashes never have to survive escaping.
const BACKSLASH = String.fromCharCode(92)
const winPath = (...parts: string[]) => parts.join(BACKSLASH)
const INSTANCE_3 = winPath('C:', 'Users', 'blogi', '.claude-instances', '3claude')
const INSTANCE_4 = winPath('C:', 'Users', 'blogi', '.claude-instances', '4claude')

// win32-gated, because the bug itself is a win32 one: drive letters, backslash separators and a
// case-insensitive filesystem are what let a single folder be spelled several ways. Elsewhere
// `path.resolve` reads `C:\Users\...` as one long filename and a backslash spelling genuinely is a
// different path from a forward-slash one, so collapsing them would be wrong rather than desirable.
const win = process.platform === 'win32'

test.skipIf(!win)('every spelling of one instance directory maps to a single cache key', () => {
  const keys = [
    INSTANCE_3,
    INSTANCE_3.toLowerCase(),
    INSTANCE_3.split(BACKSLASH).join('/'),
    INSTANCE_3 + BACKSLASH, // trailing separator
  ].map(desktopKey)
  expect(new Set(keys).size).toBe(1)
})

// The rest hold on every platform: they are about the key's shape, not path semantics.

test('different instances still get different keys', () => {
  // The normalization must not be so aggressive that it collides two real instances.
  expect(desktopKey(INSTANCE_3)).not.toBe(desktopKey(INSTANCE_4))
})

test('the key keeps its desktop: prefix so it cannot collide with cli:/acct: keys', () => {
  expect(desktopKey(INSTANCE_3).startsWith('desktop:')).toBe(true)
})

// --- the sweep races the scanner, and the scanner must survive losing -----------
//
// pruneUsageProbeTranscripts() deletes .jsonl files out of a project folder that the session
// scanner also enumerates, so this daemon routinely removes files it is itself part-way through
// reading. There is no lock to take and no ordering to arrange: the probe runs on its own timer.
//
// That read used to throw, and the throw escaped into the sessions list. Observed in the live
// daemon log on 2026-08-27:
//
//   ERROR Error: ENOENT: no such file or directory, open
//   '.../.claude/projects/C--Users-blogi--agenthydra-data-usage-probe/cc54bf76-....jsonl'
//       at async parseMeta / at async <anonymous> / at async <anonymous>
//
// The two anonymous frames are toSummary and mapPooled's worker, so the whole /api/sessions request
// died and every row already parsed for it died too: one probe file collected at the wrong instant
// could blank the session list. The warm-up path had always caught this; the list path had not.
//
// A vanished transcript is simply not a session now, so it is omitted rather than fatal.
test('a transcript deleted mid-scan yields no row instead of throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-swept-'))
  const path = join(dir, 'cc54bf76-78c4-4524-883b-37aa23b866d7.jsonl')
  writeFileSync(path, '{"type":"user","message":{"role":"user","content":"hi"}}\n')
  const stat = statSync(path)
  const tf: TranscriptFile = {
    session_id: 'cc54bf76-78c4-4524-883b-37aa23b866d7',
    source: 'claude',
    path,
    project: 'usage-probe',
    mtime_ms: stat.mtimeMs,
    size_bytes: stat.size,
    archived: false,
  }

  // Control first, so a null below cannot be explained by the row being unreadable all along.
  expect(await scanMeta(tf)).not.toBeNull()

  // Now the sweep gets it, exactly as pruneUsageProbeTranscripts() does.
  rmSync(path)

  // Both cache layers key on mtime AND size, so a changed pair is a genuine re-parse rather than a
  // hit on the control above. That is also the production shape: the file is enumerated, and only
  // then deleted, so the scanner is always working from a row it read a moment earlier.
  const rescan = await scanMeta({ ...tf, mtime_ms: stat.mtimeMs + 1, size_bytes: stat.size + 1 })
  expect(rescan).toBeNull()

  rmSync(dir, { recursive: true, force: true })
})

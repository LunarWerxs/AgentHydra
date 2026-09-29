// server/tests/transcript-stat-cache.test.ts - a sweep re-stats only the transcripts that can have moved.
//
// Measured 2026-09-29: every index sweep stat'ed all 4,910 transcripts on the owner's machine, ~10 CPU-s
// across the fs thread pool, and the 10 s TTL let each web-UI sessions poll start another. The sweep now
// trusts a transcript quiet for over an hour between full re-stats (one a minute). What must still hold,
// and is pinned here: a NEW transcript and a RECENTLY ACTIVE one's growth show on the very next sweep, a
// deleted one disappears, and a quiet one's growth shows once the full re-stat comes round.
//
// In a child Bun with its own HOME, like sessions-scan-cache.test.ts, because config.ts resolves the
// stores from homedir() at import time and `bun test` shares one process across files.
import { expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = join(tmpdir(), `ccmui-statcache-${crypto.randomUUID()}`)
const projectDir = join(home, '.claude', 'projects', 'D--demo')
mkdirSync(projectDir, { recursive: true })
mkdirSync(join(home, '.codex', 'sessions'), { recursive: true })
mkdirSync(join(home, '.codex', 'archived_sessions'), { recursive: true })

const env = {
  ...process.env,
  USERPROFILE: home,
  HOME: home,
  AGENTHYDRA_HOME: join(home, '.agenthydra'),
  AGENTHYDRA_DB: join(home, 'test.db'),
  AGENTHYDRA_RUN_LOG_DIR: join(home, 'run-logs'),
}
const TRANSCRIPT = JSON.stringify(join(import.meta.dir, '..', 'src', 'transcript.ts'))

test('new and active transcripts show at once, a deleted one goes, a quiet one waits for the full re-stat', () => {
  const body = `
      const { appendFileSync, rmSync, utimesSync, writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const t = await import(${TRANSCRIPT});
      const dir = ${JSON.stringify(projectDir)};
      const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, cwd: 'D:\\\\demo', timestamp: '2026-09-29T00:00:00Z' }) + '\\n';
      const quiet = join(dir, 'quiet-1.jsonl'), active = join(dir, 'active-1.jsonl'), doomed = join(dir, 'doomed-1.jsonl');
      for (const p of [quiet, active, doomed]) writeFileSync(p, line);
      const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
      utimesSync(quiet, twoHoursAgo, twoHoursAgo);
      const size = (files, id) => files.find((f) => f.session_id === id)?.size_bytes ?? null;
      await t.ensureTranscriptIndex(true);
      appendFileSync(quiet, line); utimesSync(quiet, twoHoursAgo, twoHoursAgo);
      appendFileSync(active, line);
      rmSync(doomed);
      writeFileSync(join(dir, 'fresh-1.jsonl'), line);
      const next = await t.ensureTranscriptIndex(true);
      t.resetClaudeStatCache();
      const full = await t.ensureTranscriptIndex(true);
      console.log(JSON.stringify({
        one: line.length,
        activeNext: size(next, 'active-1'), quietNext: size(next, 'quiet-1'), quietFull: size(full, 'quiet-1'),
        doomedNext: size(next, 'doomed-1'), freshNext: size(next, 'fresh-1'),
      }));`
  const proc = Bun.spawnSync([process.execPath, '-e', body], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = proc.stdout.toString().trim()
  if (!proc.success || !out) throw new Error(`child failed: ${proc.stderr.toString() || out}`)
  const r = JSON.parse(out.slice(out.lastIndexOf('\n') + 1))
  expect(r.activeNext).toBe(2 * r.one) // growth of a recently written transcript: the next sweep
  expect(r.freshNext).toBe(r.one) // a new transcript: the next sweep
  expect(r.doomedNext).toBeNull() // a deleted one: gone at once
  expect(r.quietNext).toBe(r.one) // quiet for two hours: trusted until the full re-stat...
  expect(r.quietFull).toBe(2 * r.one) // ...which then sees it grow
}, 30_000)

// Records ONE real, short Agent SDK turn as JSONL for the normalize tests.
// Run: bun server/scripts/record-fixture.ts [out.jsonl]   (default server/test/fixtures/basic-turn.jsonl)
// Uses the machine's default Claude login and a Haiku model; costs a few cents.
// Home paths are rewritten to C:/Users/test so the fixture carries nothing of this machine.

import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const out = resolve(process.argv[2] ?? join(import.meta.dir, '..', 'test', 'fixtures', 'basic-turn.jsonl'))
const cwd = mkdtempSync(join(tmpdir(), 'desk-fixture-'))
writeFileSync(join(cwd, 'notes.txt'), 'The meeting moved to Thursday at 10am.\n')
writeFileSync(join(cwd, 'todo.md'), '# Todo\n\n- buy milk\n- call the plumber\n')

/** Every spelling of the home folder a JSON line can hold, longest first. */
function homeVariants(): string[] {
  const home = homedir()
  const fwd = home.replace(/\\/g, '/')
  const back = fwd.replace(/\//g, '\\')
  const variants = [JSON.stringify(back).slice(1, -1), back, fwd]
  // Claude Code's project folder name for a path (C--Users-name-...).
  variants.push(fwd.replace(/[:/]/g, '-'))
  return [...new Set(variants)].sort((a, b) => b.length - a.length)
}

function scrub(line: string): string {
  let s = line
  for (const v of homeVariants()) {
    const to = v.includes('-') && !v.includes('/') && !v.includes('\\') ? 'C--Users-test' : v.includes('\\\\') ? 'C:\\\\Users\\\\test' : v.includes('\\') ? 'C:\\Users\\test' : 'C:/Users/test'
    s = s.split(v).join(to)
  }
  // Streamed input_json_delta chunks can split a path mid-way, so the user name goes on its own too.
  const user = basename(homedir())
  if (user.length >= 3) s = s.replace(new RegExp(`\\b${user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), 'test')
  return s
}

const lines: string[] = []
try {
  const q = query({
    prompt: 'List the files in this folder, read notes.txt, then answer in one sentence: when is the meeting?',
    options: {
      cwd,
      model: 'claude-haiku-4-5-20251001',
      includePartialMessages: true,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      // No user/project settings: keeps this machine's hooks, CLAUDE.md and MCP servers out of the fixture.
      settingSources: [],
      maxTurns: 6,
    },
  })
  for await (const msg of q as AsyncIterable<SDKMessage>) {
    lines.push(scrub(JSON.stringify(msg)))
  }
} finally {
  rmSync(cwd, { recursive: true, force: true })
}

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, lines.join('\n') + '\n')
const types = lines.map((l) => {
  const m = JSON.parse(l) as { type: string; subtype?: string; event?: { type: string } }
  return m.type === 'stream_event' ? `stream_event/${m.event?.type}` : m.subtype ? `${m.type}/${m.subtype}` : m.type
})
const counts = new Map<string, number>()
for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1)
console.log(`wrote ${lines.length} messages to ${scrub(out)}`)
for (const [t, n] of counts) console.log(`  ${t}: ${n}`)

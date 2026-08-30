// server/tests/chat-gate.test.ts - Piece 8 pinned: every state and lane of the gate, from
// fixture transcripts. running (registry-live), each crashed kind (mid-turn on an unanswered
// user message, mid-turn on closing tool traffic, usage-limit, overload, error, empty tail),
// each finished lane (archive-candidate via recap-yes, needs-input via question and via
// done-no, human via interruption), the orphan-evidence note, done-claim parsing, and the
// no-transcript null.
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ChatGateDeps, chatGate, parseDoneClaim } from '../src/chat-gate'
import type { LiveSession } from '../src/live-registry'

const line = (o: unknown) => `${JSON.stringify(o)}\n`
const user = (text: string) => ({ type: 'user', message: { role: 'user', content: text } })
const assistant = (text: string) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
})
const toolAssistant = () => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
})
const apiError = (text: string) => ({
  type: 'assistant',
  isApiErrorMessage: true,
  message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] },
})

/** A claude home holding one transcript for `sid`; returns deps wired to it. */
function home(sid: string, transcript: string, over: Partial<ChatGateDeps> = {}): ChatGateDeps {
  const root = mkdtempSync(join(tmpdir(), 'gate-'))
  const proj = join(root, 'projects', 'D--Work')
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(proj, `${sid}.jsonl`), transcript)
  return { claudeHome: root, registry: () => [], orphans: () => [], ...over }
}

const RECAP_DONE = [
  'All shipped and verified.',
  '## What I did',
  '- Everything.',
  '## Am I 100% done?',
  '- Yes.',
  '## Do I recommend anything else?',
  '- Nothing.',
].join('\n')

test('running: a live registry entry wins, with quiet reported and no verdict beyond it', () => {
  const sid = 'sess-running'
  const deps = home(sid, line(user('go')) + line(assistant('working on it')))
  deps.registry = () => [
    {
      pid: 4242,
      sessionId: sid,
      cwd: 'D:\\Work',
      name: 'peer-a',
      startedAt: 1,
      transcriptPath: join(String(deps.claudeHome), 'projects', 'D--Work', `${sid}.jsonl`),
    } satisfies LiveSession,
  ]
  const g = chatGate(sid, deps)
  expect(g?.state).toBe('running')
  expect(g?.live?.pid).toBe(4242)
  expect(g?.crashed).toBe(null)
  expect(g?.finished).toBe(null)
})

test('crashed mid-turn: an unanswered user message', () => {
  const g = chatGate(
    's1',
    home('s1', line(assistant('done with step 1')) + line(user('now do step 2'))),
  )
  expect(g?.state).toBe('crashed')
  expect(g?.crashed?.kind).toBe('mid-turn')
})

test('crashed mid-turn: the transcript ends on tool traffic with no closing text', () => {
  const g = chatGate('s2', home('s2', line(user('go')) + line(toolAssistant())))
  expect(g?.state).toBe('crashed')
  expect(g?.crashed?.kind).toBe('mid-turn')
})

test('crashed kinds: usage-limit, overload, refused, error - the existing vocabulary', () => {
  expect(
    chatGate('s3', home('s3', line(apiError("You've hit your weekly limit · resets 3am"))))?.crashed
      ?.kind,
  ).toBe('usage-limit')
  expect(
    chatGate('s4', home('s4', line(apiError('API Error: 529 overloaded'))))?.crashed?.kind,
  ).toBe('overload')
  expect(
    chatGate('s5', home('s5', line(apiError("Claude's safeguards flagged this message."))))?.crashed
      ?.kind,
  ).toBe('refused')
  expect(
    chatGate('s6', home('s6', line(apiError('API Error: something broke'))))?.crashed?.kind,
  ).toBe('error')
})

test('crashed: an empty/unspeaking tail never invents a finish', () => {
  const g = chatGate('s7', home('s7', 'not json\n{"type":"tool_result"}\n'))
  expect(g?.state).toBe('crashed')
  expect(g?.crashed?.kind).toBe('mid-turn')
})

test('orphaned dead-pid registry residue is cited as crash evidence', () => {
  const sid = 's8'
  const deps = home(sid, line(user('go')))
  deps.orphans = () => [
    {
      pid: 1,
      sessionId: sid,
      cwd: 'D:\\Work',
      name: 'x',
      startedAt: 1,
      transcriptPath: null,
      registryPath: 'x.json',
    },
  ]
  const g = chatGate(sid, deps)
  expect(g?.state).toBe('crashed')
  expect(g?.cause).toContain('died un-gracefully')
})

test('finished / archive-candidate: recap says done and nothing is asked', () => {
  const g = chatGate('s9', home('s9', line(user('go')) + line(assistant(RECAP_DONE))))
  expect(g?.state).toBe('finished')
  expect(g?.finished?.lane).toBe('archive-candidate')
  expect(g?.finished?.recapPresent).toBe(true)
  expect(g?.finished?.doneClaim).toBe('yes')
  expect(g?.finished?.endsWithQuestion).toBe(false)
})

test('finished / needs-input-review: a trailing question, even with a done recap', () => {
  const g = chatGate(
    's10',
    home(
      's10',
      line(user('go')) + line(assistant(`${RECAP_DONE}\nShould I also update the docs?`)),
    ),
  )
  expect(g?.finished?.lane).toBe('needs-input-review')
  expect(g?.finished?.endsWithQuestion).toBe(true)
})

test('finished / needs-input-review: recap does not claim done', () => {
  const notDone = RECAP_DONE.replace('- Yes.', '- No, blocked on credentials.')
  const g = chatGate('s11', home('s11', line(user('go')) + line(assistant(notDone))))
  expect(g?.finished?.lane).toBe('needs-input-review')
  expect(g?.finished?.doneClaim).toBe('no')
})

test('finished / needs-input-review: no recap at all is not a proven done', () => {
  const g = chatGate('s12', home('s12', line(user('go')) + line(assistant('All wrapped up.'))))
  expect(g?.finished?.lane).toBe('needs-input-review')
  expect(g?.finished?.doneClaim).toBe('unknown')
})

test('finished / human: a deliberate interruption is theirs to pick back up', () => {
  const g = chatGate(
    's13',
    home('s13', line(assistant('working...')) + line(user('[Request interrupted by user]'))),
  )
  expect(g?.state).toBe('finished')
  expect(g?.finished?.lane).toBe('human')
  expect(g?.finished?.interrupted).toBe(true)
})

test('the evidence carries the last assistant text, bounded', () => {
  const long = `start ${'x'.repeat(3000)} ## Am I 100% done?\n- Yes.`
  const g = chatGate('s14', home('s14', line(user('go')) + line(assistant(long))))
  expect((g?.finished?.lastAssistantText.length ?? 0) <= 2000).toBe(true)
})

test('no transcript anywhere -> null: what cannot be gated cannot be acted on', () => {
  const deps = home('other-session', line(user('hi')))
  expect(chatGate('missing-session', deps)).toBe(null)
})

test('a giant closing record still classifies - the window grows instead of faking a crash', () => {
  // A >64KB final assistant record with a done recap: the first cut read one fixed window,
  // parsed zero records, and called it crashed mid-turn (review-confirmed).
  const filler = line(user('go')).repeat(200)
  const big = `${'x'.repeat(80 * 1024)}\n\n${RECAP_DONE}`
  const g = chatGate('s15', home('s15', filler + line(assistant(big))))
  expect(g?.state).toBe('finished')
  expect(g?.finished?.lane).toBe('archive-candidate')
})

test('prefacing text does not make a dangling tool call a finish', () => {
  const dangling = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me check that for you.' },
        { type: 'tool_use', name: 'Bash', input: {} },
      ],
    },
  }
  const g = chatGate('s16', home('s16', line(user('go')) + line(dangling)))
  expect(g?.state).toBe('crashed')
  expect(g?.crashed?.kind).toBe('mid-turn')
  expect(g?.cause).toContain('tool call whose result never landed')
})

test('a recap QUOTED in a code block or blockquote cannot fake done:yes', () => {
  const quoting = [
    'Here is what a recap looks like:',
    '```',
    '## Am I 100% done?',
    '- Yes.',
    '```',
    'Anyway, still deciding how to proceed.',
  ].join('\n')
  const g = chatGate('s17', home('s17', line(user('go')) + line(assistant(quoting))))
  expect(g?.finished?.lane).toBe('needs-input-review')
  expect(g?.finished?.doneClaim).toBe('unknown')
  const quoted = ['> ## Am I 100% done?', '> - Yes.', 'Thoughts?'].join('\n')
  const g2 = chatGate('s18', home('s18', line(user('go')) + line(assistant(quoted))))
  expect(g2?.finished?.doneClaim).toBe('unknown')
})

test('a sidechain record appended after the real last turn does not hijack the verdict', () => {
  const sidechain = {
    type: 'user',
    isSidechain: true,
    message: { role: 'user', content: 'compaction side-branch chatter' },
  }
  const g = chatGate(
    's19',
    home('s19', line(user('go')) + line(assistant(RECAP_DONE)) + line(sidechain)),
  )
  expect(g?.state).toBe('finished')
  expect(g?.finished?.lane).toBe('archive-candidate')
})

test('parseDoneClaim reads the section, not the whole message', () => {
  expect(parseDoneClaim('## Am I 100% done?\n- Yes.\n## Next\n- No idea.')).toBe('yes')
  expect(parseDoneClaim('## Am I 100% done?\n- Done except the CI verdict.')).toBe('no')
  expect(parseDoneClaim('## Am I 100% done?\n- Blocked on your call.')).toBe('no')
  expect(parseDoneClaim('nothing here')).toBe('unknown')
})

// --- STALL DETECTION: a chat that is alive and stuck looks exactly like one that is alive and
// busy, so the tell is narrow on purpose (newest record = an unanswered SHELL tool call, quiet
// past the threshold). The verdict is ADVISORY: state stays 'running' and nothing acts on it.

const liveDeps = (sid: string, transcript: string, quietMin: number): ChatGateDeps => {
  const deps = home(sid, transcript)
  const path = join(String(deps.claudeHome), 'projects', 'D--Work', `${sid}.jsonl`)
  deps.registry = () => [
    {
      pid: 999,
      sessionId: sid,
      cwd: 'D:Work',
      name: 'peer-a',
      startedAt: 1,
      transcriptPath: path,
    } satisfies LiveSession,
  ]
  deps.nowMs = statSync(path).mtimeMs + quietMin * 60_000
  return deps
}
const shellCall = (name: string) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', name, input: {} }] },
})
const toolResult = () => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
})

test('stalled: alive, quiet for hours, newest record is an unanswered shell call', () => {
  const g = chatGate('st1', liveDeps('st1', line(user('go')) + line(shellCall('Bash')), 45))
  expect(g?.state).toBe('running')
  expect(g?.stalled?.tool).toBe('Bash')
  expect(g?.cause).toContain('STUCK')
  // It must never assert more than it knows: a long command looks the same from outside.
  expect(g?.stalled?.why).toContain('Read the chat before acting')
})

test('NOT stalled: the tool result landed, so the chat is simply working', () => {
  const g = chatGate(
    'st2',
    liveDeps(
      'st2',
      line(shellCall('Bash')) + line(toolResult()) + line(assistant('carrying on')),
      45,
    ),
  )
  expect(g?.state).toBe('running')
  expect(g?.stalled ?? null).toBe(null)
})

test('NOT stalled: a slow file edit is not a stall - edits auto-approve, so flagging them cries wolf', () => {
  const g = chatGate('st3', liveDeps('st3', line(user('go')) + line(shellCall('Write')), 45))
  expect(g?.stalled ?? null).toBe(null)
})

test('NOT stalled below the quiet threshold: a command that has run for two minutes is a command', () => {
  const g = chatGate('st4', liveDeps('st4', line(user('go')) + line(shellCall('Bash')), 2))
  expect(g?.stalled ?? null).toBe(null)
  expect(g?.cause).toContain('background work')
})

test('a DORMANT chat is never called stalled - the tell needs a live process behind it', () => {
  const g = chatGate('st5', home('st5', line(user('go')) + line(shellCall('Bash'))))
  expect(g?.state).toBe('crashed')
  expect(g?.stalled ?? null).toBe(null)
})

test('a twenty-minute command is still a command - the threshold is half an hour on purpose', () => {
  const g = chatGate('st6', liveDeps('st6', line(user('go')) + line(shellCall('Bash')), 20))
  expect(g?.stalled ?? null).toBe(null)
})

// server/tests/session-continuations.test.ts — one conversation, one row.
//
// Claude Code does not keep writing to a session it has compacted: it opens a new file with a new
// session id and carries on. The user saw the consequence three times over — three rows titled
// "rQubit T10-M06 v1 piece hash parity", 823 / 1071 / 3179 messages, sharing 881 message uuids, all
// the same chat. What is pinned here is the collapse itself, and specifically the ways it could go
// wrong QUIETLY: hiding a row whose successor is not there, looping forever on a cycle, or leaving
// two rows because it only walked one hop of a chain that was two.

import { describe, expect, test } from 'bun:test'
import { collapseContinuations } from '../src/sessions'
import type { TranscriptFile } from '../src/transcript'

const file = (id: string, extra: Partial<TranscriptFile> = {}): TranscriptFile => ({
  session_id: id,
  source: 'claude',
  path: `C:/store/${id}.jsonl`,
  project: 'D--NEWProjects',
  mtime_ms: 1_000,
  size_bytes: 10,
  archived: false,
  ...extra,
})

const ids = (r: { rows: TranscriptFile[] }) => r.rows.map((f) => f.session_id).sort()

describe('collapseContinuations', () => {
  test('a chain two compactions long collapses to the newest, not to two rows', () => {
    // The real shape from the report: the original was continued, and the continuation was itself
    // continued. Walking a single hop would hide the original and still leave two rows on screen.
    const rows = collapseContinuations([
      file('original', { supersededBy: 'second' }),
      file('second', { supersededBy: 'third' }),
      file('third'),
    ])
    expect(ids(rows)).toEqual(['third'])
  })

  test('the survivor is where the conversation actually is', () => {
    // Not the original. Clicking the row has to open what you were last doing, and after a
    // compaction that lives in the newest transcript; the original stops at the compaction point.
    const rows = collapseContinuations([file('old', { supersededBy: 'new' }), file('new')])
    expect(rows.rows[0]?.session_id).toBe('new')
  })

  test('a transcript whose successor is not in the index is kept', () => {
    // Deleted, pruned, or simply not swept yet. This row is the only surviving evidence that the
    // conversation happened, so hiding it would lose the chat entirely rather than tidy it.
    const rows = collapseContinuations([file('orphan', { supersededBy: 'gone' })])
    expect(ids(rows)).toEqual(['orphan'])
  })

  test('a cycle keeps its rows instead of hanging or deleting the conversation', () => {
    // Nothing should be able to write one, but a chain that eats its own tail has no newest member,
    // and the two failure modes available here are an infinite walk and an empty list.
    const rows = collapseContinuations([
      file('a', { supersededBy: 'b' }),
      file('b', { supersededBy: 'a' }),
    ])
    expect(ids(rows)).toEqual(['a', 'b'])
  })

  test('an index with no continuations at all is returned untouched', () => {
    // The common case by a wide margin: about 8% of conversations are continuations, so the
    // remaining 92% must not pay for a map of the whole store.
    const input = [file('one'), file('two')]
    expect(collapseContinuations(input).rows).toBe(input)
  })

  test('a superseding id belonging to another store cannot hide a session', () => {
    // The link is resolved within Claude's own store, so a same-named id from a different source is
    // not the successor and must not swallow the row.
    const rows = collapseContinuations([
      file('shared', { supersededBy: 'elsewhere' }),
      file('elsewhere', { source: 'codex' }),
    ])
    expect(ids(rows)).toEqual(['elsewhere', 'shared'])
  })

  test('two branches from the same parent each resolve to their own end', () => {
    // A compaction point can be continued more than once. Each branch is its own live conversation,
    // so both ends survive; what must not survive is the parent they both replaced.
    const rows = collapseContinuations([
      file('parent', { supersededBy: 'branchA' }),
      file('branchA'),
      file('branchB', { supersededBy: 'branchA' }),
    ])
    expect(ids(rows)).toEqual(['branchA'])
  })
})

// The absorbed ids are not bookkeeping. Everything else about a session is keyed on its session id
// — which instance owns it, whether a queue run dispatched it, whether it is archived — and a
// compaction moves the conversation to an id none of those tables has ever seen. A queue row keeps
// the id it dispatched and never updates it, so a run that compacts mid-flight is known to the queue
// only by its predecessor while the list shows only its successor. Without this the "queued" filter
// answers with nothing for a job that is running right now.
describe('collapseContinuations reports what each surviving row speaks for', () => {
  test('the survivor inherits the ids of everything it absorbed', () => {
    const { absorbed } = collapseContinuations([
      file('original', { supersededBy: 'second' }),
      file('second', { supersededBy: 'third' }),
      file('third'),
    ])
    expect(absorbed.get('third')?.sort()).toEqual(['original', 'second'])
  })

  test('credit goes to the END of the chain, never to a hidden middle', () => {
    // 'second' is itself collapsed away, so crediting it would hand the ids to a row that is not on
    // screen and the lookup would come back empty anyway.
    const { absorbed } = collapseContinuations([
      file('original', { supersededBy: 'second' }),
      file('second', { supersededBy: 'third' }),
      file('third'),
    ])
    expect(absorbed.has('second')).toBe(false)
  })

  test('a kept row claims nothing it did not absorb', () => {
    const { absorbed } = collapseContinuations([file('lonely', { supersededBy: 'gone' })])
    expect(absorbed.size).toBe(0)
  })
})

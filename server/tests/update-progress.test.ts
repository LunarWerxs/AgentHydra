// server/src/update-progress.ts — what a running self-update reports about itself.
//
// This exists because a user described the update as "just sat there spinning for a very long
// time". The spinner was never stuck; the apply request simply covers minutes of real work and said
// nothing until it finished, so a healthy slow update and a hung one were indistinguishable. The
// properties worth pinning are therefore the ones that keep the report HONEST rather than merely
// present: a terminal state is always reached (a failed apply must not leave the UI mid-download
// forever), byte counters never survive into a phase they do not describe, and the sequence number
// always advances so a poller can tell "still going" from "stalled".
import { beforeEach, expect, test } from 'bun:test'
import {
  beginUpdateProgress,
  finishUpdateProgress,
  resetUpdateProgress,
  setUpdateBytes,
  setUpdatePhase,
  updateProgress,
} from '../src/update-progress'

beforeEach(resetUpdateProgress)

test('starts idle, with nothing to report', () => {
  const p = updateProgress()
  expect(p.phase).toBe('idle')
  expect(p.startedAt).toBeNull()
  expect(p.message).toBe('')
})

test('beginning an apply stamps a start time and leaves idle behind', () => {
  beginUpdateProgress('Checking for the latest release…', 1000)
  const p = updateProgress()
  expect(p.phase).toBe('preparing')
  expect(p.startedAt).toBe(1000)
  expect(p.message).toBe('Checking for the latest release…')
})

test('byte counters do not leak into a phase that is not a download', () => {
  // "62 MB of 96 MB" pinned under a message about extracting is worse than no number at all.
  beginUpdateProgress('start')
  setUpdatePhase('downloading', 'Downloading…')
  setUpdateBytes(50, 100)
  expect(updateProgress().receivedBytes).toBe(50)

  setUpdatePhase('extracting', 'Extracting…')
  expect(updateProgress().receivedBytes).toBeNull()
  expect(updateProgress().totalBytes).toBeNull()
})

test('a download with no content-length reports bytes without inventing a total', () => {
  beginUpdateProgress('start')
  setUpdatePhase('downloading', 'Downloading…')
  setUpdateBytes(1234, null)
  const p = updateProgress()
  expect(p.receivedBytes).toBe(1234)
  expect(p.totalBytes).toBeNull()
})

test('a fresh apply never inherits the previous run’s byte counters', () => {
  beginUpdateProgress('first')
  setUpdatePhase('downloading', 'Downloading…')
  setUpdateBytes(90, 100)
  finishUpdateProgress(true, 'done')

  beginUpdateProgress('second')
  const p = updateProgress()
  expect(p.receivedBytes).toBeNull()
  expect(p.totalBytes).toBeNull()
})

test('failure reaches a terminal phase and clears the counters', () => {
  // The whole point: an apply that dies mid-download must not leave the UI on "Downloading… 40%".
  beginUpdateProgress('start')
  setUpdatePhase('downloading', 'Downloading…')
  setUpdateBytes(40, 100)
  finishUpdateProgress(false, 'download failed (HTTP 500)')
  const p = updateProgress()
  expect(p.phase).toBe('failed')
  expect(p.message).toBe('download failed (HTTP 500)')
  expect(p.receivedBytes).toBeNull()
})

test('the terminal state is KEPT, so the last poll can still read the outcome', () => {
  beginUpdateProgress('start')
  finishUpdateProgress(true, 'Updated to v1.2.3. Restarting…')
  expect(updateProgress().phase).toBe('done')
  // Reading it does not consume it.
  expect(updateProgress().phase).toBe('done')
})

test('every mutation advances seq, so a poller can distinguish progress from a stall', () => {
  const seqs = [updateProgress().seq]
  beginUpdateProgress('a')
  seqs.push(updateProgress().seq)
  setUpdatePhase('downloading', 'b')
  seqs.push(updateProgress().seq)
  setUpdateBytes(1, 2)
  seqs.push(updateProgress().seq)
  finishUpdateProgress(true, 'c')
  seqs.push(updateProgress().seq)
  for (let i = 1; i < seqs.length; i++) {
    expect(seqs[i]).toBeGreaterThan(seqs[i - 1] as number)
  }
})

test('the returned record is a copy — a caller cannot mutate the module’s state', () => {
  beginUpdateProgress('start')
  const p = updateProgress()
  p.phase = 'done'
  p.message = 'tampered'
  expect(updateProgress().phase).toBe('preparing')
  expect(updateProgress().message).toBe('start')
})

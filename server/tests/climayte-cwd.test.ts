// server/tests/climayte-cwd.test.ts — a send with a new `cwd` (climayte_send): the next launch
// carries the worker's session into that folder's project dir and resumes it there.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  climayteCancel,
  climayteRun,
  climayteSend,
  setCliMayteAccountsProvider,
} from '../src/climayte'
import { workers } from '../src/climayte-core'
import { applyPendingCwd } from '../src/climayte-launch'
import type { CliMayteAccount } from '../src/climayte-lib'
import { encodeCwdKey } from '../src/transcript'

const scratch = mkdtempSync(join(tmpdir(), 'climayte-cwd-'))
const OLD = join(scratch, 'old')
const NEW = join(scratch, 'new')
const CONFIG = join(scratch, 'config')

beforeAll(() => {
  for (const d of [OLD, NEW, CONFIG]) mkdirSync(d, { recursive: true })
  setCliMayteAccountsProvider(() => [])
})
afterAll(() => {
  climayteCancel({ group: 'cwd-test' })
  setCliMayteAccountsProvider(null)
  rmSync(scratch, { recursive: true, force: true })
})

describe('a worker moved to another folder', () => {
  test('the next launch resumes the same session in the new folder, the original kept; a bad cwd is refused', () => {
    const reply = climayteRun({ group: 'cwd-test', tasks: [{ prompt: 'work', cwd: OLD }] })
    const id = reply.workers[0]?.id ?? ''
    const w = workers.get(id)
    if (!w) throw new Error('no worker made')
    w.sessionId = 'sess-1'
    const oldDir = join(CONFIG, 'projects', encodeCwdKey(OLD))
    mkdirSync(join(oldDir, 'sess-1'), { recursive: true })
    writeFileSync(join(oldDir, 'sess-1.jsonl'), '{"a":1}\n')
    writeFileSync(join(oldDir, 'sess-1', 'tool.txt'), 'side')

    // Refused: relative, missing, a file, a network path, a device path. Nothing queued.
    const aFile = join(oldDir, 'sess-1.jsonl')
    for (const bad of ['rel/dir', join(scratch, 'nope'), aFile, '\\\\host\\share', '\\\\?\\C:\\']) {
      expect(climayteSend(id, 'go', { cwd: bad }).ok).toBe(false)
    }
    expect(w.pendingCwd).toBeUndefined()
    expect(w.pending).toEqual([])

    expect(climayteSend(id, 'go on', { cwd: NEW }).ok).toBe(true)
    expect(w.pendingCwd).toBe(NEW)
    expect(w.cwd).toBe(OLD) // not until the launch

    const acct = { id: 'a1', configDir: CONFIG } as CliMayteAccount
    applyPendingCwd(w, acct, 'sess-1', false)
    const newDir = join(CONFIG, 'projects', encodeCwdKey(NEW))
    expect(w.cwd).toBe(NEW)
    expect(w.pendingCwd).toBeUndefined()
    expect(w.sessionId).toBe('sess-1')
    expect(existsSync(join(newDir, 'sess-1.jsonl'))).toBe(true)
    expect(existsSync(join(newDir, 'sess-1', 'tool.txt'))).toBe(true)
    expect(existsSync(join(oldDir, 'sess-1.jsonl'))).toBe(true) // the original stays
    const gap =
      statSync(join(newDir, 'sess-1.jsonl')).mtimeMs -
      statSync(join(oldDir, 'sess-1.jsonl')).mtimeMs
    expect(Math.abs(gap)).toBeLessThan(2)
  })
})

import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatSummary } from '@shared/protocol'
import { ChatStore } from '../src/engine/store'
import { renameOver } from '../src/write-flushed'

const WINDOWS = process.platform === 'win32'
const LOCKED = ['EPERM', 'EACCES', 'EBUSY']

const temps: string[] = []
function scratch(): { target: string; tmp: string } {
  const dir = mkdtempSync(join(tmpdir(), 'desk-wf-'))
  temps.push(dir)
  const target = join(dir, 'chats.json')
  const tmp = join(dir, 'chats.json.1.tmp')
  writeFileSync(target, 'old')
  writeFileSync(tmp, 'new')
  return { target, tmp }
}
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A PowerShell process that opens `file` without delete sharing and holds it for `ms` once it is open. */
async function hold(file: string, ms: number): Promise<{ exited: Promise<number>; release: () => Promise<void> }> {
  const marker = `${file}.held`
  const proc = Bun.spawn(
    [
      'powershell',
      '-NoProfile',
      '-Command',
      "$f=[System.IO.File]::Open($env:HOLD_FILE,'Open','Read','Read'); [System.IO.File]::WriteAllText($env:HOLD_MARKER,'x'); Start-Sleep -Milliseconds ([int]$env:HOLD_MS); $f.Close()",
    ],
    { env: { ...process.env, HOLD_FILE: file, HOLD_MARKER: marker, HOLD_MS: String(ms) }, stdout: 'ignore', stderr: 'ignore' },
  )
  const deadline = Date.now() + 15_000
  while (!existsSync(marker)) {
    if (Date.now() > deadline) throw new Error('the holder never opened the file')
    await Bun.sleep(25)
  }
  return {
    exited: proc.exited,
    release: async () => {
      proc.kill()
      await proc.exited
    },
  }
}

function errorCode(fn: () => void): string {
  try {
    fn()
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? ''
  }
  return ''
}

function chat(id: string): ChatSummary {
  return {
    id,
    sessionId: 's-' + id,
    title: 'Chat ' + id,
    cwd: 'C:/Users/test/p',
    account: { id: 'default', label: 'Default', configDir: null },
    accountAuto: true,
    model: null,
    effort: null,
    permissionMode: 'bypassPermissions',
    delegateToCliMayte: true,
    status: 'closed',
    activity: '',
    turnStartedAt: null,
    lastError: null,
    limitResetsAt: null,
    unread: false,
    pinned: false,
    archived: false,
    group: null,
    forkedFrom: null,
    createdAt: 1,
    updatedAt: 2,
    costUsd: 0,
    contextPct: 0,
    pendingCount: 0,
    queuedCount: 0,
    climayteActive: 0,
  } as ChatSummary
}

describe('renameOver', () => {
  test('replaces the file when nothing holds it', () => {
    const { target, tmp } = scratch()
    renameOver(tmp, target)
    expect(readFileSync(target, 'utf8')).toBe('new')
    expect(existsSync(tmp)).toBe(false)
  })
})

describe.skipIf(!WINDOWS)('a rename over a file another program holds open', () => {
  test('renameSync throws while the lock holds (the repro)', async () => {
    const { target, tmp } = scratch()
    const holder = await hold(target, 10_000)
    try {
      const code = errorCode(() => renameSync(tmp, target))
      console.log(`repro: renameSync over the held file threw ${code}`)
      expect(LOCKED).toContain(code)
      expect(readFileSync(target, 'utf8')).toBe('old')
    } finally {
      await holder.release()
    }
  }, 20_000)

  test('renameOver waits out a holder that lets go within its window', async () => {
    const { target, tmp } = scratch()
    const holder = await hold(target, 800)
    try {
      renameOver(tmp, target)
      expect(readFileSync(target, 'utf8')).toBe('new')
    } finally {
      await holder.release()
    }
  }, 20_000)

  test('renameOver throws the lock error once the holder outlasts its window', async () => {
    const { target, tmp } = scratch()
    const holder = await hold(target, 30_000)
    try {
      const started = Date.now()
      const code = errorCode(() => renameOver(tmp, target))
      expect(LOCKED).toContain(code)
      expect(Date.now() - started).toBeGreaterThanOrEqual(1900)
      expect(readFileSync(target, 'utf8')).toBe('old')
    } finally {
      await holder.release()
    }
  }, 20_000)

  test('a debounced chats.json save blocked past the window is logged and written once the lock lets go', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-wf-store-'))
    temps.push(dir)
    const file = join(dir, 'chats.json')
    writeFileSync(file, '[]')
    const holder = await hold(file, 3500)
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const store = new ChatStore(dir, { debounceMs: 10, retryMs: 300 })
      store.saveChats([chat('a')])
      await holder.exited
      const deadline = Date.now() + 5_000
      while (!readFileSync(file, 'utf8').includes('"a"') && Date.now() < deadline) await Bun.sleep(50)
      expect(JSON.parse(readFileSync(file, 'utf8')).map((c: { id: string }) => c.id)).toEqual(['a'])
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('could not be saved, trying again'))
    } finally {
      logged.mockRestore()
      await holder.release()
    }
  }, 20_000)
})

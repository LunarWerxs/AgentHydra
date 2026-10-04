// The folder dialog's helper (server/src/folders/pick-folder.cs) compiles with this Windows' csc.exe (C# 5)
// and its COM setup holds: --probe builds the dialog without showing it and reads the start folder back
// through IShellItem, which only works while the interop declarations match Windows' vtables.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { helperExe } from '../../src/folders/pick'

setDefaultTimeout(60_000)

const temps: string[] = []

afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  temps.push(d)
  return d
}

async function probe(exe: string, start: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([exe, '--probe', '--start', start], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code, stdout, stderr }
}

describe.if(process.platform === 'win32')('pick-folder helper', () => {
  test('builds, and sets the dialog up in the start folder; a start folder that is gone is no error', async () => {
    const exe = await helperExe(temp('desk-pick-home-'))
    expect(existsSync(exe)).toBe(true)

    const start = temp('desk-pick start ')
    expect(await probe(exe, start)).toEqual({ code: 0, stdout: start, stderr: '' })
    expect(await probe(exe, join(start, 'gone'))).toEqual({ code: 0, stdout: '', stderr: '' })
  })
})

// The in-process Windows process table (src/core/win-process-table.ts) against the real OS.
//
// Its contract is the live Windows boundary: a wrong struct offset, UNICODE_STRING offset or
// FILETIME epoch reads plausible-looking garbage rather than failing, and every caller would then
// trust it over the PowerShell fallback. So this starts a child it knows everything about and
// checks each field the callers use.

import { expect, test } from 'bun:test'
import { basename } from 'node:path'
import {
  nativeCommandLines,
  nativeProcessesNamed,
  nativeProcessInfo,
  nativeProcessTable,
} from '../src/core/win-process-table'

test.skipIf(process.platform !== 'win32')(
  'reads a known child: pid, parent, name, command line, exe, start time, working set',
  async () => {
    const marker = `win-process-table-${process.pid}-${Date.now()}`
    const exeName = basename(process.execPath)
    const child = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 5000)', marker], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    try {
      // The process exists once spawn returns; give its command line a moment to be mapped.
      await Bun.sleep(200)
      const table = nativeProcessTable({ mustHave: child.pid })
      expect(table).not.toBeNull()
      expect(table!.length).toBeGreaterThan(10)

      const named = nativeProcessesNamed([exeName.toUpperCase()])
      const row = named?.find((p) => p.pid === child.pid)
      expect(row).toBeDefined()
      expect(row!.ppid).toBe(process.pid)
      expect(row!.name.toLowerCase()).toBe(exeName.toLowerCase())
      expect(row!.commandLine).toContain(marker)
      expect(row!.executablePath?.toLowerCase()).toBe(process.execPath.toLowerCase())
      const started = Date.parse(row!.creationDate ?? '')
      expect(Math.abs(Date.now() - started)).toBeLessThan(10_000)
      expect(row!.workingSetSize).toBeGreaterThan(0)

      expect(nativeCommandLines([child.pid])?.get(child.pid)).toContain(marker)
    } finally {
      child.kill()
      await child.exited
    }
    // Bun still holds the exited child's handle, so the process object opens; what callers rely
    // on is that it leaves the table and its command line stops reading.
    expect(nativeProcessTable({ fresh: true })!.some((p) => p.pid === child.pid)).toBe(false)
    expect(nativeCommandLines([child.pid])?.has(child.pid)).toBe(false)
    expect(nativeProcessInfo(0x7ffffffc)).toBeNull()
  },
  // A real child process: a cold Windows CI runner has taken several times the 5 s default.
  20_000,
)

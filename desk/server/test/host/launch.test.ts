// A chat host is started through WMI on Windows (launch.ts detachedCommand): outside the server's process tree,
// hidden, every argument reaching it as it was given, a path with spaces among them.

import { afterEach, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detachedCommand } from '../../src/host/launch'

const temps: string[] = []
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

test.skipIf(process.platform !== 'win32')('a host starts outside our process tree with its arguments intact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk launch '))
  temps.push(dir)
  const out = join(dir, 'out.json')
  const script = join(dir, 'echo args.ts')
  writeFileSync(script, "require('node:fs').writeFileSync(process.argv[2], JSON.stringify({ args: process.argv.slice(3), ppid: process.ppid }))\n")
  const args = ['a b', 'quote"inside', 'ends\\', "it's", 'C:\\Program Files\\x y\\']
  const plan = detachedCommand('win32', [process.execPath, script, out, ...args])
  expect(plan.detached).toBe(false) // the powershell is ours; what it starts is not
  const child = spawn(plan.argv[0]!, plan.argv.slice(1), { stdio: 'ignore', windowsHide: true })
  child.on('error', () => {})
  const deadline = Date.now() + 20_000
  while (!existsSync(out) && Date.now() < deadline) await Bun.sleep(100)
  const got = JSON.parse(readFileSync(out, 'utf8')) as { args: string[]; ppid: number }
  expect(got.args).toEqual(args)
  // WMI's provider host is its parent, not this process (nor the powershell this process started).
  expect(got.ppid).not.toBe(process.pid)
  expect(got.ppid).not.toBe(child.pid)
}, 30_000)

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { indexReader } from '../src/static-index'

const temps: string[] = []

afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

test('a missing index.html answers the copy read last time, and a rewritten one is read at once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-index-'))
  temps.push(dir)
  const file = join(dir, 'index.html')
  const read = indexReader(file)
  expect(await read()).toBeNull()
  writeFileSync(file, '<script src="/assets/app-OLD.js"></script>')
  expect(await read()).toContain('app-OLD.js')
  unlinkSync(file)
  expect(await read()).toContain('app-OLD.js')
  writeFileSync(file, '<script src="/assets/app-NEW.js"></script>')
  expect(await read()).toContain('app-NEW.js')
})

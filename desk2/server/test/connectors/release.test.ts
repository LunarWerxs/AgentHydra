import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installedApp, installFromRelease } from '../../src/connectors/release'

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'rel-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const BODY = new TextEncoder().encode('pretend this is a program')
const sha = createHash('sha256').update(BODY).digest('hex')

function fakeFetch(sums: string | null): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url)
    if (u.endsWith('/releases/latest')) {
      const assets = [{ name: 'app.exe', browser_download_url: 'https://example.com/app.exe', size: BODY.length }]
      if (sums !== null) assets.push({ name: 'SHA256SUMS.txt', browser_download_url: 'https://example.com/SHA256SUMS.txt', size: sums.length })
      return Response.json({ tag_name: 'v1.2.3', assets })
    }
    if (u.endsWith('SHA256SUMS.txt')) return new Response(sums ?? '')
    return new Response(BODY)
  }) as unknown as typeof fetch
}

const run = (dest: string, sums: string | null, progress?: (l: string) => void) =>
  installFromRelease({ repo: 'Example/App', asset: 'app.exe', dest, progress, fetchImpl: fakeFetch(sums) })

test('a matching checksum installs and installedApp reads it back', async () => {
  const dest = join(tmp(), 'apps', 'app')
  const lines: string[] = []
  const r = await run(dest, `${sha}  app.exe\n`, (l) => lines.push(l))
  expect(r.version).toBe('v1.2.3')
  expect(r.sha256).toBe(sha)
  expect(installedApp(dest)).toEqual({ file: join(dest, 'app.exe'), version: 'v1.2.3' })
  expect(lines.some((l) => l.startsWith('Downloading'))).toBe(true)
  expect(readdirSync(dest).sort()).toEqual(['app.exe', 'installed.json'])
})

test('a wrong checksum refuses and leaves no file', async () => {
  const dest = join(tmp(), 'app')
  await expect(run(dest, `${'0'.repeat(64)}  app.exe\n`)).rejects.toThrow(/checksum/)
  expect(existsSync(join(dest, 'app.exe'))).toBe(false)
  expect(existsSync(join(dest, 'app.exe.partial'))).toBe(false)
  expect(installedApp(dest)).toBeNull()
})

test('no line for the asset, or no SHA256SUMS.txt, refuses and leaves no file', async () => {
  const dest = join(tmp(), 'app')
  await expect(run(dest, `${sha}  other.exe\n`)).rejects.toThrow(/no line for app.exe/)
  await expect(run(dest, null)).rejects.toThrow(/SHA256SUMS/)
  expect(existsSync(join(dest, 'app.exe'))).toBe(false)
  expect(existsSync(join(dest, 'app.exe.partial'))).toBe(false)
})

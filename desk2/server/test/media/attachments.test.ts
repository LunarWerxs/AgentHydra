import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { ServerContext } from '../../src/context'
import attachments, { MAX_ATTACHMENT_BYTES, safeName } from '../../src/plugins/36-attachments'

let home: string | null = null
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true })
  home = null
})

function app(): Hono {
  home = mkdtempSync(join(tmpdir(), 'attach-'))
  const hono = new Hono()
  attachments(hono, { home } as unknown as ServerContext)
  return hono
}

describe('safeName', () => {
  test('keeps one path segment and drops reserved characters', () => {
    expect(safeName('C:/Users/me/report:final?.pdf')).toBe('report_final_.pdf')
    expect(safeName('../../secret.txt')).toBe('secret.txt')
    expect(safeName('...')).toBe('file')
    expect(safeName('CON.md')).toBe('_CON.md')
  })

  test('a long name is shortened before its extension', () => {
    const name = safeName(`${'a'.repeat(300)}.pdf`)
    expect(name.length).toBe(120)
    expect(name.endsWith('a.pdf')).toBe(true)
  })
})

describe('POST /api/attachments', () => {
  test('keeps the bytes under the hash folder and names the path', async () => {
    const hono = app()
    const bytes = new TextEncoder().encode('# Notes\n')
    const res = await hono.request('/api/attachments?name=notes.md', { method: 'POST', body: bytes })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { path: string; name: string; bytes: number; mediaType: string }
    expect(body).toMatchObject({ name: 'notes.md', bytes: bytes.length, mediaType: 'text/markdown' })
    expect(readFileSync(body.path, 'utf8')).toBe('# Notes\n')
    const again = (await (await hono.request('/api/attachments?name=notes.md', { method: 'POST', body: bytes })).json()) as { path: string }
    expect(again.path).toBe(body.path)
  })

  test('refuses a body over the cap before reading it', async () => {
    const hono = app()
    const res = await hono.request('/api/attachments?name=big.zip', {
      method: 'POST',
      headers: { 'content-length': String(MAX_ATTACHMENT_BYTES + 1) },
      body: 'x',
    })
    expect(res.status).toBe(413)
  })
})

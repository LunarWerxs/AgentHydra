// plugins/59-chat-undo.ts through a Desk server: the chat comes from a stand-in /api/chats/:id, the transcript from a
// temp config folder, the files from a temp work folder. Nothing outside those folders is read or written.

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chatFileUndo } from '@shared/connectors'
import { encodeProjectDir } from '../../src/bridge/session-jsonl'
import { createServer, type DeskServer } from '../../src/index'

const temps: string[] = []
const stops: (() => unknown)[] = []
const saved = process.env.HYDRA_DESK_HOME
const temp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p))
  temps.push(d)
  return d
}
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
  if (saved === undefined) delete process.env.HYDRA_DESK_HOME
  else process.env.HYDRA_DESK_HOME = saved
})

const SESSION = '11111111-2222-4333-8444-555555555555'

async function desk(cwd: string, transcript: string): Promise<DeskServer> {
  const configDir = temp('chat-undo-config-')
  const dir = join(configDir, 'projects', encodeProjectDir(cwd))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${SESSION}.jsonl`), transcript)
  const home = temp('chat-undo-home-')
  process.env.HYDRA_DESK_HOME = home
  const plugins = temp('chat-undo-plugins-')
  writeFileSync(
    join(plugins, '20-fake-chat.ts'),
    `export default (app) => app.get('/api/chats/:id', (c) => c.req.param('id') === 'c1' ? c.json({ cwd: ${JSON.stringify(cwd)}, sessionId: ${JSON.stringify(SESSION)}, account: { configDir: ${JSON.stringify(configDir)} } }) : c.json({ error: 'no' }, 404))\n`
  )
  writeFileSync(join(plugins, '59-chat-undo.ts'), `export { default } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, '..', '..', 'src', 'plugins', '59-chat-undo.ts')).href)}\n`)
  const server = await createServer({ port: 0, home, pluginsDir: plugins })
  stops.push(() => server.stop())
  return server
}

const lines = (file: string, before: string, after: string): string =>
  [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u1', name: 'Edit', input: { file_path: file, old_string: before, new_string: after } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1' }] }, toolUseResult: { originalFile: `${before}\n` } })
  ].join('\n')

test('the plan lists the chat file with its counts, and the confirmed paths are put back', async () => {
  const cwd = temp('chat-undo-work-')
  const file = join(cwd, 'a.txt')
  writeFileSync(file, 'new\n')
  const s = await desk(cwd, lines(file, 'old', 'new'))
  const url = `http://127.0.0.1:${s.port}${chatFileUndo('c1')}`
  expect(await (await fetch(url)).json()).toEqual({ files: [{ path: 'a.txt', added: 1, removed: 1, kind: 'restore', state: 'ready' }] })
  // A path the plan did not list is ignored, and the listed one is restored.
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths: ['a.txt', 'other.txt'] }) })
  expect(await res.json()).toEqual({ done: ['a.txt'], skipped: [{ path: 'other.txt', reason: 'nothing to undo in it any more' }] })
  expect(readFileSync(file, 'utf8')).toBe('old\n')
})

test('a foreign Origin, an unknown chat and an empty request change nothing', async () => {
  const cwd = temp('chat-undo-work-')
  const file = join(cwd, 'a.txt')
  writeFileSync(file, 'new\n')
  const s = await desk(cwd, lines(file, 'old', 'new'))
  const base = `http://127.0.0.1:${s.port}`
  expect((await fetch(base + chatFileUndo('c1'), { headers: { origin: 'https://evil.example.com' } })).status).toBe(403)
  expect((await fetch(base + chatFileUndo('nope'))).status).toBe(404)
  expect((await fetch(base + chatFileUndo('c1'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(400)
  expect(readFileSync(file, 'utf8')).toBe('new\n')
})

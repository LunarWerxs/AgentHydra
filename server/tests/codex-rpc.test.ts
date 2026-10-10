import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectCodexRpc } from '../src/core/codex-rpc'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'codex-rpc-'))
  roots.push(home)
  const script = join(home, 'server.ts')
  writeFileSync(
    script,
    `
    import {createInterface} from 'node:readline'
    const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
    let initialized = false
    createInterface({input: process.stdin}).on('line', (line) => {
      const message = JSON.parse(line)
      if (message.method === 'initialized') { initialized = true; return }
      if (message.method === 'initialize') { send({id:message.id,result:{}}); return }
      if (message.method === 'hang') return
      if (message.method === 'exit') { process.exit(0); return }
      if (message.method === 'fail') { send({id:message.id,error:{code:1,message:'Request rejected'}}); return }
      send({method:'notification',params:{}})
      send({id:message.id,result:{initialized,home:process.env.CODEX_HOME}})
    })
  `,
  )
  return { home, command: [process.execPath, script] }
}

test('Codex RPC handshakes and scopes the child to the selected home', async () => {
  const f = fixture()
  const rpc = await connectCodexRpc(f.home, { command: f.command })
  try {
    expect(await rpc.call<{ initialized: boolean; home: string }>('read')).toEqual({
      initialized: true,
      home: f.home,
    })
    const error = await rpc.call('fail').then(
      () => '',
      (error: Error) => error.message,
    )
    expect(error).toBe('Request rejected')
  } finally {
    await rpc.close()
  }
})

test('Codex RPC rejects pending work when the child exits', async () => {
  const f = fixture()
  const rpc = await connectCodexRpc(f.home, { command: f.command })
  try {
    const error = await rpc.call('exit').then(
      () => '',
      (error: Error) => error.message,
    )
    expect(error).toContain('exited')
  } finally {
    await rpc.close()
  }
})

// The per-call timeout also bounds the initialize handshake, which waits on the child bun starting:
// about 0.3 s here (2026-10-04). With the old 500 ms, a loaded box that started it slower failed in
// connect, before the hang this test is about was ever sent.
const RPC_TIMEOUT_MS = 2_000

test('Codex RPC times out and closes the connection', async () => {
  const f = fixture()
  const rpc = await connectCodexRpc(f.home, { command: f.command, timeoutMs: RPC_TIMEOUT_MS })
  try {
    const error = await rpc.call('hang').then(
      () => '',
      (error: Error) => error.message,
    )
    expect(error).toContain('timed out')
    const closedError = await rpc.call('read').then(
      () => '',
      (error: Error) => error.message,
    )
    expect(closedError).toContain('closed')
  } finally {
    await rpc.close()
  }
}, 20_000)

// A Codex refresh token rotates: two app-servers refreshing one home can sign the account out. The
// daemon's own connections to a home take turns; other homes never wait.
test('connections to one Codex home take turns, other homes do not wait', async () => {
  const a = fixture()
  const b = fixture()
  const first = await connectCodexRpc(a.home, { command: a.command })
  let secondOpen = false
  const second = connectCodexRpc(a.home, { command: a.command }).then((rpc) => {
    secondOpen = true
    return rpc
  })
  const other = await connectCodexRpc(b.home, { command: b.command })
  await Bun.sleep(300)
  expect(secondOpen).toBe(false)
  await first.close()
  const rpc = await second
  expect(secondOpen).toBe(true)
  await rpc.close()
  await other.close()
}, 20_000)

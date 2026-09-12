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

test('Codex RPC times out and closes the connection', async () => {
  const f = fixture()
  const rpc = await connectCodexRpc(f.home, { command: f.command, timeoutMs: 500 })
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
})

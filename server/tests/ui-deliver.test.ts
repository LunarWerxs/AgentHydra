// server/tests/ui-deliver.test.ts - the delivery actuator's contract pinned: every PS1 exit
// maps to a DISTINCT outcome (each implies a different next move), the aim proof is
// mandatory, and busy-abort is the default.
import { expect, test } from 'bun:test'
import { interpretDeliverExit, uiDeliverToChat } from '../src/ui-deliver'

test('each exit code is a distinct outcome - never collapsed into a bare failure', () => {
  expect(interpretDeliverExit(0, 'DELIVERED to X').outcome).toBe('delivered')
  expect(interpretDeliverExit(0, 'DELIVERED to X').ok).toBe(true)
  expect(interpretDeliverExit(3, 'not rendered').outcome).toBe('not-rendered')
  expect(interpretDeliverExit(4, 'REFUSED').outcome).toBe('wrong-chat')
  expect(interpretDeliverExit(5, 'composer').outcome).toBe('composer-refused')
  expect(interpretDeliverExit(6, 'ABORT').outcome).toBe('chat-busy')
  expect(interpretDeliverExit(1, 'boom').outcome).toBe('error')
  // An unmapped code is an error, never a silent success.
  expect(interpretDeliverExit(99, '').outcome).toBe('error')
  expect(interpretDeliverExit(99, '').ok).toBe(false)
})

test('a failing exit is never ok, and the detail survives for the caller', () => {
  for (const code of [1, 3, 4, 5, 6, 99]) {
    const r = interpretDeliverExit(code, 'the PS1 said why')
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('the PS1 said why')
  }
  // An empty stdout still yields something actionable.
  expect(interpretDeliverExit(3, '   ').detail).toBe('exit 3')
})

test('verifyText is MANDATORY - a delivery with no aim proof is refused before spawning', async () => {
  let spawned = false
  const r = await uiDeliverToChat({
    instanceDir: String.raw`c:\i\work`,
    title: 'A chat',
    message: 'hello',
    verifyText: '   ',
    run: async () => {
      spawned = true
      return { code: 0, out: 'DELIVERED' }
    },
  })
  expect(r.ok).toBe(false)
  expect(r.outcome).toBe('error')
  expect(r.detail).toContain('no aim proof')
  expect(spawned).toBe(false)
})

test('the PS1 gets exact instance/title/message/verify args, and busy-abort by default', async () => {
  let args: string[] = []
  await uiDeliverToChat({
    instanceDir: String.raw`c:\i\work`,
    title: 'Some chat',
    message: 'do the thing',
    verifyText: 'its own words',
    run: async (a) => {
      args = a
      return { code: 0, out: 'DELIVERED' }
    },
  })
  expect(args).toEqual([
    '-Instance',
    String.raw`c:\i\work`,
    '-Title',
    'Some chat',
    '-Message',
    'do the thing',
    '-VerifyText',
    'its own words',
    '-IfBusyAbort',
  ])
})

test('ifBusyAbort:false is the only way to drop the never-interrupt rail', async () => {
  let args: string[] = []
  await uiDeliverToChat({
    instanceDir: 'd',
    title: 't',
    message: 'm',
    verifyText: 'v',
    ifBusyAbort: false,
    run: async (a) => {
      args = a
      return { code: 0, out: 'ok' }
    },
  })
  expect(args).not.toContain('-IfBusyAbort')
})

test('a throwing spawn is an error result, never an exception the caller must catch', async () => {
  const r = await uiDeliverToChat({
    instanceDir: 'd',
    title: 't',
    message: 'm',
    verifyText: 'v',
    run: async () => {
      throw new Error('powershell vanished')
    },
  })
  expect(r.ok).toBe(false)
  expect(r.outcome).toBe('error')
  expect(r.detail).toContain('powershell vanished')
})

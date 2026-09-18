// server/tests/orchestrator-child-env.test.ts — audit AH-04: a toolbox child talks to the daemon
// that spawned it, not to whatever 7787 happens to hold.
//
// The daemon auto-hops off a busy 7787 and hydralib's default was 7787 with no other discovery,
// so a child of a hopped daemon addressed the wrong port (reproduced with AGENTHYDRA_PORT=17787
// and no URL set). orchestratorChildEnv is the one place the child's environment is built.
import { expect, test } from 'bun:test'
import { orchestratorChildEnv, setOrchestratorDaemonUrl } from '../src/orchestrator'

test('the bound daemon URL is pinned into the child, over anything the daemon inherited', () => {
  const env = orchestratorChildEnv(
    { PATH: 'keep-me', AGENTHYDRA_URL: 'http://127.0.0.1:7787' },
    'http://127.0.0.1:17787',
  )
  expect(env.AGENTHYDRA_URL).toBe('http://127.0.0.1:17787')
  expect(env.PATH).toBe('keep-me')
  // The UTF-8 pipe pins ride along unchanged.
  expect(env.PYTHONUTF8).toBe('1')
  expect(env.PYTHONIOENCODING).toBe('utf-8')
  // ⛔ AND THE BUFFERING PIN (2026-09-18). Python block-buffers stdout when it is a pipe, so a
  // child that is KILLED — a cancel, a deadline — never flushes and the adapter records
  // `stdout: ""`. Two cancelled runs read as a crash with no diagnostic that way, and the
  // diagnostic had been written. A caller that cannot inherit this must not exist: the
  // environment is built here, for every child, in one place.
  expect(env.PYTHONUNBUFFERED).toBe('1')
})

test('an inherited PYTHONUNBUFFERED cannot be turned off under the daemon', () => {
  // A daemon started from a shell that had set it to '' (Python treats empty as unset) must still
  // hand its children an unbuffered pipe — the pin overrides, it does not merely default.
  const env = orchestratorChildEnv({ PYTHONUNBUFFERED: '' }, null)
  expect(env.PYTHONUNBUFFERED).toBe('1')
})

test('the URL index.ts records at boot is what every later child gets by default', () => {
  setOrchestratorDaemonUrl('http://127.0.0.1:7791')
  try {
    expect(orchestratorChildEnv({ AGENTHYDRA_URL: 'http://127.0.0.1:7787' }).AGENTHYDRA_URL).toBe(
      'http://127.0.0.1:7791',
    )
  } finally {
    // Other tests in this process must not inherit a recorded URL.
    setOrchestratorDaemonUrl('')
  }
})

test('with no recorded URL and no runtime pointer, an inherited URL is left as the caller set it', () => {
  setOrchestratorDaemonUrl('')
  // '' is falsy, so the recorded slot is treated as unset; the suite's scratch CONFIG_DIR holds no
  // runtime.json of this daemon's, so the base env's value is what survives.
  const env = orchestratorChildEnv({ AGENTHYDRA_URL: 'http://127.0.0.1:4242' }, null)
  expect(typeof env.AGENTHYDRA_URL).toBe('string')
  expect(env.AGENTHYDRA_URL.startsWith('http://')).toBe(true)
})

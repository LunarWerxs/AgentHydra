// The daemon always leads a person to Desk 2 (desk2.ts), never to a dead port. The contract, with the health
// probe and the process starter injected so nothing here starts a real Desk 2:
//   Desk 2 answers -> a page asked of the daemon is a 302 to it, query kept (the Connections sign-in return);
//   Desk 2 is down -> it is started once, however many pages ask, and the page is the starting page;
//   Desk 2 is absent -> the daemon answers nothing for it (index.ts serves the old window as before).
import { describe, expect, test } from 'bun:test'
import { createDesk2, type Desk2Deps, type StartPlan } from '../src/desk2'

const norm = (p: string) => p.replaceAll('\\', '/')

interface Rig {
  desk: ReturnType<typeof createDesk2>
  plans: StartPlan[]
  probes: { count: number }
  state: { up: boolean; startsUp: boolean }
  opened: string[]
}

/** A Desk 2 whose files, health and starter are all fake. `files` are path endings that "exist". */
function rig(
  over: Partial<Desk2Deps> = {},
  files = ['desk2/server/src/index.ts'],
  up = false,
): Rig {
  const plans: StartPlan[] = []
  const probes = { count: 0 }
  const state = { up, startsUp: true }
  const opened: string[] = []
  let clock = 1_000_000
  const desk = createDesk2({
    appRoot: 'C:/example/AgentHydra',
    platform: 'linux',
    env: { HYDRA_DESK_HOME: 'C:/example/desk-home' },
    exists: (p) => files.some((f) => norm(p).endsWith(f)),
    probe: async () => {
      probes.count++
      return state.up
    },
    run: async (plan) => {
      plans.push(plan)
      if (state.startsUp) state.up = true
      return { pid: 4242, code: 0 }
    },
    shutdown: async () => {
      state.up = false
    },
    kill: () => {},
    which: () => '/usr/bin/bun',
    openBrowser: (u) => {
      opened.push(u)
      return true
    },
    daemonUrl: () => 'http://127.0.0.1:7787',
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
    startTimeoutMs: 2000,
    healthTtlMs: 2000,
    ...over,
  })
  return { desk, plans, probes, state, opened }
}

describe('a page asked of the daemon', () => {
  test('goes on to Desk 2 with its query when Desk 2 answers, and starts nothing', async () => {
    const { desk, plans } = rig({}, ['desk2/server/src/index.ts'], true)
    const res = await desk.page(new URL('http://127.0.0.1:7787/connections?code=abc&state=s1'))
    expect(res?.status).toBe(302)
    expect(res?.headers.get('location')).toBe('http://127.0.0.1:7798/?code=abc&state=s1')
    expect(plans).toHaveLength(0)
  })

  test('follows HYDRA_DESK_PORT', async () => {
    const { desk } = rig({ env: { HYDRA_DESK_PORT: '7901' } }, ['desk2/server/src/index.ts'], true)
    const res = await desk.page(new URL('http://127.0.0.1:7787/'))
    expect(res?.headers.get('location')).toBe('http://127.0.0.1:7901/')
  })

  test('is one health probe for a burst of page loads', async () => {
    const { desk, probes } = rig({}, ['desk2/server/src/index.ts'], true)
    for (let i = 0; i < 6; i++) await desk.page(new URL('http://127.0.0.1:7787/'))
    expect(probes.count).toBe(1)
  })

  test('starts Desk 2 once and answers the starting page while it is down', async () => {
    const { desk, plans } = rig()
    const pages = await Promise.all(
      [1, 2, 3].map(() => desk.page(new URL('http://127.0.0.1:7787/?x=1'))),
    )
    for (const res of pages) {
      expect(res?.status).toBe(200)
      expect(res?.headers.get('content-type')).toContain('text/html')
      const html = (await res?.text()) ?? ''
      expect(html).toContain('Starting AgentHydra...')
      // it goes on to Desk 2 with the query, and names the log if Desk 2 never comes up
      expect(html).toContain('http://127.0.0.1:7798/?x=1')
      expect(html).toContain('/api/desk2/status')
      expect(norm(html)).toContain('C:/example/desk-home/logs/server.log')
    }
    expect(await desk.start()).toEqual({ ok: true, started: true })
    expect(plans).toHaveLength(1)
    expect((await desk.status()).up).toBe(true)
  })

  test('is a 302 to Desk 2 once it has come up', async () => {
    const { desk } = rig()
    await desk.page(new URL('http://127.0.0.1:7787/'))
    await desk.start()
    desk.forgetHealth()
    const res = await desk.page(new URL('http://127.0.0.1:7787/'))
    expect(res?.status).toBe(302)
  })

  test('a Desk 2 that never answers ends in an error status naming why, and can be started again', async () => {
    const { desk, plans, state } = rig()
    state.startsUp = false
    await desk.page(new URL('http://127.0.0.1:7787/'))
    const result = await desk.start()
    expect(result.ok).toBe(false)
    const status = await desk.status()
    expect(status.up).toBe(false)
    expect(status.starting).toBe(false)
    expect(status.error).toContain('did not answer')
    await desk.start()
    expect(plans).toHaveLength(2)
  })

  test("is not Desk 2 where desk2/ is absent: no answer, no start, today's window", async () => {
    const { desk, plans, probes } = rig({}, [])
    expect(desk.present()).toBe(false)
    expect(await desk.page(new URL('http://127.0.0.1:7787/'))).toBeNull()
    expect((await desk.start()).ok).toBe(false)
    expect(await desk.open()).toBe(false)
    expect(plans).toHaveLength(0)
    expect(probes.count).toBe(0)
  })
})

describe('how Desk 2 is started', () => {
  test("elsewhere than Windows: bun on server/src/index.ts from desk2, logged, told this daemon's URL", () => {
    const { desk } = rig({
      env: { HYDRA_DESK_HOME: 'C:/example/desk-home', HYDRA_DESK_PORT: '7901' },
    })
    desk.setDaemonUrl('http://127.0.0.1:7790')
    const plan = desk.planStart()
    expect(plan?.command).toBe('/usr/bin/bun')
    expect(plan?.args.map(norm)).toEqual(['server/src/index.ts'])
    expect(norm(plan?.cwd ?? '')).toBe('C:/example/AgentHydra/desk2')
    expect(plan?.env.HYDRA_URL).toBe('http://127.0.0.1:7790')
    expect(plan?.env.HYDRA_DESK_PORT).toBe('7901')
    expect(norm(plan?.logPath ?? '')).toBe('C:/example/desk-home/logs/server.log')
  })

  test('uses the bun a bundle ships when there is one', () => {
    const { desk } = rig({}, ['desk2/server/src/index.ts', 'desk2/runtime/bun'])
    expect(norm(desk.bun() ?? '')).toBe('C:/example/AgentHydra/desk2/runtime/bun')
  })

  test('on Windows: the launcher, hidden and without a window, or start.vbs when a window is wanted', () => {
    const files = [
      'desk2/server/src/index.ts',
      'desk2/launcher/start.ps1',
      'desk2/launcher/start.vbs',
    ]
    const { desk } = rig({ platform: 'win32' }, files)
    const hidden = desk.planStart()
    expect(hidden?.command).toBe('powershell.exe')
    expect(hidden?.args).toContain('Hidden')
    expect(hidden?.args).toContain('-NoWindow')
    expect(hidden?.args).toContain('-NoDialog')
    expect(norm(hidden?.args.find((a) => a.endsWith('start.ps1')) ?? '')).toContain(
      'desk2/launcher',
    )
    const window = desk.planStart({ window: true })
    expect(norm(window?.command ?? '')).toMatch(/wscript\.exe$/)
    expect(window?.args.map(norm).some((a) => a.endsWith('desk2/launcher/start.vbs'))).toBe(true)
  })
})

describe('opening AgentHydra for a person', () => {
  test('elsewhere than Windows it starts Desk 2 and opens the default browser at it', async () => {
    const { desk, opened } = rig()
    expect(await desk.open()).toBe(true)
    expect(opened).toEqual(['http://127.0.0.1:7798/'])
  })

  test('on Windows it runs start.vbs, which starts the server and the native window, and opens no browser', async () => {
    const files = [
      'desk2/server/src/index.ts',
      'desk2/launcher/start.ps1',
      'desk2/launcher/start.vbs',
    ]
    const { desk, plans, opened } = rig({ platform: 'win32' }, files)
    expect(await desk.open()).toBe(true)
    expect(plans).toHaveLength(1)
    expect(plans[0]?.args.map(norm).some((a) => a.endsWith('start.vbs'))).toBe(true)
    expect(opened).toEqual([])
  })
})

describe('stopping Desk 2 for an update', () => {
  test('asks the server to stop and ends no pid when it goes', async () => {
    const { desk, state } = rig({}, ['desk2/server/src/index.ts'], true)
    expect(await desk.stop()).toEqual({ ok: true })
    expect(state.up).toBe(false)
  })

  test('is a no-op when Desk 2 is not running', async () => {
    const { desk, plans } = rig()
    expect(await desk.stop()).toEqual({ ok: true })
    expect(plans).toHaveLength(0)
  })
})

describe('while the updater installs desk2/, or could not', () => {
  test('an install in progress answers the starting page and starts nothing, even with a half-copied desk2/', async () => {
    const notice = {
      state: 'installing' as const,
      message: 'Installing the window from the v2.0.0 release.',
    }
    const { desk, plans } = rig({ installNotice: () => notice })
    const res = await desk.page(new URL('http://127.0.0.1:7787/'))
    expect(res?.status).toBe(200)
    const html = (await res?.text()) ?? ''
    expect(html).toContain('Installing the window from the v2.0.0 release.')
    expect(plans).toHaveLength(0)
    expect((await desk.status()).install).toEqual(notice)
  })

  test('with desk2/ absent a failure notice is the page, with what to do', async () => {
    const message = 'The window could not be installed: HTTP 503. Download the zip.'
    const { desk, plans } = rig({ installNotice: () => ({ state: 'failed', message }) }, [])
    const res = await desk.page(new URL('http://127.0.0.1:7787/'))
    expect(await res?.text()).toContain('Download the zip.')
    expect(plans).toHaveLength(0)
  })

  test('with desk2/ absent and nothing installing it, the daemon answers nothing for it', async () => {
    const { desk } = rig({}, [])
    expect(await desk.page(new URL('http://127.0.0.1:7787/'))).toBeNull()
  })
})

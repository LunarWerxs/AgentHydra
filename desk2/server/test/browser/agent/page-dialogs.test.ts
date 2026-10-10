// An agent page answers its JavaScript dialogs (page-dialogs.ts, watched from navigate.ts `callerPage`), against a
// real headless Chrome: a command behind an alert or a confirm returns instead of waiting out its timeout, a dialog
// the page opens after the tool's own link has closed is answered too, and each answer is kept for browser_tab_errors.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { callerPage, connect, type Link } from '../../../src/browser/agent/navigate'
import { pageDialogs } from '../../../src/browser/agent/page-dialogs'
import { findChrome } from '../../../src/browser/cdp'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let chrome: ChildProcess | undefined
let profile = ''
let port = 0

beforeAll(async () => {
  const bin = findChrome()
  if (!bin) throw new Error('no Chrome installed: the dialog test needs headless Chrome')
  profile = mkdtempSync(join(tmpdir(), 'hydra-dialog-test-'))
  chrome = spawn(
    bin,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      'about:blank',
    ],
    { windowsHide: true, stdio: 'ignore' },
  )
  for (let i = 0; i < 150 && !port; i++) {
    const file = join(profile, 'DevToolsActivePort')
    try {
      if (existsSync(file)) port = Number(readFileSync(file, 'utf8').split('\n')[0])
    } catch {
      // On Windows Chrome holds the file locked while it writes it (EBUSY): the port is not there yet.
    }
    if (!port) await sleep(100)
  }
  if (!port) throw new Error('Chrome did not open a debugging port')
}, 60_000)

afterAll(async () => {
  chrome?.kill()
  await sleep(300)
  // No profile when beforeAll stopped first: rmSync('') under Bun on Windows empties the working folder.
  if (!profile) return
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    // Chrome can hold its profile a moment after the kill; the OS temp folder takes the rest.
  }
})

/** The page a caller of its own gets, through the same call every page tool makes. */
async function agentPage(session: string): Promise<string> {
  return (await callerPage({ attachPort: port }, { session })).targetId
}

const pageLink = (targetId: string) => connect(`ws://127.0.0.1:${port}/devtools/page/${targetId}`)

/** The command's answer, or a failure well inside the link's own 30 s timeout: a dialog nobody answered. */
async function evaluate(link: Link, expression: string): Promise<unknown> {
  const timeout = sleep(5_000).then(() => Promise.reject(new Error('no answer within 5 s: the dialog was left open')))
  const r = (await Promise.race([link.send('Runtime.evaluate', { expression, returnByValue: true }), timeout])) as {
    result?: { value?: unknown }
  }
  return r.result?.value
}

describe('an agent page answers JavaScript dialogs', () => {
  test('an alert is accepted and a confirm dismissed, and both are recorded', async () => {
    const id = await agentPage('dialogs-now')
    const link = await pageLink(id)
    try {
      expect(await evaluate(link, 'alert("Saved"); "after the alert"')).toBe('after the alert')
      expect(await evaluate(link, 'confirm("Delete it?")')).toBe(false)
    } finally {
      link.close()
    }
    expect(pageDialogs(id).map(({ type, message, answered }) => ({ type, message, answered }))).toEqual([
      { type: 'alert', message: 'Saved', answered: 'accepted' },
      { type: 'confirm', message: 'Delete it?', answered: 'dismissed' },
    ])
  }, 20_000)

  // A dialog that opens while no link has the Page domain on cannot be answered over CDP at all, so a tool's own
  // short link is not enough: the page's watcher must be there when it opens.
  test('a dialog the page opens after the tool has let go is answered', async () => {
    const id = await agentPage('dialogs-later')
    const first = await pageLink(id)
    try {
      expect(await evaluate(first, 'setTimeout(() => confirm("Later?"), 200); "scheduled"')).toBe('scheduled')
    } finally {
      first.close()
    }
    await sleep(800)
    const next = await pageLink(id)
    try {
      expect(await evaluate(next, '1 + 1')).toBe(2)
    } finally {
      next.close()
    }
    expect(pageDialogs(id).map(({ type, message, answered }) => ({ type, message, answered }))).toEqual([
      { type: 'confirm', message: 'Later?', answered: 'dismissed' },
    ])
  }, 20_000)
})

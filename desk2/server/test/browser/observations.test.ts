import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { observeProfile, observationLedgerPath, recordBrowserProfileObservation } from '../../src/browser/observations'

let home: string
let saved: string | undefined

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'observations-'))
  saved = process.env.HYDRA_DESK_BROWSER_STORE
  process.env.HYDRA_DESK_BROWSER_STORE = join(home, 'store')
})

afterAll(() => {
  if (saved === undefined) delete process.env.HYDRA_DESK_BROWSER_STORE
  else process.env.HYDRA_DESK_BROWSER_STORE = saved
  rmSync(home, { recursive: true, force: true })
})

const ledger = (): Record<string, Record<string, { state: string; title: string }>> =>
  JSON.parse(readFileSync(observationLedgerPath(), 'utf8'))

describe('the profile site ledger', () => {
  test('notes a reached page, a sign-in wall and a bot check by host', () => {
    recordBrowserProfileObservation(
      'acct',
      '[{"title":"Inbox","url":"https://mail.example.com/u/0/"},{"title":"Sign in","url":"https://accounts.google.com/signin"},{"title":"Just a moment...","url":"https://shop.example.test/"}]',
    )
    const forProfile = ledger().acct
    expect(forProfile['mail.example.com'].state).toBe('reached')
    expect(forProfile['accounts.google.com'].state).toBe('signin-wall')
    expect(forProfile['shop.example.test'].state).toBe('challenged')
  })

  test('the ledger lives beside the profile store, not inside it', () => {
    expect(observationLedgerPath()).toBe(join(home, 'browser-profile-logins.json'))
  })

  test('a reply with no page in it writes nothing', () => {
    recordBrowserProfileObservation('quiet', 'no pages here')
    expect(ledger().quiet).toBeUndefined()
  })

  test('a reply names the profile by its slug, as browser_* calls resolve it', async () => {
    await observeProfile('Cloud Ops', undefined, '{"title":"Console","url":"https://console.example.com/"}')
    expect(ledger()['cloud-ops']['console.example.com'].state).toBe('reached')
  })

  test('a failed write never throws into the tool call', () => {
    const file = observationLedgerPath()
    rmSync(file, { force: true })
    mkdirSync(file)
    expect(() =>
      recordBrowserProfileObservation('blocked', '{"title":"Home","url":"https://example.org/"}'),
    ).not.toThrow()
  })
})

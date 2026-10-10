// The tab ledger writer: what it writes is what ownership.ts reads, and it leaves every row it did not touch alone.

import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dropPage, ownPage } from '../../src/browser/ledger'
import { readLedger, TABS_LEDGER } from '../../src/browser/ownership'
import { tempDir } from '../git/helpers'

const rawLedger = (dir: string) => JSON.parse(readFileSync(join(dir, TABS_LEDGER), 'utf8'))

describe('tab ledger writer', () => {
  test('a written row reads back through ownership.ts in the Connections shape', () => {
    const dir = tempDir('ledger-')
    ownPage(dir, 'TARGET-A', 'session-alpha')
    const row = readLedger(dir).get('TARGET-A')
    expect(row?.chat).toBe('session-alpha')
    expect(Math.abs((row?.at ?? 0) - Date.now())).toBeLessThan(60_000)
    const raw = rawLedger(dir)
    expect(raw.v).toBe(1)
    expect(raw.tabs['TARGET-A'].chat).toBe('session-alpha')
    expect(new Date(raw.tabs['TARGET-A'].at).toISOString()).toBe(raw.tabs['TARGET-A'].at)
  })

  test('a row another writer put there survives an AgentHydra write', () => {
    const dir = tempDir('ledger-')
    const other = { chat: 'session-connections', at: new Date().toISOString() }
    writeFileSync(join(dir, TABS_LEDGER), JSON.stringify({ v: 1, tabs: { 'TARGET-OTHER': other } }))
    ownPage(dir, 'TARGET-A', 'session-alpha')
    expect(rawLedger(dir).tabs['TARGET-OTHER']).toEqual(other)
    expect(readLedger(dir).get('TARGET-A')?.chat).toBe('session-alpha')
  })

  test('dropping a page removes only its own row', () => {
    const dir = tempDir('ledger-')
    const other = { chat: 'session-connections', at: new Date().toISOString() }
    writeFileSync(join(dir, TABS_LEDGER), JSON.stringify({ v: 1, tabs: { 'TARGET-OTHER': other, 'TARGET-A': { chat: 'session-alpha', at: new Date().toISOString() } } }))
    dropPage(dir, 'TARGET-A')
    expect(rawLedger(dir).tabs).toEqual({ 'TARGET-OTHER': other })
  })

  test('a page with no session is not written', () => {
    const dir = tempDir('ledger-')
    ownPage(dir, 'TARGET-A', undefined)
    ownPage(dir, 'TARGET-A', '')
    expect(existsSync(join(dir, TABS_LEDGER))).toBe(false)
  })

  test('a missing ledger is created with the one row', () => {
    const dir = tempDir('ledger-')
    expect(existsSync(join(dir, TABS_LEDGER))).toBe(false)
    ownPage(dir, 'TARGET-A', 'session-alpha')
    expect(Object.keys(rawLedger(dir).tabs)).toEqual(['TARGET-A'])
  })

  test('a half-written ledger is replaced cleanly and leaves no temp file behind', () => {
    const dir = tempDir('ledger-')
    writeFileSync(join(dir, TABS_LEDGER), '{"v":1,"tabs":{"TARGET-O')
    ownPage(dir, 'TARGET-A', 'session-alpha')
    expect(Object.keys(rawLedger(dir).tabs)).toEqual(['TARGET-A'])
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})

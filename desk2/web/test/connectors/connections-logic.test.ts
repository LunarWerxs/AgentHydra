import { describe, expect, test } from 'bun:test'
import type { ConnectorView } from '../../../shared/connectors'
import { bypassRow, chatScopeAllowed, chipText, connectionsServerInfo, filterCompanies, isCurrent, pageShouldOpen, showConnectionsChip, signInLine, starState } from '../../src/components/connectors/connections-logic'

const view = (over: Partial<ConnectorView>): ConnectorView => ({
  id: 'connections', name: 'Connections', blurb: '', homepage: 'https://example.com', installable: false, pane: false,
  state: 'running', url: null, version: null, enabled: true, givesChats: false, checkedAt: 0, ...over
})

describe('the chip shows', () => {
  test('only while the connector is enabled and on this machine', () => {
    expect(showConnectionsChip([view({})])).toBe(true)
    expect(showConnectionsChip([view({ state: 'absent' })])).toBe(false)
    expect(showConnectionsChip([view({ enabled: false })])).toBe(false)
    expect(showConnectionsChip([view({ id: 'repoyeti' })])).toBe(false)
    expect(showConnectionsChip(null)).toBe(false)
  })
})

describe('what the pill says', () => {
  const acme = { companyId: 'c1', name: 'Acme Example' }
  test('the workspace name, with the chat marker only for a chat pin', () => {
    expect(chipText({ signedIn: true, company: acme, scope: 'folder' })).toEqual({ text: 'Acme Example', muted: false, pinned: false })
    expect(chipText({ signedIn: true, company: acme, scope: 'chat' }).pinned).toBe(true)
  })
  test('No workspace is muted; signed out offers sign-in; before the first answer it is just the name of the app', () => {
    expect(chipText({ signedIn: true, company: null, scope: null })).toEqual({ text: 'No workspace', muted: true, pinned: false })
    expect(chipText({ signedIn: false, company: null, scope: null }).text).toBe('Sign in')
    expect(chipText(null).text).toBe('Connections')
  })
  test('the check is on the company whose id the workspace has', () => {
    expect(isCurrent({ signedIn: true, company: acme, scope: 'chat' }, { companyId: 'c1', name: 'Other label' })).toBe(true)
    expect(isCurrent({ signedIn: true, company: acme, scope: 'chat' }, { companyId: 'c2', name: 'Acme Example' })).toBe(false)
  })
})

describe('picking and the search', () => {
  const cs = [{ companyId: 'c1', name: 'Acme Example' }, { companyId: 'c2', name: 'Globex Example' }, { companyId: 'c3', name: 'acme labs' }]
  test('pinning this chat needs a Claude session', () => {
    expect(chatScopeAllowed(null)).toBe(false)
    expect(chatScopeAllowed('sess-1')).toBe(true)
  })
  test('the filter is case-insensitive by name; blank keeps all; no match is empty', () => {
    expect(filterCompanies(cs, 'ACME').map((c) => c.companyId)).toEqual(['c1', 'c3'])
    expect(filterCompanies(cs, '  ')).toEqual(cs)
    expect(filterCompanies(cs, 'zzz')).toEqual([])
  })
})

describe('the star', () => {
  const ws = { signedIn: true, company: null, scope: null, defaultCompanyId: 'c1' } as const
  test('filled only on the folder default, with its own titles', () => {
    expect(starState(ws, { companyId: 'c1', name: 'A' })).toMatchObject({ on: true, title: 'Default for new chats' })
    expect(starState(ws, { companyId: 'c2', name: 'B' })).toMatchObject({ on: false, title: 'Set as default for new chats in this folder' })
    expect(starState(null, { companyId: 'c1', name: 'A' }).on).toBe(false)
  })
})

describe('sign-in', () => {
  test('the page opens the link unless Connections already did, and never a link that is not http(s)', () => {
    expect(pageShouldOpen({ url: 'https://studio.example.com/d', opened: false })).toBe('https://studio.example.com/d')
    expect(pageShouldOpen({ url: 'https://studio.example.com/d', opened: true })).toBeNull()
    expect(pageShouldOpen({ url: 'javascript:alert(1)', opened: false })).toBeNull()
    expect(pageShouldOpen({ url: null, opened: false })).toBeNull()
  })
})

test('the Bypass permissions row shows a check and On / Off, and is hidden when Connections does not say', () => {
  const ws = (bypassPermissions?: boolean | null, signedIn = true) => ({ signedIn, company: null, scope: null, bypassPermissions }) as const
  expect(bypassRow(ws(true))).toEqual({ label: 'Bypass permissions', on: true, value: 'On' })
  expect(bypassRow(ws(false))).toEqual({ label: 'Bypass permissions', on: false, value: 'Off' })
  expect(bypassRow(ws(null))).toBeNull()
  expect(bypassRow(ws(undefined))).toBeNull()
  expect(bypassRow(ws(true, false))).toBeNull()
  expect(bypassRow(null)).toBeNull()
})

describe('the Connections pane', () => {
  test('names the transport from the address: HTTP with one, stdio without', () => {
    expect(connectionsServerInfo([view({ url: 'http://127.0.0.1:7791/mcp', version: '1.2.3' })])).toEqual({ transport: 'HTTP', url: 'http://127.0.0.1:7791/mcp', stateText: 'Running', running: true, version: '1.2.3' })
    expect(connectionsServerInfo([view({})])).toMatchObject({ transport: 'stdio', url: null, running: true })
  })
  test('says why a server that is set up does not answer; nothing when it is off or absent', () => {
    expect(connectionsServerInfo([view({ state: 'failed', reason: 'timed out' })])).toMatchObject({ running: false, stateText: 'Not answering: timed out' })
    expect(connectionsServerInfo([view({ state: 'absent' })])).toBeNull()
    expect(connectionsServerInfo([view({ enabled: false })])).toBeNull()
    expect(connectionsServerInfo(null)).toBeNull()
  })
  test('the sign-in line follows the workspace read', () => {
    expect(signInLine(null)).toBe('Checking')
    expect(signInLine({ signedIn: true, company: null, scope: 'folder' })).toBe('Signed in')
    expect(signInLine({ signedIn: false, company: null, scope: 'folder' })).toBe('Signed out')
  })
})

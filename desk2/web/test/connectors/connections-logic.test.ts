import { describe, expect, test } from 'bun:test'
import type { ConnectorView } from '../../../shared/connectors'
import { canClear, chatScopeAllowed, chipText, effectiveScope, isCurrent, pageShouldOpen, showConnectionsChip } from '../../src/components/connectors/connections-logic'

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

describe('the scope choice', () => {
  test('This chat needs a Claude session; without one a pick goes to the folder', () => {
    expect(chatScopeAllowed(null)).toBe(false)
    expect(effectiveScope('chat', null)).toBe('folder')
    expect(effectiveScope('chat', 'sess-1')).toBe('chat')
    expect(effectiveScope('folder', 'sess-1')).toBe('folder')
  })
  test('only a chat pin can be cleared', () => {
    expect(canClear('chat')).toBe(true)
    expect(canClear('folder')).toBe(false)
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

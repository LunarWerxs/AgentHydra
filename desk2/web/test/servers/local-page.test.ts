import { describe, expect, it } from 'bun:test'
import { isLocalPage } from '../../src/components/servers/logic'

describe('isLocalPage', () => {
  it('a file:// page is local, whatever its case or spacing', () => {
    expect(isLocalPage('file:///C:/Users/me/Project/tmp/review/main.card-share.html')).toBe(true)
    expect(isLocalPage('  FILE:///C:/Users/me/a.html ')).toBe(true)
  })
  it('web and empty addresses are not local', () => {
    expect(isLocalPage('https://example.com/file:///x')).toBe(false)
    expect(isLocalPage('http://127.0.0.1:7798/ah/')).toBe(false)
    expect(isLocalPage('')).toBe(false)
  })
})

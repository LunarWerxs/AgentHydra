import { describe, expect, it } from 'bun:test'
import { noteWords, shortId, shortName, siteBrand, splitChips } from '../../src/components/servers/names'

const base = { name: 'scratch', title: undefined, note: null, sessionHosts: [] as string[], sites: [] as { host: string; state: 'reached'; at: string }[] }

describe('shortName', () => {
  it('a title wins over everything', () => {
    expect(shortName({ ...base, title: ' Shop admin ', note: 'Something else.', sessionHosts: ['github.com'] })).toBe('Shop admin')
  })
  it('the first login site gives a brand', () => {
    expect(shortName({ ...base, sessionHosts: ['github.com', 'example.com'], note: 'Logins.' })).toBe('GitHub')
    expect(shortName({ ...base, sites: [{ host: 'admin.example.co.uk', state: 'reached', at: '2026-10-01T00:00:00Z' }] })).toBe('Example')
  })
  it('else the first sentence of the note, at most 28 characters', () => {
    expect(shortName({ ...base, note: 'Store admin for the example shop. It holds the owner login. Do not clear it.' })).toBe('Store admin for the…')
    expect(noteWords('Short one. More text')).toBe('Short one')
    expect(noteWords('  ')).toBeNull()
    expect(noteWords('x'.repeat(60))?.length).toBeLessThanOrEqual(28)
  })
  it('else the name with a uuid tail shortened', () => {
    expect(shortName({ ...base, name: 'company-00000000-1111-2222-3333-444444444444' })).toBe('company-00000000')
    expect(shortId('plain-name')).toBe('plain-name')
    expect(shortId('shop-a1b2c3d4e5f6a7b8')).toBe('shop-a1b2c3d4')
  })
})

describe('siteBrand', () => {
  it('names the brand, not the host', () => {
    expect(siteBrand('www.github.com')).toBe('GitHub')
    expect(siteBrand('mail.example.test')).toBe('Example')
    expect(siteBrand('localhost')).toBeNull()
  })
})

describe('splitChips', () => {
  it('up to 5 chips are all shown', () => {
    const hosts = ['a.example.com', 'b.example.com', 'c.example.com', 'd.example.com', 'e.example.com']
    expect(splitChips(hosts)).toEqual({ shown: hosts, more: [] })
  })
  it('more than 5 shows the first 5 and folds the rest into +N', () => {
    const hosts = Array.from({ length: 8 }, (_, i) => `h${i}.example.com`)
    const { shown, more } = splitChips(hosts)
    expect(shown).toEqual(hosts.slice(0, 5))
    expect(more).toEqual(hosts.slice(5))
  })
})

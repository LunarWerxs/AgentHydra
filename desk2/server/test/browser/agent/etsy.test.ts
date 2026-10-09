import { describe, expect, test } from 'bun:test'
import { etsyRefusal, etsyWebsiteHostIn } from '../../../src/browser/agent/etsy'
import { callTool } from '../../../src/browser/agent/tools'

describe('the Etsy refusal', () => {
  test('an etsy.com URL, a subdomain and a URL nested in another argument are refused', () => {
    expect(etsyWebsiteHostIn({ url: 'https://etsy.com/listing/1' })).toBe('etsy.com')
    expect(etsyWebsiteHostIn({ url: 'https://www.etsy.com/' })).toBe('www.etsy.com')
    expect(etsyWebsiteHostIn({ steps: [{ do: 'goto', url: 'https://shop.etsy.com/x' }] })).toBe('shop.etsy.com')
  })

  test('a non-Etsy host passes, and so do the look-alikes Connections does not treat as Etsy', () => {
    expect(etsyWebsiteHostIn({ url: 'https://shop.example.test/cart' })).toBeNull()
    expect(etsyWebsiteHostIn({ url: 'https://notetsy.example.test/' })).toBeNull()
    expect(etsyWebsiteHostIn({ url: 'https://etsy.com.example.test/' })).toBeNull()
    expect(etsyWebsiteHostIn({ url: 'https://etsy.co.example.test/' })).toBeNull()
  })

  test('callTool refuses an Etsy URL in any argument before the tool runs, with the Connections text', async () => {
    const res = await callTool('browser_status', { attachPort: 9222, url: 'https://www.etsy.com/' })
    expect(res).toEqual({ ok: false, status: 403, error: etsyRefusal('www.etsy.com') })
    expect(etsyRefusal('etsy.com').startsWith("browser REFUSED: etsy.com - Etsy's API Terms of Use §9 forbid automated software reading etsy.com")).toBe(true)
  })
})

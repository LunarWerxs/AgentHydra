import { describe, expect, test } from 'bun:test'
import { rotateKey, sign, unsign } from '../src/signing.ts'

describe('signing', () => {
  test('round-trips a payload with the per-install key', () => {
    const token = sign('{"sub":"abc"}')
    expect(unsign(token)).toBe('{"sub":"abc"}')
  })

  test('refuses a tampered body and a tampered mac', () => {
    const token = sign('hello')
    const [body, mac] = token.split('.') as [string, string]
    expect(unsign(`${body}x.${mac}`)).toBeNull()
    expect(unsign(`${body}.${mac.slice(0, -2)}zz`)).toBeNull()
    expect(unsign(undefined)).toBeNull()
    expect(unsign('no-dot')).toBeNull()
  })

  test('an explicit secret is isolated from the install key', () => {
    const secret = Buffer.alloc(32, 7)
    const token = sign('x', secret)
    expect(unsign(token, secret)).toBe('x')
    expect(unsign(token)).toBeNull()
  })

  test('rotating the key invalidates every earlier token', () => {
    const before = sign('session')
    rotateKey()
    expect(unsign(before)).toBeNull()
    expect(unsign(sign('session'))).toBe('session')
  })
})

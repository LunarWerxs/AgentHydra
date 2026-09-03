/**
 * The per-install HMAC signing key, and the sign/unsign primitives built on it. One key signs
 * the owner session cookie and the OAuth `state`, so rotateKey() is a true "sign out everywhere".
 * Vendored from RepoYeti's src/signing.ts; the key lives under state/remote/.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR, ensureConfigDir } from './config.ts'
import { restrictToCurrentUser } from './fs-perms.ts'

let KEY: Buffer | null = null
function keyPath(): string {
  return join(CONFIG_DIR, 'session.key')
}

export function key(): Buffer {
  if (KEY) return KEY
  ensureConfigDir()
  const p = keyPath()
  if (existsSync(p)) {
    KEY = Buffer.from(readFileSync(p, 'utf8').trim(), 'hex')
  } else {
    KEY = randomBytes(32)
    writeFileSync(p, KEY.toString('hex'), { mode: 0o600 })
    restrictToCurrentUser(p)
  }
  return KEY
}

export function sign(payload: string, secret?: Buffer): string {
  const body = Buffer.from(payload).toString('base64url')
  const mac = createHmac('sha256', secret ?? key())
    .update(body)
    .digest('base64url')
  return `${body}.${mac}`
}

export function unsign(token: string | undefined, secret?: Buffer): string | null {
  if (!token) return null
  const [body, mac] = token.split('.')
  if (!body || !mac) return null
  const expected = createHmac('sha256', secret ?? key())
    .update(body)
    .digest('base64url')
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  return Buffer.from(body, 'base64url').toString()
}

/** Rotate the key: every session cookie on every device stops verifying at once. */
export function rotateKey(): Buffer {
  ensureConfigDir()
  const fresh = randomBytes(32)
  const p = keyPath()
  writeFileSync(p, fresh.toString('hex'), { mode: 0o600 })
  restrictToCurrentUser(p)
  KEY = fresh
  return fresh
}

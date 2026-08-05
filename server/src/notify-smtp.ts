// server/src/notify-smtp.ts — a minimal, dependency-free SMTP submission client.
//
// WHY hand-rolled instead of nodemailer: this repo ships three runtime dependencies total, and the
// email path here is one message, to one recipient, over an authenticated submission port. That is
// roughly 150 lines of RFC 5321 conversation — small enough that a dependency (and its transitive
// tree, inside a single compiled binary) costs more than it saves.
//
// It speaks the SUBMISSION subset only, which is all a notifier needs:
//   · implicit TLS on 465, or plaintext connect + STARTTLS upgrade on 587/25
//   · EHLO, AUTH LOGIN / AUTH PLAIN (whichever the server advertises), MAIL FROM, RCPT TO, DATA
//   · no pipelining, no 8BITMIME negotiation, no attachments — the body is base64'd UTF-8 text,
//     which is legal everywhere and sidesteps line-length and encoding questions entirely.
//
// It is NOT a general mail library: no bcc, no multiple recipients per envelope, no queueing. If
// this ever needs to grow past "tell me one thing happened", replace it rather than extend it.

import { connect as netConnect, type Socket } from 'node:net'
import { type TLSSocket, connect as tlsConnect } from 'node:tls'

export interface SmtpConfig {
  host: string
  port: number
  /** true → implicit TLS from the first byte (port 465). false → plaintext connect, then STARTTLS. */
  secure: boolean
  user: string
  pass: string
}

export interface SmtpMessage {
  from: string
  to: string
  subject: string
  /** Plain text. Encoded base64 on the wire, so any UTF-8 and any line length is safe. */
  text: string
}

export type SmtpResult = { ok: true } | { ok: false; error: string }

/** Whole-conversation ceiling. A submission handshake is a few round trips; anything past this is
 *  a wedged connection, and the notifier must not hang on it. */
const OVERALL_TIMEOUT_MS = 20_000

// --- message building (pure, so it is unit-testable without a socket) ---------

/**
 * Fold an address into a header-safe form. CR/LF are stripped rather than escaped: a newline in a
 * header is header injection (it would let a crafted instance label append its own headers), and
 * there is no legitimate reason for one to appear in an address or subject.
 */
function headerSafe(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim()
}

/** RFC 2047 encoded-word, so a non-ASCII subject survives. */
function encodeSubject(subject: string): string {
  const clean = headerSafe(subject)
  // eslint-disable-next-line no-control-regex -- deliberately testing for non-ASCII
  if (!/[^\x20-\x7E]/.test(clean)) return clean
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`
}

/** Base64 body, hard-wrapped at 76 chars per RFC 2045. */
function encodeBody(text: string): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64')
  return (b64.match(/.{1,76}/g) ?? ['']).join('\r\n')
}

/**
 * The full RFC 5322 message, ready for DATA. Exported for tests: everything that can be wrong about
 * an email (header injection, encoding, dot-stuffing) is decided here, with no socket involved.
 *
 * `date` is injected so the output is deterministic under test.
 */
export function buildMessage(msg: SmtpMessage, date = new Date()): string {
  const body = encodeBody(msg.text)
  const lines = [
    `From: ${headerSafe(msg.from)}`,
    `To: ${headerSafe(msg.to)}`,
    `Subject: ${encodeSubject(msg.subject)}`,
    `Date: ${date.toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    'X-Mailer: AgentHydra',
    '',
    body,
  ]
  return lines.join('\r\n')
}

/**
 * Dot-stuffing (RFC 5321 §4.5.2): a line consisting of a single "." terminates DATA, so any body
 * line that STARTS with "." gets a second one prepended. Base64 never produces a leading dot, but
 * the headers are caller-supplied and this is a two-line guarantee — cheaper than reasoning about
 * whether it can happen.
 */
export function dotStuff(message: string): string {
  return message.replace(/^\./gm, '..')
}

// --- the conversation ---------------------------------------------------------

interface Conn {
  socket: Socket | TLSSocket
  /** Read one complete SMTP reply (handles multi-line `250-…` continuations). */
  read(): Promise<{ code: number; text: string }>
  write(line: string): void
}

/** Parse a possibly multi-line reply. Complete when a line matches `NNN<space>`. */
function replyComplete(buf: string): boolean {
  const lines = buf.split(/\r?\n/).filter((l) => l.length > 0)
  const last = lines[lines.length - 1]
  return !!last && /^\d{3} /.test(last)
}

function wrap(socket: Socket | TLSSocket): Conn {
  let buffer = ''
  let waiter: ((r: { code: number; text: string }) => void) | null = null
  let failure: Error | null = null
  let failWaiter: ((e: Error) => void) | null = null

  const flush = () => {
    if (!waiter || !replyComplete(buffer)) return
    const text = buffer
    buffer = ''
    const resolve = waiter
    waiter = null
    failWaiter = null
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0)
    const code = Number(lines[lines.length - 1]?.slice(0, 3) ?? 0)
    resolve({ code, text })
  }

  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    flush()
  })
  const fail = (err: Error) => {
    failure = err
    failWaiter?.(err)
  }
  socket.on('error', fail)
  socket.on('close', () => fail(new Error('connection closed by server')))

  return {
    socket,
    read: () =>
      new Promise((resolve, reject) => {
        if (failure) {
          reject(failure)
          return
        }
        waiter = resolve
        failWaiter = reject
        flush()
      }),
    write: (line: string) => {
      socket.write(`${line}\r\n`)
    },
  }
}

/** Send `cmd`, read the reply, and throw unless the status code is in `expect`. */
async function say(conn: Conn, cmd: string, expect: number[]): Promise<string> {
  conn.write(cmd)
  const reply = await conn.read()
  if (!expect.includes(reply.code)) {
    // Never echo the command back: an AUTH line carries the password.
    throw new Error(`SMTP ${reply.code}: ${reply.text.trim().split(/\r?\n/)[0] ?? ''}`)
  }
  return reply.text
}

function openSocket(cfg: SmtpConfig): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = cfg.secure
      ? tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host }, () => resolve(socket))
      : netConnect({ host: cfg.host, port: cfg.port }, () => resolve(socket))
    socket.once('error', reject)
  })
}

function upgradeTls(socket: Socket, host: string): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    socket.removeAllListeners('data')
    socket.removeAllListeners('error')
    socket.removeAllListeners('close')
    const tls = tlsConnect({ socket, servername: host }, () => resolve(tls))
    tls.once('error', reject)
  })
}

/** Does the EHLO banner advertise this extension? */
const advertises = (banner: string, ext: string): boolean =>
  new RegExp(`^250[ -]${ext}\\b`, 'im').test(banner)

/**
 * Send one message. Never throws — a failure comes back as `{ ok: false, error }` so a notifier can
 * report "email failed" without a try/catch at every call site. The error text never contains the
 * password (see `say`).
 */
export async function sendMail(cfg: SmtpConfig, msg: SmtpMessage): Promise<SmtpResult> {
  let socket: Socket | TLSSocket | null = null
  const timeout = setTimeout(() => {
    try {
      socket?.destroy(new Error('SMTP conversation timed out'))
    } catch {
      // already gone
    }
  }, OVERALL_TIMEOUT_MS)
  timeout.unref?.()
  try {
    socket = await openSocket(cfg)
    let conn = wrap(socket)
    const greeting = await conn.read()
    if (greeting.code !== 220) throw new Error(`SMTP ${greeting.code}: unexpected greeting`)

    // 'agenthydra.local' rather than a real hostname: submission servers accept any syntactically
    // valid EHLO name, and leaking the user's machine name into a mail header is gratuitous.
    let banner = await say(conn, 'EHLO agenthydra.local', [250])

    if (!cfg.secure && advertises(banner, 'STARTTLS')) {
      await say(conn, 'STARTTLS', [220])
      const tls = await upgradeTls(socket as Socket, cfg.host)
      socket = tls
      conn = wrap(tls)
      banner = await say(conn, 'EHLO agenthydra.local', [250]) // must re-EHLO after the upgrade
    }

    if (cfg.user) {
      // AUTH LOGIN is the widest-supported; PLAIN is the fallback when only it is advertised.
      if (/AUTH[ =].*\bLOGIN\b/i.test(banner)) {
        await say(conn, 'AUTH LOGIN', [334])
        await say(conn, Buffer.from(cfg.user, 'utf8').toString('base64'), [334])
        await say(conn, Buffer.from(cfg.pass, 'utf8').toString('base64'), [235])
      } else {
        const token = Buffer.from(`\0${cfg.user}\0${cfg.pass}`, 'utf8').toString('base64')
        await say(conn, `AUTH PLAIN ${token}`, [235])
      }
    }

    await say(conn, `MAIL FROM:<${headerSafe(msg.from)}>`, [250])
    await say(conn, `RCPT TO:<${headerSafe(msg.to)}>`, [250, 251])
    await say(conn, 'DATA', [354])
    conn.write(`${dotStuff(buildMessage(msg))}\r\n.`)
    const stored = await conn.read()
    if (stored.code !== 250) throw new Error(`SMTP ${stored.code}: message rejected`)
    // QUIT is courtesy; a server that drops the socket first must not turn a delivered message
    // into a reported failure.
    try {
      await say(conn, 'QUIT', [221])
    } catch {
      // delivered already
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timeout)
    try {
      socket?.destroy()
    } catch {
      // already gone
    }
  }
}

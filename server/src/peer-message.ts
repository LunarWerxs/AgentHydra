// server/src/peer-message.ts - THE OFFICIAL CHANNEL: deliver a message into a LIVE Claude
// session over its own peer-messaging pipe, exactly the way one session's SendMessage reaches
// another. No UI, no composer click - the message lands in the session's native input queue
// (`queue-operation: enqueue` in its transcript) and runs when its current turn finishes.
//
// HOW IT WORKS, decoded from the CLI binary's own debug recipe (2026-09-01):
//   · Each live session publishes, in ~/.claude/sessions/, a registry `<pid>.json` carrying
//     `messagingSocketPath` (a Windows named pipe \\.\pipe\LOCAL\cc-msg-<hash>) and a sibling
//     `<pid>.<hash>.key` file holding {"peerToken": "<32 hex>"}.
//   · A peer connects to the pipe and writes TWO newline-terminated JSON lines: an auth line
//     {type:'auth',token:<peerToken>} then {type:'user',message:{role:'user',content:<text>}}.
//     Auth is required whenever the key published (it does, on this platform).
//
// LIMIT, and why the composer still exists: the pipe exists ONLY for a LIVE session. A dormant
// or crashed chat has no pipe - it must be BOOTED, which only the composer send does. So the
// courier/message endpoint uses this for live chats and the composer for the rest.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import net from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface PeerTarget {
  pid: number
  socketPath: string
  token: string | null
}

/** The live registry entry for a session id, with its pipe path and published peer token.
 *  null when the session is not live (no pipe to inject into). */
export function peerTargetFor(
  sessionId: string,
  claudeHome = join(homedir(), '.claude'),
): PeerTarget | null {
  const dir = join(claudeHome, 'sessions')
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return null
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    let reg: Record<string, unknown>
    try {
      reg = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    } catch {
      continue
    }
    if (reg?.sessionId !== sessionId) continue
    const socketPath = typeof reg.messagingSocketPath === 'string' ? reg.messagingSocketPath : ''
    const pid = typeof reg.pid === 'number' ? reg.pid : 0
    if (!socketPath || !pid) continue
    // pid must be alive to bother
    try {
      process.kill(pid, 0)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') continue
    }
    // its key file is `<pid>.<hash>.key` beside the registry json
    let token: string | null = null
    for (const kf of files) {
      if (!kf.startsWith(`${pid}.`) || !kf.endsWith('.key')) continue
      try {
        token = JSON.parse(readFileSync(join(dir, kf), 'utf8'))?.peerToken ?? null
      } catch {
        token = null
      }
      break
    }
    return { pid, socketPath, token }
  }
  return null
}

/** Write one user message into a live session's pipe. Resolves true when the pipe accepted the
 *  bytes (the session enqueues it); the caller still CONFIRMS via transcript growth. */
export function injectPeerMessage(
  target: PeerTarget,
  text: string,
  timeoutMs = 6000,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      try {
        sock.destroy()
      } catch {
        /* ignore */
      }
      resolve(ok)
    }
    const sock = net.connect(target.socketPath, () => {
      let payload = ''
      if (target.token) payload += JSON.stringify({ type: 'auth', token: target.token }) + '\n'
      payload += JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'
      sock.write(payload, () => {
        // give the peer a moment to read the line before we close (a connection that sends no
        // complete line in time is dropped; a clean close after the write is accepted)
        setTimeout(() => done(true), 1200)
      })
    })
    sock.on('error', () => done(false))
    setTimeout(() => done(false), timeoutMs)
  })
}

/** Deliver `text` to a live session AND confirm it landed by watching the transcript grow.
 *  Returns {ok, reason}. ok=false with reason 'not-live' means there is no pipe (dormant/
 *  crashed) - the caller should fall back to the composer, which can boot it. */
export async function deliverPeerMessage(
  sessionId: string,
  transcriptPath: string | null,
  text: string,
  confirmMs = 45000,
): Promise<{ ok: boolean; reason: string }> {
  const target = peerTargetFor(sessionId)
  if (!target) return { ok: false, reason: 'not-live' }
  const sizeOf = () => {
    try {
      return transcriptPath ? statSync(transcriptPath).size : 0
    } catch {
      return 0
    }
  }
  const before = sizeOf()
  const wrote = await injectPeerMessage(target, text)
  if (!wrote) return { ok: false, reason: 'pipe-refused' }
  const deadline = Date.now() + confirmMs
  while (Date.now() < deadline) {
    if (sizeOf() > before) return { ok: true, reason: 'enqueued-and-transcript-grew' }
    await new Promise((r) => setTimeout(r, 1500))
  }
  return { ok: false, reason: 'wrote-but-no-transcript-growth' }
}

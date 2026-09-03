import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from '../http-app'
import { findTranscriptById } from '../live-registry'
import { samePathKey } from '../path-key'
import { jsonBody } from '../route-helpers'
import { desktopHomeFor, liveSessionEntry } from '../session-launch'

/** Deliver a message into a desktop chat end to end - the real message endpoint. See index.ts for
 *  the app-wide middleware this route runs behind. */
// Deliver a MESSAGE into a desktop chat, end to end - the real message endpoint (owner word,
// 2026-09-01). One call: find where the chat renders, type the text through the app's own
// composer (accessibility-API control invocation - the proven Deliver-DesktopChat actuator,
// no cursor, no coordinates), and VERIFY the turn started from the transcript itself. The
// composer send is also what boots a dormant or crashed chat's engine (measured 2026-08-26),
// so delivery doubles as the revive. NOTHING HEADLESS: the turn runs in the app.
//
// THE COLLAPSED-SIDEBAR FIX (the owner's exact complaint: a virtualized/collapsed row must
// not break delivery): when the actuator reports the row NOT RENDERED and the session has no
// live writer, this fires the app's OWN `claude://resume` import targeted at the instance -
// the app re-renders the chat at the top of its sidebar - then retries the type once. A live
// unrendered session is refused honestly (resume-importing over a live writer is forbidden).
app.post('/api/sessions/:id/message', async (c) => {
  const sessionId = c.req.param('id')
  const body = await jsonBody(c)
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) return c.json({ ok: false, error: 'text required' }, 400)

  const { findDesktopChat } = await import('../instance-sessions')
  const meta = findDesktopChat(sessionId)
  const home = await desktopHomeFor(sessionId).catch(() => null)
  if (!meta || !home) return c.json({ ok: false, error: 'no desktop chat holds this session' }, 404)
  const { listInstances } = await import('../core/instances')
  const inst = (await listInstances()).find((i) => samePathKey(i.dir, home))
  if (!inst) return c.json({ ok: false, error: `no instance owns ${home}` }, 404)
  if (!inst.isRunning)
    return c.json(
      {
        ok: false,
        error: `instance '${inst.name}' is not running - open it first (delivery types into the app)`,
      },
      409,
    )

  const { statSync } = await import('node:fs')
  const transcript = findTranscriptById(join(homedir(), '.claude'), sessionId)
  const sizeOf = () => {
    try {
      return transcript ? statSync(transcript).size : 0
    } catch {
      return 0
    }
  }

  // ROUTE 1 - THE OFFICIAL CHANNEL (peer messaging): if the session is LIVE, inject the text
  // into its own message pipe exactly as one session's SendMessage reaches another. It lands
  // in the native input queue (no UI, no composer click, no verify snippet needed - the token
  // authenticates and the session id addresses) and runs when the current turn ends. Only a
  // live session has a pipe, so a dormant/crashed chat falls through to the composer, the one
  // route that can BOOT it. (owner, 2026-09-01: "why don't we use the old method" - this is
  // it, preferred wherever it applies; proven end to end the same day.)
  {
    const { deliverPeerMessage } = await import('../peer-message')
    const peer = await deliverPeerMessage(
      sessionId,
      transcript,
      text,
      Math.min(120, Math.max(10, Number(body.confirm_secs) || 45)) * 1000,
    )
    if (peer.ok)
      return c.json({
        ok: true,
        route: 'peer',
        delivered: true,
        typed: false,
        detail: 'delivered over the native peer channel - queued in the chat, no UI',
      })
    if (peer.reason !== 'not-live')
      // the pipe existed but did not confirm - honest failure; do NOT also composer-type
      // (that would risk a duplicate into a live chat)
      return c.json(
        {
          ok: false,
          route: 'peer',
          delivered: false,
          detail: `peer channel did not confirm (${peer.reason})`,
        },
        422,
      )
    // 'not-live' => no pipe (dormant/crashed): fall through to the composer, which boots it.
  }
  // The verify snippet: a line of the chat's OWN last words, so the actuator proves it found
  // the right conversation before typing one character. Caller may supply one; otherwise it
  // is derived from the transcript tail, and no derivable snippet is an honest refusal.
  // THE FLOOR APPLIES TO THE CALLER TOO (2026-09-01). The derivation below refuses anything under
  // 10 characters, but a SUPPLIED verify_text was taken at any length - and three deliveries
  // arrived carrying "x". One character matches essentially any pane, so for those the wrong-chat
  // guard was off while appearing to be on, and one of them reported "typed, but the transcript
  // did not grow". A too-short snippet is a placeholder, not a proof: derive a real one from the
  // transcript instead, and fall back to the placeholder only for a chat with no words yet.
  const MIN_VERIFY = 10
  const supplied = typeof body.verify_text === 'string' ? body.verify_text.trim() : ''
  const placeholder = supplied.length > 0 && supplied.length < MIN_VERIFY ? supplied : ''
  let verify = supplied.length >= MIN_VERIFY ? supplied : ''
  if (!verify && transcript) {
    try {
      const raw = readFileSync(transcript, 'utf8')
      const tail = raw.length > 60000 ? raw.slice(-60000) : raw
      for (const line of tail.split('\n').reverse()) {
        if (!line.includes('"text"')) continue
        try {
          const rec = JSON.parse(line)
          const parts = Array.isArray(rec?.message?.content) ? rec.message.content : []
          for (const p of parts.reverse()) {
            if (p?.type === 'text' && typeof p.text === 'string') {
              // TWO render truths (measured live 2026-09-01): the transcript holds RAW
              // MARKDOWN while the pane shows RENDERED text (strip `*_#> and the line
              // matches - inline code keeps its characters), AND the pane shows the END of
              // a long message, so the snippet must come from the LAST lines, never an
              // earlier "cleaner" one that is scrolled off-screen. Skip only link lines
              // ("[text](url)" renders as just "text").
              const lines = p.text
                .split('\n')
                .map((s: string) => s.trim())
                .filter((s: string) => s.length >= 10)
              for (const raw of lines.reverse()) {
                if (raw.includes('](')) continue
                // a leading "- " / "1. " renders as a bullet GLYPH, not text (measured
                // live 2026-09-01: the pane's ListItem name starts at the first word)
                const cand = raw
                  .replace(/^([-*+]|\d+[.)])\s+/, '')
                  .replace(/[`*_#>]/g, '')
                  .trim()
                // A line EVERY chat ends with proves nothing: the house style signs off
                // with "- Signed: <Employee>", and preferring the last line handed that
                // footer back as the snippet (seen live 2026-09-01). It would match a dozen
                // panes. Walk past it to real content.
                if (/^signed\s*[:-]/i.test(cand)) continue
                if (cand.length >= MIN_VERIFY) {
                  verify = cand.slice(0, 80)
                  break
                }
              }
            }
            if (verify) break
          }
        } catch {
          continue
        }
        if (verify) break
      }
    } catch {
      /* fall through to the refusal below */
    }
  }
  if (!verify && placeholder) {
    // Nothing derivable AND the caller sent a placeholder: the one legitimate case is a chat
    // that has no words yet (a fresh console landing). Allowed, but never quietly - this is the
    // wrong-chat guard running at its weakest, and the log must say so.
    verify = placeholder
    console.warn(
      `[message] ${meta.title ?? sessionId}: typing on a PLACEHOLDER verify_text (${JSON.stringify(placeholder)}) - no transcript text to prove the pane; acceptable only for a chat with no words yet`,
    )
  }
  if (!verify)
    return c.json(
      {
        ok: false,
        error: `no verify snippet derivable from the transcript (pass verify_text of at least ${MIN_VERIFY} characters) - refusing to type blind`,
      },
      422,
    )

  const { spawnSync } = await import('node:child_process')
  const actuator = join(process.cwd(), 'misc', 'Deliver-DesktopChat.ps1')
  if (!existsSync(actuator))
    return c.json({ ok: false, error: `delivery actuator missing at ${actuator}` }, 500)
  const type = () =>
    spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        actuator,
        '-Title',
        meta.title ?? '',
        '-Message',
        text,
        '-VerifyText',
        verify,
        '-IfBusyAbort',
        '-SearchByContent',
        '-Instance',
        inst.name,
      ],
      { timeout: 240000, windowsHide: true, encoding: 'utf8' },
    )

  const before = sizeOf()
  let attempt = type()
  let rendered = attempt.status === 0
  let rerendered = false
  const saidNotRendered = /not rendered/i.test(`${attempt.stdout}${attempt.stderr}`)
  if (!rendered && saidNotRendered) {
    // A live writer normally forbids the resume-import - but an engine whose transcript has
    // been QUIET for minutes has no in-flight turn to protect (the idle-booted shape: the
    // app boots a chat's engine that then writes nothing). Stop it the way the daemon's own
    // migrate does, kill-wait included; an engine that keeps respawning belongs to an app
    // that has the chat OPEN, and that stays an honest refusal.
    const live = liveSessionEntry(sessionId)
    if (live) {
      // mtime is NOT a safe quiet signal here: an idle-booted engine touches its transcript
      // periodically without appending (measured 2026-09-01, size static for 100 minutes
      // while mtime stayed under a minute old). Whether a turn is in flight is the CALLER'S
      // gate to judge from the tail records; this primitive acts only on that word.
      if (body.allow_stop_idle !== true)
        return c.json(
          {
            ok: false,
            error:
              'the row is not rendered AND the session has a live writer - pass allow_stop_idle:true ONLY after your own gate verified no turn is in flight (the last tail record is a completed assistant turn), or migrate it',
          },
          409,
        )
      try {
        process.kill(live.pid)
      } catch {
        /* already exiting */
      }
      const killDeadline = Date.now() + 8000
      while (Date.now() < killDeadline && liveSessionEntry(sessionId))
        await new Promise((r) => setTimeout(r, 250))
      if (liveSessionEntry(sessionId))
        return c.json(
          {
            ok: false,
            error:
              'the live writer keeps respawning - an app holds this chat open; deliver there or migrate it',
          },
          409,
        )
    }
    // ⛔ THE SELF-HEAL GOES THROUGH THE GUARDED IMPORT, NEVER A RAW DEEPLINK (owner,
    // 2026-09-01: "it's also duplicating chats"). Firing `claude://resume` at a profile that
    // ALREADY carries the chat makes the app create a SECOND desktop entry, with its own
    // chatId, for the same conversation - proved live: temp1 ended up with two rendered rows
    // titled identically, and from then on nothing could act on either, because the sidebar
    // actuator (correctly) refuses to guess between two identical titles. A duplicate is
    // therefore not just clutter: it makes the chat permanently unmanageable.
    //
    // "The row is not rendered" is exactly the condition under which that mistake is easiest
    // to make, because the row often IS there and merely unreachable - collapsed group,
    // virtualized out of view. importSessionToDesktop asks the chat index first and returns
    // alreadyRendered instead of importing, which is the check the raw spawn skipped.
    const { importSessionToDesktop } = await import('../session-launch')
    const healed = await importSessionToDesktop({
      sessionId,
      instanceDir: home,
      title: meta.title ?? null,
    })
    if (healed.alreadyRendered)
      return c.json(
        {
          ok: false,
          error:
            'the row is present in that instance but the actuator could not reach it (collapsed ' +
            'group or scrolled out of the virtualized list) - re-importing would create a ' +
            'DUPLICATE chat, so this refuses. Expand its group or scroll it into view, or ' +
            'migrate the chat to another instance.',
        },
        409,
      )
    await new Promise((r) => setTimeout(r, 8000))
    rerendered = true
    attempt = type()
    rendered = attempt.status === 0
    // A freshly re-rendered conversation paints its content ASYNC: the row selects but the
    // pane can still be loading when the verify check looks (measured live 2026-09-01 -
    // "after selecting ... the conversation does not show the expected text"). One more
    // wait-and-retry covers the paint; a real wrong-chat still refuses on both tries.
    if (
      !rendered &&
      /does not show the expected text/i.test(`${attempt.stdout}${attempt.stderr}`)
    ) {
      await new Promise((r) => setTimeout(r, 8000))
      attempt = type()
      rendered = attempt.status === 0
    }
  }
  if (!rendered) {
    const lines = `${attempt.stdout ?? ''}${attempt.stderr ?? ''}`.trim().split('\n')
    const last = lines.pop() ?? ''
    return c.json(
      {
        ok: false,
        rerendered,
        verify_used: verify,
        actuator_tail: lines.slice(-4),
        error: `composer refused: ${last.slice(0, 240) || `exit ${attempt.status}`}`,
      },
      422,
    )
  }

  // CONFIRM from the artifact, never the keystroke: the transcript must grow (a boot from
  // dormant can take a while, so the window covers an engine start).
  // A DORMANT chat must BOOT before its first byte lands, and a cold boot on a busy
  // machine runs well past the old 45s default - healthy wakes were being reported as
  // 'typed, but the transcript did not grow' (measured 2026-09-01). The composer route
  // therefore waits longer by default; a caller may still pin confirm_secs.
  const confirmMs = Math.min(240, Math.max(10, Number(body.confirm_secs) || 120)) * 1000
  const deadline = Date.now() + confirmMs
  let delivered = false
  while (Date.now() < deadline) {
    if (sizeOf() > before) {
      delivered = true
      break
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return c.json({
    ok: delivered,
    typed: true,
    rerendered,
    delivered,
    detail: delivered
      ? 'typed, and the transcript is growing - the turn is running in the app'
      : `typed, but the transcript did not grow within ${confirmMs / 1000}s - not claiming delivery`,
  })
})

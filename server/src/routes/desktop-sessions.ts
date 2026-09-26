import { readFileSync } from 'node:fs'
import { pickCarriedSettings } from '../chat-settings-carry'
import { resolveRequiredTitle } from '../chat-title'
import { tryNativeArchiveChat } from '../claude-native-archive'
import {
  getClaudeNativeSettings,
  parseClaudeNativeProfileConfig,
  setClaudeNativeProfileConfig,
} from '../claude-native-settings'
import { tryNativeUltracode } from '../claude-native-ultracode'
import { NATIVE_EFFORTS } from '../core/claude-native/native-program'
import { listInstances } from '../core/instances'
import { rememberMigratedSettings } from '../db'
import { app } from '../http-app'
import {
  findDesktopChat as findDesktopChatMeta,
  instanceRefForSession,
  invalidateSessionMetaCache,
} from '../instance-sessions'
import { newChatUltracodeEnabled, withUltracode } from '../new-chat-defaults'
import { samePathKey } from '../path-key'
import { invalidEnum, jsonBody, VALID_EFFORTS, VALID_PERMISSION_MODES } from '../route-helpers'
import { captureScreen } from '../screenshot'
import {
  applyDesktopChatAutomation,
  archiveDesktopChat,
  archiveRootsForMove,
  awaitChatRecord,
  cancelChatArchiveReassert,
  coldImportSessionToDesktop,
  desktopChatCarriers,
  desktopHomeFor,
  findChatMetaPath,
  importSessionToDesktop,
  isSessionSuperseded,
  launchTerminalSession,
  liveSessionEntry,
  reassertChatArchive,
  reassertChatTitle,
  unarchiveChatRecord,
} from '../session-launch'
import { getSession } from '../sessions'
import { type UiArchiveOutcome, uiArchiveChat } from '../ui-archive'

/** Screenshot capture, launching a visible terminal session, and the desktop-chat lifecycle
 *  operations (import, automation stamp, archive, migrate). See index.ts for the app-wide
 *  middleware these routes run behind. */
// Capture what is actually ON SCREEN, and hand back the path so the caller can LOOK at it.
// Everything else this daemon reports is read from disk, and disk is not the screen - the gap
// between them is where the archive-that-stayed-visible and the title-that-got-wiped both
// lived. An AI session can read the returned PNG directly; a human can open it. Nothing here
// interprets the image, deliberately: it is a camera, not a judge.
app.post('/api/screenshot', async (c) => {
  const body = await jsonBody(c)
  const result = await captureScreen(typeof body.path === 'string' ? body.path : undefined)
  return c.json(result, result.ok ? 200 : 500)
})
// Start a NEW interactive Claude session in a VISIBLE terminal window, pinned to an instance's
// account. Unlike a headless queue run it is on the user's screen and joins the live
// registry, so peer messaging can reach it.
app.post('/api/sessions/launch-terminal', async (c) => {
  const body = await jsonBody(c)
  if (
    typeof body.cwd !== 'string' ||
    !body.cwd.trim() ||
    typeof body.prompt !== 'string' ||
    !body.prompt.trim()
  )
    return c.json({ error: 'cwd and prompt are required' }, 400)
  if (body.effort != null && invalidEnum(body.effort, VALID_EFFORTS, 'effort'))
    return c.json({ error: invalidEnum(body.effort, VALID_EFFORTS, 'effort') }, 400)
  // An unattended window must be able to ask for a mode that does not stop on shell
  // approvals. Validated against the same set every other entry point uses,
  // because 'bypassPermissions' runs every tool with no approval and a typo must not silently
  // become something else.
  if (body.permission_mode != null && !VALID_PERMISSION_MODES.has(String(body.permission_mode)))
    return c.json(
      { error: `permission_mode must be one of ${[...VALID_PERMISSION_MODES].join(', ')}` },
      400,
    )
  // resume_session_id continues an existing thread in the window (owner's no-headless rule:
  // continuations happen where they can be watched). Refuse it while that thread is live, and
  // refuse a done-marked lineage (one lineage, one continuation — its successor owns the task).
  if (typeof body.resume_session_id === 'string' && body.resume_session_id.trim()) {
    const rid = body.resume_session_id.trim()
    if (liveSessionEntry(rid))
      return c.json(
        { ok: false, reason: 'session-live: stop its process before a terminal resume' },
        409,
      )
    if (body.force !== true && isSessionSuperseded(rid))
      return c.json(
        {
          ok: false,
          reason:
            'superseded: session is done-marked (handed off/migrated); resuming would duplicate its successor — pass force:true only if you have verified there is no successor',
        },
        409,
      )
  }
  const result = await launchTerminalSession({
    cwd: body.cwd,
    prompt: body.prompt,
    instanceRef: typeof body.instance_ref === 'string' ? body.instance_ref : null,
    model: typeof body.model === 'string' ? body.model : null,
    effort: typeof body.effort === 'string' ? body.effort : null,
    resumeSessionId: typeof body.resume_session_id === 'string' ? body.resume_session_id : null,
    force: body.force === true,
    permissionMode: typeof body.permission_mode === 'string' ? body.permission_mode : null,
    // No `visible` knob. It existed for one evening and its false case produced a chat nobody
    // could see, which this program does not run (headless-policy.ts). A terminal session is
    // visible or it does not happen.
  })
  return c.json(result, result.ok ? 200 : 422)
})
// Import a FINISHED session into a desktop instance's app as a visible chat (the app's own
// claude://resume one-way import, targeted at one instance via its profile dir). Refuses a
// session that is currently live — the import rewrites the transcript.
app.post('/api/sessions/:id/import-desktop', async (c) => {
  const sessionId = c.req.param('id')
  const body = await jsonBody(c)
  const ref =
    typeof body.instance_ref === 'string' && body.instance_ref.trim()
      ? body.instance_ref.trim()
      : instanceRefForSession(sessionId)
  if (!ref?.startsWith('desktop:'))
    return c.json(
      { ok: false, error: "instance_ref ('desktop:<dir>') is required — none could be inferred" },
      400,
    )
  if (body.force !== true && isSessionSuperseded(sessionId))
    return c.json(
      {
        ok: false,
        error:
          'superseded: session is done-marked (handed off/migrated); importing would revive a retired lineage — pass force:true only if you have verified there is no successor',
      },
      409,
    )
  // THE NAMING REQUIREMENT (owner directive, 2026-08-29): a chat must not land with a generic
  // name. The caller supplies a real title, or restates the current one exactly (proof of a
  // programmatic review) - chat-title.ts is the one definition of both doors.
  //
  // A CHAT HAS TWO CURRENT NAMES here too, same as /migrate below: the session list's
  // transcript-derived title (`imported.title`) and the desktop record's own on-disk title
  // (the sidebar / Instances "Chats" name a caller who read the DOSSIER actually restates).
  // Checking only the former meant a chat renamed in the app, or a migrate_chat run that
  // restated the dossier's title as `confirm_title` (its documented, expected behaviour), was
  // refused 400 "confirm_title does not match the current title" even though the caller had
  // genuinely reviewed and restated a real, current name (2026-09-15 overnight run, session
  // 7e1fa278: daemon title "Your market still looks like ..." vs desktop meta "Logos for
  // Connections products"). Read the on-disk record the same way /migrate does, so either
  // name restated exactly is accepted here too.
  const imported = await getSession(sessionId, 'claude')
  const sourceRendered = findDesktopChatMeta(sessionId)
  let recordTitle: string | null = null
  try {
    if (sourceRendered?.path) {
      const sourceMeta = JSON.parse(readFileSync(sourceRendered.path, 'utf8')) as Record<
        string,
        unknown
      >
      if (typeof sourceMeta.title === 'string') recordTitle = sourceMeta.title
    }
  } catch {
    // an unreadable source record just means no second name to check against
  }
  const titled = resolveRequiredTitle({
    title: body.title,
    confirmTitle: body.confirm_title,
    currentTitle: imported?.title ?? null,
    recordTitle,
  })
  if (!titled.ok) return c.json({ ok: false, error: titled.error }, 400)
  const result = await importSessionToDesktop({
    sessionId,
    instanceDir: ref.slice('desktop:'.length),
    title: titled.title,
    force: body.force === true,
  })
  return c.json(result, result.ok ? 200 : 422)
})
// Stamp a desktop chat's automation posture to bypassPermissions (owner rule, restated
// 2026-08-28: every migrated chat MUST be bypass before it starts; all chats default to
// bypass). Same running-app caveat as every metadata write: verify via the dossier before
// booting and re-stamp when the app re-saved the old mode.
app.post('/api/sessions/:id/automation', async (c) => {
  const sessionId = c.req.param('id')
  const home = await desktopHomeFor(sessionId).catch(() => null)
  if (!home) return c.json({ ok: false, error: 'no desktop entry for this session' }, 404)
  const stamped = applyDesktopChatAutomation(home, sessionId)
  invalidateSessionMetaCache()
  return c.json(
    {
      ok: stamped,
      mode: 'bypassPermissions',
      caveat:
        'a RUNNING app may re-save the old mode; verify via the dossier before booting and re-stamp if needed',
    },
    stamped ? 200 : 422,
  )
})
// Archive (or unarchive) a chat in the DESKTOP app by flipping its metadata flag across every
// profile that carries it - and, for an ARCHIVE under a RUNNING app, by driving that app's own
// Archive control so the row leaves the sidebar now (see uiArchiveWithinBudget below). The
// response says which of those happened: `stillOnScreen` false means retired, true means the
// flag is written and waiting for that instance's next restart, with the reason the click did
// not settle. UNARCHIVE has no in-app control to drive and still waits for the restart.
/** How long the archive route waits for the app's own Archive click before answering
 *  without it. Under hydralib's 30s POST default, with room for the answer itself. */
const UI_ARCHIVE_BUDGET_MS = 20_000

/**
 * Drive the app's own Archive control for one profile, bounded, and never throwing.
 *
 * Bounded because this route's callers are bounded: archive_chat.py posts here on hydralib's
 * 30s default. A measured click is nowhere near that (listing 32 rendered rows took 1.6s on
 * 2026-09-17, the click a few seconds more), but ui-archive's own spawn guard is 90s, and a UIA
 * call that hangs on a closing window would turn a working endpoint into a caller-side timeout -
 * the worst shape, because the caller then cannot tell what happened. Losing the race is not a
 * failure to hide: the flag is written, the reassert watcher is already running, and the caller
 * is told the click did not settle. The timer is cleared either way, so no archive leaves a
 * 20s timer armed behind it.
 */
async function uiArchiveWithinBudget(
  profile: string,
  sessionId: string,
): Promise<UiArchiveOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      uiArchiveChat(profile, sessionId),
      new Promise<UiArchiveOutcome>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              clicked: false,
              verified: false,
              reason: `the app's own Archive control did not finish within ${UI_ARCHIVE_BUDGET_MS / 1000}s`,
            }),
          UI_ARCHIVE_BUDGET_MS,
        )
      }),
    ])
  } catch (e) {
    return {
      clicked: false,
      verified: false,
      reason: `the app's own Archive control could not be driven: ${e instanceof Error ? e.message : String(e)}`,
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// Effort + ultracode for one chat inside its RUNNING app (claude-native-ultracode.ts): the only
// route that reaches the app's memory and a live engine, where a disk stamp does not. `effort`
// is any picker level (default xhigh); `ultracode` defaults on, and false lands a chat without it.
app.post('/api/claude-native/ultracode', async (c) => {
  const body = await jsonBody(c)
  if (typeof body.profileDir !== 'string' || typeof body.sessionId !== 'string')
    return c.json({ ok: false, reason: 'profileDir and sessionId are required' }, 400)
  const effort = body.effort === undefined ? 'xhigh' : String(body.effort)
  const ultracode = body.ultracode !== false
  if (!NATIVE_EFFORTS.includes(effort))
    return c.json({ ok: false, reason: `effort must be one of ${NATIVE_EFFORTS.join('/')}` }, 400)
  if (ultracode && effort !== 'xhigh' && effort !== 'max')
    return c.json({ ok: false, reason: 'ultracode on requires an effort of xhigh or max' }, 400)
  const out = await tryNativeUltracode(body.profileDir, body.sessionId, effort, ultracode)
  return c.json(out, out.ok ? 200 : 409)
})

// Connections are opt-in per profile. launchDebugger applies on the next ordinary Open;
// saving configuration does not launch or restart a desktop instance.
app.get('/api/claude-native/settings', (c) => c.json(getClaudeNativeSettings()))
app.put('/api/claude-native/settings', async (c) => {
  const body = await jsonBody(c)
  if (typeof body.profile !== 'string' || !('config' in body))
    return c.json({ ok: false, error: 'profile and config are required' }, 400)
  try {
    setClaudeNativeProfileConfig(
      body.profile,
      body.config === null ? null : parseClaudeNativeProfileConfig(body.config),
    )
    return c.json({ ok: true, settings: getClaudeNativeSettings() })
  } catch (error) {
    return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400)
  }
})

// A capability attempt for orchestrator callers. Explicit unavailability permits their old
// guarded path; a refusal or lost reply is terminal and must never become a title-based retry.
app.post('/api/sessions/:id/native-archive', async (c) => {
  const body = await jsonBody(c)
  const profile =
    typeof body.instance_ref === 'string' && body.instance_ref.startsWith('desktop:')
      ? body.instance_ref.slice('desktop:'.length)
      : ''
  if (!/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/i.test(profile))
    return c.json(
      {
        available: true,
        ok: false,
        verified: false,
        dispatch: 'not-sent',
        reason: 'instance_ref must be desktop:<full profile directory>',
      },
      400,
    )
  // `leaving`: CLI ids of the other chats a move is taking off this same profile, so a batch
  // sharing one cwd does not refuse each archive over its siblings' servers.
  const leaving = Array.isArray(body.leaving)
    ? body.leaving.filter((id: unknown): id is string => typeof id === 'string')
    : []
  // `sourceAtLimit`: the move is draining an account at its usage limit, so the archive goes
  // ahead even over another chat's servers and names each one it stopped (owner, 2026-09-26).
  const result = await tryNativeArchiveChat(profile, c.req.param('id'), {
    leavingCliSessionIds: leaving,
    sourceAtLimit: body.sourceAtLimit === true,
  })
  if (result.kind === 'unavailable')
    return c.json({ ...result, available: false, ok: false, verified: false })
  return c.json({ ...result, available: true }, result.ok ? 200 : 409)
})

app.post('/api/sessions/:id/desktop-archive', async (c) => {
  const body = await jsonBody(c)
  const sessionId = c.req.param('id')
  const wantArchived = body.archived !== false
  // SCOPE, AMBIGUITY AND LIVENESS (2026-09-08, after this route's fleet-wide sweep archived the
  // real copy of a migrated chat - engine still running - on the instance it had just landed on).
  // The migrate path already scopes itself (archiveRootsForMove); this door did not.
  const scopeRef =
    typeof body.instance_ref === 'string' && body.instance_ref.trim()
      ? body.instance_ref.trim()
      : null
  let roots: string[] | undefined
  let nativeProfile: string | undefined
  if (scopeRef) {
    if (!scopeRef.startsWith('desktop:'))
      return c.json({ ok: false, error: "instance_ref must be 'desktop:<dir>'" }, 400)
    roots = [scopeRef.slice('desktop:'.length)]
    nativeProfile = roots[0]
  } else {
    // AMBIGUITY IS A REFUSAL, the same rule the chat actuator applies to titles. Only when the
    // caller did not name a scope: an explicit target is always honoured.
    const carriers = desktopChatCarriers(sessionId)
    if (carriers.length > 1)
      return c.json(
        {
          ok: false,
          error:
            `ambiguous: ${carriers.length} profiles carry this session (${carriers.join(', ')}). ` +
            'After a migration the source holds the leftover and the target holds the REAL chat, ' +
            "so archiving both hides a chat in use. Pass instance_ref ('desktop:<dir>') to say which.",
          carriers,
        },
        409,
      )
    if (carriers.length === 1) nativeProfile = carriers[0]
  }
  // Native state decides whether THIS copy is busy. A migrated destination can be running
  // while its source is safely idle. Run this before both the global live guard and disk writes.
  if (wantArchived && nativeProfile) {
    const native = await tryNativeArchiveChat(nativeProfile, sessionId)
    if (native.kind === 'result') {
      return c.json(
        {
          ...native,
          available: true,
          nativeArchive: native,
          stillOnScreen: native.verified ? false : null,
          uiArchive: [],
          note: native.verified
            ? 'Archived through the running app’s native session manager; no UI action or restart needed.'
            : (native.reason ??
              'Native archive was not verified; no disk or UI fallback was attempted.'),
        },
        native.ok ? 200 : 409,
      )
    }
  }
  // Never hide a chat whose engine is running, unless a caller says so outright.
  if (wantArchived && body.force !== true && liveSessionEntry(sessionId))
    return c.json(
      {
        ok: false,
        error:
          'session-live: refusing to archive a chat with a running engine (its app drops the row ' +
          'from the sidebar and only re-reads the store at boot, so the owner loses sight of a ' +
          'working chat); pass force:true if that is genuinely intended',
      },
      409,
    )
  // ⛔ CALL OFF ANY LIVE ARCHIVE WATCHER **BEFORE** WRITING (2026-09-18, measured on instance 56 /
  // chat d9fc4886). The `wantArchived` guard below stops this route FIRING a watcher on an
  // unarchive - but it never addressed the watcher an EARLIER archive already left running, and
  // that one lives for ten minutes. Inside that window every unarchive was reverted within ~1.5s
  // while this route answered ok:true / changed:true: three tool calls and a hand-written flip of
  // the JSON all lost, with four daemon lines claiming "the app's re-save" for an app that was
  // CLOSED. An unarchive is the owner contradicting the intent that armed the watcher, so it
  // stands the watcher down first - cancelling after the write would just lose a race.
  const cancelledWatchers: string[] = []
  if (!wantArchived) {
    for (const profile of roots ?? desktopChatCarriers(sessionId)) {
      if (cancelChatArchiveReassert(profile, sessionId)) cancelledWatchers.push(profile)
    }
  }
  const result = await archiveDesktopChat(sessionId, wantArchived, roots)
  // SAY when the flag landed under a running app, rather than returning a bare ok:true for a
  // chat the owner can still see. Measured 2026-08-26 by asking the app itself right after
  // this call: disk said archived, the app still reported isArchived:false, and the chat
  // stayed in the sidebar. Reporting that as success is how "archived" came to mean "still
  // there".
  // ⛔ NOT `h.changed && h.wasRunning` (fixed 2026-09-18). This decides whether the response
  // carries `stillOnScreen` and the `uiArchive` outcome at all - and that question is "does a
  // RUNNING app hold this chat's list?", which has nothing to do with whether THIS call happened
  // to write the flag. With the old test, the retry after a failed click ran the click (the gate
  // below is fixed too) and then fell through to a bare fallback return that dropped the outcome
  // on the floor: the caller saw `{ok, hits, flagOnDisk: []}` and no sign a click had been
  // attempted. `retiredInApp` still distinguishes "the row is gone" from "it is still there", so
  // widening this cannot report a retired row as on-screen.
  const underRunningApp = (result.hits ?? []).some((h) => h.wasRunning)
  // ⛔ `changed:true` MEANS "I WROTE IT", NOT "IT STUCK" - and for ten minutes after any archive
  // those were different facts, silently. READ THE FLAG BACK. This is the same disk-vs-reality
  // lesson as `stillOnScreen`, one layer down: there the write was real and the SCREEN disagreed;
  // here the write was real and the FILE disagreed a second later. A caller cannot tell either
  // from `ok:true`, so the route says what is actually on disk now.
  const flagOnDisk: Array<{ profile: string; isArchived: boolean | null }> = []
  for (const hit of result.hits ?? []) {
    if (!hit.changed) continue
    let seen: boolean | null = null
    try {
      const metaPath = findChatMetaPath(hit.profile, sessionId)
      if (metaPath) seen = JSON.parse(readFileSync(metaPath, 'utf8')).isArchived === true
    } catch {
      // an unreadable file is "cannot say", never a quiet "it worked"
      seen = null
    }
    flagOnDisk.push({ profile: hit.profile, isArchived: seen })
  }
  const flagStuck = flagOnDisk.length > 0 && flagOnDisk.every((f) => f.isArchived === wantArchived)
  /** Facts every response below carries, so no exit path can drop them. */
  const writeTruth = {
    flagOnDisk,
    flagStuck,
    ...(cancelledWatchers.length ? { cancelledWatchers } : {}),
    ...(flagOnDisk.length && !flagStuck
      ? {
          flagWarning:
            'the write was made and the flag on disk does NOT match what was asked. Something ' +
            'else is writing this record - check for a reassertChatArchive watcher still ' +
            'running for this chat, and for the app re-saving its in-memory copy.',
        }
      : {}),
  }
  // THE DURABLE FIX BELONGS HERE TOO (owner, 2026-09-01: "it's also duplicating chats"). A
  // RUNNING app re-saves isArchived=false within seconds and resurrects the row it was just
  // told to put away — so a chat archived on its old account came back and appeared in BOTH
  // apps at once. /migrate already fired this watcher; this route did not, and this route is
  // what every archive and every account move actually goes through. Fire-and-forget: it must
  // not delay the response, and its own caps bound it.
  //
  // ⛔ ARCHIVE ONLY, AND THE `wantArchived` GUARD IS THE WHOLE POINT (measured live 2026-09-17).
  // reassertChatArchive writes isArchived=TRUE - that is all it does, for ten minutes or eight
  // restores. Fired after an UNARCHIVE it does not defend the caller's write, it DESTROYS it:
  // the flag went to false, the watcher put it back within ~1.5s, and the route had just told
  // the caller "the flag is written ... until that instance next restarts", which by then was
  // false twice over. Observed by unarchiving a chat under a running app and reading the
  // dossier back: archived was true again, and the next archive answered changed:false.
  if (wantArchived) {
    for (const hit of result.hits ?? []) {
      if (!hit.changed || !hit.wasRunning) continue
      void reassertChatArchive(hit.profile, sessionId).catch(() => {})
    }
  }
  // ⛔ FINISH THE JOB HERE, rather than telling the caller to go run a script. Owner ruling,
  // 2026-09-17, after archiving 17 chats by hand: when a built-in does not do the thing it says
  // it does, the built-in gets fixed - nobody should be writing a one-off script to finish a
  // basic operation. The server-side click has existed in ui-archive.ts since 2026-08-30 and
  // NOTHING called it: every
  // caller of this route got a flag, a paragraph explaining the flag was not enough, and a
  // homework assignment. Its own rails decide whether clicking is safe (it refuses when another
  // LIVE chat shares the rendered title), so the worst case here is the old behaviour plus a
  // reason. Awaited on purpose: a fast answer that leaves the chat on screen is the bug.
  const uiOutcomes: Array<{
    profile: string
    clicked: boolean
    verified: boolean
    reason?: string
  }> = []
  if (wantArchived) {
    for (const hit of result.hits ?? []) {
      // ⛔ NOT `!hit.changed || !hit.wasRunning` (fixed 2026-09-18). The click's job is to remove
      // the ROW, and a row can be on screen whether or not THIS call wrote the flag - in fact the
      // state that needs it most is "flag already true, row still rendered", which is exactly what
      // a failed click leaves behind. Gating on `changed` made the first attempt the only attempt:
      // if its last-moment re-aim guard refused (it always did then: the app rebuilds a row's
      // kebab on its first menu open, and the old guard re-read the stale handle's blank name -
      // it re-aims by identity now, see Manage-DesktopChat.ps1 ReAimVerdict), every
      // retry answered `changed:false, wasRunning:false` and did nothing, forever. Measured on
      // #13. A running app is the whole precondition; `uiArchiveWithinBudget` is already bounded,
      // and a row the sidebar no longer renders is its own cheap no-op.
      if (!hit.wasRunning) continue
      const outcome = await uiArchiveWithinBudget(hit.profile, sessionId)
      uiOutcomes.push({ profile: hit.profile, ...outcome })
    }
  }
  const retiredInApp = uiOutcomes.length > 0 && uiOutcomes.every((o) => o.verified)
  if (underRunningApp && retiredInApp)
    return c.json({
      ...result,
      ...writeTruth,
      stillOnScreen: false,
      uiArchive: uiOutcomes,
      // ⛔ SAY WHICH OF THE TWO SETTLED IT (2026-09-17). `verified` is true down two different
      // paths - the control was driven, or there was no rendered row left to drive because the
      // chat was already retired - and this note claimed the first one for both. A caller
      // reading "the control was driven" beside `clicked: false` is reading a contradiction,
      // and the whole point of this route's rename to `stillOnScreen` was that a verdict must
      // not be readable two ways.
      note: uiOutcomes.some((o) => o.clicked)
        ? "the flag is written AND the app's own Archive control was driven, so the row has left " +
          'the sidebar now - no restart needed.'
        : 'the flag is written and no rendered row is left to retire (the chat was already off ' +
          'the sidebar), so nothing needed clicking - no restart needed.',
    })
  if (underRunningApp)
    return c.json({
      ...result,
      ...writeTruth,
      stillOnScreen: true,
      ...(uiOutcomes.length ? { uiArchive: uiOutcomes } : {}),
      note:
        'the flag is written, but that app is RUNNING and holds its chat list in memory, so the ' +
        `chat is STILL ${wantArchived ? 'ON SCREEN' : 'HIDDEN'} until that instance next ` +
        'restarts. ' +
        (wantArchived
          ? `The in-app click was attempted and did not settle it: ${
              uiOutcomes
                .map((o) => o.reason)
                .filter(Boolean)
                .join(' | ') || 'no rendered row to click'
            }.`
          : // UNARCHIVE has no in-app control to drive: the app's row menu offers Archive, not a
            // way to put a hidden chat back, so there is nothing to click and saying a click was
            // attempted would be a lie. Only that instance's restart re-reads the store.
            "unarchiving has no in-app control to drive - the app's row menu can archive a chat, " +
            'not restore one, so only that restart brings it back.'),
    })
  return c.json({ ...result, ...writeTruth }, result.ok ? 200 : 404)
})
// The default first message a migrated chat receives when the caller supplies no prompt.
const MIGRATION_NOTICE =
  '[agenthydra] You are being migrated to a different account and this thread will appear ' +
  "in the owner's desktop app shortly. In a few lines: state what this thread is working on, " +
  'what is verified complete so far, and the concrete next steps. Do not start new work in ' +
  'this turn and do not touch any files; after this turn, this notice is spent - resume ' +
  'normally when the owner next asks.'
// Move a chat to a different account, end to end: stop its live process if it has one (this is
// user-initiated — the chat is being moved, so its current run ends), flag its old desktop
// entries archived, then IMPORT it into the target instance's app under its real title. The
// chat continues life on the new account, visible where the user looks.
//
// NOTHING HEADLESS HAPPENS HERE, and that is the point (owner law 2026-08-26). An earlier
// design ran a one-turn "migration notice" resume through the queue on the target account and
// let the finalize hook import the result — which meant every migrated desktop chat spent its
// first turn as an invisible headless run, the exact failure the owner reported ("every chat
// you were migrating from desktop to desktop ended up being migrated to a headless thing I
// couldn't see"). The transcript store is SHARED across instances, so moving a thread needs no
// turn at all: archive the old entries, import into the new profile, done. Any prompt the
// caller wants delivered is sent afterwards through the app's own native message channel, which
// boots the chat's engine in the app where the owner can watch it.
app.post('/api/sessions/:id/migrate', async (c) => {
  const sessionId = c.req.param('id')
  const body = await jsonBody(c)
  const ref = typeof body.instance_ref === 'string' ? body.instance_ref.trim() : ''
  if (!ref.startsWith('desktop:'))
    return c.json({ ok: false, error: "instance_ref ('desktop:<dir>') is required" }, 400)
  // Optional prompt override. The same-instance variant of this endpoint is the REVIVE path for
  // an imported chat the owner never clicked (live-but-deaf to peer messages, measured): kill
  // its passive process, run the caller's message as the resume turn, land it back imported —
  // the nudge gets delivered through the front door instead of queueing into a void.
  const prompt =
    typeof body.prompt === 'string' && body.prompt.trim()
      ? body.prompt.trim().slice(0, 8000)
      : MIGRATION_NOTICE
  const s = await getSession(sessionId, 'claude')
  if (!s) return c.json({ ok: false, error: 'session not found' }, 404)
  // What the chat WAS SET TO, read before anything below touches its record: model, effort, the
  // ultracode toggle, the Chrome permission mode, its permission grants (chat-settings-carry.ts).
  // The app's import creates the target record with defaults, and the owner was putting these
  // back by hand on every moved chat (2026-09-03, 13 of 16 reset). The whole source record is kept
  // too: a CLOSED target receives a copy of it rather than an app-created record. Read before the
  // title door because the record's own `title` is one of the two names that door accepts.
  const sourceRendered = findDesktopChatMeta(sessionId)
  let sourceMeta: Record<string, unknown> = {}
  try {
    if (sourceRendered?.path)
      sourceMeta = JSON.parse(readFileSync(sourceRendered.path, 'utf8')) as Record<string, unknown>
  } catch {
    // an unreadable source record means nothing to carry; the move still proceeds
  }
  const carried = pickCarriedSettings(sourceMeta)
  // THE NAMING REQUIREMENT (owner directive, 2026-08-29): a migration is a landing, so the
  // same contract as import-desktop - a real new title, or the current one restated exactly.
  // "Current" is either name the chat goes by right now: the session list's transcript-derived
  // title, or the desktop record's own (what the app's sidebar and the Instances "Chats" list
  // show, and so what a person planning a move from there has actually read).
  const migrateTitle = resolveRequiredTitle({
    title: body.title,
    confirmTitle: body.confirm_title,
    currentTitle: s.title ?? null,
    recordTitle: typeof sourceMeta.title === 'string' ? sourceMeta.title : null,
  })
  if (!migrateTitle.ok) return c.json({ ok: false, error: migrateTitle.error }, 400)
  // One lineage, one continuation — checked BEFORE the kill below, so a refused migrate never
  // leaves the thread stopped. A done-marked session was already handed off or migrated; moving
  // it again would spin up a second continuation of work its successor owns.
  if (body.force !== true && isSessionSuperseded(sessionId))
    return c.json(
      {
        ok: false,
        error:
          'superseded: session is done-marked (already handed off/migrated); migrating would duplicate its successor — pass force:true only if you have verified there is no successor',
      },
      409,
    )

  // A live chat's process must stop before anything appends to its transcript. User-initiated:
  // clicking "migrate" means "move this thread", current turn included.
  const live = liveSessionEntry(sessionId)
  // ...unless the caller declined the kill (`stop_live: false`), which the MCP move tool passes.
  // A person clicking migrate has the chat in front of them; an agent calling the tool has not
  // watched it, so it gets the import door's refusal instead of silently ending someone's turn.
  // Same shape and wording as importSessionToDesktop's, so the caller-facing error is unchanged.
  if (live && body.stop_live === false)
    return c.json(
      { ok: false, reason: 'session-live: refusing to import under an active writer' },
      422,
    )
  if (live) {
    try {
      process.kill(live.pid)
    } catch {
      // Already exiting — the wait below settles it either way.
    }
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && liveSessionEntry(sessionId)) {
      await new Promise((r) => setTimeout(r, 250))
    }
    if (liveSessionEntry(sessionId))
      return c.json({ ok: false, error: 'could not stop the live session process' }, 409)
  }

  // LAND FIRST, VERIFY BY READ-BACK, AND ONLY THEN ARCHIVE THE SOURCE (2026-09-08). This route
  // used to archive the source's rows BEFORE importing, on the theory that the failure of an app
  // import is not always knowable. That ordering is exactly what turned every failure into a
  // vanished chat: the hot import answers ok when its 20s stamp wait runs out with no record
  // (stampImportedChat's `false` is "not titled", not "not landed"), a target app busy with the
  // previous chat of a bulk move regularly takes longer than that, an engine the app respawned
  // on the source got the import refused as a live writer, and in every one of those cases the
  // source was already archived, the target held nothing, and the UI counted the chat as moved.
  // The orchestrator's migrate_chat never had this bug because it verifies the landing and settles
  // the source afterwards; the route now does the same. A landing that cannot be verified leaves
  // the chat where it was and says so; if the app creates the row late, the chat shows on both
  // accounts, visibly, and the next move of it finds the target's copy and just settles the source.
  //
  // NO CONSOLE IN AUTOMATION (owner ruling, 2026-08-29): every migration lands in the
  // target desktop app - the old terminal fallback for homeless threads is gone. Console is
  // only ever for chats a person deliberately created in a console.
  // Desktop surface: the thread lands in the target instance's app as a chat, dormant. The
  // daemon has no messaging tools of its own, so the PROMPT is not delivered here — an
  // interactive caller delivers it through the app's own message channel, which BOOTS the
  // dormant chat's engine and runs the turn in the app (measured 2026-08-26). No click is
  // involved, and no headless process is created.
  //
  // TWO LANDINGS, chosen by whether the target app is running (owner ask, 2026-09-03):
  //   · running -> the app's own import creates the record; the carried settings are merged onto
  //     it with the title and the bypass stamp, and remembered so the sweep keeps them there until
  //     that app's next start makes them permanent.
  //   · closed  -> the record is written straight into the target's store, a near-copy of the
  //     source's, and the app finds it there - settings intact - when it starts. No boot, nothing
  //     to fight. This used to be refused outright ("importing would boot that instance"); the
  //     refusal still holds for the app import, and this is the path that does not need one.
  const targetDir = ref.slice('desktop:'.length)
  const targetRunning = (await listInstances()).some(
    (i) => i.isRunning && samePathKey(i.dir, targetDir),
  )
  let landing: 'hot' | 'cold'
  // Records of this chat under a PREVIOUS login of the target, moved into the backup dir so the
  // landing is the only record there (session-launch.ts setAsideStaleLoginRecords).
  let staleLoginSetAside: string[] = []
  if (targetRunning) {
    landing = 'hot'
    const imported = await importSessionToDesktop({
      sessionId,
      instanceDir: targetDir,
      title: migrateTitle.title,
      force: body.force === true,
      carried,
    })
    if (!imported.ok) return c.json({ ok: false, error: imported.reason ?? 'import failed' }, 422)
    staleLoginSetAside = imported.staleLoginSetAside ?? []
    if (Object.keys(carried).length) rememberMigratedSettings(sessionId, targetDir, carried)
  } else {
    landing = 'cold'
    const cold = await coldImportSessionToDesktop({
      sessionId,
      instanceDir: targetDir,
      title: migrateTitle.title,
      sourceMeta,
      force: body.force === true,
    })
    if (!cold.ok) return c.json({ ok: false, error: cold.reason ?? 'cold import failed' }, 422)
    staleLoginSetAside = cold.staleLoginSetAside ?? []
  }
  // The proof: the target's store holds the record. The hot import already waited up to 20s for
  // it; this grants the app another 25s (a bulk move keeps it busy) before the move is called
  // unverified. The cold path wrote the file itself, so its read-back is immediate.
  const landedPath = await awaitChatRecord(targetDir, sessionId, {
    deadlineMs: landing === 'hot' ? 25_000 : 5_000,
  })
  if (!landedPath) {
    invalidateSessionMetaCache()
    return c.json(
      {
        ok: false,
        error:
          landing === 'hot'
            ? 'landing-unverified: the target app did not create the chat record within 45s of the import; the chat was left on its current account - retry once the app is idle'
            : 'landing-unverified: the record written into the closed target could not be read back; the chat was left on its current account',
      },
      422,
    )
  }
  // A move INTO an account that still holds an ARCHIVED copy (the chat lived there before and was
  // moved away): the app's import may reuse that record rather than create one, and nothing on
  // the hot path writes isArchived=false, so the move used to complete with the chat hidden on
  // the account it had just arrived at. Exactly the record that landed, never a session-wide
  // flip, so an unrelated twin in the same store is not resurrected beside it.
  const targetUnarchived = unarchiveChatRecord(landedPath)

  // THE NAME HAS TO SURVIVE THE MOVE TOO (owner report, 2026-09-09: chats arriving on the new
  // account called "General coding session"). The hot landing's title is a single disk write into
  // a store the RUNNING target app is holding in memory - where the import handler left the title
  // unset - so the app's first re-save of that chat blanks it, and the sidebar renders the blank
  // as the app's generic label. `titleDurable: !running` has always reported this honestly and
  // nothing acted on it. The same bounded watcher shape as the archive flag above, aimed at the
  // TARGET, and it writes only over a non-name, so an owner who renames the chat in the app
  // during the window keeps their name (reassertChatTitle's header has the full reasoning).
  // Cold landings need none of this: nothing is running there to re-save over the record.
  if (landing === 'hot')
    void reassertChatTitle(targetDir, sessionId, migrateTitle.title).catch(() => {})

  // Old desktop entries: flagged archived NOW, after the landing is proven.
  //
  // EVERY OTHER PROFILE - NEVER THE TARGET'S OWN (bug, reproduced live 2026-09-04). This used to
  // call archiveDesktopChat with no roots, which walks the default profile plus every isolated
  // instance and flips the flag in each store that carries the chat, the TARGET included, and
  // nothing downstream put it back. Excluding the target fixes it upstream, where no write is
  // made at all, rather than by racing the running app with a corrective write it re-saves over.
  const archived0 = await archiveDesktopChat(sessionId, true, archiveRootsForMove(targetDir)).catch(
    () => null,
  )
  // The move rewrote metadata in TWO stores (created in the target, archived in the source), and
  // the scan behind every session listing caches for 15s. Without this the very next read serves
  // the pre-migrate rows: the caller sees the chat still on the old account, and setPreferred
  // never gets to pick the live copy over the source's fresh tombstone.
  invalidateSessionMetaCache()
  // THE DURABLE FIX for the zombie twin (owner ask, 2026-09-01): a RUNNING source app
  // re-saves isArchived=false within seconds and resurrects the stale row. For each source
  // profile whose app was running, fire a bounded background watcher that keeps the flag true
  // until the app's next boot makes it stick. Fire-and-forget: it must never delay the
  // migrate's own response, and its own caps bound it. Started only here, after the landing is
  // verified: a watcher started before a failed landing would re-hide the chat the failure had
  // left in place. The TARGET dir is excluded so the fresh import is never touched — belt and
  // braces now that the archive above cannot reach it either.
  for (const hit of archived0?.hits ?? []) {
    if (!hit.changed || !hit.wasRunning) continue
    if (samePathKey(hit.profile, targetDir)) continue
    void reassertChatArchive(hit.profile, sessionId).catch(() => {})
  }
  return c.json({
    ok: true,
    surface: 'desktop',
    landing,
    // Read back from the target's store, not taken from the import's own word.
    verified: true,
    landedPath,
    targetUnarchived,
    ...(staleLoginSetAside.length ? { staleLoginSetAside } : {}),
    sourceArchived: (archived0?.hits ?? []).filter((h) => h.changed).map((h) => h.profile),
    carried: Object.keys(carried),
    stoppedLive: !!live,
    ranHeadless: false,
    // Owner ask 2026-09-03: a migrated chat should come up armed the way a new one does. The
    // bypass half is the metadata stamp above (durable now via automation-stamp-sweep.ts); the
    // ultracode half is a KEYWORD in the first prompt, so it can only ride on a prompt something
    // actually delivers. This route delivers none itself - the caller does, through the app - so
    // the prompt it hands back carries the keyword when the new-chat default is on. A person who
    // opens the chat and types their own first message is typing the keyword themselves, or not;
    // nothing here can reach into the desktop composer.
    prompt: newChatUltracodeEnabled() ? withUltracode(prompt) : prompt,
    promptDelivery: 'deliver-natively-via-the-app-message-channel (boots the chat; no click)',
  })
})

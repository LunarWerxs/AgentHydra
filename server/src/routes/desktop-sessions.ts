import { readFileSync } from 'node:fs'
import { pickCarriedSettings } from '../chat-settings-carry'
import { resolveRequiredTitle } from '../chat-title'
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
  coldImportSessionToDesktop,
  desktopHomeFor,
  importSessionToDesktop,
  isSessionSuperseded,
  launchTerminalSession,
  liveSessionEntry,
  reassertChatArchive,
} from '../session-launch'
import { getSession } from '../sessions'

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
  const imported = await getSession(sessionId, 'claude')
  const titled = resolveRequiredTitle({
    title: body.title,
    confirmTitle: body.confirm_title,
    currentTitle: imported?.title ?? null,
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
// profile that carries it. Honest caveat in the response: for a profile whose app was running,
// the change shows only after that instance next restarts (and could be re-saved away by the
// running app; the AgentHydra done-mark is the immediate signal either way).
app.post('/api/sessions/:id/desktop-archive', async (c) => {
  const body = await jsonBody(c)
  const sessionId = c.req.param('id')
  const result = await archiveDesktopChat(sessionId, body.archived !== false)
  // SAY when the flag landed under a running app, rather than returning a bare ok:true for a
  // chat the owner can still see. Measured 2026-08-26 by asking the app itself right after
  // this call: disk said archived, the app still reported isArchived:false, and the chat
  // stayed in the sidebar. Reporting that as success is how "archived" came to mean "still
  // there".
  const underRunningApp = (result.hits ?? []).some((h) => h.changed && h.wasRunning)
  // THE DURABLE FIX BELONGS HERE TOO (owner, 2026-09-01: "it's also duplicating chats"). A
  // RUNNING app re-saves isArchived=false within seconds and resurrects the row it was just
  // told to put away — so a chat archived on its old account came back and appeared in BOTH
  // apps at once. /migrate already fired this watcher; this route did not, and this route is
  // what every archive and every account move actually goes through. Fire-and-forget: it must
  // not delay the response, and its own caps bound it.
  for (const hit of result.hits ?? []) {
    if (!hit.changed || !hit.wasRunning) continue
    void reassertChatArchive(hit.profile, sessionId).catch(() => {})
  }
  if (underRunningApp)
    return c.json({
      ...result,
      visibleNow: false,
      note:
        'the flag is written, but that app is RUNNING and holds its chat list in memory, so ' +
        'the chat is STILL ON SCREEN until that instance next restarts. To retire it ' +
        "immediately, archive it through the app's own UI - misc/Manage-DesktopChat.ps1 " +
        'automates exactly that click and verifies it landed.',
    })
  return c.json(result, result.ok ? 200 : 404)
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
  // THE NAMING REQUIREMENT (owner directive, 2026-08-29): a migration is a landing, so the
  // same contract as import-desktop - a real new title, or the current one restated exactly.
  const migrateTitle = resolveRequiredTitle({
    title: body.title,
    confirmTitle: body.confirm_title,
    currentTitle: s.title ?? null,
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

  // What the chat WAS SET TO, read before anything below touches its record: model, effort, the
  // ultracode toggle, the Chrome permission mode, its permission grants (chat-settings-carry.ts).
  // The app's import creates the target record with defaults, and the owner was putting these
  // back by hand on every moved chat (2026-09-03, 13 of 16 reset). The whole source record is kept
  // too: a CLOSED target receives a copy of it rather than an app-created record.
  const sourceRendered = findDesktopChatMeta(sessionId)
  let sourceMeta: Record<string, unknown> = {}
  try {
    if (sourceRendered?.path)
      sourceMeta = JSON.parse(readFileSync(sourceRendered.path, 'utf8')) as Record<string, unknown>
  } catch {
    // an unreadable source record means nothing to carry; the move still proceeds
  }
  const carried = pickCarriedSettings(sourceMeta)

  // A live chat's process must stop before anything appends to its transcript. User-initiated:
  // clicking "migrate" means "move this thread", current turn included.
  const live = liveSessionEntry(sessionId)
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

  // Old desktop entries: flagged archived now, BEFORE the import creates the fresh entry in
  // the target profile.
  const archived0 = await archiveDesktopChat(sessionId, true).catch(() => null)
  // ...and the meta cache dropped NOW, not only after the import: within the scan cache's
  // 15s TTL, importSessionToDesktop's alreadyRendered check could read the PRE-archive rows
  // and skip the reimport entirely while this handler still answered ok (adversarial review
  // finding, 2026-08-31; bit live 2026-09-01).
  invalidateSessionMetaCache()
  // THE DURABLE FIX for the zombie twin (owner ask, 2026-09-01): a RUNNING source app
  // re-saves isArchived=false within seconds and resurrects the stale row. For each source
  // profile whose app was running, fire a bounded background watcher that keeps the flag true
  // until the app's next boot makes it stick. Fire-and-forget: it must never delay the
  // migrate's own response, and its own caps bound it. The TARGET dir is excluded so the
  // fresh import is never touched.
  const targetDir = ref.slice('desktop:'.length)
  for (const hit of archived0?.hits ?? []) {
    if (!hit.changed || !hit.wasRunning) continue
    if (samePathKey(hit.profile, targetDir)) continue
    void reassertChatArchive(hit.profile, sessionId).catch(() => {})
  }

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
  const targetRunning = (await listInstances()).some(
    (i) => i.isRunning && samePathKey(i.dir, targetDir),
  )
  let landing: 'hot' | 'cold'
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
    if (!cold.ok) {
      // The source was archived above and the chat has landed nowhere: put it back where it was
      // rather than leave a thread that shows in no app. The hot path cannot do this (its import
      // is a spawn whose failure is not always knowable); this one can.
      await archiveDesktopChat(sessionId, false).catch(() => null)
      invalidateSessionMetaCache()
      return c.json({ ok: false, error: cold.reason ?? 'cold import failed' }, 422)
    }
  }
  // The move rewrote metadata in TWO stores (archived in the source, created in the target), and
  // the scan behind every session listing caches for 15s. Without this the very next read serves
  // the pre-migrate rows: the caller sees the chat still on the old account, and setPreferred
  // never gets to pick the live copy over the source's fresh tombstone.
  invalidateSessionMetaCache()
  return c.json({
    ok: true,
    surface: 'desktop',
    landing,
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

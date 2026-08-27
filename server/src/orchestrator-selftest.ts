// server/src/orchestrator-selftest.ts - does the orchestration actually do what it claims, HERE?
//
// WHY THIS EXISTS, and why the unit tests are not it. Every rail in this feature was added
// because something silently did the wrong thing on the owner's real machine, and in almost
// every case the unit tests were green throughout:
//   · the surface-purity guard looked correct and was blind to 98.7% of his desktop chats,
//     because every chat it was tested against happened to be the rare imported kind;
//   · the app-restart guard had NEVER matched a live session, so it read as "safe" for weeks
//     and then quit an app under a running chat;
//   · imported chats were created in a permission mode that freezes them on their first shell
//     command, which no test could see because tests never boot the app.
// The common shape: a check that passes against fakes and fails against this disk, this app,
// this fleet. So this runs the real functions against REAL state, and reports what it found.
//
// SAFETY, which is the whole reason it can be run whenever you like (owner ask: "preferably
// don't break any of my active chats"). Every artifact it touches is one it created:
//   · sessions are `selftest-<uuid>` ids that exist nowhere but here;
//   · desktop metadata is written into a throwaway directory, never a real instance store;
//   · nothing is imported into, archived in, or messaged in a real app unless `deep` is asked
//     for, and even then it is a chat this file seeded, in a temp cwd, archived on the way out;
//   · the one dispatch it performs is expected to be REFUSED before any process spawns. If the
//     guard were broken it would launch `claude --resume selftest-...` against a session that
//     does not exist, which fails immediately - a loud, harmless way to discover the guard is
//     broken, which is exactly what you would want to know.
// It never reads or writes a real chat's transcript, and it cleans up after itself.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from './db'
import {
  getOrchestratorPrompts,
  ORCHESTRATOR_PROMPT_DEFAULTS,
  orchestratorView,
} from './orchestrator'
import { decideProposal, getProposal, proposeAction, reportProposalExecuted } from './proposals'
import {
  applyDesktopChatAutomation,
  applyDesktopChatTitle,
  archiveDesktopChat,
  desktopChatArchiveState,
  desktopHomeFor,
  importSessionToDesktop,
} from './session-launch'

export interface SelfTestCheck {
  /** Stable id, so a result can be compared run to run. */
  id: string
  /** What this proves, in the terms of the failure it exists to catch. */
  what: string
  ok: boolean
  /** What actually happened - populated on pass AND fail, because "how did it pass" matters. */
  detail: string
}

export interface SelfTestReport {
  ok: boolean
  ranAt: string
  durationMs: number
  passed: number
  failed: number
  /** True when the app-touching checks ran too (they create and archive one real chat). */
  deep: boolean
  /**
   * ALWAYS false, and stated rather than implied: nothing here looks at the screen.
   *
   * It verifies what is on DISK - the flag flipped, the title was written, the guard refused.
   * Whether the sidebar then SHOWS that is a different question, and the gap between the two is
   * where this feature's worst failures lived: titles written correctly and wiped by the app
   * seconds later, archive flags flipped under a running app that never repainted. The
   * `screen-lag` check below measures how much is currently stuck behind that glass, which is
   * the closest a process outside the app can honestly get. Confirming what is actually
   * rendered needs the app's own view (the reviewer's session tools) or a screenshot.
   */
  visualChecks: false
  /** A deep run leaves a PNG of the screen here. READ IT - it is the only thing in this report
   *  that can answer whether the sidebar matches what disk claims. */
  screenshotPath?: string
  checks: SelfTestCheck[]
}

/** A sacrificial session id. Prefixed so it is obvious in any log, ledger or store that this
 *  was never a conversation. */
function fakeSessionId(): string {
  return `selftest-${crypto.randomUUID()}`
}

export async function runOrchestratorSelfTest(
  opts: { deep?: boolean } = {},
): Promise<SelfTestReport> {
  const startedAt = Date.now()
  const checks: SelfTestCheck[] = []
  const add = (id: string, what: string, ok: boolean, detail: string) =>
    checks.push({ id, what, ok, detail })

  // One throwaway instance store, shaped exactly like a real one, for every residency check.
  const root = mkdtempSync(join(tmpdir(), 'agenthydra-selftest-'))
  const store = join(root, 'claude-code-sessions', 'org-selftest', 'user-selftest')
  mkdirSync(store, { recursive: true })
  const cleanup: Array<() => void> = [() => rmSync(root, { recursive: true, force: true })]

  try {
    // --- 1. a watcher pass runs to completion, right now ----------------------
    // Deliberately RUNS one rather than reading how long ago the last one was: a freshly started
    // daemon has legitimately never ticked, so the passive version reported a failure that was
    // only ever a stopwatch reading. Running it proves the thing that matters - the pass
    // completes over this machine's real state without throwing - and it is what the daemon
    // does every 60 seconds anyway.
    try {
      const { runOrchestratorOnce } = await import('./orchestrator')
      const t0 = Date.now()
      await runOrchestratorOnce()
      const view = orchestratorView()
      add(
        'watcher-pass-completes',
        'a full watch of this machine runs end to end without failing',
        view.settings.enabled && view.meta.lastTickAt !== null,
        view.settings.enabled
          ? `pass took ${Date.now() - t0}ms over ${view.meta.liveSessions} live session(s), producing ${view.attention.length} item(s) and ${view.meta.proposalsPending} open proposal(s)`
          : 'the orchestrator is switched OFF, so nothing is being watched',
      )
    } catch (err) {
      add('watcher-pass-completes', 'a full watch runs end to end', false, String(err))
    }

    // --- 2. residency, BOTH on-disk shapes ------------------------------------
    // The one that got away: a chat IMPORTED into the app is filed under the CLI id, a chat
    // CREATED in the app is filed under the app's own id with the CLI id inside. A guard that
    // knows only the first shape is blind to almost every chat the owner has.
    const importedId = fakeSessionId()
    const createdId = fakeSessionId()
    writeFileSync(
      join(store, `local_${importedId}.json`),
      JSON.stringify({ cliSessionId: importedId, isArchived: false }),
    )
    writeFileSync(
      join(store, `local_${crypto.randomUUID()}.json`),
      JSON.stringify({ cliSessionId: createdId, isArchived: false }),
    )
    const foundImported = desktopChatArchiveState(importedId, [root]).found
    const createdVisible = desktopChatArchiveState(createdId, [root]).found
    add(
      'residency-imported-shape',
      'a chat filed under the CLI id is recognised as living in a desktop app',
      foundImported,
      foundImported ? 'found by filename' : 'NOT FOUND - the filename lookup is broken',
    )
    add(
      'residency-created-shape',
      'a chat filed under the APP id (the 98.7% case) is recognised too',
      createdVisible,
      createdVisible
        ? 'found by reading cliSessionId out of the file'
        : 'NOT FOUND - this is the shape almost every real chat has',
    )

    // --- 3. the surface-purity guard, asked about the owner's REAL chats -------
    // This is the check that would have caught the worst bug of the lot, and it can only be
    // made against real state: the guard was asked "does this live in a desktop app?" and
    // answered NO for 1,325 of 1,343 real chats, because it matched filenames and almost every
    // real chat is filed the other way. A fixture cannot notice that; a sample of this disk can.
    // Read-only by construction - it looks up ids, it never dispatches anything at a real chat.
    try {
      const { sessionMetaMap } = await import('./instance-sessions')
      const real = [...sessionMetaMap().keys()].slice(0, 25)
      if (real.length === 0) {
        add(
          'guard-sees-real-chats',
          'the surface guard recognises the chats that actually exist on this machine',
          true,
          'no desktop chats on this machine to sample',
        )
      } else {
        const resolved: string[] = []
        for (const id of real) if ((await desktopHomeFor(id)) !== null) resolved.push(id)
        add(
          'guard-sees-real-chats',
          'the surface guard recognises the chats that actually exist on this machine',
          resolved.length === real.length,
          `${resolved.length}/${real.length} sampled real chats recognised as desktop-resident` +
            (resolved.length === real.length
              ? ''
              : ' - any miss is a chat that could be continued headlessly'),
        )
      }
      // And the inverse, which is what stops the guard from refusing everything: an id that
      // belongs to no desktop chat must come back as not-resident, or every queue run dies.
      const nowhere = await desktopHomeFor(fakeSessionId())
      add(
        'guard-allows-non-desktop',
        'a session that lives in no app is NOT falsely refused (queue runs still work)',
        nowhere === null,
        nowhere === null ? 'unknown id correctly reports no desktop home' : `claimed ${nowhere}`,
      )
    } catch (err) {
      add('guard-sees-real-chats', 'the surface guard recognises real chats', false, String(err))
    }

    // --- 4. the action gate: decide BEFORE execute, enforced ------------------
    const gateId = fakeSessionId()
    try {
      const pid = proposeAction({
        kind: 'revive',
        sessionId: gateId,
        summary: 'orchestrator self-test (sacrificial proposal)',
        evidence: { selftest: true },
        evidenceAt: new Date().toISOString(),
      })
      cleanup.push(() => {
        db.query('delete from orchestrator_proposals where session_id = ?').run(gateId)
      })
      const earlyExecute = pid ? reportProposalExecuted(pid, true, 'selftest') : { ok: true }
      add(
        'gate-refuses-undecided',
        'an action cannot be executed before the AI has ruled on it',
        !!pid && !earlyExecute.ok,
        !pid
          ? 'the proposal was not created at all'
          : earlyExecute.ok
            ? 'ACCEPTED an execution on an undecided proposal - the gate is open'
            : `refused: ${(earlyExecute as { reason?: string }).reason}`,
      )
      const decided = pid ? decideProposal(pid, true, 'selftest', 'sacrificial') : { ok: false }
      const executed = pid ? reportProposalExecuted(pid, true, 'selftest') : { ok: false }
      const finalState = pid ? getProposal(pid)?.status : undefined
      add(
        'gate-allows-decided',
        'once ruled on, the approved action can be executed and is recorded',
        decided.ok && executed.ok && finalState === 'executed',
        `decided=${decided.ok} executed=${executed.ok} finalState=${finalState}`,
      )
      const doubleDecide = pid ? decideProposal(pid, false, 'selftest') : { ok: true }
      add(
        'gate-ruling-is-final',
        'a second ruling cannot silently overwrite the first',
        !doubleDecide.ok,
        doubleDecide.ok ? 'ACCEPTED a second ruling' : 'refused, as it must',
      )
    } catch (err) {
      add('gate-refuses-undecided', 'the action gate is enforced', false, String(err))
    }

    // --- 5. archive + title + automation writes, on the throwaway store -------
    try {
      const before = desktopChatArchiveState(importedId, [root])
      const flipped = await archiveDesktopChat(importedId, true, [root], async () => false)
      const after = desktopChatArchiveState(importedId, [root])
      await archiveDesktopChat(importedId, false, [root], async () => false)
      add(
        'archive-roundtrip',
        'archiving a chat flips the flag the app reads, and unarchiving puts it back',
        flipped.ok && !before.archived && after.archived,
        `before=${before.archived} after=${after.archived} hits=${flipped.hits.length}`,
      )
    } catch (err) {
      add('archive-roundtrip', 'archiving flips the flag the app reads', false, String(err))
    }
    try {
      const titled = applyDesktopChatTitle(root, importedId, 'Self-test title')
      const meta = JSON.parse(readFileSync(join(store, `local_${importedId}.json`), 'utf8'))
      add(
        'title-write',
        'a chat can be given its real name instead of showing as untitled',
        titled === 'titled' && meta.title === 'Self-test title',
        `outcome=${titled} storedTitle=${JSON.stringify(meta.title)}`,
      )
      const stamped = applyDesktopChatAutomation(root, importedId)
      const meta2 = JSON.parse(readFileSync(join(store, `local_${importedId}.json`), 'utf8'))
      add(
        'automation-stamp',
        'a revived chat is set to run unattended, so it cannot freeze on an approval prompt',
        stamped && meta2.permissionMode === 'bypassPermissions',
        `stamped=${stamped} permissionMode=${JSON.stringify(meta2.permissionMode)}`,
      )
    } catch (err) {
      add('title-write', 'a chat can be given its real name', false, String(err))
    }

    // --- 6. imports refuse the two things that would corrupt a thread ---------
    try {
      const closed = await importSessionToDesktop({
        sessionId: fakeSessionId(),
        instanceDir: root,
        isLive: () => false,
        isInstanceRunning: async () => false,
      })
      add(
        'import-refuses-closed-instance',
        'importing never boots an account that the owner left closed',
        !closed.ok && (closed.reason ?? '').includes('instance-not-running'),
        closed.reason ?? 'ACCEPTED an import into a closed instance',
      )
      const live = await importSessionToDesktop({
        sessionId: fakeSessionId(),
        instanceDir: root,
        isLive: () => true,
        isInstanceRunning: async () => true,
      })
      add(
        'import-refuses-live-session',
        'importing never rewrites a transcript while something is writing to it',
        !live.ok && (live.reason ?? '').includes('session-live'),
        live.reason ?? 'ACCEPTED an import over a live session',
      )
    } catch (err) {
      add('import-refuses-closed-instance', 'imports refuse unsafe targets', false, String(err))
    }

    // --- 7. the messages the machinery sends still exist ----------------------
    try {
      const prompts = getOrchestratorPrompts()
      const keys = Object.keys(ORCHESTRATOR_PROMPT_DEFAULTS)
      const empty = keys.filter((k) => !(prompts as Record<string, string>)[k]?.trim())
      add(
        'prompts-resolve',
        'every message the orchestrator can send has text (an edit cannot blank one out)',
        empty.length === 0,
        empty.length === 0 ? `${keys.length} prompts resolve` : `EMPTY: ${empty.join(', ')}`,
      )
    } catch (err) {
      add('prompts-resolve', 'every orchestrator message has text', false, String(err))
    }

    // --- 8. the reviewer half is installed where Claude will find it ----------
    try {
      const { homedir } = await import('node:os')
      const cmd = join(homedir(), '.claude', 'commands', 'orchestrate.md')
      const present = existsSync(cmd)
      add(
        'reviewer-command-installed',
        'the /orchestrate command exists, so the judgment half can actually be started',
        present,
        present ? cmd : 'MISSING - /orchestrate would not resolve',
      )
    } catch (err) {
      add('reviewer-command-installed', '/orchestrate is installed', false, String(err))
    }

    // --- 9. how much is stuck behind the glass right now ---------------------
    // The honest version of "did it show up?". A metadata change written while its app was
    // already running is on disk but not necessarily on screen: the app holds its chat list in
    // memory and repaints at startup. That is not a theory - it is how five correctly-titled
    // chats displayed as "General coding session", and how an archived chat kept sitting in the
    // sidebar. Deterministic to measure: compare each metadata file's mtime against the start
    // time of the app that owns it.
    try {
      const { listInstances } = await import('./core/instances')
      const running = (await listInstances()).filter((i) => i.isRunning && i.startTime)
      let pending = 0
      const names: string[] = []
      for (const inst of running) {
        const startedMs = Date.parse(inst.startTime as string)
        if (Number.isNaN(startedMs)) continue
        const dir = join(inst.dir, 'claude-code-sessions')
        if (!existsSync(dir)) continue
        let n = 0
        for (const org of readdirSync(dir, { withFileTypes: true })) {
          if (!org.isDirectory()) continue
          for (const user of readdirSync(join(dir, org.name), { withFileTypes: true })) {
            if (!user.isDirectory()) continue
            const d = join(dir, org.name, user.name)
            for (const f of readdirSync(d)) {
              if (!f.startsWith('local_') || !f.endsWith('.json')) continue
              try {
                if (statSync(join(d, f)).mtimeMs > startedMs) n++
              } catch {
                // a file that vanished mid-scan is not pending anything
              }
            }
          }
        }
        // The app re-saves its OWN metadata constantly, so a nonzero count is normal and only
        // the shape of it is informative. Reported, never failed on: a check that goes red
        // during ordinary use is one you learn to ignore.
        if (n > 0) {
          pending += n
          names.push(`${inst.label ?? inst.name}:${n}`)
        }
      }
      add(
        'screen-lag',
        'how many desktop chats have on-disk changes their running app may not be showing yet',
        true,
        running.length === 0
          ? 'no desktop app is running, so nothing can be stale on screen'
          : `${pending} chat file(s) changed since their app started (${names.join(', ') || 'none'}) - informational: the app rewrites its own metadata constantly, and the visibility restart is what forces a repaint`,
      )
    } catch (err) {
      add('screen-lag', 'how much is stuck behind the glass', false, String(err))
    }

    // --- 10. DEEP: seed a real desktop chat, prove it is visible, retire it ----
    // Off by default because it leaves (and then archives) one real chat. It is the only check
    // that exercises the app itself, which is where every silent failure has come from.
    if (opts.deep) {
      const seedCwd = mkdtempSync(join(tmpdir(), 'agenthydra-selftest-cwd-'))
      cleanup.push(() => rmSync(seedCwd, { recursive: true, force: true }))
      try {
        const { seedDesktopSession } = await import('./session-launch')
        const { listInstances } = await import('./core/instances')
        const target = (await listInstances()).find((i) => i.isRunning)
        if (!target) {
          add(
            'seed-visible-chat',
            'the orchestrator can create a chat the owner can see',
            false,
            'no desktop instance is running, so there is nowhere to put one',
          )
        } else {
          const seeded = await seedDesktopSession({
            cwd: seedCwd,
            title: 'AgentHydra self-test (sacrificial, archives itself)',
            instanceRef: `desktop:${target.dir}`,
          })
          const home = seeded.sessionId ? await desktopHomeFor(seeded.sessionId) : null
          add(
            'seed-visible-chat',
            'the orchestrator can create a chat that is genuinely visible in the app',
            seeded.ok && home !== null,
            seeded.ok
              ? `seeded ${seeded.sessionId?.slice(0, 8)} into ${target.name}, visible=${home !== null}`
              : (seeded.reason ?? 'seed failed'),
          )
          if (seeded.sessionId) {
            await archiveDesktopChat(seeded.sessionId, true).catch(() => null)
            db.query(
              'insert into session_marks (session_id, done, updated_at) values (?, 1, ?) on conflict(session_id) do update set done = 1',
            ).run(seeded.sessionId, Date.now())
          }
        }
      } catch (err) {
        add('seed-visible-chat', 'the orchestrator can create a visible chat', false, String(err))
      }
    }
  } finally {
    for (const fn of cleanup) {
      try {
        fn()
      } catch {
        // Cleanup is best-effort: a temp dir left behind must never fail the report.
      }
    }
  }

  // A deep run ends with a photograph. It proves nothing on its own - nothing here reads
  // pixels - but it means the one question this report cannot answer ("is that actually what
  // the sidebar shows?") has an artifact attached to it instead of a shrug.
  let screenshotPath: string | undefined
  if (opts.deep) {
    try {
      const { captureScreen } = await import('./screenshot')
      const shot = await captureScreen()
      if (shot.ok) screenshotPath = shot.path
    } catch {
      // A failed capture must never fail the report; the absent path says it did not happen.
    }
  }

  const failed = checks.filter((c) => !c.ok).length
  return {
    ok: failed === 0,
    visualChecks: false,
    screenshotPath,
    ranAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    passed: checks.length - failed,
    failed,
    deep: !!opts.deep,
    checks,
  }
}

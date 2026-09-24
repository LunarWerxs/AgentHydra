// server/src/ui-archive.ts - the SERVER-SIDE invocation of the app's own Archive click
// (misc/Manage-DesktopChat.ps1). Owner ruling 2026-08-30 ("I will defer to your recommendation
// and say yes"): when auto-archive writes a flag under a RUNNING app, the server itself retires
// the row through the app's UI - immediate and durable, because the app makes the write - so
// the chat leaves the sidebar now, not at some future restart.
//
// SAFETY RAILS, each one bought by a measured failure:
//   - The tool acts on RENDERED titles, and a rendered title is an IN-MEMORY name that can
//     differ from the disk title (the piece-9 drill: disk said the real name, the sidebar said
//     'General coding session'). So the click fires only when the chat's DISK title is a real
//     name that the sidebar actually renders - and the hazard that matters is a DIFFERENT chat
//     sharing the title, which DISK answers: if more than one metadata file in the store
//     carries this title, refuse. The same chat rendered in two sidebar sections (measured
//     live: one import rendered twice) is safe - every matching row is the one chat.
//   - After a click that the tool reports as done, the archive is verified BY ID on disk (the
//     app's own archive re-saves the metadata), because verified-by-title is the mistake the
//     drill-cleanup lesson exists to prevent. A chat already archived on disk with no rendered
//     row is reported as settled, not as a failure.

import { readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { isGenericChatTitle } from './chat-title'
import { collectChats } from './core/chat-store-scan'
import { spawnCaptured } from './core/process.ts'
import { instanceDirForLabel } from './instance-sessions'
import { CHAT_MANAGER_FILE, resolveMiscAsset } from './misc-assets'
import { findChatMetaPath } from './session-launch'

/**
 * Callers pass either an instance LABEL ('temp1' - what a chat record and the dossier carry) or
 * an absolute profile dir. The actuator resolves both, and the disk reads below did NOT.
 *
 * ⛔ A label therefore read no store at all and every count came back 0 - indistinguishable from
 * a real miss, and silently: measured 2026-09-15, chat_rename refused a chat whose row the app
 * had drawn twice, because its live-title count was 0 for a store that plainly held it.
 */
function profileDirOf(instanceOrDir: string): string {
  return isAbsolute(instanceOrDir) ? instanceOrDir : instanceDirForLabel(instanceOrDir)
}

/** That instance's own leaf name, whichever form the caller used ('temp1', or a path to it). */
function instanceLabelOf(instanceOrDir: string): string {
  return (
    instanceOrDir
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? instanceOrDir
  ).toLowerCase()
}

/**
 * How many UNARCHIVED chats in this instance carry exactly this title, counted from the SAME
 * store scan the dossier answers from rather than by walking a path built here.
 *
 * That is the point: this question decides whether duplicate rendered rows may be acted on, and
 * a count that is wrong in the SAFE direction still blocks a legitimate act (measured 2026-09-15:
 * a path built from an instance label read an empty store and a rename refused a chat the
 * dossier could see perfectly well).
 */
function liveChatsNamed(instanceOrDir: string, title: string): number {
  const label = instanceLabelOf(instanceOrDir)
  try {
    return collectChats().filter(
      (c) => c.title === title && !c.archived && String(c.instance ?? '').toLowerCase() === label,
    ).length
  } catch {
    return 0
  }
}

const SPAWN_TIMEOUT_MS = 90_000

// ⛔ NOT `join(import.meta.dir, '..', '..', 'misc', ...)`, which is what this was until
// 2026-09-12 and which is BROKEN IN EVERY COMPILED BUILD: inside a `bun build --compile` exe
// `import.meta.dir` is the virtual embedded root (`B:\~BUN\root` on Windows), so two `..`
// hops land on `B:\` and the spawn asked for `B:\misc\Manage-DesktopChat.ps1`.
//
// It failed SILENTLY, and that is the part worth keeping: `powershell -File <missing>` prints
// "The argument ... does not exist" and EXITS 0, so `uiRenameChat`'s `code === 0` reported
// ok:true over a script that had never run. Measured live on a chat migrated between accounts
// that landed nameless - the rename "succeeded" three times and the sidebar never changed.
// resolveMiscAsset closes both halves: it returns a path that exists, or no path at all.
async function runPs1(args: string[]): Promise<{ code: number; out: string }> {
  const asset = await resolveMiscAsset(CHAT_MANAGER_FILE)
  // A non-zero code is the contract every caller here already reads as failure. Never 0: that
  // is exactly the false OK this guard exists to prevent.
  if (!asset.path)
    return { code: 1, out: asset.error ?? `misc\\${CHAT_MANAGER_FILE} could not be resolved` }
  // Stderr rides along: the PS1 runs under ErrorActionPreference=Stop, so a UIA call that throws
  // (window closed mid-click) puts the only real diagnostic on stderr - dropping it reported bare
  // 'exited 1' with nothing to act on (review-confirmed).
  //
  // ⛔ AND THE BOUND IS ON THE WHOLE THING, NOT JUST THE PROCESS (swept 2026-09-18). The old shape
  // had a `setTimeout(() => proc.kill())`, which settles `proc.exited` - but it awaited the two
  // DRAINS first, and a drain finishes only when the PIPE closes. This actuator drives a desktop
  // window; anything powershell leaves behind that inherited these pipes holds them open after it
  // has gone, so the kill could fire and the await still sit there. spawnCaptured bounds the
  // drains as well and kills the tree.
  const r = await spawnCaptured(
    ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', asset.path, ...args],
    { timeoutMs: SPAWN_TIMEOUT_MS },
  )
  if (r.timedOut)
    return {
      code: 1,
      out: `${r.stdout}\n[agenthydra] the chat actuator did not finish within ${SPAWN_TIMEOUT_MS / 1000}s and was killed${r.stderr.trim() ? `\n${r.stderr}` : ''}`.trim(),
    }
  return {
    code: r.code ?? 1,
    out: r.stderr.trim() ? `${r.stdout}\n${r.stderr}` : r.stdout,
  }
}

/** Parse the PS1 -List output into rendered titles VERBATIM: exactly the two-space indent is
 *  stripped, nothing else - a title's own leading/trailing whitespace is part of the app's
 *  accessible name and trimming it made the later exact-name click miss (review-confirmed).
 *  Exported pure for tests. */
export function parseListOutput(out: string): string[] {
  return out
    .split(/\r?\n/)
    .filter((l) => l.startsWith('  '))
    .map((l) => l.slice(2))
    .filter((l) => l.trim().length > 0)
}

/** The titles the instance's sidebar currently RENDERS (in-memory names, not disk names).
 *  Exported for zombie-rows.ts, which reconciles rendered rows against disk state - the disk
 *  is what the sweep reads and the sidebar is what the owner reads, and they drift. */
export async function listRenderedTitles(profileDir: string): Promise<string[]> {
  const { code, out } = await runPs1(['-List', '-Instance', profileDir])
  if (code !== 0) return []
  return parseListOutput(out)
}

function diskTitleOf(profileDir: string, sessionId: string): string | null {
  const p = findChatMetaPath(profileDirOf(profileDir), sessionId)
  if (!p) return null
  try {
    const meta = JSON.parse(readFileSync(p, 'utf8'))
    // VERBATIM, not trimmed: the app renders the stored string exactly, and the exact-name
    // UIA lookup needs the same bytes. Only an effectively-empty title is a null.
    return typeof meta.title === 'string' && meta.title.trim() ? meta.title : null
  } catch {
    return null
  }
}

function diskArchivedOf(profileDir: string, sessionId: string): boolean | null {
  const p = findChatMetaPath(profileDirOf(profileDir), sessionId)
  if (!p) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')).isArchived === true
  } catch {
    return null
  }
}

/** How many chats in this profile's store carry `title` on disk, ANY archive state. More than
 *  one means a rendered row with that title is ambiguous and must not be clicked. */
/** How many chats carry `title` in ONE org/user leaf directory, split out of
 *  {@link diskTitleCountOf}'s walk so that function's complexity reflects only the walk. An
 *  unreadable directory throws to the caller's guard exactly as the inline `readdirSync` did, and
 *  cannot lose a count: nothing has been counted yet at that point. Behaviour is unchanged. */
function dirTitleCountOf(dir: string, title: string, liveOnly: boolean): number {
  let n = 0
  for (const f of readdirSync(dir)) {
    if (!f.startsWith('local_') || !f.endsWith('.json')) continue
    try {
      const meta = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      if (meta.title === title && (!liveOnly || meta.isArchived !== true)) n++
    } catch {
      // one unreadable file says nothing about the others
    }
  }
  return n
}

function diskTitleCountOf(profileDir: string, title: string, liveOnly = false): number {
  let n = 0
  try {
    const storeDir = join(profileDirOf(profileDir), 'claude-code-sessions')
    for (const org of readdirSync(storeDir, { withFileTypes: true })) {
      if (!org.isDirectory()) continue
      for (const user of readdirSync(join(storeDir, org.name), { withFileTypes: true })) {
        if (!user.isDirectory()) continue
        n += dirTitleCountOf(join(storeDir, org.name, user.name), title, liveOnly)
      }
    }
  } catch {
    // no readable store: 0 forces the caller's not-rendered/ambiguity handling
  }
  return n
}

/**
 * Rename a chat through the app's own control - the one write a running app cannot undo.
 *
 * WHY THE COURIER NEEDS IT: the app renders an IMPORTED chat as 'Untitled' whatever its disk
 * title says, so a chat the daemon just delivered into sits nameless in the owner's sidebar,
 * against the naming law. Delivery itself does not depend on this (the actuator finds chats by
 * content), so a failure here is reported, never fatal.
 */
export async function uiRenameChat(
  profileDir: string,
  renderedTitle: string,
  newTitle: string,
  run: (args: string[]) => Promise<{ code: number; out: string }> = runPs1,
  countLiveTitles: (dir: string, title: string) => number = liveChatsNamed,
): Promise<{ ok: boolean; detail: string }> {
  if (isGenericChatTitle(newTitle))
    return { ok: false, detail: `refusing to rename to a generic name ('${newTitle}')` }
  // ONE CHAT DRAWN TWICE IS NOT AN AMBIGUITY, and only disk can say so (measured 2026-09-15
  // proving the 0.42.0 build: a chat spawned seconds earlier rendered two kebabs with the
  // identical name and the actuator refused "2 rendered chats end with ... - refusing to
  // guess"). The count is of LIVE chats, the same question uiArchiveChat asks below: if exactly
  // one unarchived chat here carries this name, every row rendering it is that chat. A 0 (a
  // rendered name the disk does not carry - an import whose title the app erased) leaves the
  // refusal exactly as it was.
  const args = [
    '-Title',
    renderedTitle,
    '-Instance',
    profileDir,
    '-Action',
    'Rename',
    '-NewTitle',
    newTitle,
  ]
  if (countLiveTitles(profileDir, renderedTitle) === 1) args.push('-AllowDuplicateRows')
  const { code, out } = await run(args)
  return { ok: code === 0, detail: out.trim() || `exit ${code}` }
}

// --- discovering the rendered name itself (chat_rename, 2026-09-15) ------------------------
//
// ⛔ THE DISK TITLE IS A GUESS, NOT A GUARANTEE (found live 2026-09-15, same root cause as
// name_chats.py's rendered_titles(): a RUNNING app holds a chat's record in memory and
// re-saves over the importer's title at its own re-save, so the disk copy `chat.title` can
// disagree with what the sidebar actually shows). The MCP tool's own doc told a caller to
// "pass current_title" when it knows better, but nothing here EVER looked for the real
// answer itself - a caller with no better guess than the disk title got a flat refusal on a
// row the app renders under a name nobody had reason to type in by hand.
//
// Ported from the Python orchestrator's automation_chat.py (best_rendered_alias /
// fuzzy_title_score): score every rendered row against the title we tried, and take the ONE
// row that stands unambiguously clear of the rest - never a guess among near-ties. The
// thresholds are the same numbers that script already proved live.
const ALIAS_MIN_SCORE = 0.75
const ALIAS_MIN_MARGIN = 0.15

function normTitle(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** 0-1: how well `a` and `b` name the same chat, order-independent. 1.0 when one is a
 *  normalized substring of the other (a short auto-title inside a long real one, or vice
 *  versa); otherwise the word-overlap (Dice) ratio. */
function pairScore(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b || a.includes(b) || b.includes(a)) return 1
  const wa = new Set(a.split(' '))
  const wb = new Set(b.split(' '))
  let shared = 0
  for (const w of wa) if (wb.has(w)) shared++
  return (2 * shared) / (wa.size + wb.size)
}

/**
 * The rendered rows with the actuator's localized '<more-options phrase> ' chrome taken off,
 * as normalized names, index-aligned with `rendered`; null for a row that is not a chat row.
 * The phrase is not known in advance (RenderedKebabNames refuses to guess it), but every chat
 * row in one window opens with the SAME words, while the other menu names ('Filter', a
 * navigation button) at most share a first word with it ('Weitere Navigationselemente' beside
 * 'Weitere Optionen fur <title>'). So the phrase is grown one word at a time, each step keeping
 * the largest group of rows that agree on the next word, and it stops when that group would fall
 * below two rows or below half the rows it had: past the phrase, chat titles diverge. Every kept
 * row keeps at least one word of name. No word shared by two rows means nothing is discovered.
 *
 * ⛔ Whole names only, never a row's word-suffixes: scoring every suffix let a one-word tail
 * ("integration") read as a normalized substring of a long title and score a perfect 1.0, so a
 * chat whose own row was not rendered could have its rename land on a DIFFERENT chat that merely
 * ended in a word the title contains.
 */
function renderedNames(rendered: string[]): (string | null)[] | null {
  const rows = rendered.map((row) => normTitle(row).split(' ').filter(Boolean))
  let group = rows.map((_, i) => i)
  let prefix = 0
  for (;;) {
    const byNext = new Map<string, number[]>()
    for (const i of group) {
      // The next word may only join the phrase if the row still has a name after it.
      if (rows[i].length <= prefix + 1) continue
      const next = rows[i][prefix]
      byNext.set(next, [...(byNext.get(next) ?? []), i])
    }
    const largest = [...byNext.values()].sort((a, b) => b.length - a.length)[0] ?? []
    if (largest.length < 2 || largest.length * 2 < group.length) break
    group = largest
    prefix++
  }
  if (prefix === 0) return null
  const chatRows = new Set(group)
  return rows.map((words, i) => (chatRows.has(i) ? words.slice(prefix).join(' ') : null))
}

/** The ONE rendered row that is this chat under a different name, or null. Ambiguity (no row
 *  clears the bar, or two rows tie for best) is left exactly as it was - a rename target is a
 *  near-certainty to recognise, never a guess to make. */
export function bestRenderedAlias(title: string, rendered: string[]): string | null {
  const nt = normTitle(title)
  const names = renderedNames(rendered)
  if (!nt || !names) return null
  const scored = rendered
    .map((row, i) => ({ row, score: pairScore(nt, names[i] ?? '') }))
    .sort((a, b) => b.score - a.score)
  if (scored.length === 0 || scored[0].score < ALIAS_MIN_SCORE) return null
  if (scored.length > 1 && scored[0].score - scored[1].score < ALIAS_MIN_MARGIN) return null
  return scored[0].row
}

export interface UiRenameDiscoveryDeps {
  run?: (args: string[]) => Promise<{ code: number; out: string }>
  list?: (profileDir: string) => Promise<string[]>
}

/**
 * uiRenameChat, but able to find the row itself when the title we tried does not render.
 *
 * `titleIsRendered` is true when the CALLER asserted the title (chat_rename's `current_title`)
 * - an explicit assertion's own refusal is never silently overridden by a guess, exactly the
 * doctrine set_mode_via_app's rendered-name retry already follows on the Python side. It is
 * false for a title read off disk, which is a hint the running app is free to have erased.
 */
export async function renameChatDiscoveringRenderedTitle(
  profileDir: string,
  title: string,
  newTitle: string,
  titleIsRendered: boolean,
  deps: UiRenameDiscoveryDeps = {},
): Promise<{ ok: boolean; detail: string }> {
  const run = deps.run ?? runPs1
  const list = deps.list ?? listRenderedTitles
  const first = await uiRenameChat(profileDir, title, newTitle, run)
  if (first.ok || titleIsRendered) return first
  const rendered = await list(profileDir)
  const alias = bestRenderedAlias(title, rendered)
  if (!alias || alias === title) return first
  const retry = await uiRenameChat(profileDir, alias, newTitle, run)
  return {
    ok: retry.ok,
    detail: `${retry.detail} [discovered the app renders this chat as '${alias}', not '${title}']`,
  }
}

export interface UiArchiveOutcome {
  /** The app's own Archive action fired and the tool saw the row leave the sidebar. */
  clicked: boolean
  /** The chat is settled: archived BY ID on disk with no rendered row left (a confirmed
   *  click, or found already retired). This is the bit the caller's durability reads. */
  verified: boolean
  reason?: string
}

export interface UiArchiveDeps {
  list?: (profileDir: string) => Promise<string[]>
  invoke?: (profileDir: string, title: string) => Promise<{ code: number; out: string }>
  readTitle?: (profileDir: string, sessionId: string) => string | null
  readArchived?: (profileDir: string, sessionId: string) => boolean | null
  /** How many chats in the profile's store carry this title on disk, any archive state. */
  readTitleCount?: (profileDir: string, title: string) => number
  /** How many of those are NOT archived - i.e. how many could be wrongly retired by a click. */
  readLiveTitleCount?: (profileDir: string, title: string) => number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/**
 * The line of the actuator's output that says WHY it stopped. Not simply the last line: its
 * `finally` folds back any sidebar group the run expanded and prints "collapsed N sidebar
 * group(s) back the way they were" AFTER the refusal, so taking the last line relayed a tidy-up
 * note as the reason and dropped the refusal itself (2026-09-18). The actuator's own verdict
 * lines start with one of these words; fall back to the last line for anything else.
 */
export function verdictLineOf(out: string): string {
  const lines = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const verdict = lines.filter((l) => /^(FAIL|AMBIGUOUS|STOPPED|INVOKED|RENAME INVOKED)\b/.test(l))
  return verdict.at(-1) ?? lines.at(-1) ?? ''
}

export async function uiArchiveChat(
  profileDir: string,
  sessionId: string,
  deps: UiArchiveDeps = {},
): Promise<UiArchiveOutcome> {
  const list = deps.list ?? listRenderedTitles
  const invoke =
    deps.invoke ??
    ((dir: string, title: string) =>
      // -AllowDuplicateRows: the live-count check below has already established that exactly one
      // unarchived chat here carries this title, so identical rendered rows are one chat drawn
      // twice (the case this file has documented since 2026-08) and not a choice to guess at.
      runPs1(['-Title', title, '-Instance', dir, '-Action', 'Archive', '-AllowDuplicateRows']))
  const readTitle = deps.readTitle ?? diskTitleOf
  const readArchived = deps.readArchived ?? diskArchivedOf
  const readTitleCount = deps.readTitleCount ?? diskTitleCountOf
  const readLiveTitleCount =
    deps.readLiveTitleCount ?? ((dir: string, t: string) => diskTitleCountOf(dir, t, true))
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = deps.now ?? Date.now

  const title = readTitle(profileDir, sessionId)
  if (title === null || isGenericChatTitle(title))
    return {
      clicked: false,
      verified: false,
      reason:
        'the chat has no real disk title to match a rendered row by - clicking a generic row ' +
        'could hit the wrong chat',
    }
  const rendered = await list(profileDir)
  // The PS1 emits each row menu's accessible name VERBATIM - '<localized more-options phrase>
  // <title>' - because the phrase is localized ('Weitere Optionen für ...' on a German app,
  // found live 2026-08-30, where matching the English prefix made archive silently inert for
  // chats in plain view). We hold the exact disk title, so the match happens HERE, by suffix:
  // exact, language-independent, nothing guessed.
  const matches = rendered.filter((t) => t === title || t.endsWith(title))
  if (matches.length === 0) {
    // No row to click. If the disk flag is already set, the chat is settled - already retired
    // (this is also what an idempotent re-act sees after a successful click).
    if (readArchived(profileDir, sessionId) === true)
      return {
        clicked: false,
        verified: true,
        reason: 'already archived on disk and no rendered row remains - settled',
      }
    return {
      clicked: false,
      verified: false,
      reason: `the sidebar does not render '${title}' (in-memory name differs, or the row is scrolled out) - the flag sticks at that instance's next restart`,
    }
  }
  // The hazard is a DIFFERENT chat sharing this title; disk answers that. The same chat
  // rendered in two sidebar sections (measured live) is safe - every matching row is it.
  const holders = readTitleCount(profileDir, title)
  // ⛔ THE HAZARD IS A CHAT THAT SHOULD SURVIVE, not a shared name. Refusing on the count alone
  // stranded rows nothing could ever clear: two retired chats sharing one title sat in
  // the sidebar permanently, because every pass refused to click either one on the grounds that
  // it might hit "the wrong one" - when both were already archived and either click was right.
  // So the question is not how many chats carry this title, it is whether any of them is still
  // live. If one is, clicking by title could retire it and the refusal stands.
  const live = readLiveTitleCount(profileDir, title)
  if (holders > 1 && live > 0)
    return {
      clicked: false,
      verified: false,
      reason: `${holders} chats in this profile's store carry the title '${title}' and ${live} of them ${live === 1 ? 'is' : 'are'} not archived - clicking by title could archive the wrong one`,
    }
  const { code, out } = await invoke(profileDir, title)
  // Exit 0 = row left the sidebar; exit 2 = Archive was INVOKED but the row still rendered at
  // the script's fixed check - which can simply be the app removing it a beat late, so the
  // disk poll below settles both rather than calling 2 a hard failure (review-confirmed).
  if (code !== 0 && code !== 2)
    return {
      clicked: false,
      verified: false,
      reason: `the UI archive tool exited ${code}: ${verdictLineOf(out)}`,
    }
  // Confirm by ID that the app's re-save carries the flag. Brief poll: the app writes its
  // store asynchronously after the click.
  const deadline = now() + 5000
  for (;;) {
    if (readArchived(profileDir, sessionId) === true) return { clicked: true, verified: true }
    if (now() >= deadline) break
    await sleep(500)
  }
  return {
    clicked: true,
    verified: false,
    reason:
      code === 2
        ? 'Archive was invoked but the row was still rendered and the disk flag did not ' +
          'confirm within 5s - re-check via the dossier, do not blind-retry'
        : 'the app archived the row (it left the sidebar) but the disk flag did not confirm ' +
          'within 5s - re-check via the dossier',
  }
}

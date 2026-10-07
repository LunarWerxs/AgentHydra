// server/src/core/desktop-cli-pairing.ts — every Claude Desktop account signed in on this PC also
// gets a Claude Code CLI instance linked to it, without the person adding each one by hand.
//
// WHY (owner, 2026-10-07): the desktop row's "Add a CLI login..." made the same two clicks for every
// account; with the setting on (the default) it is done for them. The CLI instance is signed in from
// the desktop's token cache (core/desktop-cli-feed.ts), so no second sign-in is asked for.
//
// THE RULES
// - A candidate is a Claude Desktop profile on this PC that is signed in now: every folder under the
//   instances root plus the default install's folder when it exists. No process scan: this runs on
//   the feed's 60 s timer.
// - A candidate with no CLI instance linked to it is paired: an UNLINKED CLI instance logged in as
//   the same account is linked (lowest number wins), else a new "<label> (CLI)" instance is made and
//   linked (and deleted again if the link fails). Then the feed signs it in at once.
// - No empty CLI instance (owner, 2026-10-07: "They should not create empty CLI instances"). A new
//   one is made only for a desktop whose token cache holds a Claude Code grant with time left, the
//   login the feed signs it in with. A profile keeps its account id after that grant runs out (four
//   on the owner's PC had), so the id alone made instances nothing could sign in. Such
//   a desktop is not marked handled: the minute pass pairs it once the app is opened and renews the
//   grant. A new instance the feed still could not sign in is deleted again.
// - A desktop is paired ONCE. Its folder goes into the handled list (setting desktop_cli_paired), and
//   so does every signed-in desktop that already has a linked CLI instance, so a person who deletes
//   or unlinks one is respected: the background pass never makes it again.
// - Only turning the setting on (runPairing({ all: true }), after the person confirms) clears that
//   list and pairs every candidate again.
// - One run at a time: a second call waits for the running one, so two passes never make two CLI
//   instances for one desktop.
// - A desktop whose pairing failed is left alone by the background pass for 30 minutes.
// - Folders are compared the way Windows does (case-insensitive, normalized slashes).
//
// ⛔ SECRETS: only identities and folder names are handled here; no token is read into a log.

import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { getSetting, setSetting } from '../db'
import { cliAccountUuid } from './account-tokens'
import {
  type CliInstance,
  createCliInstance,
  deleteCliInstance,
  getCliInstance,
  linkCliInstanceToDesktop,
  listCliInstances,
} from './cli-instances'
import { desktopCliCredential, feedCliFromDesktop } from './desktop-cli-feed'
import { readInstanceMetaMap } from './instance-meta'
import { instanceNumberFor } from './instance-numbers'
import { readLoginUuid } from './login-state'
import { claudeUserDataDir, instancesRoot } from './paths'

const SETTING_ON = 'desktop_cli_pairing'
const SETTING_PAIRED = 'desktop_cli_paired'

export interface PairingCandidate {
  desktopDir: string
  desktopNum: number
  desktopLabel: string
  action: 'create' | 'link'
  cliId: string | null
  cliNum: number | null
}

export interface Pairing {
  desktopNum: number
  desktopLabel: string
  cliId: string
  cliNum: number
  signedIn: boolean
}

export interface PairingResult {
  created: Pairing[]
  linked: Pairing[]
  failed: Array<{ desktopNum: number; desktopLabel: string; error: string }>
}

const key = (dir: string): string => dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

function handledList(): string[] {
  try {
    const v = JSON.parse(getSetting(SETTING_PAIRED)) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function saveHandled(dirs: string[]): void {
  const seen = new Set<string>()
  const out = dirs.filter((d) => !seen.has(key(d)) && seen.add(key(d)))
  setSetting(SETTING_PAIRED, JSON.stringify(out))
}

interface Signed {
  dir: string
  uuid: string
  label: string
}

/** Signed-in desktop profiles, from folder reads only. */
function signedInDesktops(): Signed[] {
  const dirs: string[] = []
  const root = instancesRoot()
  if (existsSync(root)) {
    for (const e of readdirSync(root, { withFileTypes: true }))
      if (e.isDirectory()) dirs.push(join(root, e.name))
  }
  const def = claudeUserDataDir()
  if (existsSync(def)) dirs.push(def)
  const meta = readInstanceMetaMap()
  const labels = new Map(Object.entries(meta).map(([d, m]) => [key(d), m?.label ?? null]))
  const seen = new Set<string>()
  const out: Signed[] = []
  for (const dir of dirs) {
    if (seen.has(key(dir))) continue
    seen.add(key(dir))
    const uuid = readLoginUuid(dir)
    if (!uuid) continue
    out.push({ dir, uuid: uuid.toLowerCase(), label: labels.get(key(dir)) || basename(dir) })
  }
  return out
}

const linkedTo = (clis: CliInstance[], dir: string): CliInstance | undefined =>
  clis.find((c) => c.associatedDesktopDir && key(c.associatedDesktopDir) === key(dir))

/** What turning the setting on would do now, ignoring the handled list unless `skip` names a
 *  desktop to leave out (the background pass: a handled desktop is never matched, so the minute
 *  timer reads no CLI folder for a desktop the person chose to leave unpaired). A desktop that would
 *  get a new instance but has no Claude Code login to give it is left out (see the header). That is
 *  one token decrypt per such desktop, in process under its cached key: Settings asks for the plan
 *  through Desk 2's proxy, which gives up after 10 s. */
export async function pairingPlan(
  opts: { skip?: (dir: string) => boolean } = {},
): Promise<PairingCandidate[]> {
  const clis = listCliInstances()
  const taken = new Set<string>()
  const out: PairingCandidate[] = []
  // Each unlinked CLI folder's account is read once per plan, and only when a desktop needs a match:
  // a `.claude.json` can run to megabytes and there can be a hundred CLI instances.
  let accounts: Map<string, string | null> | null = null
  const accountOf = (c: CliInstance): string | null => {
    accounts ??= new Map()
    if (!accounts.has(c.id))
      accounts.set(c.id, cliAccountUuid(c.configDir, c.loggedIn)?.toLowerCase() ?? null)
    return accounts.get(c.id) ?? null
  }
  for (const d of signedInDesktops()) {
    if (linkedTo(clis, d.dir) || opts.skip?.(d.dir)) continue
    const match = clis
      .filter((c) => !c.associatedDesktopDir && !taken.has(c.id) && accountOf(c) === d.uuid)
      .sort((a, b) => a.num - b.num)[0]
    if (!match && !(await desktopCliCredential(d.dir))) continue
    if (match) taken.add(match.id)
    out.push({
      desktopDir: d.dir,
      desktopNum: instanceNumberFor('desktop', d.dir),
      desktopLabel: d.label,
      action: match ? 'link' : 'create',
      cliId: match?.id ?? null,
      cliNum: match?.num ?? null,
    })
  }
  return out
}

let running: Promise<unknown> = Promise.resolve()
const RETRY_AFTER_MS = 30 * 60_000
/** Desktop folder key -> when pairing it last failed (this process only). */
const failedAt = new Map<string, number>()

/** Pair desktops with CLI instances (see the header). One run at a time. */
export function runPairing(opts: { all: boolean }): Promise<PairingResult> {
  const next = running.then(
    () => doPairing(opts),
    () => doPairing(opts),
  )
  running = next.catch(() => undefined)
  return next
}

async function doPairing({ all }: { all: boolean }): Promise<PairingResult> {
  const result: PairingResult = { created: [], linked: [], failed: [] }
  if (all) saveHandled([])
  const handled = handledList()
  const isHandled = (dir: string) => handled.some((h) => key(h) === key(dir))
  // The background pass also leaves a desktop that failed in the last RETRY_AFTER_MS alone, so a
  // link that keeps failing does not make (and delete) a CLI instance every minute.
  const failedLately = (dir: string) => Date.now() - (failedAt.get(key(dir)) ?? 0) < RETRY_AFTER_MS
  const plan = await pairingPlan(all ? {} : { skip: (d) => isHandled(d) || failedLately(d) })
  const clis = listCliInstances()
  // A signed-in desktop that already has a linked CLI instance counts as handled.
  const existing = signedInDesktops()
    .filter((d) => linkedTo(clis, d.dir))
    .map((d) => d.dir)
  saveHandled([...handled, ...existing])

  for (const c of plan) {
    try {
      let cli: CliInstance | null = null
      let made = false
      if (c.action === 'link' && c.cliId) {
        cli = getCliInstance(c.cliId)
      }
      if (!cli) {
        // A CLI instance's name is at most 60 characters (cli-instances.ts NAME_MAX).
        const r = createCliInstance(`${c.desktopLabel.trim().slice(0, 54).trim()} (CLI)`)
        const id = (r.data as { id?: string } | undefined)?.id
        if (!r.ok || !id) throw new Error(r.message || 'could not create the CLI instance')
        cli = getCliInstance(id)
        made = true
        if (!cli) throw new Error('the new CLI instance is missing')
      }
      const link = linkCliInstanceToDesktop(cli.id, c.desktopDir, c.desktopLabel)
      if (!link.ok) {
        if (made) deleteCliInstance(cli.id, cli.name)
        throw new Error(link.message || 'could not link the CLI instance')
      }
      const feed = await feedCliFromDesktop({
        configDir: cli.configDir,
        associatedDesktopDir: c.desktopDir,
      }).catch(() => null)
      if (made && feed !== 'fed') {
        deleteCliInstance(cli.id, cli.name)
        throw new Error(
          feed === 'no-desktop-login'
            ? 'its Desktop app has no Claude Code sign-in right now'
            : 'the new CLI instance could not be signed in',
        )
      }
      const p: Pairing = {
        desktopNum: c.desktopNum,
        desktopLabel: c.desktopLabel,
        cliId: cli.id,
        cliNum: cli.num,
        // 'own-login': a linked CLI instance with a sign-in of its own is signed in already.
        signedIn: feed === 'fed' || feed === 'current' || feed === 'own-login',
      }
      ;(made ? result.created : result.linked).push(p)
      saveHandled([...handledList(), c.desktopDir])
      failedAt.delete(key(c.desktopDir))
    } catch (err) {
      failedAt.set(key(c.desktopDir), Date.now())
      result.failed.push({
        desktopNum: c.desktopNum,
        desktopLabel: c.desktopLabel,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return result
}

/** The background pass: only while the setting is on. Never throws. */
export async function pairDesktopCliLogins(): Promise<void> {
  try {
    if (getSetting(SETTING_ON) !== '1') return
    const r = await runPairing({ all: false })
    for (const f of r.failed)
      console.error(`[desktop-cli-pairing] desktop ${f.desktopNum} not paired: ${f.error}`)
  } catch (err) {
    console.error(
      '[desktop-cli-pairing] pass failed:',
      err instanceof Error ? err.message : 'unknown error',
    )
  }
}

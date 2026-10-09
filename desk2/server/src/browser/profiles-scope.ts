// The workspace view of the saved-browser store as the browser tools answer it, and the two writes a chat may make
// to it: a note on a profile, and a claim that moves a profile into this workspace. Key names and refusals follow
// the Connections MCP's browser.mjs; a profile belongs to a workspace, so nothing here reads another one's cookies
// except to name its profiles and to score them as evidence.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { liveBrowser } from './cdp'
import {
  applyNote,
  applyTitle,
  cookieStorePath,
  mutateRegistry,
  noteFields,
  refreshProfileHosts,
  registryEntry,
  safeMtime,
} from './profiles-write'
import {
  isObject,
  type Json,
  matchWorkspace,
  readObject,
  realDirs,
  sitesOf,
  storeRoot,
} from './store'
import { browserLiveRoot, readLiveTags } from './live/tags'
import { normalizePath } from './workspace'

export class SavedBrowserError extends Error {}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const CLAIM_RETRY_MS = [0, 60, 180, 400]
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface Cand {
  name: string
  key: string
  dir: string
  scope: string
  open: boolean
}

interface Partition {
  slug: string
  workspace: string | null
  dir: string
  profiles: string[]
}

interface External {
  browser: string
  dir: string
  displayName: string
  path: string
  lastUsed: string | null
}

interface Gathered {
  root: string
  slug: string | null
  ledger: Json
  own: Cand[]
  unowned: Cand[]
  others: Partition[]
  externals: External[]
}

const EXTERNAL_ROOTS = (): [string, string][] => {
  const home = homedir()
  const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
  const roaming = process.env.APPDATA || join(home, 'AppData', 'Roaming')
  return [
    ['Chrome', join(local, 'Google', 'Chrome', 'User Data')],
    ['Chrome Beta', join(local, 'Google', 'Chrome Beta', 'User Data')],
    ['Edge', join(local, 'Microsoft', 'Edge', 'User Data')],
    ['Brave', join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')],
    ['Opera', join(roaming, 'Opera Software', 'Opera Stable')],
  ]
}

function externalNames(root: string): Record<string, string> {
  try {
    const state: unknown = JSON.parse(readFileSync(join(root, 'Local State'), 'utf8'))
    const cache =
      isObject(state) && isObject(state.profile) && isObject(state.profile.info_cache)
        ? state.profile.info_cache
        : {}
    return Object.fromEntries(
      Object.entries(cache).map(([dir, info]) => {
        const v = isObject(info) ? info : {}
        return [dir, String(v.name || v.gaia_name || v.user_name || '')]
      }),
    )
  } catch {
    return {}
  }
}

export function externalProfiles(): External[] {
  const out: External[] = []
  for (const [browser, root] of EXTERNAL_ROOTS()) {
    if (!existsSync(root)) continue
    const names = externalNames(root)
    let dirs: string[]
    try {
      dirs = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch {
      continue
    }
    for (const dir of dirs) {
      const path = join(root, dir)
      if (!existsSync(cookieStorePath(path))) continue
      out.push({ browser, dir, displayName: names[dir] || dir, path, lastUsed: safeMtime(path) })
    }
  }
  return out
}

function workspaceMap(root: string): Json {
  return readObject(join(root, 'workspaces.json')) ?? {}
}

function partitions(root: string, workspaces: Json, ownSlug: string | null): Partition[] {
  const ws = join(root, 'ws')
  return realDirs(ws)
    .filter((slug) => slug !== ownSlug)
    .map((slug) => {
      const rec = workspaces[slug]
      return {
        slug,
        workspace: isObject(rec) && typeof rec.workspace === 'string' ? rec.workspace : null,
        dir: join(ws, slug),
        profiles: realDirs(join(ws, slug)),
      }
    })
    .filter((p) => p.profiles.length > 0)
}

async function gather(cwd: string): Promise<Gathered> {
  const root = storeRoot()
  const workspaces = workspaceMap(root)
  const ledger = readObject(join(dirname(root), 'browser-profile-logins.json')) ?? {}
  const slug = await matchWorkspace(cwd, workspaces)
  const ownNames = slug ? realDirs(join(root, 'ws', slug)) : []
  const bare = realDirs(root).filter((n) => !ownNames.includes(n))
  const cand = async (name: string, key: string, dir: string, scope: string): Promise<Cand> => ({
    name,
    key,
    dir,
    scope,
    open: (await liveBrowser(dir)) !== null,
  })
  return {
    root,
    slug,
    ledger,
    own: await Promise.all(
      ownNames.map((n) => cand(n, `${slug}/${n}`, join(root, 'ws', String(slug), n), 'workspace')),
    ),
    unowned: await Promise.all(
      bare.map((n) => cand(n, n, join(root, n), slug ? 'unowned' : 'unscoped')),
    ),
    others: partitions(root, workspaces, slug),
    externals: externalProfiles(),
  }
}

const claimHint = (name: string) => `browser_profile_claim { profile: '${name}' }`
const otherWorkspaceUse = (p: Partition, name: string) =>
  `not drivable from here. Move one over with browser_profile_claim { profile: '${name}', from: ${JSON.stringify(p.workspace || p.slug)} }`

export async function profilesPayload(cwd: string): Promise<Json> {
  const g = await gather(cwd)
  return mutateRegistry((reg) => {
    const rows = (cs: Cand[], claimable: boolean) =>
      cs.map((c) => ({
        profile: c.name,
        managed: true,
        scope: c.scope,
        key: c.key,
        open: c.open,
        driving: false,
        lastUsed: safeMtime(c.dir),
        signedInHosts: refreshProfileHosts(reg, c.key, c.dir),
        sites: sitesOf(g.ledger, c.key),
        ...noteFields(registryEntry(reg, c.key)),
        ...(claimable ? { claim: claimHint(c.name) } : {}),
      }))
    const otherWorkspaces = g.others.flatMap((p) =>
      p.profiles.map((n) => ({
        profile: n,
        workspace: p.workspace || `(unrecorded: ${p.slug})`,
        use: otherWorkspaceUse(p, n),
      })),
    )
    const external = g.externals.map((p) => ({
      profile: `chrome:${p.dir}`,
      external: true,
      browser: p.browser,
      dir: p.dir,
      displayName: p.displayName,
      lastUsed: p.lastUsed,
      signedInHosts: refreshProfileHosts(reg, `external:${p.browser}:${p.dir}`, p.path),
      use: "the person's own browser: it cannot be driven in place from here, and its session cannot be copied",
    }))
    return {
      workspace: g.slug,
      managedStore: g.root,
      managed: rows(g.own, false),
      unowned: rows(g.unowned, g.slug !== null),
      ...(otherWorkspaces.length ? { otherWorkspaces } : {}),
      externalStores: EXTERNAL_ROOTS()
        .filter(([, root]) => existsSync(root))
        .map(([name, root]) => `${name}: ${root}`),
      external,
      note: "signedInHosts is the cookie store's HOST list (never a cookie value). An external row is the person's own browser and is listed, never driven.",
      scope:
        "A profile belongs to a WORKSPACE, not to the machine. `managed` is this workspace's own; `unowned` predates partitioning and is shared until claimed; `otherWorkspaces` is another workspace's and is never drivable from here. Nothing crosses to another machine.",
    }
  })
}

const hostMatches = (host: string, want: string) =>
  host === want || want.endsWith(`.${host}`) || host.endsWith(`.${want}`)

// Mirrors SERVICE_HOSTS in the Connections MCP's browser.mjs; keep the two in step.
const SERVICE_HOSTS: Record<string, string[]> = {
  gmail: ['mail.google.com', 'accounts.google.com', 'google.com'],
  google: ['accounts.google.com', 'google.com'],
  youtube: ['youtube.com'],
  cloudflare: ['dash.cloudflare.com', 'cloudflare.com'],
  github: ['github.com'],
  stripe: ['dashboard.stripe.com', 'stripe.com'],
  aws: ['console.aws.amazon.com', 'signin.aws.amazon.com', 'amazon.com'],
  discord: ['discord.com'],
  linkedin: ['linkedin.com'],
  x: ['x.com', 'twitter.com'],
  twitter: ['x.com', 'twitter.com'],
  reddit: ['reddit.com'],
  notion: ['notion.so'],
  slack: ['slack.com'],
  figma: ['figma.com'],
  vercel: ['vercel.com'],
  netlify: ['netlify.com'],
  namecheap: ['namecheap.com'],
  godaddy: ['godaddy.com'],
  shopify: ['shopify.com'],
  openai: ['chatgpt.com', 'platform.openai.com', 'openai.com'],
  anthropic: ['claude.ai', 'console.anthropic.com', 'anthropic.com'],
  supabase: ['supabase.com'],
  mongodb: ['cloud.mongodb.com', 'mongodb.com'],
  apple: ['appleid.apple.com', 'apple.com'],
  microsoft: ['login.microsoftonline.com', 'microsoft.com'],
}

function wantedHosts(query: string): string[] {
  const raw = query.trim()
  if (!raw) return []
  let direct: string | null
  try {
    direct = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.replace(/^www\./, '')
  } catch {
    direct = null
  }
  if (raw.includes('.') && direct) return [direct]
  const key = raw.toLowerCase()
  return Object.prototype.hasOwnProperty.call(SERVICE_HOSTS, key) ? SERVICE_HOSTS[key] : []
}

function scoreProfile(hosts: string[], word: string, name: string, sessionHosts: string[], note: unknown) {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const hostHit = hosts.filter((w) => sessionHosts.some((h) => hostMatches(h, w)))
  const nameHit = word.length >= 3 && norm(name).includes(word)
  const noteHit = word.length >= 3 && norm(typeof note === 'string' ? note : '').includes(word)
  return {
    points: hostHit.length * 10 + (nameHit ? 3 : 0) + (noteHit ? 3 : 0),
    hostHit,
    nameHit,
    noteHit,
  }
}

const LIVE_SELF_WORDS = new Set(['my', 'mine', 'me', 'own'])
const LIVE_BROWSER_WORDS = new Set(['the', 'a', 'browser', 'window', 'everyday', 'personal', 'usual', 'normal', 'regular', 'main'])
const LIVE_KINDS = new Set(['chrome', 'edge', 'brave'])

function taggedRows(reg: Json, query: string, word: string, resolvedHosts: string[]): Json[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const askWords = query.toLowerCase().split(/[^a-z']+/).filter(Boolean)
  const selfAsk =
    askWords.some((w) => LIVE_SELF_WORDS.has(w)) &&
    askWords.every((w) => LIVE_SELF_WORDS.has(w) || LIVE_BROWSER_WORDS.has(w) || LIVE_KINDS.has(w))
  const askedKind = askWords.find((w) => LIVE_KINDS.has(w))
  return readLiveTags()
    .tags.map((t) => {
      const key = `external:${t.browser}:${t.profileDir}`
      const sessionHosts = refreshProfileHosts(reg, key, join(browserLiveRoot(t.browser, t.userDataDir), t.profileDir))
      const words = [norm(t.tag), norm(t.profileName ?? ''), norm(t.note ?? '')].filter(Boolean)
      const nameHit =
        (selfAsk && (!askedKind || t.browser.toLowerCase() === askedKind)) ||
        (word.length >= 3 && words.some((w) => w.includes(word) || (w.length >= 3 && word.includes(w))))
      const hostHit = resolvedHosts.filter((w) => sessionHosts.some((h) => hostMatches(h, w)))
      const loginsUnreadable = registryEntry(reg, key).hostsReadable === false
      return {
        tag: t.tag,
        browser: t.browser,
        profile: t.profileName || t.profileDir,
        profileDir: t.profileDir,
        ...(t.note ? { note: t.note } : {}),
        points: hostHit.length * 10 + (nameHit ? 5 : 0) + (loginsUnreadable ? 1 : 0),
        matchedHosts: hostHit,
        use: `browser_live { window: '${t.tag}', ... } drives this window of the person's own browser; it is never a managed profile`,
      }
    })
    .filter((r) => r.points > 0)
    .sort((a, b) => b.points - a.points)
}

export async function findPayload(cwd: string, query: string): Promise<Json> {
  const g = await gather(cwd)
  const resolvedHosts = wantedHosts(query)
  const word = query.toLowerCase().replace(/[^a-z0-9]+/g, '')
  return mutateRegistry((reg) => {
    const managed = [...g.own, ...g.unowned]
      .map((c) => {
        const sessionHosts = refreshProfileHosts(reg, c.key, c.dir)
        const entry = registryEntry(reg, c.key)
        const s = scoreProfile(resolvedHosts, word, c.name, sessionHosts, entry.note)
        return {
          profile: c.name,
          managed: true,
          scope: c.scope,
          ...noteFields(entry),
          ...s,
          matchedHosts: s.hostHit,
          use:
            c.scope === 'unowned'
              ? `profile:'${c.name}' works from here (it predates workspace partitioning and nobody owns it). Make it this workspace's for good: ${claimHint(c.name)}`
              : `profile:'${c.name}' on any browser_* call`,
        }
      })
      .filter((r) => r.points > 0)
      .sort((a, b) => b.points - a.points)
    const elsewhere = g.others
      .flatMap((p) =>
        p.profiles.map((n) => {
          const sessionHosts = refreshProfileHosts(reg, `${p.slug}/${n}`, join(p.dir, n))
          const s = scoreProfile(resolvedHosts, word, n, sessionHosts, undefined)
          return {
            profile: n,
            workspace: p.workspace || `(unrecorded: ${p.slug})`,
            ...s,
            matchedHosts: s.hostHit,
            use: otherWorkspaceUse(p, n),
          }
        }),
      )
      .filter((r) => r.points > 0)
      .sort((a, b) => b.points - a.points)
    const external = g.externals
      .map((p) => {
        const sessionHosts = refreshProfileHosts(reg, `external:${p.browser}:${p.dir}`, p.path)
        const s = scoreProfile(resolvedHosts, word, `${p.displayName} ${p.dir}`, sessionHosts, undefined)
        return {
          profile: `chrome:${p.dir}`,
          external: true,
          browser: p.browser,
          ...s,
          matchedHosts: s.hostHit,
          use: "the person's own browser: it cannot be driven in place from here, and its session cannot be copied",
        }
      })
      .filter((r) => r.points > 0)
      .sort((a, b) => b.points - a.points)
    const best = managed.find((r) => r.matchedHosts.length > 0) ?? null
    const tagged = taggedRows(reg, query, word, resolvedHosts)
    return {
      query,
      workspace: g.slug,
      resolvedHosts,
      drivableNow: best
        ? {
            profile: best.profile,
            scope: best.scope,
            matchedHosts: best.matchedHosts,
            use: best.use,
          }
        : null,
      managed,
      ...(elsewhere.length ? { otherWorkspaces: elsewhere } : {}),
      ...(tagged.length ? { taggedBrowsers: tagged } : {}),
      external,
      note: best
        ? `drive profile:'${best.profile}'. A recorded session is a dated observation, not a promise: if the site asks for a login anyway, the person must sign in again.`
        : tagged.length
          ? `the person's own tagged browser may hold it: browser_live { window: '${tagged[0].tag}' } drives that window (Windows only; it asks the person's own open browser, not a managed profile).`
          : 'no saved browser in this workspace holds this session by its cookie hosts',
    }
  })
}

export async function saveProfileNote(
  cwd: string,
  name: string,
  fields: { note?: unknown; title?: unknown },
): Promise<Json> {
  const g = await gather(cwd)
  const own = g.own.find((c) => c.name === name)
  const unowned = g.unowned.find((c) => c.name === name)
  const home = own ?? unowned
  if (!home) {
    const elsewhere = g.others.find((p) => p.profiles.includes(name))
    throw new SavedBrowserError(
      elsewhere
        ? `'${name}' belongs to another workspace (${elsewhere.workspace || elsewhere.slug}) - its note is not writable from here. Move it first: browser_profile_claim { profile: '${name}', from: ${JSON.stringify(elsewhere.workspace || elsewhere.slug)} }`
        : `no saved browser called '${name}' in this workspace - browser_profiles lists them.`,
    )
  }
  if (fields.note === undefined && fields.title === undefined)
    throw new SavedBrowserError(
      "browser_profile_note needs note and/or title - the note says what the saved browser is for, the title is its short name (e.g. 'GitHub')",
    )
  return mutateRegistry((reg) => {
    const entry = registryEntry(reg, home.key)
    if (fields.note !== undefined) applyNote(entry, fields.note)
    if (fields.title !== undefined) applyTitle(entry, fields.title)
    return {
      profile: name,
      key: home.key,
      note: entry.note || null,
      ...(entry.note ? { noteAt: entry.noteAt } : {}),
      title: entry.title || null,
      ...(fields.note !== undefined && !entry.note ? { cleared: true } : {}),
      ...(fields.title !== undefined && !entry.title ? { titleCleared: true } : {}),
    }
  })
}

interface Source {
  dir: string
  key: string
  slug: string | null
  wasOwnedBy: string | null
}

const sourceMatches = (s: Source, from: string) =>
  s.slug === from ||
  (s.wasOwnedBy !== null &&
    (s.wasOwnedBy === from || normalizePath(s.wasOwnedBy) === normalizePath(from)))

export async function claimProfile(
  cwd: string,
  name: string,
  from: string | undefined,
): Promise<Json> {
  const root = storeRoot()
  const workspaces = workspaceMap(root)
  const slug = await matchWorkspace(cwd, workspaces)
  if (!slug)
    throw new SavedBrowserError(
      'browser_profile_claim needs a workspace: this folder is not a recorded workspace yet, so there is nothing to claim into.',
    )
  if (!SAFE_NAME.test(name)) throw new SavedBrowserError(`'${name}' is not a saved browser name`)
  const target = join(root, 'ws', slug, name)
  if (existsSync(target))
    throw new SavedBrowserError(
      `this workspace already owns a profile called '${name}' - claiming would overwrite it. Rename or delete one of them first.`,
    )

  const sources: Source[] = []
  if (realDirs(root).includes(name))
    sources.push({ dir: join(root, name), key: name, slug: null, wasOwnedBy: null })
  for (const p of partitions(root, workspaces, slug))
    if (p.profiles.includes(name))
      sources.push({
        dir: join(p.dir, name),
        key: `${p.slug}/${name}`,
        slug: p.slug,
        wasOwnedBy: p.workspace || p.slug,
      })
  const picked = from ? sources.filter((s) => sourceMatches(s, from)) : sources
  if (picked.length === 0)
    throw new SavedBrowserError(
      `no profile called '${name}' to claim${from ? ` from ${JSON.stringify(from)}` : ''}. browser_profiles lists what is claimable from here (its \`unowned\` and \`otherWorkspaces\` sections).`,
    )
  if (picked.length > 1)
    throw new SavedBrowserError(
      `'${name}' exists in more than one place. Say which with from:'<workspace>'.`,
    )
  const source = picked[0]
  if (source.wasOwnedBy !== null && !from)
    throw new SavedBrowserError(
      `'${name}' belongs to another workspace (${source.wasOwnedBy}). Claiming it moves it out of that workspace: pass from:'${source.wasOwnedBy}' to confirm.`,
    )
  if (await liveBrowser(source.dir))
    throw new SavedBrowserError(`'${name}' has a live Chrome - close it first, then claim it.`)

  mkdirSync(join(root, 'ws', slug), { recursive: true })
  let lastError: unknown = null
  for (const wait of CLAIM_RETRY_MS) {
    if (wait) await delay(wait)
    try {
      renameSync(source.dir, target)
      lastError = null
      break
    } catch (err) {
      lastError = err
    }
  }
  if (lastError)
    throw new SavedBrowserError(
      `could not move '${name}' into this workspace: ${lastError instanceof Error ? lastError.message : String(lastError)}. That is almost always a live Chrome or a file still open in it - close every window on that profile and try again. Nothing was changed.`,
    )

  const claimedFrom = source.wasOwnedBy ?? '(unowned, pre-partition)'
  mutateRegistry((reg) => {
    const profiles = isObject(reg.profiles) ? reg.profiles : {}
    reg.profiles = profiles
    const carried = profiles[source.key]
    if (isObject(carried)) {
      profiles[`${slug}/${name}`] = { ...carried, claimedAt: new Date().toISOString(), claimedFrom }
      delete profiles[source.key]
    }
  })
  return {
    status: 'claimed',
    profile: name,
    from: claimedFrom,
    nowOwnedBy: slug,
    dir: target,
    note: `profile:'${name}' is this workspace's now, and no other workspace can resolve it by name. Its logins moved with it: nothing was copied.`,
  }
}

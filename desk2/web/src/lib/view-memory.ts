// The window keeps its place through a reload (a new build, stale-bundle.ts, or a right-click Refresh): the chat
// or screen it shows is kept in sessionStorage, which lasts as long as the window does. The rest of what is on
// screen is kept beside it (ScreenMemory): owner, 2026-10-06, a Refresh "should remember the page I was on".

export type View =
  | { kind: 'chat'; id: string }
  | { kind: 'new'; cwd?: string }
  | { kind: 'external'; id: string }
  | { kind: 'elsewhere' }
  | { kind: 'settings' }

type ViewStorage = Pick<Storage, 'getItem' | 'setItem'>

const KEY = 'hydra-desk:view'

function parse(raw: string | null): unknown {
  try {
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/** A stored view, or null for anything that is not one. */
export function readView(raw: string | null): View | null {
  return toView(parse(raw))
}

function toView(v: unknown): View | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  switch (o.kind) {
    case 'chat':
    case 'external':
      return typeof o.id === 'string' ? { kind: o.kind, id: o.id } : null
    case 'new':
      return typeof o.cwd === 'string' ? { kind: 'new', cwd: o.cwd } : { kind: 'new' }
    case 'elsewhere':
    case 'settings':
      return { kind: o.kind }
    default:
      return null
  }
}

function session(): ViewStorage | null {
  return typeof sessionStorage === 'undefined' ? null : sessionStorage
}

/** The view this window showed before its last reload, else `fallback`. */
export function restoreView(fallback: View, storage: ViewStorage | null = session()): View {
  try {
    return readView(storage?.getItem(KEY) ?? null) ?? fallback
  } catch {
    return fallback
  }
}

export function rememberView(view: View, storage: ViewStorage | null = session()): void {
  try {
    storage?.setItem(KEY, JSON.stringify(view))
  } catch {
    // Storage blocked: a reload opens the default view, which is fine.
  }
}

/** The rest of the screen: the view under the Settings dialog (closing it after a reload goes back there),
 *  whether AgentHydra's pane was slid in, with whether opening it turned the cloud list on (closing it turns
 *  the list off again), and the Settings page. */
export interface ScreenMemory {
  under?: View
  hydra?: { cloud: boolean }
  section?: string
}

const SCREEN_KEY = 'hydra-desk:screen'

/** What a stored screen holds; anything unreadable is left out. */
export function readScreen(raw: string | null): ScreenMemory {
  const v = parse(raw)
  if (!v || typeof v !== 'object') return {}
  const o = v as Record<string, unknown>
  const out: ScreenMemory = {}
  const under = toView(o.under)
  if (under && under.kind !== 'settings') out.under = under
  if (o.hydra && typeof o.hydra === 'object') out.hydra = { cloud: (o.hydra as Record<string, unknown>).cloud === true }
  if (typeof o.section === 'string') out.section = o.section
  return out
}

export function restoreScreen(storage: ViewStorage | null = session()): ScreenMemory {
  try {
    return readScreen(storage?.getItem(SCREEN_KEY) ?? null)
  } catch {
    return {}
  }
}

/** Keeps the parts given, leaving the others as they were; a part given as undefined is forgotten. */
export function rememberScreen(change: ScreenMemory, storage: ViewStorage | null = session()): void {
  try {
    if (!storage) return
    storage.setItem(SCREEN_KEY, JSON.stringify({ ...readScreen(storage.getItem(SCREEN_KEY)), ...change }))
  } catch {
    // Storage blocked: a reload opens the default view, which is fine.
  }
}

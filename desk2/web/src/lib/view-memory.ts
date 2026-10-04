// The window keeps its place through a reload (a new build, stale-bundle.ts): the chat or screen it shows is
// kept in sessionStorage, which lasts as long as the window does.

export type View =
  | { kind: 'chat'; id: string }
  | { kind: 'new'; cwd?: string }
  | { kind: 'external'; id: string }
  | { kind: 'elsewhere' }
  | { kind: 'settings' }

type ViewStorage = Pick<Storage, 'getItem' | 'setItem'>

const KEY = 'hydra-desk:view'

/** A stored view, or null for anything that is not one. */
export function readView(raw: string | null): View | null {
  let v: unknown
  try {
    v = raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
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

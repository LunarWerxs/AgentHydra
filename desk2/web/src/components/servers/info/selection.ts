// What the Dev servers page shows (owner, 2026-10-07; a page since 2026-10-08): a click in the sidebar's Dev servers
// list selects a thing and the page describes it, instead of starting or opening it; none is the page's overview. The
// store keeps the one selection (store.ts `select`).
export type DevSelection =
  | { kind: 'server'; id: string }
  | { kind: 'project'; id: string }
  /** A .devwebui file or a project folder a scan found, not added yet. */
  | { kind: 'found'; path: string }
  /** A localhost server no project lists (Desk's /dw/localhost). */
  | { kind: 'other'; port: number }
  /** Add a project: a path, a clone, or a scan's results. */
  | { kind: 'add' }

export function sameSelection(a: DevSelection | null, b: DevSelection | null): boolean {
  if (!a || !b || a.kind !== b.kind) return a === b
  switch (a.kind) {
    case 'server':
    case 'project':
      return a.id === (b as { id: string }).id
    case 'found':
      return a.path === (b as { path: string }).path
    case 'other':
      return a.port === (b as { port: number }).port
    case 'add':
      return true
  }
}

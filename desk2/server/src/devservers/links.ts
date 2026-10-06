// Which servers move together (ported from DevWebUI's manager/links.ts and wait-for-port.ts).
//
// `links` are sibling local ids that act as one unit: undirected edges, expanded transitively, so a linked group starts
// and stops together whichever member the action lands on. A `companion` joins every single-server start in its project
// but is never stopped by group propagation (a shared database must not die because one consumer stopped). `waitForPort`
// is a port number or a sibling's local id whose declared port to wait for; a batch is started dependencies first.

import type { ProcessDef } from './project-file'

/** Undirected adjacency over `links` declarations, scoped to one project (global ids). */
function linkEdges(projectId: string, defs: readonly ProcessDef[]): Map<string, Set<string>> {
  const ids = new Set<string>()
  for (const d of defs) if (d.projectId === projectId) ids.add(d.id)
  const edges = new Map<string, Set<string>>()
  const connect = (a: string, b: string) => {
    if (!edges.has(a)) edges.set(a, new Set())
    edges.get(a)!.add(b)
  }
  for (const d of defs) {
    if (d.projectId !== projectId) continue
    for (const localId of d.links ?? []) {
      const target = `${d.projectId}.${localId}`
      if (target === d.id || !ids.has(target)) continue // an unknown id is ignored, like a string waitForPort
      connect(d.id, target)
      connect(target, d.id)
    }
  }
  return edges
}

/** The other members of `anchor`'s linked group (the closure over undirected links, anchor excluded). */
export function linkedGroupIds(anchor: ProcessDef, defs: readonly ProcessDef[]): string[] {
  const edges = linkEdges(anchor.projectId, defs)
  const group = new Set<string>([anchor.id])
  const queue = [anchor.id]
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const neighbor of edges.get(next) ?? []) {
      if (group.has(neighbor)) continue
      group.add(neighbor)
      queue.push(neighbor)
    }
  }
  group.delete(anchor.id)
  return [...group]
}

/** What starts with an individually started `anchor`: its linked group and every companion of its project. */
export function coStartIds(anchor: ProcessDef, defs: readonly ProcessDef[]): string[] {
  const group = new Set<string>(linkedGroupIds(anchor, defs))
  for (const d of defs) if (d.projectId === anchor.projectId && d.companion && d.id !== anchor.id) group.add(d.id)
  return [...group]
}

/** The port a server waits for before it spawns: the literal one, or a sibling's declared port; null for none. */
export function resolveWaitPort(def: ProcessDef, byId: Map<string, ProcessDef>): number | null {
  const w = def.waitForPort
  if (w === undefined) return null
  if (typeof w === 'number') return w
  return byId.get(`${def.projectId}.${w}`)?.port ?? null
}

export class DependencyCycleError extends Error {
  constructor(readonly cycle: string[]) {
    super(`dependency cycle in waitForPort: ${cycle.join(' -> ')}`)
  }
}

/** `ids` with every in-batch waitForPort dependency before its dependent; throws DependencyCycleError on a cycle. */
export function orderByDependency(ids: string[], byId: Map<string, ProcessDef>): string[] {
  const inBatch = new Set(ids)
  const dep = new Map<string, string | null>()
  for (const id of ids) {
    const w = byId.get(id)?.waitForPort
    const target = typeof w === 'string' ? `${byId.get(id)!.projectId}.${w}` : null
    dep.set(id, target && inBatch.has(target) ? target : null)
  }
  const out: string[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string, path: string[]): void => {
    const st = state.get(id)
    if (st === 'done') return
    if (st === 'visiting') throw new DependencyCycleError([...path.slice(path.indexOf(id)), id])
    state.set(id, 'visiting')
    const d = dep.get(id)
    if (d) visit(d, [...path, id])
    state.set(id, 'done')
    out.push(id)
  }
  for (const id of ids) visit(id, [])
  return out
}

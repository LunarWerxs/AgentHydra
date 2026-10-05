import type { ProcessDef } from "../types";

/**
 * Linked servers: a process may declare `links` — sibling `localId`s (same
 * project) that act as ONE unit with it. Links are treated as UNDIRECTED edges
 * and expanded transitively, so a linked group starts together AND stops
 * together no matter which member (or which side of an edge) the action lands
 * on. A `companion` process additionally rides along with EVERY individual
 * start in its project — but is never stopped by group propagation (a shared
 * database shouldn't die because one of its consumers was stopped).
 *
 * Expansion happens only for the single-process start/stop actions (GUI card
 * buttons, MCP start_process/stop_process). Autostart-on-load, start/stop
 * project/all, and restart are deliberately untouched — they have their own
 * controls, and restart stays a targeted "bounce this one process".
 */

/** Undirected adjacency over `links` declarations, scoped to one project (global ids). */
function linkEdges(projectId: string, defs: readonly ProcessDef[]): Map<string, Set<string>> {
  const ids = new Set<string>();
  for (const d of defs) if (d.projectId === projectId) ids.add(d.id);
  const edges = new Map<string, Set<string>>();
  const connect = (a: string, b: string) => {
    if (!edges.has(a)) edges.set(a, new Set());
    edges.get(a)!.add(b);
  };
  for (const d of defs) {
    if (d.projectId !== projectId) continue;
    for (const localId of d.links ?? []) {
      const target = `${d.projectId}.${localId}`;
      // Unknown targets are ignored (same leniency as a string `waitForPort`).
      if (target === d.id || !ids.has(target)) continue;
      connect(d.id, target);
      connect(target, d.id);
    }
  }
  return edges;
}

/**
 * The other members of `anchor`'s linked group (anchor excluded): the
 * transitive closure over undirected `links` edges. Cycles in `links` are
 * fine — the closure just converges. This is the set that starts AND stops
 * together with the anchor.
 *
 * `defs` is a materialized `readonly ProcessDef[]`, deliberately NOT an
 * `Iterable`: these functions walk it more than once (linkEdges, then the
 * companion sweep), and a one-shot iterator (a raw `Map.values()`, a generator)
 * is exhausted after the first pass and would silently make every later walk
 * see nothing. That was the exact bug that made linked servers a runtime no-op.
 * Requiring an array lets the compiler reject a raw iterator at the call site,
 * so the hazard cannot come back. (General rule for this codebase: a function
 * that walks an `Iterable` param more than once must `[...]` it first; here we
 * go one better and refuse the iterator outright.)
 */
export function linkedGroupIds(anchor: ProcessDef, defs: readonly ProcessDef[]): string[] {
  const edges = linkEdges(anchor.projectId, defs);
  const group = new Set<string>([anchor.id]);
  const queue = [anchor.id];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const neighbor of edges.get(next) ?? []) {
      if (group.has(neighbor)) continue;
      group.add(neighbor);
      queue.push(neighbor);
    }
  }
  group.delete(anchor.id);
  return [...group];
}

/**
 * The process ids to start alongside an individually-started `anchor` (the
 * anchor itself excluded): its linked group, plus every companion in the
 * project. Start-only — stop propagation uses {@link linkedGroupIds} alone.
 */
export function coStartIds(anchor: ProcessDef, defs: readonly ProcessDef[]): string[] {
  const group = new Set<string>(linkedGroupIds(anchor, defs));
  for (const d of defs) {
    if (d.projectId === anchor.projectId && d.companion && d.id !== anchor.id) group.add(d.id);
  }
  return [...group];
}

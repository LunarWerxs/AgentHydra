import type { ProcessView } from "@/types";

/**
 * The OTHER members of a process's linked group — the undirected, transitive
 * closure over the project's `links` declarations, mirroring the server's
 * acts-as-one-unit semantics (manager/links.ts): the group starts together and
 * stops together. Computed from the whole sibling list so a process someone
 * ELSE links to still shows as linked.
 */
export function linkedPeers(process: ProcessView, siblings: ProcessView[]): ProcessView[] {
  const byLocal = new Map(siblings.map((p) => [p.localId, p]));
  const edges = new Map<string, Set<string>>();
  const connect = (a: string, b: string) => {
    if (!edges.has(a)) edges.set(a, new Set());
    edges.get(a)!.add(b);
  };
  for (const p of siblings) {
    for (const target of p.links ?? []) {
      if (target === p.localId || !byLocal.has(target)) continue;
      connect(p.localId, target);
      connect(target, p.localId);
    }
  }
  const group = new Set<string>([process.localId]);
  const queue = [process.localId];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const neighbor of edges.get(next) ?? []) {
      if (group.has(neighbor)) continue;
      group.add(neighbor);
      queue.push(neighbor);
    }
  }
  group.delete(process.localId);
  return [...group].map((localId) => byLocal.get(localId)!);
}

import type { ProcessDef } from "../types";

/**
 * Build dependency-ordered startup (S): a process may declare `waitForPort` —
 * either a literal port number, or a sibling process's `localId` whose declared
 * `port` to wait on. This module resolves those declarations to concrete port
 * numbers (scoped to the process's own project) and topologically sorts a batch
 * of process ids so dependencies are queued to start before their dependents.
 *
 * Deliberately simple: no HTTP probes, no env-var inference — just "wait until
 * this port is listening" (see ManagerWithLifecycle.start(), which does the polling).
 */

/** A process id's resolved wait target: the literal port it must see open before spawning. */
export function resolveWaitPort(def: ProcessDef, byId: Map<string, ProcessDef>): number | null {
  const w = def.waitForPort;
  if (w === undefined) return null;
  if (typeof w === "number") return w;
  // String form: a sibling's `localId` within the SAME project — global ids are
  // `${projectId}.${localId}`, so resolve against that, not a bare id lookup.
  const sibling = byId.get(`${def.projectId}.${w}`);
  return sibling?.port ?? null;
}

/** The sibling process id a `waitForPort` string names (for cycle-naming/error messages). */
function waitTargetId(def: ProcessDef): string | null {
  const w = def.waitForPort;
  if (typeof w !== "string") return null;
  return `${def.projectId}.${w}`;
}

export class DependencyCycleError extends Error {
  constructor(public readonly cycle: string[]) {
    super(`Dependency cycle in waitForPort: ${cycle.join(" -> ")}`);
    this.name = "DependencyCycleError";
  }
}

/**
 * Order `ids` so that any process a member depends on (via a `waitForPort` string
 * reference to a SIBLING IN THIS SAME BATCH) is ordered before it. Ids with no
 * in-batch dependency, or whose dependency targets a process outside this batch
 * (e.g. already running), keep their relative input order. Throws
 * {@link DependencyCycleError} naming the cycle if one exists.
 */
export function orderByDependency(ids: string[], byId: Map<string, ProcessDef>): string[] {
  const idSet = new Set(ids);
  const deps = new Map<string, string | null>(); // id -> in-batch dependency id (or null)
  for (const id of ids) {
    const def = byId.get(id);
    const target = def ? waitTargetId(def) : null;
    deps.set(id, target && idSet.has(target) ? target : null);
  }

  const RESULT: string[] = [];
  const state = new Map<string, "visiting" | "done">();

  function visit(id: string, path: string[]): void {
    const st = state.get(id);
    if (st === "done") return;
    if (st === "visiting") {
      const cycleStart = path.indexOf(id);
      throw new DependencyCycleError([...path.slice(cycleStart), id]);
    }
    state.set(id, "visiting");
    const dep = deps.get(id);
    if (dep) visit(dep, [...path, id]);
    state.set(id, "done");
    RESULT.push(id);
  }

  for (const id of ids) visit(id, []);
  return RESULT;
}

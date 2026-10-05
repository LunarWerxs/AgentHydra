// Shared filter + sort for a process list, so the card grid and the table render
// the exact same ordering off one set of preferences (held in the store). Pure +
// stateless — pass the current options in, get a new arranged array back.
import type { ProcessView, ProjectView, SortDir, SortKey, Status, StatusBucket } from "@/types";
import { fuzzySearch } from "./fuzzy";

/** Collapse the six raw statuses into the four buckets the filter exposes. */
export function statusBucket(s: Status): StatusBucket {
  if (s === "running") return "running";
  if (s === "crashed") return "crashed";
  if (s === "starting" || s === "stopping" || s === "waiting") return "busy";
  return "stopped";
}

/** Sort precedence for the "status" column: live first, problems next, idle last. */
const STATUS_RANK: Record<Status, number> = {
  running: 0,
  starting: 1,
  waiting: 1,
  stopping: 1,
  crashed: 2,
  stopped: 3,
};

function uptimeSecs(p: ProcessView, now: number): number {
  return p.status === "running" && p.startedAt ? Math.floor((now - p.startedAt) / 1000) : -1;
}

export interface ArrangeOptions {
  sortKey: SortKey;
  sortDir: SortDir;
  statusFilter: StatusBucket[];
  /** Shared clock, only needed for the "uptime" sort. */
  now: number;
  /**
   * Fuzzy process-name filter (the toolbar search box, see lib/fuzzy.ts); blank matches
   * everything. While set, better matches rank ahead of the chosen sort key.
   */
  search?: string;
}

export function arrangeProcesses(list: ProcessView[], opts: ArrangeOptions): ProcessView[] {
  const allowed = new Set(opts.statusFilter);
  const q = opts.search?.trim();
  // Relevance per surviving process; empty when there is no search, so it never reorders.
  const relevance = new Map<ProcessView, number>();
  const filtered = list.filter((p) => {
    if (!allowed.has(statusBucket(p.status))) return false;
    if (!q) return true;
    const m = fuzzySearch(p.name, q);
    if (m) relevance.set(p, m.score);
    return !!m;
  });

  // Missing numeric values sort to the very bottom regardless of direction.
  const num = (v: number | null | undefined) => (v == null ? Number.NEGATIVE_INFINITY : v);
  const byName = (a: ProcessView, b: ProcessView) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

  const primary = (a: ProcessView, b: ProcessView): number => {
    switch (opts.sortKey) {
      case "name":
        return byName(a, b);
      case "status":
        return STATUS_RANK[a.status] - STATUS_RANK[b.status];
      case "port":
        return num(a.port) - num(b.port);
      case "cpu":
        return num(a.cpu) - num(b.cpu);
      case "memory":
        return num(a.memory) - num(b.memory);
      case "uptime":
        return uptimeSecs(a, opts.now) - uptimeSecs(b, opts.now);
      default:
        return 0;
    }
  };

  const dir = opts.sortDir === "asc" ? 1 : -1;
  const byRelevance = (a: ProcessView, b: ProcessView) =>
    (relevance.get(b) ?? 0) - (relevance.get(a) ?? 0);
  // Starred processes float to the top regardless of sort key/direction; then, while
  // searching, the better fuzzy match; ties fall through to the normal sort, then the
  // name tie-break, so equal rows stay stable.
  return [...filtered].sort(
    (a, b) =>
      Number(!!b.starred) - Number(!!a.starred) ||
      byRelevance(a, b) ||
      primary(a, b) * dir ||
      byName(a, b),
  );
}

/**
 * Order project panels by how well the toolbar search matches them: the best of the
 * project's own name (fzf "path" scheme, it is usually a folder name) and its process
 * names. Equal scores prefer the shorter label, then the earlier first hit (fzf's
 * length/begin tiebreak), then list order. Non-matching projects keep list order at
 * the end (ProjectPanel hides them). A blank search returns the list untouched.
 */
export function rankProjectsBySearch(projects: ProjectView[], search?: string): ProjectView[] {
  const q = search?.trim();
  if (!q) return projects;
  const ranked = projects.map((project) => {
    let best = { score: -1, length: 0, begin: 0 };
    const consider = (label: string, scheme: "default" | "path") => {
      const m = fuzzySearch(label, q, scheme);
      if (m && m.score > best.score) {
        best = { score: m.score, length: label.length, begin: m.positions[0] ?? 0 };
      }
    };
    consider(project.name, "path");
    for (const p of project.processes) consider(p.name, "default");
    return { project, ...best };
  });
  ranked.sort((a, b) => b.score - a.score || a.length - b.length || a.begin - b.begin);
  return ranked.map((r) => r.project);
}

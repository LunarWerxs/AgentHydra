// HSwarm's job summary counts a job's queued tasks (status "pending"), but the job's results list only
// the running and the finished ones: the queued have no ids yet. This says how many lines are missing.

/** Queued tasks the summary counts that no listed task line stands for. */
export function missingQueued(counts: Record<string, number> | undefined, listed: ReadonlyArray<{ status: string }>): number {
  const have = listed.reduce((n, x) => n + (x.status === 'pending' ? 1 : 0), 0)
  return Math.max(0, (counts?.pending ?? 0) - have)
}

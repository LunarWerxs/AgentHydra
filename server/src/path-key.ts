// server/src/path-key.ts - THE comparison key for path-shaped strings (consolidation pass,
// 2026-08-29). Four modules grew private copies of "unify slashes, trim trailing, maybe fold
// case" in one day - and two of the day's review-confirmed bugs were exactly this helper done
// slightly differently (fleet-git's unconditional lowercase vanishing a repo on case-sensitive
// filesystems; session-launch's missing slash-unify reading a RUNNING instance as not running).
// One definition ends that class.
//
// This is a PURE string key for comparing two spellings of the same path or 'desktop:<dir>'
// ref - it never touches the filesystem. For identity/cache keys that should also absolutize,
// core/paths.ts's normalizeInstancePath (resolve semantics) remains the right tool; the two
// helpers do different jobs on purpose.

/**
 * Case folding defaults to the platform's reality: on win32 paths are case-insensitive; on
 * POSIX two paths differing only by case are DIFFERENT files. Tests pass `caseFold` explicitly
 * to pin both worlds from one machine.
 */
export function pathKey(p: string, caseFold: boolean = process.platform === 'win32'): string {
  const unified = p.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
  return caseFold ? unified.toLowerCase() : unified
}

/** Do two spellings name the same path? Null/empty never matches anything. */
export function samePathKey(
  a: string | null | undefined,
  b: string | null | undefined,
  caseFold?: boolean,
): boolean {
  if (!a || !b) return false
  return pathKey(a, caseFold) === pathKey(b, caseFold)
}

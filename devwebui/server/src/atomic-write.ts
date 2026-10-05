import { renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Crash-safe file write: serialize into a sibling temp file, then rename it over the
 * target. `rename` within a directory is atomic on every filesystem we target, so a
 * crash/power-loss/AV-kill leaves EITHER the old file intact OR the new one complete —
 * never the half-written middle state a plain `writeFileSync` truncate-then-write can
 * leave behind.
 *
 * This matters most for the files we do NOT own: a `.devwebui` lives in the user's own
 * repo and is usually version-controlled and hand-authored, so truncating one on a
 * mistimed crash destroys their work, not ours. `runtime.ts` and `connections.ts` had
 * already hand-rolled this pattern for their own settings; this is that same pattern
 * extracted so every writer shares one audited copy.
 *
 * The temp name carries the pid so two processes writing the same target can't collide
 * on the temp itself, and it is a SIBLING of the target (not in the system temp dir)
 * because `rename` cannot be atomic across filesystems.
 */
export function writeFileAtomic(
  filePath: string,
  contents: string,
  options: { mode?: number } = {},
): void {
  const target = path.resolve(filePath);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, contents, options.mode === undefined ? undefined : { mode: options.mode });
    renameSync(tmp, target);
  } catch (e) {
    // Best-effort cleanup so a failed write can't litter the user's repo with .tmp files.
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore — the original error below is the one worth reporting */
    }
    throw e;
  }
}

/** {@link writeFileAtomic} for JSON, with the project's standard 2-space + trailing-newline shape. */
export function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options: { mode?: number; trailingNewline?: boolean } = {},
): void {
  const body = JSON.stringify(value, null, 2);
  writeFileAtomic(filePath, options.trailingNewline === false ? body : `${body}\n`, {
    mode: options.mode,
  });
}

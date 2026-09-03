/**
 * Make "owner-only" mean owner-only on Windows too.
 *
 * `writeFileSync(p, …, { mode: 0o600 })` is a POSIX permission bit; on NTFS it is very nearly a
 * no-op (Node maps only the write bit onto the read-only attribute and touches no ACL). The two
 * files that matter here - the HMAC key behind every owner session (signing.ts) and config.json,
 * which may hold a named-tunnel connector token - get a real ACL as well as the bit.
 *
 * `icacls` is the only way to do this without a native addon. Best-effort by design: a failure
 * here must never stop the gateway from starting; the file is no worse off than before.
 * Vendored from RepoYeti's src/fs-perms.ts.
 */
import { spawnSync } from 'node:child_process'

/** Restrict `path` to the current user (plus SYSTEM). No-op off win32, where `mode` works. */
export function restrictToCurrentUser(path: string): void {
  if (process.platform !== 'win32') return
  const user = process.env.USERNAME
  if (!user) return
  try {
    spawnSync(
      'icacls',
      [path, '/inheritance:r', '/grant:r', `${user}:F`, '/grant:r', '*S-1-5-18:F'],
      { stdio: 'ignore', windowsHide: true, timeout: 5000 },
    )
  } catch {
    /* best-effort */
  }
}

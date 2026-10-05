export interface UpdateStatus {
  ok: boolean;
  service: string;
  currentVersion: string;
  currentCommit: string | null;
  remoteCommit: string | null;
  branch: string | null;
  upstream: string | null;
  remote: string | null;
  dirty: boolean;
  updateAvailable: boolean;
  canApply: boolean;
  checkedAt: number;
  reason: string | null;
  /** The remote branch an apply would pull: the tracked/local branch when the remote has it, else
   *  the remote's HEAD branch the check fell back to. OPTIONAL: set by the git-checkout engine only. */
  remoteBranch?: string | null;
  /** True when a newer remote commit exists but HEAD is not its ancestor, so `pull --ff-only`
   *  cannot apply it (local commits the remote lacks). `canApply` is false and `reason` says so.
   *  OPTIONAL: set by the git-checkout engine only. */
  diverged?: boolean;
  /** Set only while an update cooldown is in play: the remote branch tip, whereas `remoteCommit` is
   *  the newest first-parent commit old enough to adopt (null when none is yet). OPTIONAL: set by
   *  the git-checkout engine only. */
  latestRemoteCommit?: string | null;
  /** The cooldown in days that chose `remoteCommit`; present alongside `latestRemoteCommit`. */
  cooldownDays?: number;
  /** Installed version of each release-owned component, or null where an install predates version
   *  stamping. OPTIONAL because only an app whose release ships sidecar components beside the
   *  executable can populate it: the git-checkout engine has no such components, and a fabricated
   *  entry there would be worse than an absent one. */
  components?: Array<{ name: string; version: string | null }>;
}

export interface UpdateApplyResult {
  ok: boolean;
  message: string;
  restartRequired: boolean;
  status: UpdateStatus;
  output: string[];
}

/** What `applyUpdate` rejects with: `message` is the one-line reason, `output` is every step's
 *  `$ command` + result recorded before the failure (rollback steps included), in order. */
export interface UpdateApplyError extends Error {
  output: string[];
}

export interface UpdaterOptions {
  /** Checkout root (each app resolves its own import.meta path and passes it in). */
  appRoot: string;
  /** Value of the `service` field on UpdateStatus. */
  serviceName: string;
  /** Display name used in the apply-result messages. */
  appLabel: string;
  /** Env var whose value overrides the update remote (URL or remote name). */
  updateRepoEnvVar: string;
  /** Install step, e.g. ["bun", "install"]. */
  installCmd: string[];
  /** Build step, e.g. ["bun", "run", "--cwd", "web", "build"]. */
  buildCmd: string[];
  /** Adopt only commits at least this many days old (committer date, first-parent history of the
   *  remote branch), so a bad push can be caught before installs run it. Default 0: off, the tip is
   *  adopted as soon as it is seen. Not a defence against a compromised push: the committer date is
   *  set by whoever pushes and can be backdated past the cooldown. */
  cooldownDays?: number;
}

export interface Updater {
  checkForUpdate(): Promise<UpdateStatus>;
  applyUpdate(): Promise<UpdateApplyResult>;
}

export function createUpdater(opts: UpdaterOptions): Updater;

/**
 * Open `<dir>/logs/daemon.log` and tee every `console.*` call to it (synchronous writes). The log
 * rolls at 20 MB, at start and while running, into gzipped `daemon.log.1.gz` .. `.3.gz`. Idempotent.
 * Call as the FIRST thing at startup, passing the app's config dir (e.g. `REPOYETI_HOME` else
 * `~/.repoyeti`). Returns the log-file path, or `null` if file logging could not be set up (the
 * console then behaves exactly as before). Never throws. `opts.maxBytes` lowers the roll size (tests).
 */
export function initFileLogging(dir: string, opts?: { maxBytes?: number }): string | null;

/** Roll `path` into `path.1.gz`, shifting older gzips up to `keep` (default 3). Never throws. */
export function rotateLog(path: string, keep?: number): void;

/** The current log-file path, or `null` if file logging isn't active. */
export function logFilePath(): string | null;

/** Undo the console patch, close the file and put back the default roll size. For tests; the daemon never calls this. */
export function restoreFileLogging(): void;

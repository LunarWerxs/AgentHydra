// ---------------------------------------------------------------------------
// Fast, bounded project scan. It always finds existing .devwebui files, and can
// optionally detect unconfigured package-script projects while walking. The
// breadth-first walk (a) prunes node_modules + heavy/system dirs, (b) caps depth,
// total results, and wall-clock time, and (c) reads many directories concurrently.
// Bounded by design so it returns quickly on a typical dev tree and never runs
// away on a full drive.
// ---------------------------------------------------------------------------
import { existsSync } from "node:fs";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectProject } from "./detect";
import type { DetectedProject, FoundFile, ScanResult, ScanPreset } from "../../shared/dto";

export type { DetectedProject, FoundFile, ScanResult, ScanPreset } from "../../shared/dto";

// ALWAYS skipped — universal dev junk + big app/game stores that never hold a
// .devwebui. Lower-cased; matched case-insensitively. (Dot-directories like
// .git/.next/.cache/.gradle/.cargo are pruned separately by the leading dot.)
const PRUNE = new Set([
  // generated / dependency / build dirs (inside repos)
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "target",
  "bin",
  "obj",
  "__pycache__",
  "venv",
  ".venv",
  "go",
  // big non-dev app / game stores
  "steamlibrary",
  "steamapps",
  "epic games",
  "gog galaxy",
  "riot games",
  "battle.net",
  "origin games",
  "ea games",
  "ubisoft",
  "xboxgames",
]);

// OS system-folder skip groups — added to the scan's excludes only when the
// matching toggle is on (see Settings). Folder names, matched anywhere.
export type SkipOs = "windows" | "mac" | "linux";
export const OS_SKIP: Record<SkipOs, string[]> = {
  windows: [
    "windows",
    "winnt",
    "windows.old",
    "program files",
    "program files (x86)",
    "programdata",
    "appdata",
    "application data",
    "windowsapps",
    "$recycle.bin",
    "system volume information",
    "$windows.~ws",
    "$windows.~bt",
    "$winreagent",
    "$sysreset",
    "$getcurrent",
    "recovery",
    "perflogs",
    "config.msi",
    "msocache",
    "packages.microsoft.com",
    "boot",
    "efi",
    "documents and settings",
    "all users",
    "default user",
    "onedrivetemp",
    "windows defender",
    "intel",
    "amd",
    "nvidia",
    "drivers",
    "msbuild",
  ],
  mac: [
    "library",
    "system",
    "applications",
    "private",
    "cores",
    "network",
    "volumes",
    "system volume information",
    "deriveddata",
  ],
  linux: [
    "proc",
    "sys",
    "dev",
    "run",
    "mnt",
    "media",
    "var",
    "usr",
    "boot",
    "opt",
    "srv",
    "lost+found",
    "snap",
    "tmp",
    "lib",
    "lib64",
    "sbin",
    "etc",
  ],
};

/** Sensible default roots: the user's home, plus every non-home fixed drive on Windows. */
export function defaultScanRoots(): string[] {
  const home = os.homedir();
  const roots = [home];
  if (process.platform === "win32") {
    const homeDrive = home.slice(0, 3).toUpperCase(); // e.g. "C:\"
    for (let c = 65; c <= 90; c++) {
      const root = `${String.fromCharCode(c)}:\\`;
      if (root.toUpperCase() !== homeDrive && existsSync(root)) roots.push(root);
    }
  }
  return roots;
}

async function describe(file: string): Promise<FoundFile> {
  try {
    const j = JSON.parse(await readFile(file, "utf8"));
    const processes = Array.isArray(j.processes) ? j.processes.length : 0;
    const name = typeof j.name === "string" && j.name ? j.name : path.basename(file);
    return { path: file, name, processes, valid: !!(j.name && processes) };
  } catch {
    return { path: file, name: path.basename(file), processes: 0, valid: false };
  }
}

async function describeDetected(dir: string): Promise<DetectedProject | null> {
  try {
    const proposal = await detectProject(dir);
    if (!proposal) return null;
    return {
      path: dir,
      name: proposal.name,
      framework: proposal.framework,
      processes: proposal.processes.length,
    };
  } catch {
    return null;
  }
}

/** Named scan profiles owned by the daemon, so call sites ask for an intent, not raw numbers. */
export const SCAN_PRESETS: Record<
  ScanPreset,
  { maxDepth: number; budgetMs: number; limit: number }
> = {
  quick: { maxDepth: 3, budgetMs: 6000, limit: 500 }, // shallow first pass — the likely projects
  deep: { maxDepth: 16, budgetMs: 30000, limit: 5000 }, // thorough whole-machine sweep
  scoped: { maxDepth: 16, budgetMs: 30000, limit: 5000 }, // a single typed folder (small, so fast)
  startup: { maxDepth: 12, budgetMs: 30000, limit: 5000 }, // background launch scan
};

export interface ScanOptions {
  roots?: string[];
  maxDepth?: number;
  limit?: number;
  budgetMs?: number;
  concurrency?: number;
  exclude?: string[]; // extra folder names (matched anywhere) or absolute paths to skip
  detectPackages?: boolean; // also find folders whose package scripts can scaffold a .devwebui
  preset?: ScanPreset; // supplies maxDepth/budgetMs/limit defaults; explicit values still win
  signal?: AbortSignal; // abort the walk when the requesting client disconnects
}

// Single-flight + serialize the scanner. Signal-less identical requests share a walk,
// and at most ONE walk runs at a time daemon-wide — so overlapping broad scans queue
// instead of stacking 2×concurrency readdir() storms. Request-owned abort signals are
// kept independent below so one disconnected client cannot cancel another caller's scan.
let scanChain: Promise<unknown> = Promise.resolve();
const inflight = new Map<string, Promise<ScanResult>>();

export function scanForDevWebUI(opts: ScanOptions = {}): Promise<ScanResult> {
  const { signal, preset, ...rest } = opts;
  const base = preset ? SCAN_PRESETS[preset] : undefined;
  const merged: ScanOptions = {
    ...rest,
    maxDepth: rest.maxDepth ?? base?.maxDepth,
    budgetMs: rest.budgetMs ?? base?.budgetMs,
    limit: rest.limit ?? base?.limit,
  };
  const key = JSON.stringify(merged); // identical request signature (signal excluded)
  // A request-owned AbortSignal cannot safely own a shared scan: one browser navigating away
  // would cancel the result for every other identical caller. Signal-less background scans can
  // still coalesce; abortable HTTP scans remain serialized by scanChain but are independent.
  const shareable = !signal;
  const existing = shareable ? inflight.get(key) : undefined;
  if (existing) return existing;
  const tracked = scanChain
    .catch(() => {}) // scanChain is a serialization baton, not a result — a prior scan's
    // failure must not block this one from running, so swallow and proceed
    .then(() => runScan({ ...merged, signal }))
    .finally(() => {
      if (shareable && inflight.get(key) === tracked) inflight.delete(key);
    });
  scanChain = tracked.catch(() => {}); // next scan waits for this one to finish
  if (shareable) inflight.set(key, tracked);
  return tracked;
}

/** The walk's normalized bounds + split exclude sets, resolved once per scan. */
type ScanBounds = {
  roots: string[];
  excludeNames: Set<string>;
  excludePaths: string[];
  maxDepth: number;
  limit: number;
  budgetMs: number;
  concurrency: number;
};

function parseScanOptions(opts: ScanOptions): ScanBounds {
  // Split user excludes into bare names (match any folder) vs absolute paths (prefix match).
  const excludeNames = new Set<string>();
  const excludePaths: string[] = [];
  for (const raw of opts.exclude ?? []) {
    const t = String(raw).trim().toLowerCase();
    if (!t) continue;
    if (/^([a-z]:[\\/]|[\\/])/.test(t)) excludePaths.push(path.resolve(t).toLowerCase());
    else excludeNames.add(t);
  }
  return {
    roots: (opts.roots?.length ? opts.roots : defaultScanRoots()).map((r) => path.resolve(r)),
    excludeNames,
    excludePaths,
    maxDepth: Math.min(Math.max(opts.maxDepth ?? 12, 1), 16),
    limit: Math.min(Math.max(opts.limit ?? 1000, 1), 5000),
    // Completeness over speed: default 30s ceiling (was 5s) so a deep scan won't miss
    // vital projects. The watchdog below guarantees we still return by then.
    budgetMs: Math.min(Math.max(opts.budgetMs ?? 30000, 500), 60000),
    // Directory scanning is I/O-latency bound, so many concurrent readdir()s — not OS
    // threads — are the lever. Bun parallelises async readdir well past 24 (≈3× from 24→64).
    concurrency: Math.min(Math.max(opts.concurrency ?? 64, 1), 512),
  };
}

async function runScan(opts: ScanOptions = {}): Promise<ScanResult> {
  const signal = opts.signal;
  const start = Date.now();
  const { roots, excludeNames, excludePaths, maxDepth, limit, budgetMs, concurrency } =
    parseScanOptions(opts);

  const files: FoundFile[] = [];
  const detected: DetectedProject[] = [];
  const seen = new Set<string>(roots.map((r) => r.toLowerCase()));
  let scannedDirs = 0;
  let truncated = false;
  let timedOut = false;
  let settled = false;

  // The three flags above mean "stop walking" to every part of the walk; named once so the
  // per-entry and per-directory guards read as one condition each instead of three.
  const stopped = (): boolean => settled || timedOut || truncated;
  /** Results so far, against `limit` — the cap counts files and detected projects together. */
  const collected = (): number => files.length + detected.length;

  // Full path to descend into, or null if `e` is pruned/excluded/already seen/too deep.
  // Marks the path seen as a side effect of accepting it, same as the original inline check.
  function resolveSubdir(dir: string, e: Dirent, depth: number): string | null {
    if (depth + 1 > maxDepth) return null;
    const lower = e.name.toLowerCase();
    if (e.name.startsWith(".") || PRUNE.has(lower) || excludeNames.has(lower)) return null;
    const full = path.join(dir, e.name);
    const k = full.toLowerCase();
    if (excludePaths.some((p) => k === p || k.startsWith(p + path.sep))) return null;
    if (seen.has(k)) return null;
    seen.add(k);
    return full;
  }

  // Classify one directory's already-read entries: which subdirs to descend into, which
  // files to describe, and whether the dir looks like an undetected package root. Pulled
  // out of scanDir so the per-entry branching is its own (small) function.
  function partitionEntries(dir: string, depth: number, entries: Dirent[]) {
    const subdirs: { dir: string; depth: number }[] = [];
    const fileJobs: Promise<FoundFile>[] = [];
    let packageJson = false;
    for (const e of entries) {
      if (stopped()) break;
      if (e.isSymbolicLink()) continue; // don't follow links — avoids cycles + escapes
      if (e.isDirectory()) {
        const full = resolveSubdir(dir, e, depth);
        if (full) subdirs.push({ dir: full, depth: depth + 1 });
      } else if (e.isFile()) {
        const lower = e.name.toLowerCase();
        if (lower.endsWith(".devwebui")) fileJobs.push(describe(path.join(dir, e.name)));
        else if (opts.detectPackages && lower === "package.json") packageJson = true;
      }
    }
    return { subdirs, fileJobs, packageJson };
  }

  // Drain one directory's .devwebui jobs into `files`, honouring the shared result cap.
  async function collectFiles(fileJobs: Promise<FoundFile>[]): Promise<void> {
    for (const f of await Promise.all(fileJobs)) {
      if (stopped()) break;
      if (collected() >= limit) {
        truncated = true;
        break;
      }
      files.push(f);
    }
  }

  // A package root with no .devwebui of its own: nothing to add here, but its scripts
  // could scaffold one. Does nothing unless detection is on and this dir was a bare package root.
  async function detectPackageRoot(
    dir: string,
    sawPackageJson: boolean,
    hadOwnFiles: boolean,
  ): Promise<void> {
    if (!opts.detectPackages || !sawPackageJson || hadOwnFiles) return;
    if (stopped() || collected() >= limit) return;
    const found = await describeDetected(dir);
    // Other concurrent directories may have filled the shared result cap while package.json
    // was being inspected.
    if (!found || settled || timedOut) return;
    if (collected() < limit) detected.push(found);
    else truncated = true;
  }

  // Read one directory: collect its .devwebui files, return its descendable subdirs.
  async function scanDir(dir: string, depth: number): Promise<{ dir: string; depth: number }[]> {
    if (stopped()) return [];
    scannedDirs++;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries || stopped()) return []; // unreadable (permissions, gone), or we just gave up
    const { subdirs, fileJobs, packageJson } = partitionEntries(dir, depth, entries);
    await collectFiles(fileJobs);
    await detectPackageRoot(dir, packageJson, fileJobs.length > 0);
    return subdirs;
  }

  // Continuous work-pool: keep `concurrency` directories in flight at once across ALL
  // roots/depths, so a huge home tree never starves the other drives (level-by-level did).
  const queue: { dir: string; depth: number }[] = roots.map((dir) => ({ dir, depth: 0 }));
  let queueHead = 0;
  let active = 0;
  await new Promise<void>((resolve) => {
    let onAbort: (() => void) | null = null;
    function settle() {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      resolve();
    }
    // Backstop: pump() only re-fires when a readdir settles, so if every in-flight
    // readdir stalls (a hung mapped/removable drive) the in-pump budget check never
    // runs. This timer guarantees we return within budget regardless.
    const watchdog = setTimeout(() => {
      timedOut = true;
      settle();
    }, budgetMs + 100);
    // Client disconnected (Hono aborts the request signal) — stop walking and return
    // whatever we've found so far rather than burning I/O nobody is waiting on.
    if (signal) {
      if (signal.aborted) {
        timedOut = true;
        settle();
      } else {
        onAbort = () => {
          timedOut = true;
          settle();
        };
        signal.addEventListener("abort", onAbort);
      }
    }
    const pump = () => {
      if (settled) return;
      if (Date.now() - start > budgetMs) timedOut = true;
      else if (collected() >= limit) truncated = true;
      if (timedOut || truncated) {
        settle();
        return;
      }
      while (active < concurrency && queueHead < queue.length) {
        // Indexed FIFO avoids copying a potentially huge directory frontier on every visit.
        const { dir, depth } = queue[queueHead++]!;
        active++;
        scanDir(dir, depth)
          .then((subs) => {
            if (settled) return;
            for (const s of subs) queue.push(s);
          })
          .finally(() => {
            active--;
            pump();
          });
      }
      if (active === 0 && queueHead >= queue.length) settle();
    };
    pump();
  });

  // Show the most useful first: most processes, then shallowest path.
  files.sort((a, b) => b.processes - a.processes || a.path.length - b.path.length);
  detected.sort((a, b) => b.processes - a.processes || a.path.length - b.path.length);

  return { files, detected, scannedDirs, truncated, timedOut, ms: Date.now() - start, roots };
}

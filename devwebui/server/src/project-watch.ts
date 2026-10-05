// Live `.devwebui` reloading — the daemon re-reads a project's file when it changes
// on disk, so an edit shows up in the GUI without restarting anything.
//
// The gap this closes: `readDevWebUIFile()` ran EXACTLY ONCE per project — the boot
// loop in index.ts, or a GUI/MCP load. The daemon is long-lived, so after that first
// parse the file on disk and the daemon's picture of it drifted apart silently. Edit
// `.devwebui` in an editor, reload the GUI, and you'd still see the OLD process list:
// the frontend faithfully rendered what the daemon held, and the daemon had never
// looked at the file again. (Found 2026-07-16: five servers added to a repo's
// `.devwebui` were invisible in the GUI until the daemon restarted. Reloading the
// browser cannot help — the staleness is server-side.)
//
// Reconciliation is NOT re-implemented here: `Manager.reconcileProject()` already
// applies a re-read the right way — it adds new processes, drops removed ones, and
// PRESERVES the running state of everything unchanged, restarting only a process whose
// exec shape (command/cwd/runtime/env) actually moved. This module's whole job is to
// notice the write and call it. That is why auto-reload is safe: editing a file to add
// a server never disturbs the servers already running.
//
// Five things it has to get right, each of which breaks a naive `watch(file)`:
//
//   1. WATCH THE DIRECTORY, NOT THE FILE. Editors (and `git checkout`, and any
//      write-temp-then-rename) save ATOMICALLY: the original inode is replaced, not
//      appended to. A file-level watch is bound to the old inode and goes permanently
//      deaf after the first such save — it would work once in testing and never again
//      in real use. A non-recursive directory watch keeps firing across replacements.
//   2. DEBOUNCE. One save emits several events (rename + change, or chunked writes).
//      Reconciling per event does the work N times and can restart a server mid-write.
//   3. NEVER TRUST A PARTIAL READ. A file caught mid-write parses as invalid JSON, and
//      an atomic rename leaves a window where the path briefly does not exist at all.
//      Both throw, and both are TRANSIENT — so a failed read is skipped and left for
//      the next event, never allowed to drop the project. A project vanishing from the
//      GUI because it was read 3ms too early would be a far worse bug than staleness.
//   4. IGNORE NO-OP WRITES. Compared against the last text we successfully applied, so
//      a touch, a formatter rewrite, or the daemon's OWN writes (the GUI/MCP edit
//      routes write the file, then reconcile it themselves) don't reconcile twice.
//      Belt-and-braces: reconcileProject is idempotent, so the duplicate would be
//      harmless anyway — by the time our event lands, the route has already applied
//      the same def and `execChanged` is false, so nothing restarts.
//   5. TREAT THE EVENT'S FILENAME AS ADVISORY. It is the least portable part of
//      fs.watch. For an atomic save, Windows reports both the old and the new name, so
//      the destination `.devwebui` shows up; Linux and macOS report the event against
//      the TEMP file, or omit the name entirely, and never name the destination. Keying
//      the re-check off that name therefore missed precisely the save style rule 1
//      exists to survive, and it did so on 2 of the 3 platforms we ship (caught by CI
//      2026-07-18, after a Windows-only local run passed). So the name is ignored: any
//      event in a watched dir re-checks that dir's watched files. A spurious check
//      costs one small read and changes nothing, because rule 4 byte-compares before
//      doing any work, and rule 2 coalesces a burst into a single check.
//
// The watch set self-syncs off the manager's "projects" event — the same signal the
// GUI listens to — so loading or removing a project adjusts the watchers with no call
// sites to keep in step.
import { type FSWatcher, readFileSync, watch } from "node:fs";
import path from "node:path";
import type { Manager } from "./manager";
import { readDevWebUIFile } from "./projects";

// Long enough to coalesce an editor's multi-event save, short enough to feel instant.
// The cost of being too low is a wasted parse (harmless — see rule 3); the cost of
// being too high is the GUI feeling laggy after a save.
const DEBOUNCE_MS = 200;

/** Case/separator-insensitive key, matching the registry's own path identity. */
const keyOf = (filePath: string): string => path.resolve(filePath).toLowerCase();

export class ProjectWatcher {
  /** dir key → one non-recursive watcher covering every watched file in it. */
  private dirWatchers = new Map<string, FSWatcher>();
  /** file key → the raw text we last successfully reconciled (null = not yet read). */
  private lastText = new Map<string, string | null>();
  /** file key → its pending debounce timer. */
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** file key → its real (non-lowercased) path, for reads and logs. */
  private realPath = new Map<string, string>();
  private stopped = false;

  constructor(private readonly manager: Manager) {}

  /** Begin watching every loaded project, and keep the set in step as projects come and go. */
  start(): void {
    this.sync();
    this.manager.on("projects", this.sync);
  }

  /** Close every watcher and cancel pending reloads (daemon shutdown). */
  stop(): void {
    this.stopped = true;
    this.manager.off("projects", this.sync);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const w of this.dirWatchers.values()) w.close();
    this.dirWatchers.clear();
    this.lastText.clear();
    this.realPath.clear();
  }

  /** Files currently watched — exposed for tests/diagnostics. */
  watchedFiles(): string[] {
    return [...this.realPath.values()];
  }

  // Reconcile the watch set with the manager's loaded projects. Arrow-bound so it can
  // be used directly as the "projects" listener (and removed again in stop()).
  private sync = (): void => {
    if (this.stopped) return;
    const desired = new Map<string, string>();
    for (const p of this.manager.listProjects()) desired.set(keyOf(p.path), p.path);

    for (const [k, file] of desired) {
      if (this.lastText.has(k)) continue;
      this.realPath.set(k, file);
      // Prime with the current text so the initial sync doesn't reconcile state the
      // manager just loaded. An unreadable file primes null and reloads on first event.
      this.lastText.set(k, this.readRaw(file));
    }
    for (const k of [...this.lastText.keys()]) {
      if (desired.has(k)) continue;
      this.lastText.delete(k);
      this.realPath.delete(k);
      const t = this.timers.get(k);
      if (t) {
        clearTimeout(t);
        this.timers.delete(k);
      }
    }
    this.syncDirs();
  };

  // One watcher per distinct parent dir of a watched file; drop dirs that no longer host one.
  private syncDirs(): void {
    const needed = new Set<string>();
    for (const file of this.realPath.values()) needed.add(keyOf(path.dirname(file)));

    for (const [dirKey, w] of this.dirWatchers) {
      if (needed.has(dirKey)) continue;
      w.close();
      this.dirWatchers.delete(dirKey);
    }
    for (const file of this.realPath.values()) {
      const dir = path.dirname(file);
      const dirKey = keyOf(dir);
      if (this.dirWatchers.has(dirKey)) continue;
      try {
        // The reported filename is ADVISORY, so it is never used to decide whether to
        // re-check (see rule 5). Every event in a watched dir re-checks that dir's
        // watched files.
        const w = watch(dir, { persistent: false }, () => {
          for (const [k, f] of this.realPath) {
            if (keyOf(path.dirname(f)) === dirKey) this.schedule(k);
          }
        });
        // A watched dir being renamed/removed surfaces here; drop the watcher rather
        // than let an unhandled 'error' event take the daemon down with it.
        w.on("error", () => {
          w.close();
          this.dirWatchers.delete(dirKey);
        });
        this.dirWatchers.set(dirKey, w);
      } catch {
        // Unwatchable dir (permissions, a path that just disappeared). Staleness is the
        // cost; a thrown watcher must never stop the daemon from booting.
      }
    }
  }

  private schedule(fileKey: string): void {
    if (this.stopped || !this.lastText.has(fileKey)) return;
    const pending = this.timers.get(fileKey);
    if (pending) clearTimeout(pending);
    this.timers.set(
      fileKey,
      setTimeout(() => {
        this.timers.delete(fileKey);
        this.reload(fileKey);
      }, DEBOUNCE_MS),
    );
  }

  private readRaw(file: string): string | null {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null; // mid-rename, or gone — transient by assumption (see rule 3)
    }
  }

  private reload(fileKey: string): void {
    if (this.stopped) return;
    const file = this.realPath.get(fileKey);
    if (!file) return;

    const raw = this.readRaw(file);
    // Unreadable, or byte-identical to what's already applied: nothing to do. Leaving
    // lastText untouched on a failed read is what makes the retry work — the next write
    // differs from the last APPLIED text, so it still reconciles.
    if (raw == null || raw === this.lastText.get(fileKey)) return;

    let loaded: ReturnType<typeof readDevWebUIFile>;
    try {
      loaded = readDevWebUIFile(file);
    } catch (e) {
      // Invalid JSON / schema. Usually a half-written save (self-heals on the next
      // event); if it's a real authoring mistake, say so once per distinct bad text
      // and keep the last good state loaded rather than tearing the project down.
      this.lastText.set(fileKey, raw);
      console.error(`[devwebui] ${file}: ${(e as Error).message}`);
      return;
    }
    this.lastText.set(fileKey, raw);
    try {
      // fromWatch: this reload came from the FILE changing, not from a user action —
      // see ManagerWithProjects.reconcileProject for why that must not auto-execute.
      this.manager.reconcileProject(loaded, { fromWatch: true });
    } catch (e) {
      console.error(`[devwebui] reload failed for ${file}: ${(e as Error).message}`);
    }
  }
}

/** Start watching loaded projects' files. Returns the watcher so the daemon can stop it. */
export function startProjectWatch(manager: Manager): ProjectWatcher {
  const w = new ProjectWatcher(manager);
  w.start();
  return w;
}

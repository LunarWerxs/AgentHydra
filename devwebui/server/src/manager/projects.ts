import type { LoadedProject, ProcessDef } from "../types";
import { deleteLogs } from "../log-vault";
import { clearEnabledOverrides, clearProjectOverride } from "../state";
import { ManagerWithLifecycle } from "./lifecycle";
import type { Entry, Project } from "./types";

/**
 * The definition fields that decide what actually GETS EXECUTED. A reload that changes
 * any of them is the security-relevant case `reconcileProject` treats specially; cosmetic
 * edits (name, port, colour) are never "exec changes".
 */
function execDefinitionChanged(prev: ProcessDef, next: ProcessDef): boolean {
  return (
    prev.command !== next.command ||
    prev.cwd !== next.cwd ||
    prev.runtime !== next.runtime ||
    JSON.stringify(prev.env ?? null) !== JSON.stringify(next.env ?? null) ||
    // A compose block runs docker commands before spawning, so it is executed config too.
    JSON.stringify(prev.compose ?? null) !== JSON.stringify(next.compose ?? null) ||
    // Prompt answers are typed into the process's stdin, so they are executed input too.
    JSON.stringify(prev.answers ?? null) !== JSON.stringify(next.answers ?? null)
  );
}

/**
 * Project registration/reload/removal — the "write" half of project
 * management (the read-only `listProjects`/`getProjectPath` live in
 * `ManagerBase` since they're also needed there for `emitProjects`).
 */
export class ManagerWithProjects extends ManagerWithLifecycle {
  // ---- projects ---------------------------------------------------------
  /**
   * Register (or hard-reload) a project. Use reconcileProject for in-place edits.
   * `opts.autostart` (default true) gates the launch-time auto-start: the boot loop
   * passes the `autoStartOnLaunch` setting so a fresh daemon doesn't stampede every
   * server, while runtime GUI adds keep auto-starting per their toggles.
   */
  addProject(p: LoadedProject, opts?: { autostart?: boolean }): void {
    const prev = this.projects.get(p.id);
    if (prev) {
      // Hard reload: forget toggles for processes that no longer exist in the file
      // (a renamed/removed id would otherwise leak forever in state.json).
      const incoming = new Set(p.processes.map((x) => x.id));
      clearEnabledOverrides(prev.processIds.filter((id) => !incoming.has(id)));
      this.purgeProject(p.id);
    }
    this.projects.set(p.id, {
      id: p.id,
      name: p.name,
      color: p.color,
      path: p.path,
      processIds: p.processes.map((x) => x.id),
    });
    for (const def of p.processes) this.entries.set(def.id, this.newEntry(def));
    if (opts?.autostart ?? true)
      this.startMany(p.processes.filter((def) => this.willAutostart(def)).map((def) => def.id));
    this.emitProjects();
  }

  /**
   * Run the launch-time auto-start the boot loop skipped: safe mode's "Leave safe mode". Same
   * selection addProject makes (project switch AND process toggle); anything already running or
   * queued is left alone by startMany. Returns the ids it asked to start.
   */
  startLaunchAutostart(): string[] {
    const ids: string[] = [];
    for (const proj of this.projects.values())
      for (const id of proj.processIds) {
        const e = this.entries.get(id);
        if (e && this.willAutostart(e.def)) ids.push(id);
      }
    this.startMany(ids);
    return ids;
  }

  /**
   * Apply a re-read of a project's file, preserving the running state of unchanged processes.
   *
   * `opts.fromWatch` marks a reload triggered by the file changing ON DISK rather than by a
   * user action in the GUI/CLI/MCP. That distinction is a security boundary: a `git pull`,
   * a branch switch, or a teammate's commit can change a `.devwebui` with no code execution
   * involved, and applying it blindly would relaunch a running server on an attacker-supplied
   * command — or start a brand-new one — within one debounce window. So a watch-driven reload
   * REGISTERS the new definition but does not act on it: changed processes keep running as
   * they were and are flagged `configChanged` for an explicit restart, and newly-appeared
   * processes stay stopped regardless of `autostart`. GUI-driven edits (opts absent) apply
   * immediately, exactly as before — the user is right there and asked for it.
   */
  reconcileProject(lp: LoadedProject, opts?: { fromWatch?: boolean }): void {
    const fromWatch = opts?.fromWatch === true;
    const existing = this.projects.get(lp.id);
    if (!existing) {
      this.addProject(lp, { autostart: !fromWatch });
      return;
    }

    const incoming = new Map(lp.processes.map((p) => [p.id, p]));
    this.dropRemovedProcesses(existing, incoming);
    this.startMany(this.applyProcessDefs(lp, fromWatch));

    existing.name = lp.name;
    existing.color = lp.color;
    existing.processIds = lp.processes.map((p) => p.id);
    this.emitProjects();
  }

  /** Processes that vanished from the file: tear down the entry and forget everything keyed to its id. */
  private dropRemovedProcesses(existing: Project, incoming: Map<string, ProcessDef>): void {
    for (const pid of [...existing.processIds]) {
      if (incoming.has(pid)) continue;
      const e = this.entries.get(pid);
      if (e) this.discardEntry(e);
      this.entries.delete(pid);
      this.errors.clear(pid);
      this.alerts.removeRulesForProcess(pid); // process removed from the file: its rules can never match again
      clearEnabledOverrides([pid]); // process removed from the file — forget its toggle
    }
  }

  /**
   * Register every process in `lp`, updating existing entries in place. Returns the ids that
   * should now be auto-started — newly-appeared processes only, and never on a watch reload.
   */
  private applyProcessDefs(lp: LoadedProject, fromWatch: boolean): string[] {
    const newAutostartIds: string[] = [];
    for (const def of lp.processes) {
      const e = this.entries.get(def.id);
      if (!e) {
        this.entries.set(def.id, this.newEntry(def));
        if (this.willAutostart(def) && !fromWatch) newAutostartIds.push(def.id);
        continue;
      }
      const execChanged = execDefinitionChanged(e.def, def);
      e.def = def;
      if (execChanged && e.child) this.applyChangedExec(e, def.id, fromWatch);
      else this.emitStatus(e);
    }
    return newAutostartIds;
  }

  /** A running process whose definition changed: apply it now, or (watch reload) hold it. */
  private applyChangedExec(e: Entry, id: string, fromWatch: boolean): void {
    if (!fromWatch) {
      void this.restart(id);
      return;
    }
    // Registered, not applied — the running child keeps the definition it started
    // with until the user restarts it. `configChanged` drives the GUI's badge.
    e.configChanged = true;
    this.addLog(
      e,
      "stderr",
      "[devwebui] this process's .devwebui entry changed on disk; restart it to apply the new command.",
    );
    this.emitStatus(e);
  }

  async removeProject(id: string): Promise<void> {
    const proj = this.projects.get(id);
    if (!proj) return;
    await Promise.all(proj.processIds.map((pid) => this.stop(pid)));
    for (const pid of proj.processIds) {
      this.errors.clear(pid);
      this.alerts.removeRulesForProcess(pid);
      deleteLogs(pid); // no reader can ever reach these again — don't leave them on disk
    }
    clearEnabledOverrides(proj.processIds); // explicit removal — drop its toggles
    clearProjectOverride(id);
    this.purgeProject(id);
    this.emitProjects();
  }

  private purgeProject(id: string): void {
    const proj = this.projects.get(id);
    if (!proj) return;
    for (const pid of proj.processIds) {
      const e = this.entries.get(pid);
      if (e) this.discardEntry(e);
      this.entries.delete(pid);
    }
    this.projects.delete(id);
  }

  startProject(id: string): void {
    const p = this.projects.get(id);
    if (p) this.startMany(p.processIds);
  }

  /** Ids of every process with a live child — the snapshot the auto-update relaunch restores. */
  runningIds(): string[] {
    return [...this.entries.values()].filter((e) => e.child).map((e) => e.def.id);
  }

  /** Start an explicit list of ids through the ordinary staggered, dependency-ordered queue. */
  startProcesses(ids: string[]): void {
    this.startMany(ids.filter((id) => this.entries.has(id)));
  }

  async stopProject(id: string): Promise<void> {
    const p = this.projects.get(id);
    if (p) await Promise.all(p.processIds.map((pid) => this.stop(pid)));
  }
}

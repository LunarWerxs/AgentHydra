// ---------------------------------------------------------------------------
// Per-machine run-intent state (~/.devwebui/state.json). PURELY a preference for
// what should auto-start next time the daemon loads — toggling it NEVER starts or
// stops a live process (that's what the Start/Stop buttons are for).
//
// Two independent levels:
//   • per-process override  (default = the .devwebui `autostart`)
//   • per-project override   (default = on) — a master switch that GATES the whole
//     stack without touching the individual per-process toggles.
// A process auto-starts iff  projectEnabled(project) && processEnabled(process).
// ---------------------------------------------------------------------------
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-write";
import { dataDir } from "./data-dir";

const stateFile = (): string => path.join(dataDir(), "state.json");

interface StateShape {
  enabled: Record<string, boolean>; // process id -> on/off
  projectEnabled: Record<string, boolean>; // project id -> on/off (master switch)
}

let cache: StateShape | null = null;

const obj = (v: unknown): Record<string, boolean> =>
  v && typeof v === "object" ? (v as Record<string, boolean>) : {};

function load(): StateShape {
  if (cache) return cache;
  try {
    const j = JSON.parse(readFileSync(stateFile(), "utf8"));
    cache = { enabled: obj(j?.enabled), projectEnabled: obj(j?.projectEnabled) };
  } catch {
    cache = { enabled: {}, projectEnabled: {} };
  }
  return cache;
}

function persist(): void {
  if (!cache) return;
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeJsonAtomic(stateFile(), cache, { trailingNewline: false });
  } catch {
    /* best-effort — losing a toggle is recoverable */
  }
}

// ---- per-process ----------------------------------------------------------
/** The user's explicit on/off for a process, or undefined to use its autostart default. */
export function getEnabledOverride(id: string): boolean | undefined {
  return load().enabled[id];
}

export function setEnabledOverride(id: string, enabled: boolean): void {
  load().enabled[id] = enabled;
  persist();
}

/** Forget process overrides (e.g. when they're removed from a .devwebui file). */
export function clearEnabledOverrides(ids: string[]): void {
  const s = load();
  let changed = false;
  for (const id of ids)
    if (id in s.enabled) {
      delete s.enabled[id];
      changed = true;
    }
  if (changed) persist();
}

// ---- per-project (master switch) ------------------------------------------
/** The project's master on/off, or undefined to default ON. */
export function getProjectOverride(projectId: string): boolean | undefined {
  return load().projectEnabled[projectId];
}

export function setProjectOverride(projectId: string, enabled: boolean): void {
  load().projectEnabled[projectId] = enabled;
  persist();
}

export function clearProjectOverride(projectId: string): void {
  const s = load();
  if (projectId in s.projectEnabled) {
    delete s.projectEnabled[projectId];
    persist();
  }
}

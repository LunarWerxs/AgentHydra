import { mkdirSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic-write";
import path from "node:path";
import { dataDir } from "./data-dir";
import type { ErrorEvent, ErrorSource } from "../../shared/dto";

export type { ErrorEvent, ErrorSource } from "../../shared/dto";

// A de-duplicated, persisted record of process error output — modelled on
// Connections' "runnyknows" recorder: dedupe by a normalized fingerprint, keep an
// occurrence count + first/last seen, ignore known dev/HMR noise, persist as
// NDJSON so the record survives restarts ("in case things break and you need to fix
// them"). Source here is process stderr / crashes / error-looking stdout.

// The persisted error log lives in the shared data dir (DEVWEBUI_HOME-overridable so tests
// don't pollute the real ~/.devwebui/errors.ndjson — which is what put a phantom "N errors"
// count in the live GUI on boot). Resolved lazily — per save/load.
function errorsFile(): string {
  return path.join(dataDir(), "errors.ndjson");
}
const MAX_ERRORS = 500;
const SAVE_DEBOUNCE_MS = 1000;

// CSI escape sequences (incl. SGR color). Built via char code (27 = ESC) to keep
// the source free of literal control characters.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/**
 * Is this a *current* error — one worth surfacing in the GUI right now — as
 * opposed to a stale record that only lives on for post-mortem diagnosis?
 *
 * The persisted log (below) deliberately survives daemon restarts, but a record
 * from a PREVIOUS session (or from a process's PREVIOUS run) is not a live problem
 * and must never greet the user on launch — that phantom "1 error" on boot is
 * exactly the bug this predicate exists to kill. An error is current when:
 *   1. it was last seen during THIS daemon session (`lastSeen >= bootedAt`), AND
 *   2. it isn't stranded before the process's current run — if the process is
 *      running now (`runStartedAt` set) the error must be from that run.
 * A crashed/stopped process has `runStartedAt == null`, so a crash it just logged
 * still counts (there's no live run to post-date it) — as it should.
 */
export function isErrorActive(
  e: ErrorEvent,
  bootedAt: number,
  runStartedAt: number | null,
): boolean {
  if (e.lastSeen < bootedAt) return false; // recorded in a previous daemon session
  if (runStartedAt != null && e.lastSeen < runStartedAt) return false; // before the current run
  return true;
}

export interface ErrorInfo {
  processId: string;
  localId: string;
  processName: string;
  projectId: string;
  projectName: string;
}

// stdout lines only count as errors when they look like one.
const ERROR_PATTERN =
  /\b(error|exception|unhandled|fatal|ERR_[A-Z]+|E[A-Z]{3,}|failed|cannot find|is not defined|traceback|panic)\b/i;

// Dev-only / HMR noise that isn't a real bug (same class runnyknows ignores).
const IGNORE = [
  /\[vite\] (?:failed to connect to websocket|connecting\.\.\.|connected\.)/i,
  /does not provide an export named/i,
  /\bExperimentalWarning\b/i,
];

function normalize(text: string): string {
  return stripAnsi(text)
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z?/g, "<ts>") // ISO timestamps
    .replace(/\b\d{1,2}:\d\d:\d\d(?:\s?[AP]M)?\b/gi, "<time>") // clock times
    .replace(/\?t=\d+/g, "?t=<ts>") // HMR cache-bust
    .replace(/:\d+:\d+/g, ":<pos>") // line:col
    .replace(/0x[0-9a-f]+/gi, "<hex>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b\d{3,}\b/g, "<n>") // ports / pids / long numbers
    .trim()
    .slice(0, 400);
}

export class ErrorRecorder {
  private map = new Map<string, ErrorEvent>();
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onChange: () => void;

  constructor(onChange: () => void = () => {}) {
    this.onChange = onChange;
    this.load();
  }

  private isError(source: ErrorSource, text: string): boolean {
    if (IGNORE.some((re) => re.test(text))) return false;
    if (source === "crash" || source === "stderr") return true;
    return ERROR_PATTERN.test(text);
  }

  /** Record (or bump) an error; returns its fingerprint, or null when it was filtered out. */
  record(info: ErrorInfo, source: ErrorSource, rawText: string): string | null {
    const text = stripAnsi(rawText).trim();
    if (!text || !this.isError(source, text)) return null;
    const normalized = normalize(text);
    if (!normalized) return null;

    const fingerprint = `${info.processId}|${source}|${normalized}`;
    const now = Date.now();
    const existing = this.map.get(fingerprint);
    if (existing) {
      existing.count += 1;
      existing.lastSeen = now;
      existing.sample = text.slice(0, 400);
    } else {
      this.map.set(fingerprint, {
        fingerprint,
        processId: info.processId,
        localId: info.localId,
        processName: info.processName,
        projectId: info.projectId,
        projectName: info.projectName,
        source,
        sample: text.slice(0, 400),
        count: 1,
        firstSeen: now,
        lastSeen: now,
      });
      if (this.map.size > MAX_ERRORS) {
        const oldest = [...this.map.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
        if (oldest) this.map.delete(oldest.fingerprint);
      }
    }
    this.scheduleSave();
    this.onChange();
    return fingerprint;
  }

  list(): ErrorEvent[] {
    return [...this.map.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  clear(processId?: string): void {
    if (processId) {
      for (const [k, v] of this.map) if (v.processId === processId) this.map.delete(k);
    } else {
      this.map.clear();
    }
    this.scheduleSave();
    this.onChange();
  }

  /** Drop a single error record by fingerprint (per-item dismiss). Returns whether it existed. */
  dismiss(fingerprint: string): boolean {
    const had = this.map.delete(fingerprint);
    if (had) {
      this.scheduleSave();
      this.onChange();
    }
    return had;
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.dirty) this.save();
    }, SAVE_DEBOUNCE_MS);
  }

  private save(): void {
    this.dirty = false;
    try {
      mkdirSync(dataDir(), { recursive: true });
      writeFileAtomic(
        errorsFile(),
        `${this.list()
          .map((e) => JSON.stringify(e))
          .join("\n")}\n`,
      );
    } catch {
      /* best-effort */
    }
  }

  private load(): void {
    try {
      for (const line of readFileSync(errorsFile(), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as ErrorEvent;
          if (e.fingerprint) this.map.set(e.fingerprint, e);
        } catch {
          /* skip bad line */
        }
      }
    } catch {
      /* no log yet */
    }
  }
}

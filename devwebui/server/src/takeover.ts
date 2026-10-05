// ---------------------------------------------------------------------------
// External auto-start "take over" — some repos launch their dev server from
// OUTSIDE DevWebUI: VS Code's tasks.json (`runOptions.runOn: "folderOpen"`) or
// the "Vite" VS Code extension (`vite.autoStart: true`). When that happens the
// external launcher and DevWebUI both try to bind the same port, and DevWebUI's
// process loses the race and "crashes" on startup. This module detects those
// triggers and — on request — retires them (backing the file up first) so
// DevWebUI is the single source of truth for starting the dev server.
//
// Edits are deliberately SURGICAL string replacements, not a parse+reserialize,
// so comments, key order, and formatting in the user's .vscode files survive:
//   tasks.json    "runOn": "folderOpen"   -> "runOn": "default"  (manual-run only)
//   settings.json "vite.autoStart": true  -> "vite.autoStart": false
// ---------------------------------------------------------------------------
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import type { AutostartTrigger, TakeOverResult } from "../../shared/dto";

export type { AutostartKind, AutostartTrigger, TakeOverResult } from "../../shared/dto";

const BACKUP_SUFFIX = ".devwebui-bak";

// VS Code's .vscode/*.json are JSONC (// + /* */ comments, trailing commas). Parse
// with microsoft's jsonc-parser (the de-facto standard scanner, the same VS Code
// itself uses) rather than a hand-rolled comment/trailing-comma stripper. Tolerant:
// malformed input yields null, treated as "no triggers".
function readJsonc<T>(file: string): T | null {
  try {
    const parsed = parseJsonc(readFileSync(file, "utf8"));
    return (parsed ?? null) as T | null;
  } catch {
    return null; // unreadable — treated as "no triggers"
  }
}

type VsCodeTask = {
  label?: string;
  command?: string;
  args?: unknown[];
  runOptions?: { runOn?: string };
};

/** tasks.json triggers: any task with `runOptions.runOn === "folderOpen"`. */
function detectVsCodeTaskTriggers(tasksFile: string): AutostartTrigger[] {
  if (!existsSync(tasksFile)) return [];
  const j = readJsonc<{ tasks?: VsCodeTask[] }>(tasksFile);
  const out: AutostartTrigger[] = [];
  for (const t of j?.tasks ?? []) {
    if (!t || typeof t !== "object" || t.runOptions?.runOn !== "folderOpen") continue;
    const cmd = [t.command, ...(Array.isArray(t.args) ? t.args.map(String) : [])]
      .filter(Boolean)
      .join(" ")
      .trim();
    out.push({
      kind: "vscode-task",
      file: tasksFile,
      label: t.label ? `VS Code task “${t.label}”` : "VS Code task",
      detail: cmd ? `runs \`${cmd}\` when the folder opens` : "runs when the folder opens",
    });
  }
  return out;
}

/** settings.json trigger: the "Vite" extension's `vite.autoStart` flag. */
function detectViteExtensionTrigger(settingsFile: string): AutostartTrigger[] {
  if (!existsSync(settingsFile)) return [];
  const j = readJsonc<Record<string, unknown>>(settingsFile);
  if (j?.["vite.autoStart"] !== true) return [];
  const cmd = typeof j["vite.devCommand"] === "string" ? (j["vite.devCommand"] as string) : "";
  return [
    {
      kind: "vite-extension",
      file: settingsFile,
      label: "“Vite” VS Code extension",
      detail: cmd
        ? `auto-starts \`${cmd}\` when the folder opens`
        : "auto-starts the dev server when the folder opens",
    },
  ];
}

/** Inspect a folder's .vscode config for dev servers that start outside DevWebUI. */
export function detectAutostartTriggers(dir: string): AutostartTrigger[] {
  return [
    ...detectVsCodeTaskTriggers(path.join(dir, ".vscode", "tasks.json")),
    ...detectViteExtensionTrigger(path.join(dir, ".vscode", "settings.json")),
  ];
}

/** Back a file up exactly once (preserve the pristine original across re-runs). */
function backupOnce(file: string): string | null {
  const bak = file + BACKUP_SUFFIX;
  try {
    if (!existsSync(bak)) copyFileSync(file, bak);
    return bak;
  } catch {
    return null;
  }
}

/** What retiring one file's triggers produced — merged by the caller into its three lists. */
interface RetireOutcome {
  disabled: AutostartTrigger[];
  backups: string[];
  skipped: { file: string; reason: string }[];
}

/** Retire every trigger that lives in ONE file: rewrite it (backing it up first) so it no
 *  longer auto-starts. A file that can't be read, needs no change, or won't write lands in
 *  `skipped` with the reason rather than throwing. */
function retireTriggersInFile(file: string, ts: AutostartTrigger[]): RetireOutcome {
  const out: RetireOutcome = { disabled: [], backups: [], skipped: [] };

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    out.skipped.push({ file, reason: (e as Error).message });
    return out;
  }

  let next = text;
  if (ts.some((t) => t.kind === "vscode-task"))
    next = next.replace(/("runOn"\s*:\s*")folderOpen(")/g, "$1default$2");
  if (ts.some((t) => t.kind === "vite-extension"))
    next = next.replace(/("vite\.autoStart"\s*:\s*)true\b/g, "$1false");

  if (next === text) {
    out.skipped.push({ file, reason: "nothing to change (already retired?)" });
    return out;
  }

  const bak = backupOnce(file);
  if (bak) out.backups.push(bak);
  try {
    writeFileSync(file, next);
    out.disabled.push(...ts);
  } catch (e) {
    out.skipped.push({ file, reason: (e as Error).message });
  }
  return out;
}

/** Retire every detected external auto-start trigger under `dir`. Backs up first. */
export function takeOverAutostart(dir: string): TakeOverResult {
  const disabled: AutostartTrigger[] = [];
  const backups: string[] = [];
  const skipped: { file: string; reason: string }[] = [];

  // Group triggers by file so each file is backed up + rewritten once.
  const byFile = new Map<string, AutostartTrigger[]>();
  for (const t of detectAutostartTriggers(dir)) {
    const arr = byFile.get(t.file);
    if (arr) arr.push(t);
    else byFile.set(t.file, [t]);
  }

  for (const [file, ts] of byFile) {
    const outcome = retireTriggersInFile(file, ts);
    disabled.push(...outcome.disabled);
    backups.push(...outcome.backups);
    skipped.push(...outcome.skipped);
  }

  return { disabled, backups, skipped };
}

export interface RestoreResult {
  restored: string[];
  skipped: { file: string; reason: string }[];
}

/**
 * Undo a take-over: copy each `<file>${BACKUP_SUFFIX}` back over its original and remove the
 * backup, so a later take-over can capture a fresh pristine copy.
 *
 * takeOverAutostart has always backed the originals up, but nothing could ever put them back —
 * a user who took over by mistake, or who wants VS Code's folderOpen launch again, had to find
 * the .bak files and rename them by hand. The backups were only half a feature without this.
 */
/** The VS Code files take-over may have rewritten, and so may need to restore. */
const restorableFiles = (dir: string): string[] => [
  path.join(dir, ".vscode", "tasks.json"),
  path.join(dir, ".vscode", "settings.json"),
];

export function restoreAutostart(dir: string): RestoreResult {
  const restored: string[] = [];
  const skipped: { file: string; reason: string }[] = [];
  for (const file of restorableFiles(dir)) {
    const bak = file + BACKUP_SUFFIX;
    if (!existsSync(bak)) continue;
    try {
      copyFileSync(bak, file);
      rmSync(bak, { force: true });
      restored.push(file);
    } catch (e) {
      skipped.push({ file, reason: (e as Error).message });
    }
  }
  return { restored, skipped };
}

/** Whether a take-over of `dir` can be undone (a backup is still on disk). */
export function canRestoreAutostart(dir: string): boolean {
  return restorableFiles(dir).some((f) => existsSync(f + BACKUP_SUFFIX));
}

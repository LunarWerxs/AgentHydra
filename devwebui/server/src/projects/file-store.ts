import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic, writeJsonAtomic } from "../atomic-write";
import { dataDir } from "../data-dir";
import { detectProjectRuntime } from "../runtime";
import type { LoadedProject, ProcessDef } from "../types";
import { DevWebUIFileSchema, ProcessSchema, type DevWebUIProcess } from "../schema";

/**
 * Canonicalize a path for hashing/comparison: absolute, forward slashes (so an
 * identical path never hashes differently depending on which separator style it
 * was typed with), and lowercased ONLY on case-insensitive filesystems (Windows,
 * default macOS) — never on Linux, where `Foo` and `foo` are genuinely different
 * files. The single normalizer both projectIdFromPath and samePath below build on.
 */
function normalizePath(filePath: string): string {
  const abs = path.resolve(filePath).replace(/\\/g, "/");
  return process.platform === "linux" ? abs : abs.toLowerCase();
}

/** Stable id for a project, derived from its absolute path (survives restarts). */
export function projectIdFromPath(filePath: string): string {
  return `p${createHash("sha1").update(normalizePath(filePath)).digest("hex").slice(0, 8)}`;
}

/** Read + validate a .devwebui file into a registerable project. Throws on bad input. */
export function readDevWebUIFile(filePath: string): LoadedProject {
  const abs = path.resolve(filePath);
  let raw: unknown;
  try {
    raw = readJsonFile(abs);
  } catch (e) {
    throw new Error(`Could not read ${abs}: ${(e as Error).message}`);
  }
  const parsed = DevWebUIFileSchema.parse(raw);
  const id = projectIdFromPath(abs);
  const dir = path.dirname(abs);
  // Detect the project's runtime once from its lockfile — feeds the `auto` runtime setting so a
  // Bun project's `node …` command runs under Bun (and vice-versa) without any per-process pin.
  const detectedRuntime = detectProjectRuntime(dir);

  const seen = new Set<string>();
  const processes: ProcessDef[] = parsed.processes.map((p) => {
    if (seen.has(p.id)) throw new Error(`Duplicate process id "${p.id}" in ${abs}`);
    seen.add(p.id);
    return {
      id: `${id}.${p.id}`,
      localId: p.id,
      name: p.name,
      command: p.command,
      cwd: path.resolve(dir, p.cwd ?? "."),
      cwdRaw: p.cwd,
      color: p.color,
      env: p.env,
      autostart: p.autostart,
      starred: p.starred,
      port: p.port,
      url: p.url,
      runtime: p.runtime,
      detectedRuntime,
      waitForPort: p.waitForPort,
      links: p.links,
      companion: p.companion,
      // `file` resolves against the .devwebui folder, the same rule `cwd` follows.
      compose: p.compose?.file
        ? { ...p.compose, file: path.resolve(dir, p.compose.file) }
        : p.compose,
      answers: p.answers,
      projectId: id,
      projectName: parsed.name,
    };
  });

  return { id, name: parsed.name, color: parsed.color, path: abs, dir, processes };
}

// ---------------------------------------------------------------------------
// Edit the .devwebui file on disk (the source of truth) for GUI-driven changes.
// Every write is validated against the schema first, so the file is never left
// invalid. `localId` is the process `id` as written in the file.
// ---------------------------------------------------------------------------
/**
 * Keys the schema knows about. Anything else a user hand-added to their own
 * `.devwebui` is UNKNOWN to us — and must survive our rewrites (see `Extras`).
 */
const KNOWN_PROCESS_KEYS = new Set<string>([
  "id",
  "name",
  "command",
  "cwd",
  "color",
  "env",
  "autostart",
  "starred",
  "port",
  "url",
  "runtime",
  "waitForPort",
  "links",
  "companion",
  "compose",
  "answers",
]);
const KNOWN_FILE_KEYS = new Set<string>(["name", "color", "processes"]);

/**
 * The unrecognized keys a `.devwebui` carried when we read it. Zod strips unknown keys
 * at parse time and `clean()` rebuilds each process from a fixed allowlist, so without
 * capturing them here a single GUI action (starring a process, a rename) would silently
 * delete anything the user hand-added to their own version-controlled file. We validate
 * strictly and preserve verbatim: unknown keys ride along untouched, they just never
 * influence behavior.
 */
interface Extras {
  file: Record<string, unknown>;
  /** Per-process extras, keyed by the process's in-file `id`. */
  byProcessId: Map<string, Record<string, unknown>>;
}

const unknownKeysOf = (value: unknown, known: Set<string>): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>))
    if (!known.has(k)) out[k] = v;
  return out;
};

/** Parse JSON from disk, tolerating a UTF-8 BOM (what Notepad and some editors write). */
function readJsonFile(abs: string): unknown {
  return JSON.parse(readFileSync(abs, "utf8").replace(/^﻿/, ""));
}

interface RawFile {
  name: string;
  color?: string;
  processes: DevWebUIProcess[];
  extras: Extras;
  /** The file's existing line-ending style, so a rewrite doesn't reformat every line. */
  eol: "\n" | "\r\n";
}

/**
 * The file's dominant line ending. A `.devwebui` is usually committed, so emitting LF over a
 * CRLF file turns a one-key edit (starring a process) into a whole-file diff in the user's repo.
 */
function detectEol(text: string): "\n" | "\r\n" {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

function readRaw(filePath: string): RawFile {
  const abs = path.resolve(filePath);
  const text = readFileSync(abs, "utf8").replace(/^﻿/, "");
  const raw = JSON.parse(text);
  const parsed = DevWebUIFileSchema.parse(raw);
  const source = (raw ?? {}) as { processes?: unknown };
  const byProcessId = new Map<string, Record<string, unknown>>();
  if (Array.isArray(source.processes)) {
    for (const p of source.processes) {
      const id = (p as { id?: unknown })?.id;
      if (typeof id !== "string") continue;
      const extra = unknownKeysOf(p, KNOWN_PROCESS_KEYS);
      if (Object.keys(extra).length) byProcessId.set(id, extra);
    }
  }
  return {
    ...parsed,
    extras: { file: unknownKeysOf(raw, KNOWN_FILE_KEYS), byProcessId },
    eol: detectEol(text),
  };
}

function writeRaw(filePath: string, data: RawFile): void {
  const { extras, eol, ...rest } = data;
  const valid = DevWebUIFileSchema.parse(rest);
  // Re-attach unknown keys AFTER validation: the schema decides what is legal, the
  // extras only decide what is preserved. Known keys always win over a stale extra.
  const out = {
    ...extras.file,
    ...valid,
    processes: valid.processes.map((p) => {
      const extra = extras.byProcessId.get(p.id);
      return extra ? { ...extra, ...p } : p;
    }),
  };
  // Atomic (temp + rename): this is the USER's file, usually in their git repo — a
  // truncate-in-place write that dies mid-flight would destroy it. See atomic-write.ts.
  const body = `${JSON.stringify(out, null, 2)}\n`;
  writeFileAtomic(path.resolve(filePath), eol === "\r\n" ? body.replace(/\n/g, "\r\n") : body);
}

function clean(proc: DevWebUIProcess): DevWebUIProcess {
  // Drop empty optional fields so the file stays tidy.
  const out: DevWebUIProcess = { id: proc.id, name: proc.name, command: proc.command };
  if (proc.cwd) out.cwd = proc.cwd;
  if (proc.color) out.color = proc.color;
  if (proc.env && Object.keys(proc.env).length) out.env = proc.env;
  if (proc.autostart) out.autostart = true;
  if (proc.starred) out.starred = true;
  if (proc.port) out.port = proc.port;
  if (proc.url) out.url = proc.url;
  if (proc.runtime) out.runtime = proc.runtime;
  if (proc.waitForPort !== undefined) out.waitForPort = proc.waitForPort;
  // De-dupe and drop self-references so a linked group never lists itself.
  const links = [...new Set(proc.links ?? [])].filter((l) => l !== proc.id);
  if (links.length) out.links = links;
  if (proc.companion) out.companion = true;
  if (proc.compose) out.compose = proc.compose;
  if (proc.answers?.length) out.answers = proc.answers;
  return out;
}

/**
 * Every optional field a caller may omit. `updateProcessInFile` merges each one the way
 * `env` always did: a key the caller DIDN'T send keeps its stored value, while a key sent
 * as `undefined` clears it. Without this, an MCP `update_process` carrying only
 * `{id,name,command}` silently wiped the process's port, links, companion and star.
 */
const MERGEABLE_KEYS = [
  "cwd",
  "color",
  "env",
  "autostart",
  "starred",
  "port",
  "url",
  "runtime",
  "waitForPort",
  "links",
  "companion",
  "compose",
  "answers",
] as const satisfies readonly (keyof DevWebUIProcess)[];

/** Fill in every optional field the caller omitted from the stored record. */
function mergeOmitted(sent: DevWebUIProcess, parsed: DevWebUIProcess, stored: DevWebUIProcess) {
  const merged: DevWebUIProcess = { ...parsed };
  for (const key of MERGEABLE_KEYS) {
    if (Object.hasOwn(sent, key)) continue;
    // biome-ignore lint/suspicious/noExplicitAny: index-assigning a union of optional keys
    (merged as any)[key] = stored[key];
  }
  return merged;
}

export function addProcessToFile(filePath: string, proc: DevWebUIProcess): void {
  const raw = readRaw(filePath);
  if (raw.processes.some((p) => p.id === proc.id))
    throw new Error(`A process with id "${proc.id}" already exists in this project.`);
  raw.processes.push(clean(ProcessSchema.parse(proc)));
  writeRaw(filePath, raw);
}

export function updateProcessInFile(
  filePath: string,
  localId: string,
  proc: DevWebUIProcess,
): void {
  const raw = readRaw(filePath);
  const i = raw.processes.findIndex((p) => p.id === localId);
  if (i < 0) throw new Error(`Process "${localId}" not found.`);
  if (proc.id !== localId && raw.processes.some((p) => p.id === proc.id))
    throw new Error(`A process with id "${proc.id}" already exists in this project.`);
  const parsed = ProcessSchema.parse(proc);
  raw.processes[i] = clean(mergeOmitted(proc, parsed, raw.processes[i]));
  // An id rename would dangle every sibling's link to the old id — follow the rename.
  if (proc.id !== localId) {
    raw.processes = raw.processes.map((p) =>
      p.links?.includes(localId)
        ? clean({ ...p, links: p.links.map((l) => (l === localId ? proc.id : l)) })
        : p,
    );
    // Extras are keyed by in-file id, so a rename has to carry them across or the
    // user's hand-added keys would be dropped by the very next write.
    const carried = raw.extras.byProcessId.get(localId);
    if (carried) {
      raw.extras.byProcessId.delete(localId);
      raw.extras.byProcessId.set(proc.id, carried);
    }
  }
  writeRaw(filePath, raw);
}

export function removeProcessFromFile(filePath: string, localId: string): void {
  const raw = readRaw(filePath);
  if (raw.processes.length <= 1)
    throw new Error("A project needs at least one process — remove the whole project instead.");
  raw.processes = raw.processes
    .filter((p) => p.id !== localId)
    // Prune links that pointed at the removed process (clean() drops emptied arrays).
    .map((p) =>
      p.links?.includes(localId) ? clean({ ...p, links: p.links.filter((l) => l !== localId) }) : p,
    );
  writeRaw(filePath, raw);
}

/** Set (or clear) one process's starred flag — starred processes float to the top. */
export function setProcessStarred(filePath: string, localId: string, starred: boolean): void {
  const raw = readRaw(filePath);
  const i = raw.processes.findIndex((p) => p.id === localId);
  if (i < 0) throw new Error(`Process "${localId}" not found.`);
  raw.processes[i] = clean({ ...raw.processes[i], starred });
  writeRaw(filePath, raw);
}

/**
 * Update a project's top-level metadata (rename + recolor) in place, leaving its
 * processes untouched. A provided-but-empty `name` is rejected (the schema needs a
 * non-empty name); an empty/omitted `color` clears the key so the file stays tidy
 * and the GUI falls back to the theme accent.
 */
export function updateProjectMeta(filePath: string, meta: { name?: string; color?: string }): void {
  const raw = readRaw(filePath);
  if (meta.name !== undefined) {
    const name = meta.name.trim();
    if (!name) throw new Error("A project name can't be empty.");
    raw.name = name;
  }
  if (meta.color !== undefined) {
    const color = meta.color.trim();
    if (color) raw.color = color;
    else delete raw.color;
  }
  writeRaw(filePath, raw);
}

// ---------------------------------------------------------------------------
// Registry — the list of loaded .devwebui files, persisted across restarts so
// DevWebUI auto-loads your codebases on launch.
// ---------------------------------------------------------------------------
const registryFile = (): string => path.join(dataDir(), "registry.json");

export function readRegistry(): string[] {
  try {
    const r = JSON.parse(readFileSync(registryFile(), "utf8"));
    return Array.isArray(r.projects) ? r.projects.map(String) : [];
  } catch {
    return [];
  }
}

function writeRegistry(paths: string[]): void {
  mkdirSync(dataDir(), { recursive: true });
  writeJsonAtomic(registryFile(), { projects: paths }, { trailingNewline: false });
}

const samePath = (a: string, b: string) => normalizePath(a) === normalizePath(b);

export function registryAdd(filePath: string): void {
  const abs = path.resolve(filePath);
  const list = readRegistry();
  if (!list.some((x) => samePath(x, abs))) {
    list.push(abs);
    writeRegistry(list);
  }
}

export function registryRemove(filePath: string): void {
  writeRegistry(readRegistry().filter((x) => !samePath(x, filePath)));
}

// ---------------------------------------------------------------------------
// Ignore list — detected (not-yet-added) project folders the user dismissed, so
// the background scan stops surfacing them. Keyed by absolute directory path,
// the same space as the registry. Deliberately its OWN file, NOT `scanExclude`:
// the scan still walks into these folders, so the "show ignored" toggle can
// reveal them and un-ignoring is instant.
// ---------------------------------------------------------------------------
const ignoredFile = (): string => path.join(dataDir(), "ignored.json");

export function readIgnoredProjects(): string[] {
  try {
    const r = JSON.parse(readFileSync(ignoredFile(), "utf8"));
    return Array.isArray(r.ignored) ? r.ignored.map(String) : [];
  } catch {
    return [];
  }
}

function writeIgnoredProjects(dirs: string[]): void {
  mkdirSync(dataDir(), { recursive: true });
  writeJsonAtomic(ignoredFile(), { ignored: dirs }, { trailingNewline: false });
}

export function ignoreProject(dir: string): void {
  const abs = path.resolve(dir);
  const list = readIgnoredProjects();
  if (!list.some((x) => samePath(x, abs))) {
    list.push(abs);
    writeIgnoredProjects(list);
  }
}

export function unignoreProject(dir: string): void {
  writeIgnoredProjects(readIgnoredProjects().filter((x) => !samePath(x, dir)));
}

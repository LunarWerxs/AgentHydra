// Server-internal types live here; the cross-boundary DTOs are re-exported from
// the shared module so a module nested under src/<dir>/ reaches them as
// `../types` rather than climbing to the repo root.
export type {
  FreePortResult,
  LogLine,
  PortOwner,
  ProcessView,
  ProjectView,
  Status,
} from "../../shared/dto";
import type { AnswerRule } from "./prompt-answers";

export interface ProcessDef {
  id: string; // global, unique: `${projectId}.${localId}`
  localId: string; // as written in the .devwebui file
  name: string;
  command: string;
  cwd: string; // resolved absolute path used to spawn
  cwdRaw?: string; // as written in the .devwebui file (for round-trip editing)
  color?: string;
  env?: Record<string, string>;
  autostart?: boolean;
  starred?: boolean;
  port?: number;
  url?: string; // where the title links to: absolute URL, or a path appended to http://<host>:<port> (host = Settings.linkHost, else the GUI's own hostname)
  runtime?: "node" | "bun"; // launch this command under Node or Bun (rewrites the leading runtime)
  /** Runtime the project's package manager implies (from its lockfile). Used only when `runtime`
   *  is unset and the global setting is `auto`, to make `auto` per-project. Computed at load from
   *  the project dir, never read from or written to the .devwebui file. */
  detectedRuntime?: "node" | "bun";
  /** Dependency-ordered startup: a literal port, or a sibling process's `localId`, to wait on before spawning. */
  waitForPort?: number | string;
  /** Linked servers (sibling `localId`s): starting any member of a linked group starts the whole group. */
  links?: string[];
  /** Companion: starts whenever any other process in this project is started individually. */
  companion?: boolean;
  /** Compose-managed dependencies brought up (and waited on) before this process spawns. */
  compose?: ProcessCompose;
  /** Expect/send rules answering the process's interactive prompts (see prompt-answers.ts). */
  answers?: AnswerRule[];
  projectId: string;
  projectName: string;
}

/** A process's `compose` block, with `file` already resolved to an absolute path. See manager/compose.ts. */
export interface ProcessCompose {
  file?: string;
  mode?: "none" | "start-only" | "start-and-stop";
  skipIfRunning?: boolean;
  readinessTimeoutMs?: number;
  services?: string[];
  injectEnv?: boolean;
}

/** A project ready to register in the Manager (resolved from a .devwebui file). */
export interface LoadedProject {
  id: string;
  name: string;
  /** Optional accent color (CSS color string) from the file's top-level `color`. */
  color?: string;
  path: string;
  dir: string;
  processes: ProcessDef[];
}

// ---------------------------------------------------------------------------
// Incident Autopilot — correlates the signals DevWebUI ALREADY collects (the
// deduped error log, the last exit code, live port ownership, the project's
// own script/command definition) into a structured root-cause GUESS plus an
// executable remediation SUGGESTION. Never auto-executes anything — the
// caller (GUI/CLI/agent) decides whether to run `suggestedTool`.
//
// Deliberately EXACTLY 3 hardcoded heuristics, checked in order (no rules
// engine, no scoring, no ML): (1) port-in-use, (2) known exit-code/error
// pattern, (3) missing/invalid script. First one that matches wins; if none
// match we fall back honestly to `rootCause: "unknown"` with whatever
// evidence we gathered, rather than guessing.
// ---------------------------------------------------------------------------
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { portOwners } from "./ports";
import type { ErrorEvent } from "./errors";
import type { ProcessDef } from "./types";

export type Confidence = "high" | "medium" | "low";

export interface Remediation {
  description: string;
  /** Name of an existing MCP tool the caller can invoke to act on this (never auto-run). */
  suggestedTool: string;
  params: Record<string, unknown>;
}

export interface Diagnosis {
  rootCause: string;
  confidence: Confidence;
  evidence: string[];
  remediation: Remediation | null;
}

/** Inputs the diagnose engine needs — kept narrow so it's trivial to fabricate in tests. */
export interface DiagnoseInput {
  def: ProcessDef;
  status: string;
  exitCode: number | null;
  errors: ErrorEvent[]; // this process's error records (already filtered by caller), most recent first
  /**
   * Optional: a tail of the process's Time-Travel Log Vault file (most recent lines
   * last). Falls back into heuristic 2's search text when the de-duped error log is
   * empty — e.g. a crash whose stderr never tripped ErrorRecorder's own filters. Purely
   * additive: omitting it (as every pre-existing caller/test does) changes nothing.
   */
  logTail?: string[];
}

// ---- heuristic 2: a small, known table of exit/error signatures -----------
// Deliberately SMALL (owner directive: no rules engine) — just the handful of
// failures that are both common and unambiguous enough to name with confidence.
interface KnownError {
  test: (text: string) => boolean;
  rootCause: (m: RegExpMatchArray | null, text: string) => string;
  hint: (m: RegExpMatchArray | null) => string;
}

const PORT_IN_USE_RE = /\bEADDRINUSE\b/;
const CONN_REFUSED_RE = /\bECONNREFUSED\b.*?:(\d{2,5})\b|\bECONNREFUSED\b/;
const MODULE_NOT_FOUND_RE = /\bMODULE_NOT_FOUND\b|Cannot find module ['"]?([^\s'"]+)['"]?/;
const MISSING_ENV_RE =
  /\b([A-Z][A-Z0-9_]{2,})\s+is not (?:defined|set)\b|\bmissing (?:required )?env(?:ironment)? var(?:iable)?s?\b[:\s]*([A-Z][A-Z0-9_]{2,})?/i;
const COMMAND_NOT_FOUND_RE =
  /(?:'([^']+)' is not recognized as an internal or external command|command not found:?\s*(\S+)|\/bin\/sh:.*?:\s*(\S+):\s*(?:not found|No such file or directory))/i;

const KNOWN_ERRORS: KnownError[] = [
  {
    test: (t) => PORT_IN_USE_RE.test(t),
    rootCause: () => "the process's own listener hit EADDRINUSE (its port is already taken)",
    hint: () => "free the port and restart",
  },
  {
    test: (t) => CONN_REFUSED_RE.test(t),
    rootCause: (m) =>
      m?.[1]
        ? `a dependency on port ${m[1]} refused the connection — is it running?`
        : "a dependency refused the connection (ECONNREFUSED) — is it running?",
    hint: () => "start the dependency, then restart this process",
  },
  {
    test: (t) => MODULE_NOT_FOUND_RE.test(t),
    rootCause: (m) =>
      m?.[1]
        ? `missing module \`${m[1]}\` (MODULE_NOT_FOUND) — dependencies likely need installing`
        : "a required module is missing (MODULE_NOT_FOUND) — dependencies likely need installing",
    hint: () => "install dependencies, then restart",
  },
  {
    test: (t) => COMMAND_NOT_FOUND_RE.test(t),
    rootCause: (m) => {
      const cmd = m?.[1] || m?.[2] || m?.[3];
      return cmd
        ? `command \`${cmd}\` was not found on PATH`
        : "the configured command was not found on PATH";
    },
    hint: () => "install the missing CLI, or fix the command",
  },
  {
    test: (t) => MISSING_ENV_RE.test(t),
    rootCause: (m) => {
      const name = m?.[1] || m?.[2];
      return name ? `required env var \`${name}\` looks unset` : "a required env var looks unset";
    },
    hint: () => "set the missing env var, then restart",
  },
];

function matchKnownError(text: string): { rootCause: string; hint: string } | null {
  for (const k of KNOWN_ERRORS) {
    if (!k.test(text)) continue;
    // Re-run whichever pattern matched to capture groups for the message.
    const m =
      text.match(PORT_IN_USE_RE) ??
      text.match(CONN_REFUSED_RE) ??
      text.match(MODULE_NOT_FOUND_RE) ??
      text.match(COMMAND_NOT_FOUND_RE) ??
      text.match(MISSING_ENV_RE);
    return { rootCause: k.rootCause(m, text), hint: k.hint(m) };
  }
  return null;
}

// ---- heuristic 3: does the configured script/command actually exist? -----

/** Parse a package-manager run command into { runner, script } — e.g. "npm run dev" -> npm/dev. */
function parseRunScript(command: string): { manager: string; script: string } | null {
  const m = command.trim().match(/^(npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)(?:\s|$)/i);
  if (!m) return null;
  const [, manager, script] = m;
  // `npm run` / `pnpm run` / `yarn run` / `bun run` always mean "look up a script";
  // a bare `pnpm <script>` / `yarn <script>` / `bun <script>` also does for those three,
  // but a bare `npm <script>` is often a real npm subcommand (install, ci, …) — only
  // trust the bare form for the managers whose CLI treats it as a script alias.
  if (/^\s*npm\s+(?!run\b)/i.test(command) && !/^\s*npm\s+run\b/i.test(command)) return null;
  return { manager: manager.toLowerCase(), script };
}

/** First path segment of a shell command (naive but adequate for our own generated commands). */
function firstToken(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
}

interface ScriptCheck {
  ok: boolean;
  reason?: string;
}

/** Does `def.command` resolve to something that exists in the project? Best-effort, filesystem-only. */
function checkScriptExists(def: ProcessDef): ScriptCheck {
  const runScript = parseRunScript(def.command);
  if (runScript) {
    const pkgPath = path.join(def.cwd, "package.json");
    if (!existsSync(pkgPath)) return { ok: false, reason: `no package.json in ${def.cwd}` };
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        scripts?: Record<string, unknown>;
      };
      const scripts = pkg.scripts ?? {};
      if (!(runScript.script in scripts))
        return {
          ok: false,
          reason: `package.json has no "${runScript.script}" script (cwd: ${def.cwd})`,
        };
      return { ok: true };
    } catch {
      return { ok: false, reason: `package.json in ${def.cwd} is not valid JSON` };
    }
  }
  // Not a package-manager run — if it invokes a local file directly, check the file exists.
  const first = firstToken(def.command);
  if (/[\\/]/.test(first) || /\.(?:js|cjs|mjs|ts|cts|mts|sh|ps1|bat|cmd|exe)$/i.test(first)) {
    const resolved = path.isAbsolute(first) ? first : path.join(def.cwd, first);
    if (!existsSync(resolved)) return { ok: false, reason: `command file not found: ${resolved}` };
  }
  return { ok: true };
}

// ---- the composite diagnose() ---------------------------------------------

/**
 * Correlate raw signals into a root-cause guess. Checked in order (first
 * match wins): (1) port-in-use, (2) known exit/error signature, (3)
 * missing/invalid script. Falls back to `rootCause: "unknown"` honestly.
 */
/** Heuristic 1: something else is holding the port this process is configured to use. */
async function diagnosePortInUse(
  input: DiagnoseInput,
  evidence: string[],
): Promise<Diagnosis | null> {
  const { def, status } = input;
  if (!def.port) return null;
  const owners = await portOwners(def.port);
  const others = owners.filter((o) => o.pid !== null);
  if (others.length === 0 || (status !== "crashed" && status !== "stopped")) return null;

  const squatter = others[0];
  evidence.push(
    `port ${def.port} is currently held by ${squatter.name} (pid ${squatter.pid})${
      squatter.cmdline ? `: ${squatter.cmdline}` : ""
    }`,
  );
  return {
    rootCause: `port ${def.port} is already in use by ${squatter.name} (pid ${squatter.pid})`,
    confidence: "high",
    evidence,
    remediation: {
      description: `free port ${def.port}, then start ${def.name}`,
      suggestedTool: "start_process",
      params: { id: def.id, freePortFirst: true, port: def.port, blockingPid: squatter.pid },
    },
  };
}

/** The text heuristic 2 searches: this process's recent error samples, else the raw log tail.
 *  Pushes whichever it used onto `evidence`. */
function diagnosticSearchText(input: DiagnoseInput, evidence: string[]): string {
  const { errors, logTail } = input;
  const searchText = [errors[0]?.sample, ...errors.slice(0, 5).map((e) => e.sample)]
    .filter((v): v is string => !!v)
    .join("\n");
  if (searchText) {
    evidence.push(`recent error sample: ${searchText.slice(0, 300)}`);
    return searchText;
  }
  // No de-duped error record (e.g. its stderr never tripped ErrorRecorder's own
  // filters) — fall back to the raw log-vault tail, if the caller supplied one.
  if (!logTail?.length) return "";
  const tailText = logTail.slice(-20).join("\n");
  evidence.push(`recent log tail: ${tailText.slice(0, 300)}`);
  return tailText;
}

/** Heuristic 2: the error text matches a known exit-code / error-pattern signature. */
function diagnoseKnownError(
  input: DiagnoseInput,
  evidence: string[],
  searchText: string,
): Diagnosis | null {
  const { def, exitCode } = input;
  const known = searchText ? matchKnownError(searchText) : null;
  if (!known || exitCode === 0) return null;
  evidence.push(`matched known error signature`);
  return {
    rootCause: known.rootCause,
    confidence: "high",
    evidence,
    remediation: {
      description: `${known.hint} for ${def.name}`,
      suggestedTool: "restart_process",
      params: { id: def.id },
    },
  };
}

/** Heuristic 3: the configured command's script doesn't resolve on disk. */
function diagnoseMissingScript(input: DiagnoseInput, evidence: string[]): Diagnosis | null {
  const { def, status, exitCode } = input;
  if (status !== "crashed" && exitCode === null) return null;
  const scriptCheck = checkScriptExists(def);
  if (scriptCheck.ok) return null;
  evidence.push(`script check failed: ${scriptCheck.reason}`);
  return {
    rootCause: `the configured command for ${def.name} doesn't resolve: ${scriptCheck.reason}`,
    confidence: "medium",
    evidence,
    remediation: {
      description: `fix the command/script for ${def.name} in its .devwebui file, then restart`,
      suggestedTool: "restart_process",
      params: { id: def.id },
    },
  };
}

export async function diagnose(input: DiagnoseInput): Promise<Diagnosis> {
  const { status, exitCode } = input;
  const evidence: string[] = [];
  evidence.push(`status: ${status}`, `exit code: ${exitCode ?? "n/a"}`);

  // Checked in order (first match wins); falls through to `rootCause: "unknown"` honestly.
  const portInUse = await diagnosePortInUse(input, evidence);
  if (portInUse) return portInUse;

  const known = diagnoseKnownError(input, evidence, diagnosticSearchText(input, evidence));
  if (known) return known;

  const missingScript = diagnoseMissingScript(input, evidence);
  if (missingScript) return missingScript;

  return {
    rootCause: "unknown",
    confidence: "low",
    evidence,
    remediation: null,
  };
}

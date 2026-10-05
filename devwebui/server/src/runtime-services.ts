// Runtime services context block - one paste-ready summary of what is running
// and how to reach it, written from the AGENT'S point of view (this machine),
// not the browser's. Agents otherwise burn turns probing ports, guessing base
// URLs and hunting for which env var holds an API key.
//
// Idea from OpenHands (MIT) `buildRuntimeServicesInfo`, which renders a
// <RUNTIME_SERVICES> block into an agent's system message; written fresh here.
//
// SECRETS: only env var NAMES ever leave this module. A process's `.devwebui`
// env values are never read into the output, so the block is safe to paste
// into any agent context or log.
import type { ProcessView, Status } from "./types";

/** One reachable service as an agent on this machine sees it. */
export interface RuntimeService {
  /** Global process id (`<projectId>.<localId>`), or "devwebui" for the daemon itself. */
  id: string;
  name: string;
  projectName?: string;
  status: Status;
  pid?: number | null;
  /** Base URL reachable from this machine; absent when the process declares no port or URL. */
  url?: string;
  /** Full health-check URL, when the service has one DevWebUI knows about. */
  healthUrl?: string;
  /** NAMES (never values) of the process's `.devwebui` env vars that look like credentials. */
  authEnv: string[];
}

export interface RuntimeServicesInfo {
  services: RuntimeService[];
  /** The rendered <RUNTIME_SERVICES> block, ready to paste into an agent's context. */
  block: string;
}

// A process counts as "up" (worth listing by default) while it holds or is about to hold its port.
const LIVE: ReadonlySet<Status> = new Set<Status>(["running", "starting", "waiting"]);

// Env var names that conventionally hold a credential. Matching a name only ever surfaces the
// name, so a false positive costs one extra word in the block, never a leak.
const CREDENTIAL_NAME = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH/i;

/** Env var names that look like credentials, sorted for a stable block. */
export function credentialEnvNames(env: Record<string, string> | undefined): string[] {
  return Object.keys(env ?? {})
    .filter((k) => CREDENTIAL_NAME.test(k))
    .sort();
}

/**
 * The URL an agent on this machine should use for a process. An absolute http(s) `url` is used
 * verbatim; a `/path` url is appended to `http://localhost:<port>`; otherwise the bare port.
 * Deliberately ignores the GUI's `linkHost` setting, which is the BROWSER's view of the host.
 */
export function agentUrl(p: Pick<ProcessView, "port" | "url">): string | undefined {
  if (p.url && /^https?:\/\//i.test(p.url)) return p.url;
  if (!p.port) return undefined;
  const base = `http://localhost:${p.port}`;
  if (!p.url) return base;
  return `${base}${p.url.startsWith("/") ? "" : "/"}${p.url}`;
}

function serviceLine(s: RuntimeService): string {
  const where = s.url ?? "no declared port or URL";
  const label = s.projectName
    ? `${s.name} (${s.projectName}, id ${s.id})`
    : `${s.name} (id ${s.id})`;
  const state = s.pid ? `${s.status}, pid ${s.pid}` : s.status;
  const parts = [`- ${label}: ${where} [${state}]`];
  if (s.healthUrl) parts.push(`health: GET ${s.healthUrl}`);
  if (s.authEnv.length) parts.push(`auth env: ${s.authEnv.join(", ")}`);
  return parts.join("; ");
}

/** Render services as the <RUNTIME_SERVICES> block. */
export function renderRuntimeServicesBlock(services: RuntimeService[]): string {
  return [
    "<RUNTIME_SERVICES>",
    "URLs are as seen from this machine. Auth env lists env var NAMES only: " +
      "read the value from that variable, it is never shown here.",
    ...services.map(serviceLine),
    "</RUNTIME_SERVICES>",
  ].join("\n");
}

/**
 * Build the runtime services summary: the DevWebUI daemon itself first (at the origin the caller
 * reached it on), then every live process, or every process when `includeStopped` is set.
 * `envOf` returns a process's `.devwebui` env; only its credential-looking NAMES are kept.
 */
export function buildRuntimeServicesInfo(
  processes: ProcessView[],
  envOf: (id: string) => Record<string, string> | undefined,
  daemonOrigin: string,
  includeStopped = false,
): RuntimeServicesInfo {
  const daemon: RuntimeService = {
    id: "devwebui",
    name: "DevWebUI daemon",
    status: "running",
    pid: process.pid,
    url: daemonOrigin,
    healthUrl: `${daemonOrigin}/api/health`,
    authEnv: [],
  };
  const services = [
    daemon,
    ...processes
      .filter((p) => includeStopped || LIVE.has(p.status))
      .map(
        (p): RuntimeService => ({
          id: p.id,
          name: p.name,
          projectName: p.projectName,
          status: p.status,
          pid: p.pid,
          url: agentUrl(p),
          authEnv: credentialEnvNames(envOf(p.id)),
        }),
      ),
  ];
  return { services, block: renderRuntimeServicesBlock(services) };
}

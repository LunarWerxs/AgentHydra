import net from "node:net";
import { spawn } from "node:child_process";
import treeKill from "tree-kill";
import type { PortOwner } from "../../shared/dto";
import { collectStdout } from "./spawn-capture";

export type { PortOwner };

/** Spawn a command, capture stdout, resolve on close (bounded by a short timeout). Port-owner
 *  output (cmdlines) is small, so this caps well below collectStdout's 1 MiB default. */
const collect = (cmd: string, args: string[], timeoutMs?: number) =>
  collectStdout(cmd, args, { maxBytes: 1 << 16, ...(timeoutMs ? { timeoutMs } : {}) });

/**
 * How long the WINDOWS enrichment probe may take, overriding collectStdout's 5s default.
 *
 * That default is fine for the unix path (`lsof`, `ps` — tiny static binaries) but is not enough
 * for this one, which starts a whole PowerShell and makes it autoload NetTCPIP and CimCmdlets. On a
 * warm developer machine the round trip is ~1.5s; on a cold or loaded one it goes well past that,
 * and collectStdout RESOLVES WITH WHAT IT HAS on timeout rather than reporting one. So the probe
 * came back empty, portOwners returned [], and a port that was plainly occupied was reported as
 * having no owner — diagnose() then downgraded a port-in-use crash to "low confidence, cause
 * unknown". Red on main 2026-08-03..2026-08-06 at ~5010ms, then again on 2026-08-15 at ~20014ms.
 *
 * Raising this number was the first fix and it was the wrong shape: ANY timeout can be exceeded on
 * a loaded runner, and every time one is, the answer is silently wrong rather than late. So the
 * number is no longer load-bearing. `netstat -ano` — a native binary with no modules to autoload —
 * now answers "who holds this port" on its own, and PowerShell is demoted to enrichment (real
 * process name, command line, uptime). If it is slow we lose the trimmings, never the fact.
 *
 * 8s is therefore just "long enough to be worth waiting for on a warm machine", not a correctness
 * guarantee.
 */
const WIN_OWNER_PROBE_TIMEOUT_MS = 8_000;

/** netstat's table can be long on a busy machine, and OUR line may be anywhere in it, so this
 *  cannot use `collect`'s 64 KiB cap: a truncated table reads exactly like a free port. */
const NETSTAT_MAX_BYTES = 1 << 20;

// Field separator for the one-line-per-owner PowerShell/ps output below. "::" avoids both the
// PowerShell backtick-tab escape headaches in a JS template AND collisions with a Windows
// command line (which may contain plain colons, e.g. drive letters, but essentially never "::").
const FIELD_SEP = "::";

/** Who is listening on `port`? Returns each owning PID + name + best-effort cmdline/uptime. */
export async function portOwners(port: number): Promise<PortOwner[]> {
  if (process.platform === "win32") {
    // One CIM query gets CommandLine + CreationDate for every owning PID in a single round-trip
    // (rather than a Get-Process-per-PID follow-up). CommandLine/CreationDate can be null (e.g.
    // a protected/system process this user can't inspect) — "" downstream reads back as undefined.
    // Each command line's own newlines are collapsed so it can't smuggle in extra output lines.
    const ps =
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
      `Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { ` +
      `$procId = $_; $p = Get-Process -Id $procId -ErrorAction SilentlyContinue; if ($p) { ` +
      `$ci = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue; ` +
      `$cmd = if ($ci -and $ci.CommandLine) { ($ci.CommandLine -replace '[\\r\\n]+', ' ') } else { "" }; ` +
      `$created = if ($ci -and $ci.CreationDate) { $ci.CreationDate.ToFileTimeUtc() } else { "" }; ` +
      `Write-Output "$($p.Id)${FIELD_SEP}$($p.ProcessName)${FIELD_SEP}$cmd${FIELD_SEP}$created" } }`;
    const out = await collect(
      "powershell",
      ["-NoProfile", "-Command", ps],
      WIN_OWNER_PROBE_TIMEOUT_MS,
    );
    const owners = parseWinOwners(out);
    if (owners.length > 0) return owners;
    // Nothing came back. That is either a genuinely free port or a PowerShell that was too slow,
    // and those two look identical from here (see WIN_OWNER_PROBE_TIMEOUT_MS). netstat tells them
    // apart for the price of one native process, so the PID — the part a caller acts on — survives
    // a wedged shell. Name is best-effort on top.
    const pids = parseNetstatPids(
      await collectStdout("netstat", ["-ano", "-p", "TCP"], {
        maxBytes: NETSTAT_MAX_BYTES,
      }),
      port,
    );
    if (!pids.length) return [];
    return Promise.all(
      pids.map(async (pid) => ({ pid, name: (await winProcessName(pid)) ?? String(pid) })),
    );
  }
  const pidsOut = await collect("sh", ["-c", `lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null`]);
  const pids = [...new Set(pidsOut.split(/\s+/).map(Number).filter(Boolean))];
  if (!pids.length) return [];
  // `args=` (full command line) + `etime=` (elapsed wall time, [[DD-]HH:]MM:SS) — the `=` suffix
  // on each key suppresses ps's column header, but NOT the leading padding etime uses, so the
  // parse below trims/splits defensively rather than assuming fixed-width columns.
  const psOut = await collect("ps", ["-o", "pid=,etime=,args=", "-p", pids.join(",")]);
  return parseUnixOwners(psOut);
}

/**
 * PIDs listening on `port`, from `netstat -ano -p TCP`. Exported for tests — the parse is the
 * whole risk here, and the command itself is not something a test can stage.
 *
 * Deliberately does NOT look at the state column. `netstat`'s states are LOCALISED (a German
 * Windows prints "ABHÖREN", not "LISTENING"), so matching that word would silently return nothing
 * on most of the world's machines — the exact failure this fallback exists to prevent.
 *
 * A listening socket is identified by its FOREIGN address being the wildcard instead, which is
 * punctuation and therefore the same in every language. That also keeps this fallback's meaning
 * identical to the primary probe's `-State Listen`: an accepted connection whose local port is
 * `port` is the same process as the listener anyway, so admitting those rows would only add a way
 * for the two paths to disagree about which PID to name.
 */
const NETSTAT_WILDCARD_FOREIGN = new Set(["0.0.0.0:0", "[::]:0", "*:*"]);

export function parseNetstatPids(out: string, port: number): number[] {
  const pids = new Set<number>();
  for (const raw of out.split(/\r?\n/)) {
    const cols = raw.trim().split(/\s+/);
    if (cols.length !== 5) continue; // header rows, UDP rows (no state), blank lines
    const [, local, foreign, , pidStr] = cols;
    // ":<port>" at the end, so 5173 never matches 15173 — and it covers 0.0.0.0:p, [::]:p and
    // 127.0.0.1:p alike, which is why an IPv4/IPv6 pair of rows dedupes through the Set.
    if (!local?.endsWith(`:${port}`)) continue;
    if (!foreign || !NETSTAT_WILDCARD_FOREIGN.has(foreign)) continue;
    if (!pidStr || !/^\d+$/.test(pidStr)) continue;
    const pid = Number(pidStr);
    if (pid > 0) pids.add(pid); // pid 0 is the idle process, never a squatter you can act on
  }
  return [...pids];
}

/** First CSV field of `tasklist /NH /FO CSV` is the image name. Exported for tests. */
export function parseTasklistName(out: string): string | undefined {
  const name = out.trim().match(/^"([^"]+)"/)?.[1];
  if (!name) return undefined; // e.g. tasklist's "INFO: No tasks are running which match…"
  // Get-Process reports ProcessName without the extension, and the PowerShell path above is the
  // one callers normally see; strip it so a fallback answer never reads as a different process.
  return name.replace(/\.exe$/i, "") || undefined;
}

/** Best-effort image name for a PID via `tasklist` (native, no modules to autoload). */
async function winProcessName(pid: number): Promise<string | undefined> {
  return parseTasklistName(
    await collect("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"]),
  );
}

function parseWinOwners(out: string): PortOwner[] {
  const owners: PortOwner[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const [pidStr, name, cmd, created] = line.split(FIELD_SEP);
    if (!pidStr || !/^\d+$/.test(pidStr)) continue;
    owners.push({
      pid: Number(pidStr),
      name: name?.trim() || pidStr,
      cmdline: cmd?.trim() || undefined,
      uptime: created ? formatUptime(fileTimeUtcToMs(created)) : undefined,
    });
  }
  return owners;
}

function parseUnixOwners(out: string): PortOwner[] {
  const owners: PortOwner[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pidStr, etime, args] = m;
    owners.push({
      pid: Number(pidStr),
      name: (args.split(/\s+/)[0]?.split(/[/\\]/).pop() ?? pidStr) || pidStr,
      cmdline: args.trim() || undefined,
      uptime: formatUnixEtime(etime),
    });
  }
  return owners;
}

/** Windows `FILETIME.ToFileTimeUtc()` (100ns ticks since 1601-01-01) → epoch milliseconds. */
function fileTimeUtcToMs(ticksStr: string): number | undefined {
  const ticks = Number(ticksStr);
  if (!Number.isFinite(ticks) || ticks <= 0) return undefined;
  const EPOCH_DIFF_MS = 11644473600000; // ms between 1601-01-01 and 1970-01-01
  return ticks / 10000 - EPOCH_DIFF_MS;
}

/** Human-readable "created at" → "Xh Ym" (or "Ym"/"Xd Yh") elapsed-since-now uptime string. */
function formatUptime(createdAtMs: number | undefined): string | undefined {
  if (createdAtMs === undefined) return undefined;
  const elapsedSec = Math.max(0, Math.floor((Date.now() - createdAtMs) / 1000));
  return formatElapsedSeconds(elapsedSec);
}

/** Parse `ps`'s `etime=` format ([[DD-]HH:]MM:SS) into the same "Xd Yh" / "Xh Ym" / "Ym" shape. */
function formatUnixEtime(etime: string): string | undefined {
  const m = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return undefined;
  const [, days, hours, minutes, seconds] = m;
  const elapsedSec =
    (Number(days) || 0) * 86400 +
    (Number(hours) || 0) * 3600 +
    (Number(minutes) || 0) * 60 +
    (Number(seconds) || 0);
  return formatElapsedSeconds(elapsedSec);
}

function formatElapsedSeconds(elapsedSec: number): string {
  const days = Math.floor(elapsedSec / 86400);
  const hours = Math.floor((elapsedSec % 86400) / 3600);
  const minutes = Math.floor((elapsedSec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Kill exactly these PIDs (and their child trees) — targeted, unlike freePort's port sweep. */
export function killPids(pids: number[]): Promise<void> {
  return Promise.all(
    pids.map(
      (pid) =>
        new Promise<void>((resolve) => {
          try {
            treeKill(pid, "SIGKILL", () => resolve());
          } catch {
            resolve();
          }
        }),
    ),
  ).then(() => undefined);
}

/**
 * Find a bindable port at or above `preferred`. The implementation was promoted
 * verbatim into the shared kit server-lib (synced in as ./find-free-port.mjs) so every
 * sibling daemon uses the identical race-free walk — re-exported here so every
 * existing `from "./ports"` import keeps resolving.
 */
export { findFreePort } from "./find-free-port.mjs";

/** True if something is already listening on the port (non-intrusive TCP probe). */
export function isPortListening(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (v: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(300);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
    try {
      sock.connect(port, host);
    } catch {
      done(false);
    }
  });
}

/** Kill whatever process is holding the given port (best-effort, cross-platform). */
export function freePort(port: number): Promise<void> {
  return new Promise((resolve) => {
    let cmd: string;
    let args: string[];
    if (process.platform === "win32") {
      cmd = "powershell";
      args = [
        "-NoProfile",
        "-Command",
        `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
          `Select-Object -ExpandProperty OwningProcess -Unique | ` +
          `ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`,
      ];
    } else {
      cmd = "sh";
      args = ["-c", `lsof -ti tcp:${port} | xargs -r kill -9`];
    }
    try {
      const c = spawn(cmd, args, { windowsHide: true });
      c.on("close", () => resolve());
      c.on("error", () => resolve());
    } catch {
      resolve();
    }
  });
}

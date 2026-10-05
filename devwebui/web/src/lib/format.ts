// Shared formatting helpers — used by ProcessCard, NotificationsDrawer, etc. so the same
// duration/relative-time/byte logic lives in exactly one place.

export function formatDuration(totalSeconds: number): string {
  const t = Math.max(0, totalSeconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

export function formatUptime(nowMs: number, startedAt: number | null, running: boolean): string {
  if (!startedAt || !running) return "—";
  return formatDuration(Math.floor((nowMs - startedAt) / 1000));
}

export { formatAgo, formatAgoCoarse } from "@/lib/relativeTime";

export function formatBytes(bytes: number | null): string {
  if (!bytes) return "—";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / 1048576)} MB`;
}

/**
 * The "engine" of a command — the bare executable name that launches it, e.g.
 * `node ../node_modules/vite/bin/vite.js --port 4180` → "node". Skips leading
 * FOO=bar env-var assignments, honours a quoted first token, and strips the
 * directory part plus common executable/script extensions.
 */
export function commandEngine(command: string): string {
  let rest = command.trim();
  for (let i = 0; i < 4 && rest; i++) {
    const m = rest.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))\s*/);
    if (!m) break;
    const token = m[1] ?? m[2] ?? m[3] ?? "";
    rest = rest.slice(m[0].length);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue; // env-var prefix
    const base = token.split(/[\\/]/).pop() ?? token;
    return base.replace(/\.(exe|cmd|bat|ps1|sh|mjs|cjs|js|ts)$/i, "") || token;
  }
  return command.trim().split(/\s+/)[0] ?? "";
}

/**
 * Browser URL for a process's dev server, or null when there's nothing to open.
 * Used to make the process title a click-through link. `host` is the configurable
 * link host (Settings → Open in browser); it defaults to `localhost`.
 *
 *   - An absolute `http(s)://` `url` is used verbatim (point anywhere; host ignored).
 *   - A relative `url` (e.g. `/admin`) is appended to `http://<host>:<port>`.
 *   - No `url` → `http://<host>:<port>`.
 *   - No port and no absolute `url` → null (a bare path has no host to hang off).
 */
export function processUrl(
  port: number | null | undefined,
  url?: string | null,
  host: string = "localhost",
): string | null {
  const custom = url?.trim();
  if (custom && /^https?:\/\//i.test(custom)) return custom;
  if (port == null) return null;
  const base = `http://${host}:${port}`;
  if (!custom) return base;
  return base + (custom.startsWith("/") ? custom : `/${custom}`);
}

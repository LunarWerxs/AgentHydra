// Local API authentication: a cookie file for same-user tools, plus OTP-paired keys for browsers.
//
// WHY: loopback-guard.mjs stops a web PAGE driving the API (it reads browser provenance headers),
// but any local process that simply omits those headers - another OS user's process, a stray
// script - can still call every route. This module closes that gap without asking anyone to
// configure a password:
//
//   - COOKIE FILE (the bitcoind idea): each daemon boot writes a fresh random 32-byte secret as
//     `__cookie__:<hex>` to <dataDir>/.cookie (temp file + atomic rename, owner-only mode) and
//     deletes it on shutdown. The CLI and the MCP shim read it and send it as HTTP Basic auth, so
//     only a process that can read the owner's data dir gets in.
//   - PAIRING (the hoppscotch-agent idea): a browser cannot read files, so the GUI asks the daemon
//     for a pairing request; the daemon shows a 6-digit code on a trusted channel (the daemon
//     console, `devwebui pairing codes`, which itself needs the cookie). Typing that code back
//     earns a per-client random key, stored server-side only as a SHA-256 hash and revocable one
//     client at a time. The GUI keeps the key in localStorage and sends it as `Authorization:
//     Bearer`. NOT an HTTP cookie: browsers do not scope cookies by port, so every localhost dev
//     server the user opens from the dashboard would receive it. EventSource cannot set headers,
//     so the live stream instead takes a short-lived, single-use ticket minted by an authorized
//     fetch (see {@link mintStreamTicket}).
//
// Enforcement is OPT-IN (DEVWEBUI_REQUIRE_AUTH=1): the cookie file is always written and the CLI
// and MCP always send it, but a daemon without the flag keeps the long-standing open-on-loopback
// behaviour so a tray build or script that predates this keeps working.
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { Context, MiddlewareHandler } from "hono";
import { writeFileAtomic, writeJsonAtomic } from "./atomic-write";
import { dataDir } from "./data-dir";
import { ROUTES } from "./routes";

/** The Basic-auth user name the cookie file carries (bitcoind's convention). */
export const COOKIE_USER = "__cookie__";
/** Query parameter carrying a stream ticket (EventSource cannot send an Authorization header). */
export const STREAM_TICKET_PARAM = "ticket";
/** Header the tray host already sends with its per-session secret (see http/core.ts). */
const TRAY_TOKEN_HEADER = "x-devwebui-shutdown-token";

/** How long a pairing code stays valid, and how many guesses one request gets. */
export const PAIRING_TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS_PER_REQUEST = 5;
/** At most this many open requests: a new one evicts the oldest, so spam cannot pile up codes. */
const MAX_PENDING = 3;
/** Global brake on guessing: this many wrong codes inside the window locks pairing for the window.
 *  Deliberately global, not per request: a per-request limit alone lets a local process open
 *  request after request and brute-force the 6-digit space. The cost is that such a process can
 *  hold pairing locked (and evict the owner's open request) for the window; the CLI and MCP, which
 *  use the cookie file, are unaffected. */
const MAX_FAILURES_PER_WINDOW = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;
/** A stream ticket is good for one EventSource connect within this long of being minted. */
const STREAM_TICKET_TTL_MS = 30_000;
const MAX_STREAM_TICKETS = 32;

/** Routes a caller must reach WITHOUT a credential: liveness probes and the pairing handshake. */
const OPEN_ROUTES = new Set<string>([
  ROUTES.health,
  ROUTES.pairingStatus,
  ROUTES.pairingRequest,
  ROUTES.pairingVerify,
]);

/** Whether this daemon enforces authentication (read per call so tests can flip it). */
export function authRequired(): boolean {
  return process.env.DEVWEBUI_REQUIRE_AUTH === "1";
}

export function cookieFilePath(): string {
  return path.join(dataDir(), ".cookie");
}

/** The secret this daemon wrote, or null before writeCookieFile (and in a client process). */
let cookieSecret: string | null = null;

/**
 * Write a fresh cookie file for this daemon run and remember its secret. Atomic (a reader never
 * sees a half-written secret) and owner-only where the OS honours POSIX modes; on Windows the
 * data dir lives in the user's profile, whose ACL already keeps other users out.
 */
export function writeCookieFile(): string {
  const secret = randomBytes(32).toString("hex");
  const file = cookieFilePath();
  writeFileAtomic(file, `${COOKIE_USER}:${secret}`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600); // rename keeps the temp's mode, but a umask may have widened it
  } catch {
    /* best-effort: Windows ignores POSIX modes */
  }
  cookieSecret = secret;
  return secret;
}

/** Delete the cookie file on shutdown, but only while it is still OURS: an auto-update successor
 *  may already have written its own, and removing that would lock the CLI out of it. */
export function removeCookieFile(): void {
  if (!cookieSecret) return;
  try {
    if (readFileSync(cookieFilePath(), "utf8").trim() === `${COOKIE_USER}:${cookieSecret}`)
      rmSync(cookieFilePath(), { force: true });
  } catch {
    /* already gone */
  }
}

/** Client side: the `__cookie__:<hex>` line from the data dir, or null when no daemon wrote one. */
export function readCookieFile(): string | null {
  try {
    const line = readFileSync(cookieFilePath(), "utf8").trim();
    return line.startsWith(`${COOKIE_USER}:`) ? line : null;
  } catch {
    return null;
  }
}

/** True when `url` targets this machine's loopback interface. */
function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

/** Client side: add the cookie file's Basic credential to a request to `url`, unless the caller
 *  set one. Only for a loopback target: DEVWEBUI_URL can point the CLI or MCP anywhere, and the
 *  secret must never leave the machine. */
export function withLocalAuth(url: string, init: RequestInit = {}): RequestInit {
  if (!isLoopbackUrl(url)) return init;
  const line = readCookieFile();
  if (!line) return init;
  const headers = new Headers(init.headers);
  if (!headers.has("authorization"))
    headers.set("authorization", `Basic ${Buffer.from(line).toString("base64")}`);
  return { ...init, headers };
}

export interface PairedClient {
  id: string;
  label: string;
  createdAt: string;
}
interface StoredClient extends PairedClient {
  keyHash: string;
}

function clientsFilePath(): string {
  return path.join(dataDir(), "paired-clients.json");
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Constant-time string equality (length leak only, which a fixed-size secret makes moot). */
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function loadClients(): StoredClient[] {
  try {
    const parsed = JSON.parse(readFileSync(clientsFilePath(), "utf8")) as { clients?: unknown };
    return Array.isArray(parsed.clients) ? (parsed.clients as StoredClient[]) : [];
  } catch {
    return [];
  }
}

function saveClients(clients: StoredClient[]): void {
  writeJsonAtomic(clientsFilePath(), { clients }, { mode: 0o600 });
}

export function listPairedClients(): PairedClient[] {
  return loadClients().map(({ id, label, createdAt }) => ({ id, label, createdAt }));
}

/** Revoke one paired client; its key stops working on the very next request. */
export function revokePairedClient(id: string): boolean {
  const clients = loadClients();
  const kept = clients.filter((c) => c.id !== id);
  if (kept.length === clients.length) return false;
  saveClients(kept);
  return true;
}

function isPairedKey(key: string): boolean {
  if (!key) return false;
  const hash = sha256(key);
  return loadClients().some((c) => typeof c.keyHash === "string" && safeEqual(c.keyHash, hash));
}

// Open pairing requests live only in memory: a daemon restart simply voids them.
interface PendingPairing {
  requestId: string;
  label: string;
  code: string;
  expiresAt: number;
  attempts: number;
}
const pending = new Map<string, PendingPairing>();
let failures: number[] = [];

function prunePending(now = Date.now()): void {
  for (const [id, p] of pending) if (p.expiresAt <= now) pending.delete(id);
  failures = failures.filter((t) => now - t < FAILURE_WINDOW_MS);
}

/** Open a pairing request. The code is NOT returned to the requester: it is announced on the
 *  daemon console and listed by {@link pendingPairings} for authenticated callers only. */
export function startPairing(label: string): { requestId: string; expiresInSecs: number } {
  prunePending();
  while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value as string);
  const request: PendingPairing = {
    requestId: randomUUID(),
    label: label.trim().slice(0, 80) || "browser",
    code: String(randomInt(0, 1_000_000)).padStart(6, "0"),
    expiresAt: Date.now() + PAIRING_TTL_MS,
    attempts: 0,
  };
  pending.set(request.requestId, request);
  console.log(
    `[devwebui] pairing code for "${request.label}": ${request.code} (valid ${PAIRING_TTL_MS / 60_000} min; also shown by \`devwebui pairing codes\`)`,
  );
  return { requestId: request.requestId, expiresInSecs: PAIRING_TTL_MS / 1000 };
}

export interface PendingPairingView {
  requestId: string;
  label: string;
  code: string;
  expiresAt: string;
}

export function pendingPairings(): PendingPairingView[] {
  prunePending();
  return [...pending.values()].map((p) => ({
    requestId: p.requestId,
    label: p.label,
    code: p.code,
    expiresAt: new Date(p.expiresAt).toISOString(),
  }));
}

export type PairingResult =
  | { ok: true; client: PairedClient; key: string }
  | { ok: false; reason: string };

/** Check a typed code; on success mint and persist a new paired client and return its key once. */
export function completePairing(requestId: string, code: string): PairingResult {
  prunePending();
  if (failures.length >= MAX_FAILURES_PER_WINDOW)
    return { ok: false, reason: "too many wrong codes; try again later" };
  const request = pending.get(requestId);
  if (!request) return { ok: false, reason: "unknown or expired pairing request" };
  if (!safeEqual(request.code, String(code ?? "").trim())) {
    failures.push(Date.now());
    request.attempts += 1;
    if (request.attempts >= MAX_ATTEMPTS_PER_REQUEST) pending.delete(requestId);
    return { ok: false, reason: "wrong code" };
  }
  pending.delete(requestId);
  const key = randomBytes(32).toString("hex");
  const client: PairedClient = {
    id: randomUUID(),
    label: request.label,
    createdAt: new Date().toISOString(),
  };
  saveClients([...loadClients(), { ...client, keyHash: sha256(key) }]);
  return { ok: true, client, key };
}

// Stream tickets live only in memory, keyed by the ticket, valued by its expiry.
const streamTickets = new Map<string, number>();

/** Mint a single-use ticket an authorized caller hands to EventSource as `?ticket=`. It opens only
 *  the stream route, once, within {@link STREAM_TICKET_TTL_MS}, so a URL that lands in a log or
 *  history is already dead. */
export function mintStreamTicket(): { ticket: string; expiresInSecs: number } {
  const now = Date.now();
  for (const [t, exp] of streamTickets) if (exp <= now) streamTickets.delete(t);
  while (streamTickets.size >= MAX_STREAM_TICKETS)
    streamTickets.delete(streamTickets.keys().next().value as string);
  const ticket = randomBytes(32).toString("hex");
  streamTickets.set(ticket, now + STREAM_TICKET_TTL_MS);
  return { ticket, expiresInSecs: STREAM_TICKET_TTL_MS / 1000 };
}

/** Spend a stream ticket: true (and gone) when it was live, false otherwise. */
function consumeStreamTicket(ticket: string): boolean {
  const exp = streamTickets.get(ticket);
  if (exp === undefined) return false;
  streamTickets.delete(ticket);
  return exp > Date.now();
}

/** Test hook: forget open requests, the failure window and unspent stream tickets. */
export function resetPairingState(): void {
  pending.clear();
  failures = [];
  streamTickets.clear();
}

export interface LocalAuthOptions {
  /** Enforce at all? Default: {@link authRequired}. */
  required?: () => boolean;
  /** The tray's per-session secret (DEVWEBUI_TRAY_SHUTDOWN_TOKEN); it proves the same thing. */
  trayToken?: string;
}

/** Does this request carry a valid credential: the cookie file (Basic or Bearer), a paired key
 *  (Bearer), or the tray's session token? */
export function isAuthorized(c: Context, options: LocalAuthOptions = {}): boolean {
  const auth = c.req.header("authorization") ?? "";
  const [scheme, value = ""] = auth.split(/\s+/, 2);
  if (scheme?.toLowerCase() === "basic" && cookieSecret) {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    if (safeEqual(decoded, `${COOKIE_USER}:${cookieSecret}`)) return true;
  }
  if (scheme?.toLowerCase() === "bearer" && value) {
    if (cookieSecret && safeEqual(value, cookieSecret)) return true;
    if (isPairedKey(value)) return true;
  }
  const tray = c.req.header(TRAY_TOKEN_HEADER) ?? "";
  return !!options.trayToken && !!tray && safeEqual(tray, options.trayToken);
}

/** Hono middleware for `/api/*`, mounted after loopbackGuard. A no-op unless enforcement is on. */
export function createLocalAuth(options: LocalAuthOptions = {}): MiddlewareHandler {
  const required = options.required ?? authRequired;
  return async (c, next) => {
    if (!required() || OPEN_ROUTES.has(c.req.path) || isAuthorized(c, options)) return next();
    const ticket = c.req.query(STREAM_TICKET_PARAM);
    if (c.req.path === ROUTES.stream && ticket && consumeStreamTicket(ticket)) return next();
    return c.json(
      {
        error: "unauthorized: send the cookie file (devwebui CLI/MCP) or pair this browser",
        pairing: ROUTES.pairingStatus,
      },
      401,
    );
  };
}

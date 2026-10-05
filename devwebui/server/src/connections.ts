// ---------------------------------------------------------------------------
// "Sync my settings with Connections" — the daemon-side Backend-for-Frontend.
//
// DevWebUI is a single-user local daemon, so the daemon IS the BFF: it runs the
// OIDC login (Authorization Code + PKCE, public client — no secret), holds the
// owner's refresh token server-side, mints access tokens, and calls the Connections
// settings-sync store (studio.connectionsapi.com/v1/app-data/{clientId}). The browser
// never holds a token.
//
// Since 2026-07-08 the OAuth/refresh/identity machinery is the OFFICIAL SDK — @cnct/connect
// (which also ships the settings-store locker client, since its 0.7.0) — instead of a
// hand-rolled copy: single-flight rotation-safe refresh, per-attempt redirect_uri, server-side
// revoke on forget, and id_token identity all come from the shared package. This
// module keeps only the DevWebUI-specific parts: the state file (which also carries
// the app's own sync prefs), the settings allowlist, and the sync orchestration.
//
// Because DevWebUI has no tunnel / remote mode, there is NO auth gate and NO session
// cookie: "signed in" simply means the daemon holds a refresh token.
//
// Off by default: with sync disabled (the default), nothing here runs. What syncs is a
// small ALLOWLIST of portable prefs (PREF_KEYS) + the web's appearance blob (theme).
// Never machine-specific or secret values.
//
// @cnct/connect is an `optionalDependency` (package.json), NOT statically imported: a public
// `bun install` with no LunarWerx account still boots the daemon cleanly even if the package
// fails to install/resolve. It is pulled in ONLY by `connect()`/`locker()` below, via
// `await import()`, which only ever runs on a path the owner actually triggered (sign-in, or
// boot's pullNow() when sync was already enabled) — never on a cold boot with sync off. A
// missing install surfaces as `SdkUnavailableError`, caught by `guardSync` in
// connections-routes.ts like any other sync failure — never a boot crash.
// ---------------------------------------------------------------------------
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "./atomic-write";
import path from "node:path";
import { dataDir } from "./data-dir";
import type {
  ConnectClient,
  ConnectStore,
  SettingsSync,
  SettingsSyncStatus,
  TokenSet,
} from "@cnct/connect";
import { readSettings, writeSettings, type Settings } from "./runtime";
import { seal, sealingActive, unseal, wrapTokenStore } from "./dpapi-seal.mjs";

/** DevWebUI's own public "Sign in with Connections" OAuth client (PKCE — no secret). Its client_id
 *  doubles as the settings-sync store `appId`, so DevWebUI's synced data is namespaced to itself. */
const OAUTH = {
  issuer: "https://accounts.connectionsapi.com",
  clientId: "622a12e32d0b39c68f56c63316f351e5",
  scopes: ["openid", "profile", "email", "photo"],
};

/**
 * The ONLY settings keys that sync — portable UI/behaviour prefs.
 *
 * Widened 2026-08-25 from four keys to thirteen. The old list excluded the scan-skip settings as
 * "machine/OS-specific", which reads right and is backwards: `skipMac` only ever DOES anything on
 * a Mac, so carrying it from the desktop where you set it to the Mac where it applies is the
 * entire point. The exclusions that survived are the ones with a mechanism behind them, listed in
 * [`NEVER_SYNCED`] below with their reasons.
 */
const PREF_KEYS = [
  "runtime",
  "freePortOnStart",
  "monitorResources",
  "autoScan",
  // Scan policy. Each `skip*` flag is inert on the operating systems it does not name, so these
  // travel to the machine where they matter instead of being re-set there by hand.
  "skipWindows",
  "skipMac",
  "skipLinux",
  "osSkip",
  // The curated exclude list. It mixes folder NAMES (portable) with absolute paths (not), and
  // that is fine: a path that does not exist on this machine simply never matches anything, so
  // the worst case is a dead entry, against the real cost of rebuilding the list per machine.
  "scanExclude",
  // Update preferences, minus the one that acts on its own — see NEVER_SYNCED.
  "updateNotify",
  "autoUpdateIntervalSecs",
  // A risk preference, not an action: a longer cooldown only ever makes an install wait.
  "updateCooldownDays",
  // How you like the app to present itself.
  "portableMode",
  "hideTrayIcon",
] as const satisfies readonly (keyof Settings)[];

/**
 * Every settings key that deliberately does NOT sync, with the reason.
 *
 * Kept as a list so the type below can prove the two together cover `Settings`. Before this, a
 * new setting silently defaulted to "not synced" — which is how nine portable preferences ended
 * up stranded without anyone deciding they should be.
 */
const NEVER_SYNCED = [
  // A hostname that resolves on THIS network. Carrying `192.168.1.50` to a laptop on a different
  // network points its Open buttons at nothing, or worse, at someone else's machine.
  "linkHost",
  // Unattended-action toggles. A machine someone just signed in on must not start launching
  // every server, or updating and relaunching itself, without being told to here.
  "autoStartOnLaunch",
  "autoUpdate",
  // A per-machine latch: the one-time first-launch scan. Syncing a `true` would suppress that
  // first scan on a machine that has never run one.
  "firstScanDone",
  // Per-install identity for the update ping. Syncing it would merge two installs into one.
  "pulseInstallId",
  "pulseInstallReported",
] as const satisfies readonly (keyof Settings)[];

/**
 * Compile-time proof that the two lists partition `Settings`.
 *
 * A new settings key that belongs to neither fails this line and the error names it, in the
 * editor, before the commit rather than after it.
 */
type UnclassifiedSettingsKey = Exclude<
  keyof Settings,
  (typeof PREF_KEYS)[number] | (typeof NEVER_SYNCED)[number]
>;
const _everySettingIsClassified: UnclassifiedSettingsKey extends never
  ? true
  : [
      "these Settings keys sync neither way — add each to PREF_KEYS or NEVER_SYNCED",
      UnclassifiedSettingsKey,
    ] = true;
void _everySettingIsClassified;

// ── persisted state (~/.devwebui/connections.json, 0600) ─────────────────────────
const stateFile = (): string => path.join(dataDir(), "connections.json");

interface ConnState {
  /** LEGACY (pre-SDK) credential slot — migrated into `sdk` on first boot, then removed. */
  refreshToken?: string;
  enabled?: boolean;
  lastSyncedAt?: string;
  version?: number;
  appearance?: Record<string, unknown>;
  identity?: { sub: string; email: string; name?: string; picture?: string };
  /** The @cnct/connect session entries (token set + in-flight PKCE), keyed by the SDK.
   *  Sensitive → this file is 0600, never committed. */
  sdk?: Record<string, string>;
}

let state: ConnState = {};
let loaded = false;

function persist(): void {
  mkdirSync(dataDir(), { recursive: true });
  writeJsonAtomic(stateFile(), state, { mode: 0o600, trailingNewline: false });
}

// The SDK's persistence rides THIS module's state file (one 0600 JSON for everything), via a
// ConnectStore adapter over the in-memory `state` — every set/remove goes through persist().
const TOKEN_KEY = `cnx.connect.tokens.${OAUTH.clientId}`;
const stateStore: ConnectStore = {
  get: (key) => state.sdk?.[key] ?? null,
  set: (key, value) => {
    state.sdk ??= {};
    state.sdk[key] = value;
    persist();
  },
  remove: (key) => {
    if (state.sdk && key in state.sdk) {
      delete state.sdk[key];
      persist();
    }
  },
};

/** Thrown when a sync/sign-in op is attempted but @cnct/connect (an `optionalDependency`) never
 *  installed — e.g. a public install where the optional native/peer resolution was skipped.
 *  Surfaces as a normal `guardSync` error, not a boot crash. */
class SdkUnavailableError extends Error {
  code = "sdk_unavailable";
  constructor(pkg: string, cause: unknown) {
    super(`${pkg} is not installed — Connections cloud sync is unavailable`);
    this.name = "SdkUnavailableError";
    this.cause = cause;
  }
}

let connectClient: ConnectClient | null = null;
/** The lazily-built SDK client (after initConnections loads the state file). Dynamically
 *  imports @cnct/connect — never pulled in on a boot where sync is off. The constructor
 *  redirectUri is a placeholder — every real sign-in passes the live origin per attempt. */
async function connect(): Promise<ConnectClient> {
  if (connectClient) return connectClient;
  let createConnect: typeof import("@cnct/connect").createConnect;
  try {
    ({ createConnect } = await import("@cnct/connect"));
  } catch (e) {
    throw new SdkUnavailableError("@cnct/connect", e);
  }
  connectClient = createConnect({
    clientId: OAUTH.clientId,
    issuer: OAUTH.issuer,
    scopes: OAUTH.scopes,
    redirectUri: "http://127.0.0.1/oauth/callback",
    // Wrap the store so the persisted TokenSet (the durable refresh token) is DPAPI-sealed at
    // rest on Windows; the transient PKCE record and non-Windows hosts pass through unchanged.
    store: wrapTokenStore(stateStore, TOKEN_KEY),
    // Late-bound so a test harness's globalThis.fetch stub is honored even though the
    // client is memoized across calls (the SDK captures `fetch` at construction). Cast:
    // the SDK only CALLS it; Bun's `typeof fetch` also declares a `preconnect` member.
    fetch: ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) as typeof fetch,
  });
  return connectClient;
}

/** Load persisted sync state (incl. the credential) into memory. Call once at daemon boot. */
export function initConnections(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (existsSync(stateFile())) state = JSON.parse(readFileSync(stateFile(), "utf8")) as ConnState;
  } catch {
    state = {};
  }
  // One-time legacy migration (pre-SDK state files): the bare refreshToken moves into the SDK's
  // token entry in the SAME file, so an existing signed-in daemon stays signed in across the
  // upgrade — no re-login. expiresAt 0 forces a refresh on first use (rotation persists back
  // through the store adapter above).
  if (state.refreshToken && !state.sdk?.[TOKEN_KEY]) {
    const seed: TokenSet = { accessToken: "", refreshToken: state.refreshToken, expiresAt: 0 };
    state.sdk ??= {};
    state.sdk[TOKEN_KEY] = seal(JSON.stringify(seed)); // seal the seeded token at rest (Windows)
    delete state.refreshToken;
    persist();
  }
  // Say it out loud where at-rest sealing isn't available. dpapi-seal.mjs degrades to a
  // plaintext passthrough off Windows by design, which is defensible — but silently, which
  // is not: the user's refresh token is then only as protected as the file mode, and they
  // had no way to find that out. Only warn when there is actually a token on disk to protect.
  if (!sealingActive() && state.sdk?.[TOKEN_KEY]) {
    console.warn(
      "[devwebui] Connections sign-in token is stored UNENCRYPTED at rest on this platform " +
        "(file permissions only). At-rest sealing is currently Windows-only.",
    );
  }
}

/** True when the daemon holds a Connections credential (the owner has signed in). Synchronous —
 *  reads the SDK's token entry straight from the in-memory state. */
export function hasConnection(): boolean {
  const raw = state.sdk?.[TOKEN_KEY];
  if (!raw) return false;
  const plain = unseal(raw); // DPAPI-sealed at rest → decrypt; legacy plaintext passes through
  if (!plain) return false;
  try {
    const tokens = JSON.parse(plain) as TokenSet;
    return Boolean(tokens.refreshToken || tokens.accessToken);
  } catch {
    return false;
  }
}

/** Build the authorize URL for a sign-in that redirects back to `${origin}/oauth/callback`.
 *  The live origin rides the SDK's per-attempt redirectUri override (the daemon may be reached
 *  as localhost, 127.0.0.1, or a LAN IP — the callback must match whichever the browser used). */
export async function buildAuthorizeUrl(origin: string): Promise<string> {
  const client = await connect();
  return client.signIn({ redirect: false, redirectUri: `${origin}/oauth/callback` });
}

/** Complete the OIDC callback: exchange the code, persist the session, capture identity. */
export async function handleCallback(
  origin: string,
  code: string,
  stateTok: string,
): Promise<boolean> {
  try {
    const callbackUrl = `${origin}/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(stateTok)}`;
    const client = await connect();
    const user = await client.handleCallback(callbackUrl);
    state.identity = {
      sub: user.sub,
      email: user.email ?? "",
      name: user.name ?? "",
      picture: user.picture ?? "",
    };
    persist();
    return true;
  } catch {
    return false;
  }
}

/** Backfill display identity (name/picture) for sessions created before those fields existed —
 *  best-effort, only when something is missing, piggybacking on calls that already network. */
async function backfillIdentity(): Promise<void> {
  if (state.identity?.name && state.identity?.picture) return;
  try {
    const client = await connect();
    const user = await client.getUser();
    state.identity = {
      sub: user.sub,
      email: user.email ?? "",
      name: user.name ?? "",
      picture: user.picture ?? "",
    };
    persist();
  } catch {
    /* identity is best-effort; syncing works without it */
  }
}

// ── settings mapping (the allowlist) ─────────────────────────────────────────────
function collectPrefs(): Record<string, unknown> {
  const s = readSettings();
  const out: Record<string, unknown> = {};
  for (const k of PREF_KEYS) out[k] = s[k];
  return out;
}

/** Apply an allowlisted prefs blob to the persisted settings; returns the saved Settings (or null). */
function applyPrefs(prefs: Record<string, unknown> | undefined): Settings | null {
  if (!prefs || typeof prefs !== "object") return null;
  const patch: Partial<Settings> = {};
  for (const k of PREF_KEYS) {
    if (k in prefs) (patch as Record<string, unknown>)[k] = prefs[k];
  }
  return writeSettings(patch); // writeSettings validates each field and ignores anything off-shape
}

// ── public sync API ───────────────────────────────────────────────────────────────
export interface SyncStatus {
  enabled: boolean;
  connected: boolean;
  name: string | null;
  email: string | null;
  picture: string | null;
  lastSyncedAt: string | null;
  version: number;
  appearance: Record<string, unknown> | null;
  /**
   * Whether the durable OAuth refresh token is encrypted AT REST. True on Windows, where
   * dpapi-seal.mjs seals it with DPAPI (CurrentUser scope). Everywhere else that module
   * degrades to a plaintext passthrough, so the token sits in ~/.devwebui protected only
   * by file mode 0600 — readable by anything running as the same user. That degradation
   * was previously invisible: a macOS/Linux user had no way to know the protection the
   * docs describe does not apply to them. Surfaced so the GUI can say so plainly.
   */
  tokenSealed: boolean;
}

export function syncStatus(): SyncStatus {
  return {
    enabled: state.enabled === true,
    connected: hasConnection(),
    name: state.identity?.name || null,
    email: state.identity?.email || null,
    picture: state.identity?.picture || null,
    lastSyncedAt: state.lastSyncedAt ?? null,
    version: state.version ?? 0,
    appearance: state.appearance ?? null,
    tokenSealed: sealingActive(),
  };
}

let settingsSync: SettingsSync | null = null;
let lastApplied: Settings | null = null;

function recordEngineStatus(status: SettingsSyncStatus): void {
  if (status.version !== null) state.version = status.version;
  if (status.lastSyncedAt !== null) {
    state.lastSyncedAt = new Date(status.lastSyncedAt).toISOString();
  }
  if (status.version !== null || status.lastSyncedAt !== null) persist();
}

async function syncEngine(): Promise<SettingsSync> {
  if (settingsSync) return settingsSync;
  let createSettingsSync: typeof import("@cnct/connect").createSettingsSync;
  try {
    ({ createSettingsSync } = await import("@cnct/connect"));
  } catch (e) {
    throw new SdkUnavailableError("@cnct/connect", e);
  }
  const client = await connect();
  settingsSync = createSettingsSync(client.locker(), {
    // Existing users already have { prefs, appearance }; both stay top-level.
    keys: ["prefs", "appearance"],
    read: () => ({
      prefs: collectPrefs(),
      ...(state.appearance ? { appearance: state.appearance } : {}),
    }),
    write: (patch) => {
      lastApplied = applyPrefs(
        patch.prefs && typeof patch.prefs === "object"
          ? (patch.prefs as Record<string, unknown>)
          : undefined,
      );
      if (patch.appearance && typeof patch.appearance === "object") {
        state.appearance = patch.appearance as Record<string, unknown>;
      }
      persist();
    },
    onStatus: recordEngineStatus,
  });
  return settingsSync;
}

function requireSuccess(status: SettingsSyncStatus): SettingsSyncStatus {
  if (status.state === "synced") return status;
  if (status.state === "signed-out") {
    const error = new Error("not_signed_in") as Error & { code?: string };
    error.code = "not_signed_in";
    throw error;
  }
  throw status.error ?? new Error(`settings sync ended in ${status.state}`);
}

/** Flush the current allowlisted settings immediately. */
export async function pushNow(): Promise<void> {
  requireSuccess(await (await syncEngine()).flush());
  await backfillIdentity();
}

/** Pull remote settings and apply the allowlisted subset. Returns the applied Settings (or null). */
export async function pullNow(): Promise<{ applied: Settings | null; version: number }> {
  lastApplied = null;
  const status = requireSuccess(await (await syncEngine()).pull());
  await backfillIdentity();
  return { applied: lastApplied, version: status.version ?? 0 };
}

/** Turn sync on: pull the remote doc (applying it) or seed the store from local if it's empty. */
export async function enable(
  appearance?: Record<string, unknown>,
): Promise<{ status: SyncStatus; applied: Settings | null }> {
  state.enabled = true;
  if (appearance) state.appearance = appearance;
  persist();
  let applied: Settings | null = null;
  if (hasConnection()) {
    lastApplied = null;
    requireSuccess(await (await syncEngine()).hydrate({ seedIfEmpty: true }));
    applied = lastApplied;
    await backfillIdentity();
  }
  return { status: syncStatus(), applied };
}

/** Turn sync off. `forget` also disconnects — deletes the remote document, REVOKES the grant
 *  server-side (RFC 7009, so the refresh-token family is dead everywhere), and clears the session. */
export async function disable(forget = false): Promise<SyncStatus> {
  state.enabled = false;
  settingsSync?.stop();
  if (forget) {
    if (hasConnection()) {
      try {
        await (settingsSync ?? (await syncEngine())).locker.delete();
      } catch {
        /* best-effort remote wipe */
      }
      try {
        const client = await connect();
        await client.signOut({ revoke: true });
      } catch {
        /* best-effort revoke — the local credential is cleared below regardless */
      }
    }
    state.identity = undefined;
    state.appearance = undefined;
    state.version = 0;
    state.lastSyncedAt = undefined;
    state.sdk = undefined;
  }
  settingsSync = null;
  persist();
  return syncStatus();
}

/** The web changed appearance; the SDK engine owns debounce/coalescing. */
export async function updateAppearance(appearance: Record<string, unknown>): Promise<void> {
  state.appearance = appearance;
  persist();
  if (state.enabled && hasConnection()) (await syncEngine()).push();
}

/** Flush a pending debounce before daemon shutdown/relaunch. */
export async function flushPending(): Promise<void> {
  if (state.enabled && hasConnection()) {
    requireSuccess(await (await syncEngine()).flushAndStop({ timeoutMs: 5_000 }));
    await backfillIdentity();
  }
}

/** Sign out / disconnect fully (used by the logout route). */
export async function logout(): Promise<void> {
  await disable(true);
}

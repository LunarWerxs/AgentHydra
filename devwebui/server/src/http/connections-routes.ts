// ---------------------------------------------------------------------------
// "Sign in with Connections" + settings-sync HTTP surface.
//
// Thin adapter over server/src/connections.ts (the daemon-side BFF). The browser
// only talks to these local daemon routes; the daemon holds the refresh token and
// calls the store. DevWebUI has no auth gate (local single-user daemon), so these
// are ordinary routes — the sync ops themselves check whether a connection exists.
// ---------------------------------------------------------------------------
import type { Context, Hono } from "hono";
import type { Manager } from "../manager";
import type { Settings } from "../runtime";
import { ROUTES } from "../routes";
import {
  buildAuthorizeUrl,
  handleCallback,
  syncStatus,
  enable,
  disable,
  logout,
  updateAppearance,
  pullNow,
  pushNow,
} from "../connections";
import { readBody } from "./core";

/** Apply the synced runtime prefs to the live manager (mirrors PUT /api/settings). */
function applyToManager(manager: Manager, s: Settings): void {
  manager.globalRuntime = s.runtime;
  manager.freePortOnStart = s.freePortOnStart;
  manager.monitorResources = s.monitorResources;
  manager.applyMonitorResources();
}

/** Run a sync op and turn any failure into an inline `{ ok:false, error }` (HTTP 200 — non-fatal;
 *  the daemon keeps using local settings and the UI surfaces the reason). */
async function guardSync<T extends object>(c: Context, run: () => Promise<T>): Promise<Response> {
  try {
    return c.json({ ok: true, ...(await run()) });
  } catch (e) {
    const err = e as {
      code?: string;
      status?: number;
      message?: string;
      retryAfterSeconds?: number;
    };
    const code = err.code ?? (err.message === "not_signed_in" ? "not_signed_in" : "sync_failed");
    return c.json({ ok: false, error: code, retryAfterSeconds: err.retryAfterSeconds });
  }
}

/** GET /oauth/login — start the OIDC flow. */
async function handleOauthLogin(c: Context): Promise<Response> {
  try {
    const url = await buildAuthorizeUrl(new URL(c.req.url).origin);
    return c.redirect(url);
  } catch {
    return c.redirect("/?connect=failed");
  }
}

/** GET /oauth/callback — exchange the code, then best-effort converge sync in the background. */
async function handleOauthCallback(c: Context, manager: Manager): Promise<Response> {
  const origin = new URL(c.req.url).origin;
  const code = c.req.query("code");
  const stateTok = c.req.query("state");
  const ok =
    code && stateTok ? await handleCallback(origin, code, stateTok).catch(() => false) : false;
  // If sync was already enabled before this sign-in, converge now that we have a token: pull the
  // remote doc (applying it) OR seed the store from local if the remote is empty. `enable()` does
  // exactly that pull-or-seed; run it in the background so the redirect never waits on the network.
  if (ok && syncStatus().enabled) {
    void enable()
      .then(({ applied }) => applied && applyToManager(manager, applied))
      .catch(() => {}); // best-effort background converge — the redirect already fired; a failed
    // pull-or-seed just leaves local settings as-is until the next sync attempt
  }
  return c.redirect(ok ? "/?connected=1" : "/?connect=failed");
}

/** PUT /api/settings/sync body shape. */
type SyncPutBody = { enabled?: boolean; forget?: boolean; appearance?: Record<string, unknown> };

/** Apply one PUT /api/settings/sync request's requested change and return the resulting status. */
async function applySyncPut(b: SyncPutBody, manager: Manager) {
  if (b.enabled === true) {
    const { status, applied } = await enable(b.appearance);
    if (applied) applyToManager(manager, applied);
    return status;
  }
  if (b.enabled === false) return await disable(b.forget === true);
  if (b.appearance && typeof b.appearance === "object") await updateAppearance(b.appearance);
  return syncStatus();
}

export function registerConnectionsRoutes(app: Hono, manager: Manager): void {
  // ── OIDC login (full-page navigations, not /api) ──────────────────────────
  app.get("/oauth/login", handleOauthLogin);
  app.get("/oauth/callback", (c) => handleOauthCallback(c, manager));

  // ── identity ──────────────────────────────────────────────────────────────
  app.get(ROUTES.authMe, (c) => {
    const s = syncStatus();
    return c.json({
      ok: true,
      connected: s.connected,
      name: s.name,
      picture: s.picture,
      email: s.email,
    });
  });
  app.post(ROUTES.authLogout, async (c) => {
    await logout();
    return c.json({ ok: true });
  });

  // ── settings sync ───────────────────────────────────────────────────────────
  app.get(ROUTES.settingsSync, (c) => c.json({ ok: true, ...syncStatus() }));

  app.put(ROUTES.settingsSync, async (c) => {
    const b = (await readBody(c)) as SyncPutBody;
    return guardSync(c, () => applySyncPut(b, manager));
  });

  app.post(ROUTES.settingsSyncPull, (c) =>
    guardSync(c, async () => {
      const { applied } = await pullNow();
      if (applied) applyToManager(manager, applied);
      return syncStatus();
    }),
  );

  app.post(ROUTES.settingsSyncPush, (c) =>
    guardSync(c, async () => {
      await pushNow();
      return syncStatus();
    }),
  );
}

/** Exported so the boot sequence can apply a background pull's result to the live manager. */
export { applyToManager };

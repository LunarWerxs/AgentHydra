import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import type { Manager } from "../manager";
import { isLoopbackOrigin, loopbackGuard } from "../loopback-guard.mjs";
import { createLocalAuth } from "../local-auth";
import {
  allowedOrigins,
  registerRealtime,
  registerSystemRoutes,
  type CreateAppOptions,
} from "./core";
import { registerProjectRoutes } from "./project-routes";
import { registerProcessRoutes } from "./process-routes";
import { registerConnectionsRoutes } from "./connections-routes";
import { registerAlertRoutes } from "./alert-routes";
import { registerPortProxy } from "./port-proxy";
import { BROWSER_PAGE_PATHS, registerBrowserRoutes } from "./browser-routes";
import { registerPairingRoutes } from "./pairing-routes";

function embeddedContentType(pathname: string): string {
  const ext = path.extname(pathname).toLowerCase();
  return (
    {
      ".css": "text/css; charset=utf-8",
      ".html": "text/html; charset=utf-8",
      ".ico": "image/x-icon",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".ttf": "font/ttf",
      ".webmanifest": "application/manifest+json; charset=utf-8",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    }[ext] ?? "application/octet-stream"
  );
}

export function createApp(manager: Manager, options: CreateAppOptions = {}) {
  const app = new Hono();
  // Port proxy first: a `<target>.localhost` request belongs to that managed dev server, /api/*
  // paths included, so it must be claimed before cors, the guard below, or any daemon route. It
  // runs the same CSRF guard itself (http/port-proxy.ts).
  registerPortProxy(app, manager, options.port);
  // CORS is scoped to the daemon's own origin(s) — see allowedOrigins(). This alone only
  // gates whether a browser lets a page READ a cross-origin response; the Origin-gate
  // below stops the mutating request from running at all. Non-browser clients (no Origin
  // header) are unaffected by either.
  // The browser bridge's page paths are the one exception: a supervised dev app on ANOTHER
  // loopback port must read its SSE stream and post answers, so those two paths grant any
  // loopback origin (never a non-loopback one; the guard below refuses those anyway).
  const origins = allowedOrigins(options.port);
  app.use(
    "/api/*",
    cors({
      origin: (origin, c) =>
        origins.includes(origin) ||
        (BROWSER_PAGE_PATHS.includes(c.req.path) && isLoopbackOrigin(origin))
          ? origin
          : null,
    }),
  );
  // Cross-site (CSRF) guard — the shared kit primitive (server/src/loopback-guard.mjs). Rejects
  // browser cross-site requests (Sec-Fetch-Site: cross-site, or a present non-loopback Origin/Host)
  // on every /api/* verb; same-origin (GUI), same-site (dev), and non-browser (CLI/tray/MCP) pass.
  // Runs after cors so a preflight OPTIONS is answered by cors and never reaches the guard. Replaces
  // DevWebUI's former hand-rolled requireAllowedOrigin (which gated only mutating verbs); the shared
  // guard also blocks cross-site GET read-exfil.
  app.use("/api/*", loopbackGuard);
  // Local auth (server/src/local-auth.ts): the guard above only stops browsers; this stops any
  // other local process too, by requiring the cookie file or a paired key. Opt-in, so it is a
  // no-op unless the daemon was started with DEVWEBUI_REQUIRE_AUTH=1.
  app.use(
    "/api/*",
    createLocalAuth({
      required: () => options.requireAuth === true,
      trayToken: options.shutdownToken,
    }),
  );

  registerRealtime(app, manager);
  registerSystemRoutes(app, manager, options);
  registerProjectRoutes(app, manager);
  registerProcessRoutes(app, manager);
  registerConnectionsRoutes(app, manager);
  registerAlertRoutes(app, manager);
  registerBrowserRoutes(app, manager);
  registerPairingRoutes(app, options);
  registerWebAssetRoutes(app);
  return app;
}

/** Serve the built GUI from the daemon. Resolve web/dist in BOTH shapes: dev (relative to this
 *  source) and compiled (a `web/dist` shipped next to the single-file binary — see scripts/build.ts).
 *  An embedded bundle wins: the single-file binary ships the GUI inside itself, so a stray web/dist
 *  on disk must not shadow it. */
function registerWebAssetRoutes(app: Hono): void {
  const embedded = (
    globalThis as {
      __DEVWEBUI_EMBEDDED_WEB__?: Readonly<Record<string, string>>;
    }
  ).__DEVWEBUI_EMBEDDED_WEB__;
  const distCandidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../web/dist"),
    path.resolve(path.dirname(process.execPath), "web", "dist"),
  ];
  const dist = distCandidates.find((c) => existsSync(c));

  if (embedded) {
    app.get("/*", async (c) => {
      let pathname = decodeURIComponent(new URL(c.req.url).pathname);
      if (pathname === "/" || pathname === "") pathname = "/index.html";
      const lastSeg = pathname.slice(pathname.lastIndexOf("/") + 1);
      const isAsset = pathname.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(lastSeg);
      const embeddedPath = embedded[pathname];
      if (embeddedPath) {
        return new Response(new Uint8Array(readFileSync(embeddedPath)), {
          headers: {
            "cache-control": pathname.startsWith("/assets/")
              ? "public, max-age=31536000, immutable"
              : "no-cache",
            "content-type": embeddedContentType(pathname),
          },
        });
      }
      if (isAsset) return c.text("not found", 404, { "cache-control": "no-store" });
      return new Response(new Uint8Array(readFileSync(embedded["/index.html"]!)), {
        headers: { "cache-control": "no-cache", "content-type": "text/html; charset=utf-8" },
      });
    });
    return;
  }
  if (!dist) return;

  const root = path.relative(process.cwd(), dist);
  app.use("/assets/*", serveStatic({ root }));
  // A MISSING hashed chunk under /assets/ (a stale browser tab requesting an old chunk after a
  // rebuild/auto-update) must return a real 404 — NOT fall through to the index.html SPA fallback,
  // which hands the browser text/html for a module script ("Failed to load module script … MIME
  // type text/html"). The client recovers from the 404 via a vite:preloadError reload (see
  // web/src/lib/chunk-reload-recovery.ts). Navigation routes (no /assets/ prefix) still fall
  // through to the SPA below.
  app.get("/assets/*", (c) => c.text("not found", 404, { "cache-control": "no-store" }));
  // Root-level public files (icon.svg / icon-light.svg / favicon.ico / logo-*.svg) must resolve
  // as real files first — without this the SPA fallback below answers the browser's favicon
  // request with index.html and the daemon-served app never shows a tab icon (the Vite dev
  // server masks the bug by serving web/public itself).
  app.use("/*", serveStatic({ root }));
  app.get("/*", serveStatic({ path: path.join(root, "index.html") }));
}

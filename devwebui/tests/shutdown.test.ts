import "./isolate"; // CWD-proof data-dir isolation — must load before any server/src import
import { expect, test } from "bun:test";
import { ROUTES } from "../shared/routes";
import { createApp } from "../server/src/http";
import { Manager } from "../server/src/manager";

test("daemon shutdown endpoint requires an intentional tray or UI shutdown signal", async () => {
  const manager = new Manager();
  manager.monitorResources = false;
  manager.applyMonitorResources();
  let shutdowns = 0;
  const app = createApp(manager, {
    shutdownToken: "secret",
    requestShutdown: () => {
      shutdowns += 1;
    },
  });

  try {
    // No Origin header (CLI/MCP/tray-style request) — the Origin gate doesn't apply, so this
    // still reaches the handler and is rejected on the shutdown token/source check itself.
    const rejected = await app.request(ROUTES.shutdown, { method: "POST" });
    expect(rejected.status).toBe(403);
    expect(shutdowns).toBe(0);

    const trayAccepted = await app.request(ROUTES.shutdown, {
      method: "POST",
      headers: { "x-devwebui-shutdown-token": "secret" },
    });
    expect(trayAccepted.status).toBe(200);
    expect(await trayAccepted.json()).toEqual({ ok: true });
    expect(shutdowns).toBe(1);

    const uiAccepted = await app.request(ROUTES.shutdown, {
      method: "POST",
      headers: { "x-devwebui-shutdown-source": "ui" },
    });
    expect(uiAccepted.status).toBe(200);
    expect(await uiAccepted.json()).toEqual({ ok: true });
    expect(shutdowns).toBe(2);
  } finally {
    manager.dispose();
  }
});

test("mutating routes reject a foreign Origin before the handler runs (CSRF)", async () => {
  const manager = new Manager();
  manager.monitorResources = false;
  manager.applyMonitorResources();
  let shutdowns = 0;
  const app = createApp(manager, {
    shutdownToken: "secret",
    requestShutdown: () => {
      shutdowns += 1;
    },
    port: 4000,
  });

  try {
    // (i) A foreign Origin is 403'd even though the request otherwise carries valid
    // shutdown credentials — proves the Origin gate runs BEFORE the handler, not just
    // that the handler itself would have rejected it.
    const foreign = await app.request(ROUTES.shutdown, {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "x-devwebui-shutdown-source": "ui",
      },
    });
    expect(foreign.status).toBe(403);
    expect(shutdowns).toBe(0);

    // (ii) No Origin header at all (CLI/MCP/tray, curl) — the gate doesn't apply; the
    // request proceeds to the handler and succeeds on its own merits.
    const noOrigin = await app.request(ROUTES.shutdown, {
      method: "POST",
      headers: { "x-devwebui-shutdown-source": "ui" },
    });
    expect(noOrigin.status).toBe(200);
    expect(shutdowns).toBe(1);

    // (iii) An allowed Origin (the daemon's own bound port) still works.
    const allowed = await app.request(ROUTES.shutdown, {
      method: "POST",
      headers: {
        origin: "http://localhost:4000",
        "x-devwebui-shutdown-source": "ui",
      },
    });
    expect(allowed.status).toBe(200);
    expect(shutdowns).toBe(2);
  } finally {
    manager.dispose();
  }
});

test("a GET route is guarded too: a foreign Origin is refused, an absent one still passes", async () => {
  const manager = new Manager();
  manager.monitorResources = false;
  manager.applyMonitorResources();
  const app = createApp(manager, {});

  try {
    // (i) The old hand-rolled gate exempted GET, which left cross-site read-exfil open (a
    // malicious page could fetch local data straight out of the daemon). The shared kit
    // guard covers every /api/* verb, so a foreign Origin is refused on a read as well.
    const foreign = await app.request(ROUTES.health, {
      headers: { origin: "https://evil.example" },
    });
    expect(foreign.status).toBe(403);

    // (ii) A GET with no Origin at all (the tray's health probe, curl, MCP) is still served:
    // closing the read hole must not break the same-machine tools that poll this route.
    const noOrigin = await app.request(ROUTES.health);
    expect(noOrigin.status).toBe(200);
  } finally {
    manager.dispose();
  }
});

// Pins the port proxy (server/src/http/port-proxy.ts) at the createApp seam: a request whose Host
// is `<target>.localhost` must reach the managed process's own port (even on an /api/* path the
// daemon also serves), a cross-site one must be refused by the shared CSRF guard, an unmanaged
// port must not be relayed, and `/proxy/<target>/...` must hand off to the subdomain form.
import "./isolate"; // CWD-proof data-dir isolation - must load before any server/src import
import { afterAll, expect, test } from "bun:test";
import { createApp } from "../server/src/http";
import { Manager } from "../server/src/manager";
import type { LoadedProject } from "../server/src/types";

// A stand-in dev server that echoes what it received, so the test sees what the proxy forwarded.
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    return Response.json({
      path: url.pathname,
      search: url.search,
      host: req.headers.get("host"),
      forwardedHost: req.headers.get("x-forwarded-host"),
    });
  },
});

// A second stand-in bound to [::1] only, as Vite on its default `localhost` host often is under
// Node 17+. Null where the machine has no IPv6 loopback; its test is skipped there.
const upstreamV6 = (() => {
  try {
    return Bun.serve({ hostname: "::1", port: 0, fetch: () => Response.json({ family: "v6" }) });
  } catch {
    return null;
  }
})();

const manager = new Manager();
manager.monitorResources = false;
manager.applyMonitorResources();
const project: LoadedProject = {
  id: "proxyproj",
  name: "Proxy Proj",
  path: `${import.meta.dir}\\proxyproj.devwebui`,
  dir: import.meta.dir,
  processes: [
    {
      id: "proxyproj.web",
      localId: "web",
      name: "web",
      command: "echo never-started",
      cwd: import.meta.dir,
      autostart: false,
      projectName: "Proxy Proj",
      projectId: "proxyproj",
      port: upstream.port,
    },
    {
      id: "proxyproj.v6",
      localId: "v6",
      name: "v6",
      command: "echo never-started",
      cwd: import.meta.dir,
      autostart: false,
      projectName: "Proxy Proj",
      projectId: "proxyproj",
      port: upstreamV6?.port,
    },
  ],
};
manager.addProject(project, { autostart: false });
const app = createApp(manager, { port: 4000 });

afterAll(() => {
  upstream.stop(true);
  upstreamV6?.stop(true);
  manager.dispose();
});

test("a <process>.localhost request is forwarded to that process's port, /api/* included", async () => {
  const res = await app.request("http://proxyproj.web.localhost:4000/api/health?x=1");
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, string>;
  expect(body.path).toBe("/api/health");
  expect(body.search).toBe("?x=1");
  expect(body.host).toBe(`localhost:${upstream.port}`);
  expect(body.forwardedHost).toBe("proxyproj.web.localhost:4000");
});

test("a project's slugged name and a declared port both resolve to the same process", async () => {
  for (const host of ["proxy-proj.localhost:4000", `${upstream.port}.localhost:4000`]) {
    const res = await app.request(`http://${host}/page`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { path: string }).path).toBe("/page");
  }
});

test("cross-site requests are refused: a confirm page for a browser load, 403 JSON otherwise", async () => {
  const page = await app.request("http://proxyproj.web.localhost:4000/", {
    headers: { "sec-fetch-site": "cross-site", accept: "text/html" },
  });
  expect(page.status).toBe(403);
  expect(await page.text()).toContain('href="/"');
  expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");

  const post = await app.request("http://proxyproj.web.localhost:4000/api/delete", {
    method: "POST",
    headers: { origin: "https://evil.example" },
  });
  expect(post.status).toBe(403);
});

test("a port no managed process declares is not relayed", async () => {
  const res = await app.request("http://4000.localhost:4000/");
  expect(res.status).toBe(404);
  // The proxy's own refusal, not a web-asset 404 that would pass with the proxy gone.
  expect(((await res.json()) as { error: string }).error).toContain("no managed process");
});

test.skipIf(!upstreamV6)("a dev server listening on [::1] only is still reached", async () => {
  const res = await app.request("http://proxyproj.v6.localhost:4000/");
  expect(res.status).toBe(200);
  expect(((await res.json()) as { family: string }).family).toBe("v6");
});

test("/proxy/<target>/... redirects to the subdomain form, keeping path and query", async () => {
  const res = await app.request("http://localhost:4000/proxy/proxyproj.web/app/page?q=2");
  expect(res.status).toBe(307);
  expect(res.headers.get("location")).toBe("http://proxyproj.web.localhost:4000/app/page?q=2");
  const unknown = await app.request("http://localhost:4000/proxy/nope/");
  expect(unknown.status).toBe(404);
});

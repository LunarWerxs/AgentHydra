// Pins the two promises the <RUNTIME_SERVICES> block makes to an agent: every URL is one it can
// reach from this machine (absolute url verbatim, /path joined to localhost:<port>, the daemon
// at the origin it was called on), and a credential env var shows up by NAME only, never value.
import { expect, test } from "bun:test";
import { agentUrl, buildRuntimeServicesInfo } from "../server/src/runtime-services";
import type { ProcessView } from "../server/src/types";

function proc(over: Partial<ProcessView>): ProcessView {
  return {
    id: "p1.web",
    localId: "web",
    name: "Web",
    command: "bun run dev",
    cwd: "/repo",
    enabled: true,
    projectId: "p1",
    projectName: "Repo",
    status: "running",
    pid: 4242,
    startedAt: 1,
    restarts: 0,
    exitCode: null,
    cpu: null,
    memory: null,
    conflict: false,
    ...over,
  };
}

test("agentUrl: absolute url verbatim, /path joined to localhost:<port>, bare port, none", () => {
  expect(agentUrl({ port: 5173, url: "https://app.example.test/x" })).toBe(
    "https://app.example.test/x",
  );
  expect(agentUrl({ port: 5173, url: "/admin" })).toBe("http://localhost:5173/admin");
  expect(agentUrl({ port: 5173 })).toBe("http://localhost:5173");
  expect(agentUrl({})).toBeUndefined();
});

test("block lists the daemon with its health URL and a credential env var by name only", () => {
  const secretValue = "sk-should-never-appear";
  const info = buildRuntimeServicesInfo(
    [proc({ port: 5173 })],
    () => ({ OPENAI_API_KEY: secretValue, PORT: "5173" }),
    "http://127.0.0.1:4000",
  );
  expect(info.services[0]).toMatchObject({
    id: "devwebui",
    url: "http://127.0.0.1:4000",
    healthUrl: "http://127.0.0.1:4000/api/health",
  });
  expect(info.services[1]).toMatchObject({
    id: "p1.web",
    url: "http://localhost:5173",
    authEnv: ["OPENAI_API_KEY"],
  });
  expect(info.block.startsWith("<RUNTIME_SERVICES>\n")).toBe(true);
  expect(info.block.endsWith("\n</RUNTIME_SERVICES>")).toBe(true);
  expect(info.block).toContain("auth env: OPENAI_API_KEY");
  expect(JSON.stringify(info)).not.toContain(secretValue);
});

test("stopped processes are left out unless includeStopped is set", () => {
  const procs = [proc({}), proc({ id: "p1.worker", status: "stopped", pid: null })];
  const ids = (all: boolean) =>
    buildRuntimeServicesInfo(procs, () => undefined, "http://localhost:4000", all).services.map(
      (s) => s.id,
    );
  expect(ids(false)).toEqual(["devwebui", "p1.web"]);
  expect(ids(true)).toEqual(["devwebui", "p1.web", "p1.worker"]);
});

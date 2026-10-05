#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const binary = resolve(
  process.argv[2] ?? join("dist", process.platform === "win32" ? "devwebui.exe" : "devwebui"),
);
if (!existsSync(binary)) throw new Error(`release smoke: missing executable at ${binary}`);

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", ok);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("release smoke: no free port");
  await new Promise<void>((ok) => server.close(() => ok()));
  return address.port;
}

const scratch = mkdtempSync(join(tmpdir(), "devwebui-release-smoke-"));
process.on("exit", () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {}
});

let child: any = undefined;
try {
  mkdirSync(join(scratch, "cwd"));
  const port = await freePort();
  child = Bun.spawn([binary], {
    cwd: join(scratch, "cwd"),
    env: {
      ...process.env,
      DEVWEBUI_HOME: join(scratch, "state"),
      DEVWEBUI_PORT: String(port),
      DEVWEBUI_NO_OPEN: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const deadline = Date.now() + 30_000;
  let health: Response | null = null;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      health = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (health.ok) break;
    } catch {}
    await Bun.sleep(200);
  }
  if (!health?.ok) throw new Error(`${basename(binary)} did not serve /api/health`);
  const home = await fetch(`http://127.0.0.1:${port}/`);
  const html = await home.text();
  if (!home.ok || !/<(?:html|!doctype html)/i.test(html)) {
    throw new Error(`release smoke: root was not the embedded UI (${home.status})`);
  }
  const assetPath = html.match(/(?:src|href)=["'](\/assets\/[^"'?#]+)["']/i)?.[1];
  if (!assetPath) throw new Error("release smoke: HTML did not reference a built asset");
  const asset = await fetch(`http://127.0.0.1:${port}${assetPath}`);
  if (!asset.ok || (await asset.arrayBuffer()).byteLength === 0) {
    throw new Error(`release smoke: embedded asset failed: ${assetPath}`);
  }
  console.log(`✓ release executable served health, UI, and ${assetPath}`);
} finally {
  if (child) {
    child.kill();
    await Promise.race([child.exited, Bun.sleep(5_000)]);
  }
  await removeScratch(scratch);
}

/** Windows keeps the folder busy for a moment after the executable exits (EBUSY / EPERM), and
 *  longer on a loaded box: retry the removal instead of failing a smoke run that passed. */
async function removeScratch(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 40 || (code !== "EBUSY" && code !== "EPERM")) throw e;
      await Bun.sleep(250);
    }
  }
}

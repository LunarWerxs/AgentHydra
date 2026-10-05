import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { detectProject } from "../server/src/detect";

async function withPackageJson(
  pkg: Record<string, unknown>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "devwebui-detect-"));
  try {
    await writeFile(path.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test.each([
  [
    "a Next.js dev server",
    { dev: "next dev" },
    "Next.js",
    { id: "dev", name: "Dev", command: "npm run dev", port: 3000 },
  ],
  [
    "a React scripts server with the CRA default port",
    { start: "react-scripts start" },
    "React",
    { id: "start", name: "Start", command: "npm run start", port: 3000 },
  ],
  [
    "a Webpack dev server and honors explicit ports",
    { dev: "webpack serve --mode development --port 8081" },
    "Webpack",
    { id: "dev", name: "Dev", command: "npm run dev", port: 8081 },
  ],
])("detectProject scaffolds %s", async (_name, scripts, framework, process) => {
  await withPackageJson({ name: "site", scripts }, async (dir) => {
    const detected = await detectProject(dir);
    expect(detected?.framework).toBe(framework);
    expect(detected?.processes).toMatchObject([process]);
  });
});

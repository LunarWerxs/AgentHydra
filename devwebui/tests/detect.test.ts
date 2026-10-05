import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

// Claude Code Desktop keeps a folder's preview servers in .claude/launch.json (JSON with comments):
// https://code.claude.com/docs/en/desktop#configure-preview-servers
async function withFiles(
  files: Record<string, string>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "devwebui-launch-"));
  try {
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), text);
    }
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("detectProject reads Claude Code's .claude/launch.json when there is no package.json", async () => {
  const launch = `{
  // the preview servers
  "version": "0.0.1",
  "configurations": [
    {
      "name": "frontend",
      "runtimeExecutable": "npm",
      "runtimeArgs": ["run", "dev", "--", "--host", "my host"],
      "cwd": "\${workspaceFolder}/apps/web",
      "port": 3001,
      "env": { "NODE_ENV": "development" },
    },
    { "name": "api", "program": "server.js", "args": ["--verbose"], "port": 4000 },
    { "name": "default port", "runtimeExecutable": "yarn", "runtimeArgs": ["dev"] },
    { "name": "attached", "url": "https://app.localhost:3000" },
  ],
}`;
  await withFiles({ ".claude/launch.json": launch }, async (dir) => {
    const detected = await detectProject(dir);
    expect(detected?.name).toBe(titleOf(path.basename(dir)));
    expect(detected?.processes).toEqual([
      {
        id: "frontend",
        name: "frontend",
        command: 'npm run dev -- --host "my host"',
        cwd: "apps/web",
        port: 3001,
        env: { NODE_ENV: "development" },
        color: expect.any(String),
      },
      {
        id: "api",
        name: "api",
        command: "node server.js --verbose",
        port: 4000,
        color: expect.any(String),
      },
      {
        id: "default-port",
        name: "default port",
        command: "yarn dev",
        port: 3000,
        color: expect.any(String),
      },
    ]);
  });
});

test("detectProject takes .claude/launch.json over package.json scripts, and keeps a url", async () => {
  const launch = JSON.stringify({
    version: "0.0.1",
    configurations: [
      {
        name: "web",
        runtimeExecutable: "bun",
        runtimeArgs: ["run", "dev"],
        port: 8443,
        url: "https://localhost:8443",
      },
    ],
  });
  await withFiles(
    {
      "package.json": JSON.stringify({ name: "@acme/site", scripts: { dev: "vite" } }),
      ".claude/launch.json": launch,
    },
    async (dir) => {
      const detected = await detectProject(dir);
      expect(detected?.name).toBe("Site");
      expect(detected?.processes).toMatchObject([
        { id: "web", command: "bun run dev", port: 8443, url: "https://localhost:8443" },
      ]);
    },
  );
});

test("detectProject falls back to package.json when .claude/launch.json has nothing it can run", async () => {
  const launch =
    '{ "configurations": [{ "name": "attached", "url": "http://localhost:3000" }] } trailing junk';
  await withFiles(
    {
      "package.json": JSON.stringify({ name: "site", scripts: { dev: "next dev" } }),
      ".claude/launch.json": launch,
    },
    async (dir) => {
      expect((await detectProject(dir))?.processes).toMatchObject([
        { id: "dev", command: "npm run dev" },
      ]);
    },
  );
});

const titleOf = (s: string) =>
  s
    .replace(/[-_:]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());

#!/usr/bin/env bun
/**
 * Build a distributable DevWebUI executable into `dist/`:
 *   dist/devwebui[.exe] — the compiled daemon + embedded GUI
 *
 * Mirrors the same build script pattern used by sibling LunarWerx daemons. DevWebUI has no
 * native-FFI deps, so nothing is kept `--external` and there's no vendored binary to copy —
 * a clean single-file compile.
 * Run: `bun run scripts/build.ts`  (or `bun run dist`)
 */
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import pkg from "../package.json";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const TMP = join(ROOT, "tmp", "release-build");
const isWin = process.platform === "win32";
const outBin = join(DIST, isWin ? "devwebui.exe" : "devwebui");

function setWindowsGuiSubsystem(path: string): void {
  const image = readFileSync(path);
  if (image.length < 256 || image[0] !== 0x4d || image[1] !== 0x5a) {
    throw new Error("compiled Windows executable has no valid MZ header");
  }
  const pe = image.readInt32LE(0x3c);
  if (pe < 0 || pe + 94 >= image.length || image.readUInt32LE(pe) !== 0x0000_4550) {
    throw new Error("compiled Windows executable has no valid PE header");
  }
  // Bun 1.3.14's hide-console flag does not change the PE loader subsystem, so Windows can
  // create a console before Bun hides it. Stamp IMAGE_SUBSYSTEM_WINDOWS_GUI explicitly.
  image.writeUInt16LE(2, pe + 92);
  image.writeUInt32LE(0, pe + 88);
  writeFileSync(path, image);
  if (readFileSync(path).readUInt16LE(pe + 92) !== 2) {
    throw new Error("failed to stamp Windows GUI subsystem");
  }
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else if (entry.isFile()) out.push(path);
  }
  return out.sort();
}

function importPath(fromFile: string, target: string): string {
  const rel = relative(dirname(fromFile), target).replaceAll("\\", "/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function writeReleaseEntrypoint(): string {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const entry = join(TMP, "entry.ts");
  const webRoot = join(ROOT, "web", "dist");
  const files = filesUnder(webRoot);
  const imports = files.map(
    (file, index) =>
      `import asset${index} from ${JSON.stringify(importPath(entry, file))} with { type: "file" };`,
  );
  const routes = files.map((file, index) => [
    `/${relative(webRoot, file).replaceAll("\\", "/")}`,
    `asset${index}`,
  ]);

  // Windows-only: embed the tray toolkit (host exe + config + icon) beside the web assets, the
  // same way, so a compiled release exe can actually show a tray icon — see
  // server/src/tray-bootstrap.d.mts (materializeTrayToolkit reads __DEVWEBUI_EMBEDDED_TRAY__).
  // Every kit app had instead shipped a compiled exe that could never show its icon, with each
  // README noting that down as a limitation (found live 2026-09-11) — so a toolkit file missing
  // from misc\ fails the build now instead of silently shipping that same bug again.
  const trayNames = ["lunarwerx-tray.exe", "DevWebUI-Tray.json", "DevWebUI.ico"];
  const trayImports: string[] = [];
  const trayRoutes: string[] = [];
  if (isWin) {
    trayNames.forEach((name, index) => {
      const src = join(ROOT, "misc", name);
      if (!existsSync(src)) {
        throw new Error(
          `missing tray toolkit file: ${src} — a build without the tray toolkit ships an app that can never show its icon`,
        );
      }
      trayImports.push(
        `import tray${index} from ${JSON.stringify(importPath(entry, src))} with { type: "file" };`,
      );
      trayRoutes.push(`  ${JSON.stringify(name)}: tray${index},`);
    });
  }
  const trayBlock = trayRoutes.length
    ? `(globalThis as { __DEVWEBUI_EMBEDDED_TRAY__?: Readonly<Record<string, string>> })
  .__DEVWEBUI_EMBEDDED_TRAY__ = Object.freeze({
${trayRoutes.join("\n")}
});
`
    : "";

  writeFileSync(
    entry,
    `${imports.join("\n")}
${trayImports.join("\n")}

(globalThis as { __DEVWEBUI_EMBEDDED_WEB__?: Readonly<Record<string, string>> })
  .__DEVWEBUI_EMBEDDED_WEB__ = Object.freeze({
${routes.map(([route, asset]) => `  ${JSON.stringify(route)}: ${asset},`).join("\n")}
});
${trayBlock}(globalThis as { __DEVWEBUI_RELEASE_BUILD__?: boolean }).__DEVWEBUI_RELEASE_BUILD__ = true;
await import(${JSON.stringify(importPath(entry, join(ROOT, "server", "src", "index.ts")))});
`,
  );
  return entry;
}

console.log("→ clean dist/");
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

console.log("→ build web (check:i18n + vue-tsc + vite)");
await $`bun run --cwd ${join(ROOT, "web")} build`;

console.log("→ compile daemon + embedded web app (bun --compile)");
const releaseEntry = writeReleaseEntrypoint();
try {
  if (isWin) {
    await $`bun build --compile --minify --windows-hide-console --windows-icon=${join(ROOT, "misc", "DevWebUI.ico")} --windows-title=DevWebUI --windows-publisher=LunarWerx --windows-version=${`${pkg.version}.0`} --windows-description=${"Local development server manager"} ${releaseEntry} --outfile ${outBin}`;
  } else {
    await $`bun build --compile --minify ${releaseEntry} --outfile ${outBin}`;
  }
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
if (isWin) setWindowsGuiSubsystem(outBin);

console.log(`\n✓ Built ${outBin}`);
console.log(`  Run it:  ${isWin ? "dist\\devwebui.exe" : "./dist/devwebui"}`);

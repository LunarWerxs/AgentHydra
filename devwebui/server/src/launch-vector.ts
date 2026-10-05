import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The argv vector that re-launches THIS build of DevWebUI.
 *
 * Two shapes exist and callers must not care which one they got:
 *   • repo checkout      → `[<bun.exe>, <repo>/server/src/index.ts]`
 *   • compiled binary    → `[<dist/devwebui.exe>]`  (`bun build --compile`, scripts/build.ts)
 *
 * Anything that needs to spawn "me, again" (the CLI's daemon boot, a desktop
 * shortcut's launcher) builds on this instead of hardcoding `bun index.ts`, which
 * simply does not exist on a machine that only has the portable exe.
 *
 * The compiled-vs-checkout test is `existsSync(index.ts)` rather than sniffing
 * `process.execPath`'s name: inside a `bun --compile` binary this module's own
 * `import.meta.url` resolves into Bun's virtual filesystem (`/$bunfs/…`), so the
 * sibling `index.ts` is genuinely absent — including when the exe happens to be
 * run from inside a checkout, where an execPath/argv-based guess would be wrong.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_TS = path.resolve(HERE, "index.ts");

/** True when running as the compiled single-file binary rather than from a checkout. */
export function isCompiledBinary(): boolean {
  return !existsSync(INDEX_TS);
}

/** `[exe, ...args]` that boots this build's daemon when spawned with no further arguments. */
export function daemonLaunchVector(): string[] {
  return isCompiledBinary() ? [process.execPath] : [process.execPath, INDEX_TS];
}

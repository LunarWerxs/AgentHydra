// Open a logged error's `file:line:col` in the editor the developer already has running, so a
// stack frame in the error log is a jump target instead of text to retype. The approach (find
// the editor from the process list, speak each editor's own line/column flag, refuse bad input
// before spawning) follows create-react-app's react-dev-utils/launchEditor.js (MIT); the code
// is written fresh for DevWebUI. Two deliberate departures from it:
//  · the Windows process scan is Get-CimInstance Win32_Process, not the retired wmic;
//  · the launch goes through buildDetachedSpawn (WMI Win32_Process.Create on Windows), never
//    `cmd.exe /C`, so no cmd re-parse exists for a crafted file name to exploit, and an editor
//    started here outlives a daemon restart instead of being tree-killed with it.
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { buildDetachedSpawn } from "./detached-spawn.mjs";
import { collectStdout } from "./spawn-capture";
import { frameFilePath } from "../../shared/source-frames";
import type { OpenInEditorResult } from "../../shared/dto";

/** The line/column dialects the launcher speaks. Anything else is opened on the file alone. */
export type EditorKind = "vscode" | "jetbrains" | "zed" | "sublime" | "notepadpp";

// Executable name (lowercased, extension dropped) -> dialect. Listed in PREFERENCE order: when
// several are running, the first kind here wins, so the choice never depends on process order.
const EDITORS: [string, EditorKind][] = [
  ["code", "vscode"],
  ["code - insiders", "vscode"],
  ["code-insiders", "vscode"],
  ["cursor", "vscode"],
  ["windsurf", "vscode"],
  ["codium", "vscode"],
  ["vscodium", "vscode"],
  ...["idea", "webstorm", "phpstorm", "pycharm", "rider", "goland", "rubymine", "clion"].flatMap(
    (n): [string, EditorKind][] => [
      [n, "jetbrains"],
      [`${n}64`, "jetbrains"],
    ],
  ),
  ["zed", "zed"],
  ["sublime_text", "sublime"],
  ["subl", "sublime"],
  ["notepad++", "notepadpp"],
];
const KIND_BY_NAME = new Map(EDITORS);

// On macOS `ps` shows the app bundle's inner binary (VS Code's is `Electron`), which does not
// take the CLI flags; the command-line launcher lives elsewhere in the same bundle.
const MAC_LAUNCHERS: Record<string, string> = {
  "Visual Studio Code.app": "Contents/Resources/app/bin/code",
  "Visual Studio Code - Insiders.app": "Contents/Resources/app/bin/code-insiders",
  "Cursor.app": "Contents/Resources/app/bin/cursor",
  "Windsurf.app": "Contents/Resources/app/bin/windsurf",
  "VSCodium.app": "Contents/Resources/app/bin/codium",
  "Sublime Text.app": "Contents/SharedSupport/bin/subl",
  "Zed.app": "Contents/MacOS/cli",
};

/** `C:\x\Code.exe` -> `code`: the name the dialect table is keyed on, on any host OS. */
function editorName(p: string): string {
  const base = p.split(/[\\/]/).pop() ?? "";
  return base.toLowerCase().replace(/\.(?:exe|cmd|bat|sh)$/, "");
}

/** Which line/column dialect an editor executable speaks, or null when it is not one we know. */
export function editorKind(editorPath: string): EditorKind | null {
  return KIND_BY_NAME.get(editorName(editorPath)) ?? null;
}

/** The argv (after the executable) that opens `file` at `line`/`column` in that editor. */
export function editorArgs(editorPath: string, file: string, line: number, column = 1): string[] {
  switch (editorKind(editorPath)) {
    case "vscode":
      return ["-g", `${file}:${line}:${column}`];
    case "jetbrains":
      return ["--line", String(line), "--column", String(column), file];
    case "zed":
    case "sublime":
      return [`${file}:${line}:${column}`];
    case "notepadpp":
      return [`-n${line}`, `-c${column}`, file];
    default:
      return [file];
  }
}

const KIND_RANK: EditorKind[] = ["vscode", "jetbrains", "zed", "sublime", "notepadpp"];

/**
 * From a process listing (one executable path or name per line), the editor to launch: the
 * most-preferred known editor, mapped to its CLI launcher on macOS. Null when none is running.
 */
export function pickEditor(lines: string[], platform: NodeJS.Platform): string | null {
  let best: { path: string; rank: number } | null = null;
  for (const raw of lines) {
    let p = raw.trim();
    if (!p) continue;
    if (platform === "darwin") {
      const bundle = /^(.*?\/([^/]+\.app))\/Contents\//.exec(p);
      const launcher = bundle?.[2] ? MAC_LAUNCHERS[bundle[2]] : undefined;
      if (bundle?.[1] && launcher) p = `${bundle[1]}/${launcher}`;
    }
    const kind = editorKind(p);
    if (!kind) continue;
    const rank = KIND_RANK.indexOf(kind);
    if (!best || rank < best.rank) best = { path: p, rank };
  }
  return best?.path ?? null;
}

/** List running processes' executables (paths where the OS gives them) for {@link pickEditor}. */
async function runningExecutables(platform: NodeJS.Platform): Promise<string[]> {
  const out =
    platform === "win32"
      ? await collectStdout(
          "powershell",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance -ClassName Win32_Process | ForEach-Object { $_.ExecutablePath }",
          ],
          { timeoutMs: 8000 },
        )
      : await collectStdout("ps", ["x", "-o", "comm="]);
  return out.split(/\r?\n/);
}

/** Windows only launches a real `.exe` detached (see detached-spawn.mjs); find one for `name`. */
function findWindowsExe(name: string, env: NodeJS.ProcessEnv): string | null {
  if (/\.(?:cmd|bat)$/i.test(name)) return null;
  const withExt = /\.exe$/i.test(name) ? name : `${name}.exe`;
  if (path.win32.isAbsolute(withExt)) return existsSync(withExt) ? withExt : null;
  for (const dir of (env.PATH ?? env.Path ?? "").split(";").filter(Boolean)) {
    const candidate = path.win32.join(dir, withExt);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The editor to use: DEVWEBUI_EDITOR when set (the user's explicit choice, any editor), else
 * the running editor found in the process list, else VISUAL / EDITOR when that names a GUI
 * editor we know (a terminal editor like vim has no terminal to open in from here).
 */
async function resolveEditor(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<{ editor: string } | Extract<OpenInEditorResult, { ok: false }>> {
  const explicit = env.DEVWEBUI_EDITOR?.trim();
  if (explicit) {
    if (platform !== "win32") return { editor: explicit };
    const exe = findWindowsExe(explicit, env);
    return exe
      ? { editor: exe }
      : {
          ok: false,
          reason: "unsupported-editor",
          detail:
            "DEVWEBUI_EDITOR must name the editor's .exe (a .cmd/.bat shim cannot be launched)",
        };
  }
  const running = pickEditor(await runningExecutables(platform), platform);
  if (running) return { editor: running };
  for (const v of [env.VISUAL, env.EDITOR]) {
    const named = v?.trim();
    if (!named || !editorKind(named)) continue;
    const editor = platform === "win32" ? findWindowsExe(named, env) : named;
    if (editor) return { editor };
  }
  return {
    ok: false,
    reason: "no-editor",
    detail: "no running editor found; open one or set DEVWEBUI_EDITOR",
  };
}

export interface OpenRequest {
  file: string;
  line: number;
  column: number;
}

/**
 * Validate and resolve an open request before anything is spawned. `line` / `column` must be
 * positive integers (they are spliced into editor arguments), the path may not carry control
 * characters, a UNC `\\host\share` path is refused (opening one makes Windows authenticate to
 * that host), and a relative path needs the process's cwd to resolve against.
 */
export function validateOpenRequest(
  body: { file?: unknown; line?: unknown; column?: unknown },
  cwd?: string,
): { ok: true; req: OpenRequest } | Extract<OpenInEditorResult, { ok: false }> {
  const bad = (detail: string) => ({ ok: false as const, reason: "bad-input" as const, detail });
  const { line, column } = body;
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1)
    return bad("line must be a positive integer");
  if (
    column !== undefined &&
    (typeof column !== "number" || !Number.isInteger(column) || column < 1)
  )
    return bad("column must be a positive integer");
  if (typeof body.file !== "string" || !body.file.trim() || body.file.length > 4096)
    return bad("file must be a non-empty path");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u001f]/.test(body.file)) return bad("file contains control characters");
  const raw = frameFilePath(body.file.trim());
  if (/^[\\/]{2}/.test(raw)) return bad("network (UNC) paths are not opened");
  const absolute = path.isAbsolute(raw) || path.win32.isAbsolute(raw);
  if (!absolute && !cwd) return bad("a relative path needs the processId it was logged by");
  const file = absolute ? path.resolve(raw) : path.resolve(cwd as string, raw);
  return { ok: true, req: { file, line, column: (column as number | undefined) ?? 1 } };
}

/**
 * Spawn the editor outside the daemon's process tree; resolves false when it cannot start.
 * On Windows the spawned process is detached-spawn's powershell wrapper, which always exits 0,
 * so 'spawn' only proves powershell started: a missing or refused editor is not reported as
 * launch-failed there. The wrapper's Start-Process fallback (used only when WMI refuses) also
 * passes `-WindowStyle Hidden`, which can keep a not-yet-running GUI editor's window hidden.
 */
function launch(editor: string, args: string[]): Promise<boolean> {
  const plan = buildDetachedSpawn(process.platform, [editor, ...args]);
  return new Promise((resolve) => {
    try {
      const child = spawn(plan.argv[0] as string, plan.argv.slice(1), {
        detached: plan.detached,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", () => resolve(false));
      child.once("spawn", () => resolve(true));
      child.unref();
    } catch {
      resolve(false);
    }
  });
}

/** Open `body.file` at its line/column in the developer's editor. Never throws. */
export async function openInEditor(
  body: { file?: unknown; line?: unknown; column?: unknown },
  cwd?: string,
): Promise<OpenInEditorResult> {
  const checked = validateOpenRequest(body, cwd);
  if (!checked.ok) return checked;
  const { file, line, column } = checked.req;
  try {
    if (!statSync(file).isFile()) return { ok: false, reason: "not-found", detail: file };
  } catch {
    return { ok: false, reason: "not-found", detail: file };
  }
  const found = await resolveEditor(process.platform, process.env);
  if (!("editor" in found)) return found;
  const started = await launch(found.editor, editorArgs(found.editor, file, line, column));
  return started
    ? { ok: true, editor: editorName(found.editor), file, line, column }
    : { ok: false, reason: "launch-failed", detail: found.editor };
}

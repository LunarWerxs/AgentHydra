import { spawn } from "node:child_process";
import treeKill from "tree-kill";

// ---------------------------------------------------------------------------
// Native "Browse…" file picker — the daemon runs locally, so it can pop the
// real OS open-file dialog and hand back the chosen absolute path.
// ---------------------------------------------------------------------------
interface RunOpts {
  timeoutMs?: number; // hard cap so an abandoned dialog can't pin the request forever
  signal?: AbortSignal; // kill the picker when the requesting client disconnects
  maxBytes?: number; // bound captured stdout
}

/** SIGKILL a child's whole process tree (best-effort). */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    treeKill(pid, "SIGKILL", () => {});
  } catch {
    /* ignore */
  }
}

function run(cmd: string, args: string[], opts: RunOpts = {}): Promise<string> {
  const { timeoutMs = 180_000, signal, maxBytes = 1 << 20 } = opts;
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    let child: ReturnType<typeof spawn> | null = null;
    let onAbort: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (v: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      killTree(child?.pid); // close the native dialog if it's still up
      resolve(v);
    };
    timer = setTimeout(() => finish(""), timeoutMs);
    if (signal) {
      if (signal.aborted) return finish("");
      onAbort = () => finish("");
      signal.addEventListener("abort", onAbort);
    }
    try {
      child = spawn(cmd, args, { windowsHide: true });
      child.stdout?.on("data", (d: Buffer) => {
        if (out.length < maxBytes) out += d.toString();
      });
      child.on("close", () => finish(out.trim()));
      child.on("error", () => finish(""));
    } catch {
      finish("");
    }
  });
}

export function browseForDevWebUIFile(signal?: AbortSignal): Promise<string | null> {
  if (process.platform === "win32") return browseWindows(signal);
  if (process.platform === "darwin") return browseMac(signal);
  return browseLinux(signal);
}

async function browseWindows(signal?: AbortSignal): Promise<string | null> {
  const ps = [
    "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
    "$d = New-Object System.Windows.Forms.OpenFileDialog",
    "$d.Filter = 'DevWebUI files|.devwebui;*.devwebui|All files (*.*)|*.*'",
    "$d.Title = 'Select a .devwebui file'",
    "$t = New-Object System.Windows.Forms.Form; $t.TopMost = $true",
    "if ($d.ShowDialog($t) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }",
  ].join("; ");
  const out = await run("powershell", ["-NoProfile", "-STA", "-Command", ps], { signal });
  return out || null;
}

async function browseMac(signal?: AbortSignal): Promise<string | null> {
  const out = await run(
    "osascript",
    ["-e", 'POSIX path of (choose file with prompt "Select a .devwebui file")'],
    { signal },
  );
  return out || null;
}

async function browseLinux(signal?: AbortSignal): Promise<string | null> {
  const out = await run("zenity", ["--file-selection", "--title=Select a .devwebui file"], {
    signal,
  });
  return out || null;
}

// ---------------------------------------------------------------------------
// Native "Choose folder" picker — used to pick a destination for git clones.
// ---------------------------------------------------------------------------
export function browseForFolder(signal?: AbortSignal): Promise<string | null> {
  if (process.platform === "win32") return browseFolderWindows(signal);
  if (process.platform === "darwin") return browseFolderMac(signal);
  return browseFolderLinux(signal);
}

async function browseFolderWindows(signal?: AbortSignal): Promise<string | null> {
  const ps = [
    "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
    "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$d.Description = 'Choose a destination folder'",
    "$t = New-Object System.Windows.Forms.Form; $t.TopMost = $true",
    "if ($d.ShowDialog($t) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
  ].join("; ");
  const out = await run("powershell", ["-NoProfile", "-STA", "-Command", ps], { signal });
  return out || null;
}

async function browseFolderMac(signal?: AbortSignal): Promise<string | null> {
  const out = await run(
    "osascript",
    ["-e", 'POSIX path of (choose folder with prompt "Choose a destination folder")'],
    { signal },
  );
  return out || null;
}

async function browseFolderLinux(signal?: AbortSignal): Promise<string | null> {
  const out = await run(
    "zenity",
    ["--file-selection", "--directory", "--title=Choose a destination folder"],
    { signal },
  );
  return out || null;
}

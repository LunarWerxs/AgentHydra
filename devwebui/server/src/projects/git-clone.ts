import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { killTree } from "./native-dialogs";
import { fileUrlToLocalPath } from "./load-target";

// ---------------------------------------------------------------------------
// Git clone — fetch a remote repo, then load any .devwebui inside it.
// ---------------------------------------------------------------------------
const GIT_URL_RE = /^(https?:\/\/|git@[^:\s]+:|ssh:\/\/|git:\/\/)/i;

export function looksLikeGitUrl(s: string): boolean {
  // Require a real scheme or scp-style host. A bare ".git" suffix is NOT enough,
  // so local paths like C:\repos\thing.git still load as folders, not clones.
  return GIT_URL_RE.test((s ?? "").trim());
}

/** A sensible default place to clone into (`~/dev`); the user can change it. */
export function suggestCloneDest(): string {
  return path.join(os.homedir(), "dev");
}

function repoNameFromUrl(url: string): string {
  const cleaned = url
    .trim()
    .replace(/\.git\/?$/i, "")
    .replace(/[/\\]+$/, "");
  const last = cleaned.split(/[/:\\]/).pop() || "repo";
  return last.replace(/[^a-zA-Z0-9._-]/g, "-") || "repo";
}

const GIT_CLONE_TIMEOUT_MS = 600_000; // 10 min — generous for a big repo, but never indefinite

function execGit(
  args: string[],
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const { timeoutMs = GIT_CLONE_TIMEOUT_MS, signal } = opts;
  return new Promise((resolve, reject) => {
    let err = "";
    let done = false;
    let child: ReturnType<typeof spawn> | null = null;
    let onAbort: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout>;
    const settle = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      fn();
    };
    const fail = (e: Error) => settle(() => reject(e));
    const stop = (msg: string) => {
      killTree(child?.pid); // kill git AND its transport children (git-remote-https, etc.)
      fail(new Error(msg));
    };
    timer = setTimeout(
      () => stop(`git timed out after ${Math.round(timeoutMs / 1000)}s`),
      timeoutMs,
    );
    if (signal) {
      if (signal.aborted) return stop("clone cancelled");
      onAbort = () => stop("clone cancelled");
      signal.addEventListener("abort", onAbort);
    }
    try {
      child = spawn("git", args, { windowsHide: true });
      child.stderr?.on("data", (d: Buffer) => {
        if (err.length < 1 << 16) err += d.toString(); // bound captured stderr
      });
      child.on("error", (e) =>
        fail(
          (e as NodeJS.ErrnoException).code === "ENOENT"
            ? new Error("git was not found on PATH — install Git to clone repositories.")
            : (e as Error),
        ),
      );
      child.on("close", (code) =>
        settle(() =>
          code === 0 ? resolve() : reject(new Error(err.trim() || `git exited with code ${code}`)),
        ),
      );
    } catch (e) {
      fail(e as Error);
    }
  });
}

/** Clone `url` into `destDir/<repo>` and return the cloned repo directory. */
export async function cloneRepo(
  url: string,
  destDir: string,
  opts: { signal?: AbortSignal } = {},
): Promise<string> {
  if (!looksLikeGitUrl(url)) throw new Error("That doesn't look like a git URL.");
  const dest = fileUrlToLocalPath((destDir ?? "").trim());
  if (!dest) throw new Error("Choose a destination folder for the clone.");

  const base = path.resolve(dest);
  mkdirSync(base, { recursive: true });
  const target = path.join(base, repoNameFromUrl(url));
  const preexisting = existsSync(target);
  if (preexisting && readdirSync(target).length)
    throw new Error(`${target} already exists and isn't empty — pick another destination.`);

  try {
    await execGit(["clone", "--", url, target], opts); // "--" so a URL/path can't pose as a git flag
  } catch (e) {
    // A failed/aborted clone leaves a partial folder that would block the retry
    // ("already exists and isn't empty"). Remove what git created (but never a
    // folder that already existed before us).
    if (!preexisting)
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    throw e;
  }
  return target;
}

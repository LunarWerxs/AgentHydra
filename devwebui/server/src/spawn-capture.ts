import { spawn } from "node:child_process";

/**
 * Spawn a command, capture stdout, resolve on close (bounded by a short timeout).
 * Shared by ports.ts (port-owner lookups) and metrics.ts (process-tree fallback) —
 * both shell out to a short-lived `powershell`/`ps`/`lsof` helper and just want the
 * captured text back, dead or alive.
 */
export function collectStdout(
  cmd: string,
  args: string[],
  { timeoutMs = 5000, maxBytes = 1 << 20 }: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    let child: ReturnType<typeof spawn> | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child?.kill();
      } catch {
        /* ignore */
      }
      resolve(out);
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      child = spawn(cmd, args, { windowsHide: true });
      child.stdout?.on("data", (d: Buffer) => {
        if (out.length < maxBytes) out += d.toString();
      });
      child.on("close", () => {
        clearTimeout(timer);
        if (!done) {
          done = true;
          resolve(out);
        }
      });
      child.on("error", finish);
    } catch {
      finish();
    }
  });
}

import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { planManagedSpawn, POSIX_META, tokenize, WIN_META } from "../server/src/spawn-plan";

const isWin = process.platform === "win32";

// ── tokenize: pure, platform-independent (the meta set is the only platform input) ──────────────

test("tokenize splits a plain command into argv", () => {
  expect(tokenize("node vite.js --host 0.0.0.0 --port 4173 --strictPort", WIN_META)).toEqual([
    "node",
    "vite.js",
    "--host",
    "0.0.0.0",
    "--port",
    "4173",
    "--strictPort",
  ]);
});

test("tokenize keeps a quoted exe path and a quoted arg intact (metachars inside quotes are literal)", () => {
  // Exactly the shape tests/manager.test.ts uses: "<bun.exe>" -e "setInterval(() => {}, 1000)".
  expect(tokenize('"C:\\a b\\bun.exe" -e "setInterval(() => {}, 1000)"', WIN_META)).toEqual([
    "C:\\a b\\bun.exe",
    "-e",
    "setInterval(() => {}, 1000)",
  ]);
});

test("tokenize round-trips CommandLineToArgvW escaped quotes (node -e with inner quotes)", () => {
  // The exact shape the manager tests (and real `node -e`/`bun -e` commands) build: inner
  // double quotes escaped as \" and Windows path backslashes left literal.
  expect(tokenize('"C:\\x\\bun.exe" -e "require(\\"net\\").listen(4173);"', WIN_META)).toEqual([
    "C:\\x\\bun.exe",
    "-e",
    'require("net").listen(4173);',
  ]);
  // A run of backslashes NOT before a quote stays literal (path separators survive).
  expect(tokenize("node C:\\a\\b\\c.js", WIN_META)).toEqual(["node", "C:\\a\\b\\c.js"]);
});

test("tokenize bails (null) on an UNQUOTED shell operator — those must keep the shell", () => {
  expect(tokenize("vite && echo done", WIN_META)).toBeNull();
  expect(tokenize("a | b", WIN_META)).toBeNull();
  expect(tokenize("echo %PATH%", WIN_META)).toBeNull(); // %VAR% expansion
  expect(tokenize("a; b", POSIX_META)).toBeNull();
  expect(tokenize("echo $HOME", POSIX_META)).toBeNull();
});

test("tokenize bails on unbalanced quotes rather than guessing", () => {
  expect(tokenize('node "unterminated', WIN_META)).toBeNull();
});

test("tokenize returns null for an empty / whitespace-only command", () => {
  expect(tokenize("   ", WIN_META)).toBeNull();
  expect(tokenize("", WIN_META)).toBeNull();
});

test("Windows path separators are literal, not treated as shell metacharacters", () => {
  expect(tokenize("..\\..\\node_modules\\.bin\\x --p 1", WIN_META)).toEqual([
    "..\\..\\node_modules\\.bin\\x",
    "--p",
    "1",
  ]);
});

// ── planManagedSpawn decision, driven by real temp executables on the real platform ─────────────

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dwspawn-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test.skipIf(!isWin)("win: a real .exe on PATH is spawned DIRECTLY (no cmd.exe wrapper)", () => {
  withTempDir((dir) => {
    writeFileSync(path.join(dir, "dwtest_real.exe"), "");
    writeFileSync(path.join(dir, "dwtest_shim.cmd"), "@echo off");

    const direct = planManagedSpawn("dwtest_real --flag x", { env: { PATH: dir } });
    expect(direct.shell).toBe(false);
    if (direct.shell === false) {
      expect(direct.file).toBe(path.join(dir, "dwtest_real.exe"));
      expect(direct.args).toEqual(["--flag", "x"]);
    }

    // A .cmd/.bat shim (npm.cmd, vite.cmd, …) CANNOT be CreateProcess'd — it must keep the shell.
    expect(planManagedSpawn("dwtest_shim --flag", { env: { PATH: dir } }).shell).toBe(true);
    // An operator forces the shell even though dwtest_real resolves.
    expect(planManagedSpawn("dwtest_real && echo hi", { env: { PATH: dir } }).shell).toBe(true);
  });
});

test.skipIf(!isWin)("win: an explicit path to a real .exe is spawned directly", () => {
  withTempDir((dir) => {
    const exe = path.join(dir, "dwtest_real.exe");
    writeFileSync(exe, "");
    const plan = planManagedSpawn(`"${exe}" -e "x"`, { env: { PATH: "" } });
    expect(plan.shell).toBe(false);
    if (plan.shell === false) {
      expect(plan.file).toBe(exe);
      expect(plan.args).toEqual(["-e", "x"]);
    }
  });
});

test.skipIf(isWin)(
  "posix: an executable file on PATH goes direct; a non-executable keeps the shell",
  () => {
    withTempDir((dir) => {
      const exe = path.join(dir, "dwtest_real");
      writeFileSync(exe, "#!/bin/sh\n");
      chmodSync(exe, 0o755);
      const noexec = path.join(dir, "dwtest_noexec");
      writeFileSync(noexec, "");
      chmodSync(noexec, 0o644);

      const direct = planManagedSpawn("dwtest_real --flag", { env: { PATH: dir } });
      expect(direct.shell).toBe(false);
      if (direct.shell === false) expect(direct.file).toBe(exe);

      expect(planManagedSpawn("dwtest_noexec --flag", { env: { PATH: dir } }).shell).toBe(true);
    });
  },
);

test("an unresolvable command falls back to the shell (never a spawn-time ENOENT)", () => {
  expect(
    planManagedSpawn("definitely_not_a_real_binary_xyz --go", { env: { PATH: "" } }).shell,
  ).toBe(true);
});

// ── runtime proof: the pid we hold IS the real server, not a cmd.exe wrapper ─────────────────────
// This is the whole point of the change — start 25 servers and Task Manager shows 25 real
// binaries, not 25 cmd.exe. We spawn a keep-alive exactly the way spawnEntry does (plan → spawn)
// and ask the OS what the child's image actually is.

test.skipIf(!isWin)(
  "win: a directly-spawned server's pid is the real binary (bun.exe), with NO cmd.exe wrapper",
  async () => {
    // process.execPath under `bun test` is bun.exe — the same real binary a `bun …` server resolves to.
    const command = `"${process.execPath}" -e "setInterval(() => {}, 1000)"`;
    const plan = planManagedSpawn(command, {});
    expect(plan.shell).toBe(false); // an absolute path to bun.exe must take the direct path

    if (plan.shell !== false) return;
    const child = spawn(plan.file, plan.args, { windowsHide: true });
    try {
      const pid = child.pid!;
      expect(pid).toBeGreaterThan(0);

      const probe = Bun.spawnSync([
        "powershell",
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").Name`,
      ]);
      const name = probe.stdout.toString().trim().toLowerCase();
      expect(name).toBe("bun.exe"); // old shell:true path would report "cmd.exe" here
    } finally {
      child.kill();
    }
  },
  // 20s: spawns a real keep-alive bun.exe and then a PowerShell WMI probe against its pid. 752ms
  // here, and the cost is the runner's rather than the assertion's.
  20000,
);

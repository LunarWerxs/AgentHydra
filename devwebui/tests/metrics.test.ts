// ───────────────────────────────────────────────────────────────────────────────
// Metrics must measure the WHOLE process tree, not just the pid we spawned.
//
// The manager spawns every managed server with `shell: true`, so the pid it hands
// to the sampler is the OS shell WRAPPER (cmd.exe on Windows) — a ~3–8 MB idle
// process. The real Node/Bun server (50–200 MB) is a CHILD of that wrapper. If the
// sampler only reads the wrapper's pid, DevWebUI reports ~8 MB for a server using
// 150 MB. These tests pin the fix: descendants() expands a pid into its subtree,
// and sampleMetrics() sums the subtree's working set (so a shell-wrapped, memory-
// holding child is actually counted).
// ───────────────────────────────────────────────────────────────────────────────
import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { descendants, sampleMetrics } from "../server/src/metrics";

// ── Pure subtree expansion (the heart of the fix) ─────────────────────────────────

test("descendants() returns the root plus every transitive child", () => {
  // 1 ─┬─ 2 ─── 4
  //    └─ 3 ─┬─ 5
  //          └─ 6 ─── 7
  const tree = new Map<number, number[]>([
    [1, [2, 3]],
    [2, [4]],
    [3, [5, 6]],
    [6, [7]],
  ]);
  expect(descendants(1, tree).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(descendants(3, tree).sort((a, b) => a - b)).toEqual([3, 5, 6, 7]);
  expect(descendants(4, tree)).toEqual([4]); // leaf
});

test("descendants() of an unknown pid (or an empty map) is just that pid", () => {
  expect(descendants(999, new Map())).toEqual([999]); // snapshot failed → single-pid behavior
  expect(descendants(999, new Map([[1, [2]]]))).toEqual([999]); // not present in the tree
});

test("descendants() does not loop forever on a cyclic map (PID reuse safety)", () => {
  const cyclic = new Map<number, number[]>([
    [1, [2]],
    [2, [3]],
    [3, [1]], // cycle back to the root
  ]);
  expect(descendants(1, cyclic).sort((a, b) => a - b)).toEqual([1, 2, 3]);
});

// ── End-to-end: a shell-wrapped, memory-holding child IS counted ──────────────────

test("sampleMetrics() sums a shell-wrapped child's working set, not just the wrapper", async () => {
  // Grandchild grabs ~96 MB and keeps touching it (so it stays resident). It also
  // self-destructs after 25s — a safety net so a missed cleanup can't leak a process.
  const script = join(tmpdir(), `dwui-metrics-test-${process.pid}-${Date.now()}.js`);
  writeFileSync(
    script,
    "const big = Buffer.alloc(96*1024*1024); big.fill(1);" +
      "const iv=setInterval(()=>{ big[(Date.now()>>10)%big.length]=1; }, 200);" +
      "setTimeout(()=>{ clearInterval(iv); process.exit(0); }, 25000);",
  );

  // Spawn EXACTLY like manager.ts does: shell:true → wrapper → bun(grandchild).
  const child = spawn(`"${process.execPath}" "${script}"`, { shell: true });
  const wrapperPid = child.pid;
  expect(wrapperPid).toBeGreaterThan(0);

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    // Poll until the child is up and holding memory (give bun time to boot + alloc).
    let memoryMb = 0;
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      const stats = await sampleMetrics([wrapperPid!]);
      memoryMb = (stats[wrapperPid!]?.memory ?? 0) / 1024 / 1024;
      if (memoryMb > 40) break;
    }
    // A bare shell wrapper is only a few MB; clearing 40 MB proves the ~96 MB child
    // (a different process from the pid we were handed) was summed into the total.
    expect(memoryMb).toBeGreaterThan(40);
  } finally {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(wrapperPid), "/T", "/F"]);
    else
      try {
        process.kill(wrapperPid!);
      } catch {
        /* already gone */
      }
    try {
      unlinkSync(script);
    } catch {
      /* best-effort */
    }
  }
}, 40000);

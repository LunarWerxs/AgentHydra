// scripts/smoke-orchestrator.mjs - end-to-end smoke test of /orchestrate over the REAL MCP stdio
// transport.
//
// ⛔ NOT A CI STEP, AND IT MUST NEVER BECOME ONE. It drives the live fleet: it gates real chats,
// and with --act it archives them and runs the courier against real desktop windows. There is no
// runner on earth that should do that. This is a local, deliberate, human-run gate.
//
// WHY IT EXISTS (2026-08-30): `/orchestrate` is written to drive this app's MCP tools, and the MCP
// server had been registered NOWHERE - not at user scope, not in any project - so every run of the
// command since it was written had silently fallen back to hand-driving the daemon's REST API. The
// server was fine the whole time (59 tools, all present); nothing had ever plugged it in, and
// nothing would have told you. Testing the REST API proves the FALLBACK works. This speaks the same
// JSON-RPC/stdio protocol a real `/orchestrate` speaks, through the same `bun run mcp` entry the
// registration points at, and walks the command's own steps in its own order - so "the orchestrator
// works" is a claim with evidence behind it rather than an assumption.
//
// It also pins the two defects found that day, which is the half a unit test could not reach: both
// were about what the REPORT says, and only a live fleet produces a real report.
//
//   bun scripts/smoke-orchestrator.mjs          # report-only, changes nothing (the default)
//   bun scripts/smoke-orchestrator.mjs --act    # the real pass: archives, surfaces, delivers
//
// Exit 0 = every check passed. Exit 1 = at least one failed, and it names them.
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ACT = process.argv.includes("--act");
// The repo root, derived from this file rather than from cwd, so it runs from anywhere.
const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const proc = spawn("bun", ["run", "--cwd", APP, "mcp"], {
  stdio: ["pipe", "pipe", "pipe"],
  shell: process.platform === "win32",
});

let buf = "";
const pending = new Map();
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // the server may log non-protocol lines; ignore rather than crash
    }
    const r = pending.get(msg.id);
    if (r) {
      pending.delete(msg.id);
      r(msg);
    }
  }
});
proc.stderr.on("data", () => {}); // server logs land here and are not part of the protocol

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve_, reject) => {
    pending.set(id, resolve_);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => reject(new Error(`timeout on ${method}`)), 300_000);
  });
}

/** Unwrap an MCP tool result into the JSON the tool actually returned. */
async function callTool(name, args = {}) {
  const res = await rpc("tools/call", { name, arguments: args });
  if (res.error) throw new Error(`${name}: ${JSON.stringify(res.error)}`);
  const text = (res.result?.content ?? []).map((c) => c.text ?? "").join("");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const failures = [];
const ok = (label, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
  if (!cond) failures.push(label);
};

const init = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke-orchestrator", version: "1" },
});
proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
console.log(
  `\nMCP handshake: ${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version}` +
    `   mode: ${ACT ? "ACT (will change the fleet)" : "report-only"}`,
);

const tools = (await rpc("tools/list")).result.tools.map((t) => t.name);
console.log(`tools exposed: ${tools.length}\n`);

console.log("STEP 0 - every tool the command names resolves over MCP");
for (const t of ["prestart", "chat_sweep", "chat_act", "courier", "deliveries"]) {
  ok(`tool '${t}' is callable`, tools.includes(t));
}

console.log("\nSTEP 1 - prestart: census first, then every chat, gated, nothing touched");
const pre = await callTool("prestart");
ok(
  "census returned instances",
  typeof pre.instances?.openCount === "number",
  `${pre.instances?.openCount} open of ${pre.instances?.total}`,
);
ok("SANITY RAIL passes (more than one open instance)", pre.sanity?.plausible === true, pre.sanity?.why);
ok(
  "every documented lane is present",
  ["nextSteps", "holds", "handoffSoon", "collisions", "suppressed", "pendingDeliveries"].every(
    (k) => k in pre,
  ) && "stalled" in (pre.chats ?? {}),
);
ok("no chat is left un-gated", (pre.chats?.ungated ?? []).length === 0);
ok("the sweep did not error", pre.sweepError === null, String(pre.sweepError));

// The two 2026-08-30 defects, pinned against the LIVE report because that is where they lived.
const superseded = new Set((pre.junk?.supersededVisible ?? []).map((r) => r.sessionId));
const badAdvice = (pre.nextSteps ?? []).filter(
  (s) => superseded.has(s.sessionId) && s.step !== "archive",
);
ok(
  "no superseded chat is told to judge-or-resume (the loop that could never empty)",
  badAdvice.length === 0,
  badAdvice.map((s) => `${s.sessionId}:${s.step}`).join(", "),
);
const closedWall = (pre.unusableInstances ?? []).filter(
  (u) => u.running === false && u.unusable?.reason === "usage-wall",
);
ok(
  "no CLOSED instance is reported unusable for a transient usage wall",
  closedWall.length === 0,
  closedWall.map((u) => `#${u.num}`).join(", "),
);

console.log("\nSTEP 2 - the lanes an operator must read before acting");
for (const [label, rows] of [
  ["stalled (live and stuck; never acted on automatically)", pre.chats?.stalled ?? []],
  ["holds (deliberately off automation)", pre.holds ?? []],
  ["pendingDeliveries (staged, nobody sent them)", pre.pendingDeliveries ?? []],
  ["suppressed (circuit breaker holding a futile loop)", pre.suppressed ?? []],
  ["collisions (live chats sharing a working tree)", pre.collisions ?? []],
  ["handoffSoon (context nearly full)", pre.handoffSoon ?? []],
]) {
  console.log(`    ${String(rows.length).padStart(2)}  ${label}`);
}

console.log(`\nSTEP 3 - chat_sweep${ACT ? "" : " (caps 0: pure report)"}`);
const sweep = await callTool("chat_sweep", ACT ? {} : { max_archive: 0, max_surface: 0 });
ok("sweep completed", typeof sweep.scanned === "number", `scanned ${sweep.scanned}`);
ok("sweep hit no deadline cut-off", sweep.deadlineHit === false);
ok("nothing was left unswept", (sweep.unswept ?? []).length === 0);
// NOT vacuous: every row the sweep ACTED on must have been non-running. "Never act on a live chat"
// is this system's one hard rule, so it gets a check that can actually fail.
const actedOnLive = [...(sweep.archiveRows ?? []), ...(sweep.crashedRows ?? [])].filter(
  (r) => r.state === "running" && r.action !== "report-only",
);
ok(
  "no LIVE chat was acted on (the one hard rule)",
  actedOnLive.length === 0,
  actedOnLive.map((r) => `${r.sessionId}:${r.action}`).join(", "),
);

console.log(`\nSTEP 4 - courier${ACT ? " (delivering)" : " (dry run)"}`);
const courier = await callTool("courier", ACT ? { run: true } : {});
ok("courier ran", typeof courier.deliverable === "number", `${courier.deliverable} deliverable`);
ok("the pass was NOT capped (a capped pass is an unfinished queue)", courier.capHit === false);
ok("nothing was left unattempted", (courier.notAttempted ?? 0) === 0);

console.log("\nSTEP 5 - a second census agrees with the first");
const after = await callTool("prestart");
ok("census still sane on the second pass", after.sanity?.plausible === true);
ok("no undelivered prompts remain", (after.pendingDeliveries ?? []).length === 0);
if (ACT) {
  // ONLY the steps the sweep itself owns. Asserting "nextSteps is empty" was wrong and produced a
  // false red on the first real run: `judge-then-act` survives a sweep BY DESIGN (chat_sweep never
  // resolves that lane - it needs a separate chat_act decision, and a "human" verdict deliberately
  // leaves the chat exactly where it is), and `investigate` rows are report-only by construction.
  // A gate that cries wolf gets ignored, so it asserts the thing that is actually true.
  const sweepOwned = (after.nextSteps ?? []).filter(
    (s) => s.step === "archive" || s.step === "surface-and-deliver",
  );
  ok(
    "no sweep-owned work is left outstanding (archive / surface-and-deliver)",
    sweepOwned.length === 0,
    sweepOwned.map((s) => `${s.step}:${s.title}`).join(", "),
  );
  const humanOwned = (after.nextSteps ?? []).filter((s) => s.step !== "archive" && s.step !== "surface-and-deliver");
  if (humanOwned.length)
    console.log(`    ${humanOwned.length} row(s) awaiting a judgment or a human, which a sweep cannot clear:`);
  for (const s of humanOwned) console.log(`      - ${s.step}: ${s.title}`);
} else {
  console.log(`    ${(after.nextSteps ?? []).length} nextSteps outstanding (report-only: not acted on)`);
}

proc.stdin.end();
proc.kill();
console.log(
  failures.length === 0
    ? "\nORCHESTRATOR SMOKE: ALL CHECKS PASSED over the MCP transport.\n"
    : `\nORCHESTRATOR SMOKE: ${failures.length} FAILED: ${failures.join("; ")}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);

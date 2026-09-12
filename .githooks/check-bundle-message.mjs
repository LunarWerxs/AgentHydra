#!/usr/bin/env node
/**
 * Commit-msg guard: a bundle commit must name every file it swept from someone else.
 *
 * On 2026-09-12 (de81357) the owner told one session to "commit and sync as we go, including the
 * entirety of the dirty work tree". That is legitimate - a peer's work should not be lost when a
 * session dies - and the push was his call. What it left was a coordination hazard: files another
 * session was still editing went to a PUBLIC remote at a moment their author did not choose, and
 * the author found out by reading git. So a bundle commit now carries, in its own message, the
 * split between what the committing session edited and what it swept:
 *
 *     wip: bundle peer sessions' in-flight work (owner-instructed sync, 2026-09-12)
 *
 *     Mine:
 *       server/src/thing.ts
 *     Swept:
 *       orchestrator/scripts/other.py
 *
 * This hook only fires when the subject starts with `wip: bundle`. It then requires every path in
 * the commit to appear under `Mine:` or `Swept:`, and every listed path to be in the commit, so a
 * stale list cannot pass. It never refuses an ordinary commit and never judges whether bundling
 * was allowed; that is the owner's call and stays one. scripts/save-bundle.ts writes a conforming
 * message from the staged tree; doing it by hand is fine too.
 *
 * Usage (git's commit-msg hook calls it; see .githooks/commit-msg):
 *   node .githooks/check-bundle-message.mjs <path-to-message-file>
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BUNDLE_SUBJECT = /^wip: bundle\b/i;
const BLOCK_HEADING = /^(Mine|Swept):\s*$/;

/** {subject, mine, swept, hasBlocks} from a commit message, git's `#` comment lines removed. */
export function parseBundleMessage(text) {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => !l.startsWith("#"));
  const subject = (lines.find((l) => l.trim()) || "").trim();
  const blocks = { Mine: [], Swept: [] };
  let current = null;
  let hasBlocks = false;
  for (const line of lines) {
    const head = BLOCK_HEADING.exec(line);
    if (head) {
      current = head[1];
      hasBlocks = true;
      continue;
    }
    if (current && /^\s+\S/.test(line)) {
      blocks[current].push(normalize(line.trim()));
      continue;
    }
    current = null; // a blank or unindented line ends the block
  }
  return { subject, mine: blocks.Mine, swept: blocks.Swept, hasBlocks };
}

export function normalize(path) {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Every path in the commit being made. GIT_INDEX_FILE is honoured, so `git commit <paths>`
 *  (which builds a temporary index) is judged on what it actually commits. */
function stagedPaths() {
  const out = execFileSync("git", ["diff", "--cached", "--name-only", "-z"], { encoding: "utf8" });
  return out.split("\0").filter(Boolean).map(normalize);
}

/** null when the message passes, else the lines to print. */
export function judge(parsed, staged) {
  if (!BUNDLE_SUBJECT.test(parsed.subject)) return null;
  if (!parsed.hasBlocks) {
    return [
      "✗ a bundle commit must say what it swept.",
      "  The subject starts with `wip: bundle`, so the body needs a `Mine:` block (files this",
      "  session edited) and a `Swept:` block (files taken from other sessions), one path per",
      "  indented line. `bun run save:bundle -- --mine <paths>` writes it from the staged tree.",
    ];
  }
  const listed = new Set([...parsed.mine, ...parsed.swept]);
  const stagedSet = new Set(staged);
  const missing = staged.filter((p) => !listed.has(p));
  const stale = [...listed].filter((p) => !stagedSet.has(p));
  if (missing.length === 0 && stale.length === 0) return null;
  const lines = ["✗ the bundle message and the commit disagree:"];
  if (missing.length) {
    lines.push("  in the commit but under neither Mine: nor Swept: (a peer would never find these):");
    lines.push(...missing.map((p) => `    ${p}`));
  }
  if (stale.length) {
    lines.push("  listed in the message but not in the commit (the list is stale):");
    lines.push(...stale.map((p) => `    ${p}`));
  }
  lines.push("  Every file in a bundle commit is named, so its author can find it by reading the log.");
  return lines;
}

const invokedDirectly =
  process.argv[1] && /check-bundle-message\.mjs$/.test(process.argv[1].replace(/\\/g, "/"));
if (invokedDirectly) {
  const file = process.argv[2];
  if (!file) {
    console.error("check-bundle-message: missing <message file> argument");
    process.exit(2);
  }
  const parsed = parseBundleMessage(readFileSync(file, "utf8"));
  if (!BUNDLE_SUBJECT.test(parsed.subject)) process.exit(0); // not a bundle: none of our business
  const verdict = judge(parsed, stagedPaths());
  if (verdict) {
    console.error(`\n${verdict.join("\n")}\n`);
    process.exit(1);
  }
}

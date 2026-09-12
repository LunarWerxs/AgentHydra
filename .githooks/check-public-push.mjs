#!/usr/bin/env node
/**
 * Pre-push guard, two rules that used to live only in people's memory:
 *
 *  1. A push to a PUBLIC remote is refused unless this one command was told to proceed.
 *     LunarWerxs/AgentHydra is public, and a push to `main` is a release for every source install
 *     (docs/RELEASING.md). The standing rule is "check visibility, announce it with an unmissable
 *     heading, then let the owner decide". On 2026-09-11 (590bec8) a session that had not read the
 *     rule pushed a peer's half-finished work straight to origin/main with no announcement. Nothing
 *     secret went out that day; the rule that stops the day something does had no teeth. Now the
 *     heading is printed by the machine, every time, and the push stops there unless
 *     AGENTHYDRA_PUSH_PUBLIC=1 is set for that command - which announces AND proceeds, because the
 *     rule was always announce-then-do, never announce-instead-of-do.
 *
 *  2. A release tag (refs/tags/v*) is refused while the repository's own work queue has an open
 *     section. Owner directive (Michael, 2026-09-11): "We always do everything now... If something
 *     is pending a to-do, it should be to-done before we do the upcoming release." The queue is
 *     docs/todo/TODO.md, gitignored and local, so this gate can only fire on a machine that holds
 *     it; a clone without the file has nothing to gate on and passes. There is deliberately NO
 *     override for this rule: the item gets done, or the owner deletes it himself.
 *
 * VISIBILITY IS FAIL-CLOSED. A remote that is not GitHub, a lookup that times out, a rate limit -
 * every "could not tell" is treated as public. A guard that passes when it cannot see is a guard
 * that passes exactly when something is wrong. `--no-verify` still skips this hook, which a hook
 * cannot prevent; the bundling path (scripts/save-bundle.ts) never uses it, on purpose.
 *
 * Usage (git's pre-push hook calls it; see .githooks/pre-push):
 *   node .githooks/check-public-push.mjs <remote-name> <remote-url>
 *   stdin: one "<local ref> <local sha> <remote ref> <remote sha>" line per ref being pushed
 * Env:
 *   AGENTHYDRA_PUSH_PUBLIC=1         announce, then allow a public push (this one command)
 *   AGENTHYDRA_VISIBILITY_STUB=...   public | private | unknown - tests only, skips the network
 *   GH_TOKEN / GITHUB_TOKEN          optional; sent with the lookup so a rate limit cannot turn a
 *                                    private repo into "unknown"
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PUBLIC_HEADING = "# WARNING: THIS REPOSITORY IS **PUBLIC**";
const LOOKUP_TIMEOUT_MS = 5000;
const ZERO_SHA = /^0+$/;
const RELEASE_TAG = /^refs\/tags\/v\d+\.\d+\.\d+/;
const TODO_FILE = "docs/todo/TODO.md";

const [remoteName = "", remoteUrl = ""] = process.argv.slice(2);

/** owner/repo from any of the URL shapes git accepts for GitHub, or null for anything else. */
export function parseGithubSlug(url) {
  const m =
    /^(?:https?:\/\/|ssh:\/\/)?(?:[\w.-]+@)?github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    );
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** 'public' | 'private' | 'unknown', with the sentence that explains it. */
export async function lookupVisibility(url, env = process.env) {
  const stub = (env.AGENTHYDRA_VISIBILITY_STUB || "").trim().toLowerCase();
  if (stub === "public" || stub === "private" || stub === "unknown") {
    return { verdict: stub, reason: `AGENTHYDRA_VISIBILITY_STUB=${stub}` };
  }
  const slug = parseGithubSlug(url);
  if (!slug) {
    return {
      verdict: "unknown",
      reason: `${url || "(no url)"} is not a GitHub remote, so its visibility cannot be looked up`,
    };
  }
  const api = `https://api.github.com/repos/${slug.owner}/${slug.repo}`;
  // `connection: close`: Node's fetch keeps the socket alive otherwise, and on Windows a
  // process.exit() while that socket is still closing trips a libuv assertion
  // (`!(handle->flags & UV_HANDLE_CLOSING)`, exit 127) AFTER the verdict has printed - which
  // turned a correct "private, pass" into a refusal on the first hand test (2026-09-12).
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "agenthydra-pre-push",
    connection: "close",
  };
  const token = (env.GH_TOKEN || env.GITHUB_TOKEN || "").trim();
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(api, { headers, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { verdict: "unknown", reason: `GET ${api} failed (${why})` };
  }
  if (res.status === 404) {
    // Unauthenticated, a private repo and a nonexistent one both answer 404. Either way there is
    // nothing public at that slug.
    return { verdict: "private", reason: `GET ${api} -> 404 (private, or not on GitHub)` };
  }
  if (res.status === 200) {
    let visibility = "";
    try {
      visibility = String((await res.json())?.visibility || "");
    } catch {
      /* fall through: a 200 we cannot read is not proof of privacy */
    }
    if (visibility === "public") {
      return { verdict: "public", reason: `GET ${api} -> 200, visibility: public` };
    }
    if (visibility === "private" || visibility === "internal") {
      return { verdict: "private", reason: `GET ${api} -> 200, visibility: ${visibility}` };
    }
    return { verdict: "unknown", reason: `GET ${api} -> 200 with no readable visibility field` };
  }
  return { verdict: "unknown", reason: `GET ${api} -> HTTP ${res.status}` };
}

/** The refs git is about to push, from the hook's stdin. */
export function parseRefLines(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [localRef, localSha, remoteRef, remoteSha] = l.split(/\s+/);
      return { localRef, localSha, remoteRef, remoteSha, isDelete: ZERO_SHA.test(localSha || "") };
    });
}

/**
 * The open sections of the work queue: every `## ` heading after the "## Contents" heading. When
 * the file has no Contents heading, every `## ` heading except the state-of-play one counts. A
 * missing file is an empty queue - there is nothing local to gate on.
 */
export function openTodoSections(todoPath) {
  if (!existsSync(todoPath)) return [];
  const lines = readFileSync(todoPath, "utf8").split(/\r?\n/);
  const contentsAt = lines.findIndex((l) => /^## Contents\b/.test(l));
  const scope = contentsAt >= 0 ? lines.slice(contentsAt + 1) : lines;
  return scope
    .filter((l) => /^## /.test(l))
    .map((l) => l.replace(/^## /, "").trim())
    .filter((h) => contentsAt >= 0 || !/STATE OF PLAY/i.test(h));
}

function readStdin() {
  if (process.stdin.isTTY) return "";
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

async function main() {
  const refs = parseRefLines(readStdin());
  if (refs.length === 0) return 0; // nothing to push (e.g. everything up to date)

  const { verdict, reason } = await lookupVisibility(remoteUrl);
  const override = (process.env.AGENTHYDRA_PUSH_PUBLIC || "").trim() === "1";
  const refList = refs.map(
    (r) =>
      `    ${r.isDelete ? "delete " : ""}${r.remoteRef}${r.isDelete ? "" : ` <- ${r.localRef} (${(r.localSha || "").slice(0, 7)})`}`,
  );

  if (verdict !== "private") {
    const lines = [
      "",
      PUBLIC_HEADING,
      "",
      verdict === "public"
        ? `  ${remoteName || "the remote"} (${remoteUrl}) is PUBLIC: ${reason}.`
        : `  ${remoteName || "the remote"} (${remoteUrl}) could not be proven private: ${reason}.`,
      "  A push here publishes to the internet and is a release for every source install.",
      "  Refs about to be pushed:",
      ...refList,
      "",
    ];
    if (override) {
      lines.push("  AGENTHYDRA_PUSH_PUBLIC=1 is set for this command: announced, proceeding.", "");
      console.error(lines.join("\n"));
    } else {
      lines.push(
        "  Refused. If the owner has decided this push goes out, re-run with:",
        "      AGENTHYDRA_PUSH_PUBLIC=1 git push ...",
        "  which prints this heading again and then pushes. Do not use --no-verify.",
        "",
      );
      console.error(lines.join("\n"));
      return 1;
    }
  }

  const releaseTags = refs.filter((r) => !r.isDelete && RELEASE_TAG.test(r.remoteRef || ""));
  if (releaseTags.length > 0) {
    const open = openTodoSections(join(process.cwd(), ...TODO_FILE.split("/")));
    if (open.length > 0) {
      console.error(
        [
          "",
          `✗ release refused: ${releaseTags.map((r) => r.remoteRef).join(", ")} would publish binaries while`,
          `  ${TODO_FILE} still has ${open.length} open section(s):`,
          ...open.map((h) => `    - ${h}`),
          "",
          "  Nothing pending ships past a release (owner directive, 2026-09-11). Finish the item and",
          "  delete its section, or the owner deletes it himself. There is no override for this rule.",
          "",
        ].join("\n"),
      );
      return 1;
    }
  }
  return 0;
}

// Only run as a hook when executed directly; the exports above are importable by the tests.
const invokedDirectly =
  process.argv[1] && /check-public-push\.mjs$/.test(process.argv[1].replace(/\\/g, "/"));
if (invokedDirectly) {
  // exitCode rather than process.exit(): let the event loop drain so the lookup's socket is closed
  // before the process ends (see the `connection: close` note in lookupVisibility).
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`✗ pre-push guard crashed: ${err instanceof Error ? err.stack : err}`);
      process.exitCode = 1; // fail closed: a crashed guard must not read as a pass
    },
  );
}

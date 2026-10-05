import { expect, test } from "bun:test";
import {
  applyUpdate,
  assetForPlatform,
  CHECKSUM_ASSET,
  checkForUpdate,
  cleanupStaleUpdateArtifacts,
  isNewer,
  newestAgedRelease,
  parseChecksums,
  type Release,
  releaseAged,
  releaseTarget,
  sha256,
} from "../src/github-updater";
import { writeSettings } from "../src/runtime";

const direct = {
  name: "devwebui-windows-x64.exe",
  browser_download_url: "https://example.test/direct",
  size: 100,
};
const archive = {
  name: "devwebui-windows-x64.zip",
  browser_download_url: "https://example.test/archive",
  size: 40,
};

test("compiled updater selects the Windows archive regardless of direct-exe upload order", () => {
  expect(assetForPlatform([direct, archive], "win32", "x64")).toEqual(archive);
  expect(assetForPlatform([archive, direct], "win32", "x64")).toEqual(archive);
});

test("compiled updater uses the public release target names", () => {
  expect(releaseTarget("win32", "x64")).toBe("windows-x64");
  expect(releaseTarget("darwin", "arm64")).toBe("macos-arm64");
  expect(releaseTarget("linux", "x64")).toBe("linux-x64");
});

test("release versions compare as numeric semver triples", () => {
  expect(isNewer("v0.6.1", "0.6.0")).toBe(true);
  expect(isNewer("0.6.0", "0.6.0")).toBe(false);
  expect(isNewer("0.5.9", "0.6.0")).toBe(false);
});

// ── parseChecksums / sha256 ──────────────────────────────────────────────────────────────────

test("parseChecksums parses a sha256sum-style manifest, tolerating a leading '*' and CRLF line endings", () => {
  const digestA = "a".repeat(64);
  const digestB = "b".repeat(64);
  const text = `${digestA}  devwebui-windows-x64.zip\r\n${digestB} *devwebui-linux-x64.tar.gz\n`;
  expect(parseChecksums(text)).toEqual({
    "devwebui-windows-x64.zip": digestA,
    "devwebui-linux-x64.tar.gz": digestB,
  });
});

test("parseChecksums lowercases uppercase hex digests and ignores blank/malformed lines", () => {
  const upper = "A".repeat(64);
  const text = `\nnot a checksum line\n${upper}  devwebui-macos-arm64.tar.gz\n   \n`;
  expect(parseChecksums(text)).toEqual({
    "devwebui-macos-arm64.tar.gz": upper.toLowerCase(),
  });
});

test("sha256 matches known SHA-256 test vectors", () => {
  // Pinned against the standard NIST test vectors, not re-derived through node:crypto directly —
  // the whole point is catching a regression in what sha256() computes, not confirming it agrees
  // with itself.
  expect(sha256(new TextEncoder().encode("abc"))).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  expect(sha256(new Uint8Array())).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

// ── applyUpdate: refuses instead of installing ──────────────────────────────────────────────
//
// applyUpdate() reads process.execPath directly (no injection point) and, once it finds BOTH a
// platform asset and a checksum manifest in the release, creates `.update-staging` NEXT TO THE
// REAL BUN EXECUTABLE before it downloads anything — there is no way to unit-test the
// digest-mismatch refusal without that directory briefly existing on THIS machine. It never gets
// as far as renaming/replacing the real executable (the checksum check runs before that), and
// `cleanupStaleUpdateArtifacts()` (the same sweep the daemon runs on every boot) removes the
// staging dir afterward either way — see the `finally` blocks below.
const REMOTE_VERSION = "99.0.0"; // comfortably newer than this repo's pkg.version, whatever it is
const target = releaseTarget(); // this machine's own platform-arch — must match what applyUpdate resolves
const assetName = `devwebui-${target}${process.platform === "win32" ? ".zip" : ".tar.gz"}`;

function stubFetchJson(handlers: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [match, respond] of Object.entries(handlers)) {
      if (url.includes(match)) return respond();
    }
    throw new Error(`unstubbed fetch in test: ${url}`);
  }) as typeof fetch;
}

test("applyUpdate refuses when the release has no SHA256SUMS.txt manifest", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetchJson({
    "/v1/app/devwebui/latest": () =>
      new Response(
        JSON.stringify({
          tag_name: `v${REMOTE_VERSION}`,
          assets: [
            { name: assetName, browser_download_url: "https://example.test/asset", size: 123 },
            // deliberately no CHECKSUM_ASSET entry
          ],
        }),
        { status: 200 },
      ),
  });
  try {
    const result = await applyUpdate();
    expect(result.ok).toBe(false);
    expect(result.message).toContain(CHECKSUM_ASSET);
    expect(result.message).toContain("to verify the download against");
    expect(result.restartRequired).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("applyUpdate refuses when the release changed between the check and the download", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = stubFetchJson({
    "/v1/app/devwebui/latest": () =>
      new Response(
        JSON.stringify({
          tag_name: calls++ === 0 ? `v${REMOTE_VERSION}` : "v99.0.1",
          assets: [
            { name: assetName, browser_download_url: "https://example.test/asset", size: 1 },
          ],
        }),
        { status: 200 },
      ),
  });
  try {
    const result = await applyUpdate();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("the release changed since the check");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("applyUpdate refuses when the downloaded bytes don't match the published checksum", async () => {
  const originalFetch = globalThis.fetch;
  const fakeBytes = new TextEncoder().encode("not-the-real-binary");
  const wrongDigest = "0".repeat(64); // guaranteed not to equal sha256(fakeBytes)
  globalThis.fetch = stubFetchJson({
    "/v1/app/devwebui/latest": () =>
      new Response(
        JSON.stringify({
          tag_name: `v${REMOTE_VERSION}`,
          assets: [
            { name: assetName, browser_download_url: "https://example.test/asset", size: 123 },
            {
              name: CHECKSUM_ASSET,
              browser_download_url: "https://example.test/sums",
              size: 10,
            },
          ],
        }),
        { status: 200 },
      ),
    "https://example.test/asset": () => new Response(fakeBytes, { status: 200 }),
    "https://example.test/sums": () =>
      new Response(`${wrongDigest}  ${assetName}\n`, { status: 200 }),
  });
  try {
    const result = await applyUpdate();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("does not match its published checksum");
    expect(result.restartRequired).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
    cleanupStaleUpdateArtifacts();
  }
});

/**
 * The update check must survive its primary endpoint going away.
 *
 * This is the YTSort failure (2026-08) in a different shape: an artifact shipped with a single
 * baked-in update URL, that URL later stops resolving, and every install polls a dead link
 * forever with nothing surfaced to the user or the maintainer. One hardcoded endpoint and no
 * second opinion is that bug waiting to happen, so a Studio failure must fall through to
 * GitHub's own releases API, the one URL that survives an owner or repo rename.
 */
test("a failing Studio proxy falls back to GitHub instead of stranding the install", async () => {
  const seen: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    if (url.includes("studio.connectionsapi.com")) return new Response("gone", { status: 503 });
    return new Response(JSON.stringify({ tag_name: "v999.0.0", assets: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  try {
    const status = await checkForUpdate({ fresh: true });
    expect(seen.some((u) => u.includes("studio.connectionsapi.com"))).toBe(true);
    expect(seen.some((u) => u.includes("api.github.com"))).toBe(true);
    expect(status.updateAvailable).toBe(true);
  } finally {
    globalThis.fetch = real;
  }
});

test("both endpoints down reports the primary failure, not the backstop's", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("primary is unreachable");
  }) as unknown as typeof fetch;
  try {
    const status = await checkForUpdate({ fresh: true });
    expect(status.ok).toBe(false);
    expect(String(status.reason)).toContain("primary is unreachable");
  } finally {
    globalThis.fetch = real;
  }
});

// Update cooldown: only a release public for N days is offered or installed, so a bad or
// compromised release has time to be caught before an install adopts it. These pin that a
// too-young latest release is never offered, that the newest OLD-ENOUGH release is offered in
// its place, and that an unreachable release list fails closed rather than open.
const DAY = 24 * 60 * 60 * 1000;
// A frozen clock passed explicitly to every call below, fixed well in the past so it can never
// drift across the real "now" while the suite ages.
const NOW = Date.parse("2020-01-01T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

test("releaseAged: under a cooldown, too-young or undated releases are not old enough", () => {
  const rel = (published_at?: string): Release => ({
    tag_name: "v1.0.0",
    assets: [],
    published_at,
  });
  expect(releaseAged(rel(daysAgo(8)), 7, NOW)).toBe(true);
  expect(releaseAged(rel(daysAgo(2)), 7, NOW)).toBe(false);
  expect(releaseAged(rel(undefined), 7, NOW)).toBe(false);
  expect(releaseAged(rel(daysAgo(0)), 0, NOW)).toBe(true); // 0 = cooldown off
});

test("newestAgedRelease picks the highest aged stable release, skipping young, draft and prerelease", () => {
  const releases: Release[] = [
    { tag_name: "v5.0.0", assets: [], published_at: daysAgo(1) },
    { tag_name: "v4.1.0", assets: [], published_at: daysAgo(30), prerelease: true },
    { tag_name: "v4.2.0", assets: [], published_at: daysAgo(30), draft: true },
    { tag_name: "v3.0.0", assets: [], published_at: daysAgo(40) },
    { tag_name: "v4.0.0", assets: [], published_at: daysAgo(10) },
  ];
  expect(newestAgedRelease(releases, 7, NOW)?.tag_name).toBe("v4.0.0");
  expect(newestAgedRelease(releases.slice(0, 1), 7, NOW)).toBeNull();
});

test("checkForUpdate under a cooldown offers the newest aged release, not the too-young latest", async () => {
  const real = globalThis.fetch;
  const young = { tag_name: "v999.0.0", assets: [], published_at: new Date().toISOString() };
  const aged = {
    tag_name: "v998.0.0",
    assets: [{ name: assetName, browser_download_url: "https://example.test/a", size: 1 }],
    published_at: new Date(Date.now() - 10 * DAY).toISOString(),
  };
  globalThis.fetch = stubFetchJson({
    "/v1/app/devwebui/latest": () => new Response(JSON.stringify(young), { status: 200 }),
    "/releases?per_page=": () => new Response(JSON.stringify([young, aged]), { status: 200 }),
  });
  writeSettings({ updateCooldownDays: 7 });
  try {
    const status = await checkForUpdate({ fresh: true });
    expect(status.updateAvailable).toBe(true);
    expect(status.remoteCommit).toBe("v998.0.0");
    expect(status.canApply).toBe(true);
  } finally {
    globalThis.fetch = real;
    writeSettings({ updateCooldownDays: 0 });
  }
});

test("checkForUpdate under a cooldown fails closed when the release list is unreachable", async () => {
  const real = globalThis.fetch;
  const young = { tag_name: "v999.0.0", assets: [], published_at: new Date().toISOString() };
  globalThis.fetch = stubFetchJson({
    "/v1/app/devwebui/latest": () => new Response(JSON.stringify(young), { status: 200 }),
    "/releases?per_page=": () => new Response("rate limited", { status: 403 }),
  });
  writeSettings({ updateCooldownDays: 7 });
  try {
    const status = await checkForUpdate({ fresh: true });
    expect(status.ok).toBe(true);
    expect(status.updateAvailable).toBe(false);
    expect(String(status.reason)).toContain("cooldown");
  } finally {
    globalThis.fetch = real;
    writeSettings({ updateCooldownDays: 0 });
  }
});

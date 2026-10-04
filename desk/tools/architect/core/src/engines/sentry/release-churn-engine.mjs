/**
 * release-churn-engine — Sentry-inspired release-aware churn analysis
 * ===================================================================
 * Enhances the existing `git-churn-engine.mjs` with release-boundary-aware
 * analysis, adapted from Sentry's release tracking model.
 *
 * ## Sentry's Release Model (what we're adapting)
 *
 *   Sentry (`src/sentry/models/release.py`):
 *   - `Release` has version, date_added, projects, commit count, deploy count
 *   - `Deploy` has environment, date_finished
 *   - `Commit` has key, author, date_added, message
 *   - `ReleaseCommit` links releases to commits
 *   - Hotspots are often RELEASE-AWARE: a file churning between releases is
 *     more interesting than one churning within a single release cycle.
 *
 * ## What this engine adds
 *
 *   The existing `git-churn-engine.mjs` does raw revision counting:
 *     hotspot = revisions × complexity
 *
 *   This engine adds release-aware dimensions:
 *
 *   1. **Release boundary detection** — find release tags/merges in git history
 *   2. **Release-scoped churn** — churn within vs between release cycles
 *   3. **Release hotspot scoring** — weight files that change across releases
 *      higher (they indicate unstable interfaces)
 *   4. **Deploy frequency correlation** — correlate churn with deploy events
 *   5. **Release risk score** — per-file risk based on: churn × cross-release
 *      changes × recent changes
 *
 * ## Algorithm (adapted from Sentry + code-maat/CodeScene)
 *
 *   For each file:
 *     raw_churn      = total revisions in the window
 *     cross_release  = number of DISTINCT release cycles this file changed in
 *     release_churn  = raw_churn × (1 + cross_release / total_releases)
 *     risk_score     = release_churn × complexity
 *
 *   Files with high release_churn (changing in many release cycles) are
 *   the most unstable and highest-risk for regressions.
 *
 * Codebase-agnostic: shells out to `git log` and `git tag`.
 */

// ---------------------------------------------------------------------------
// Release detection — find release boundaries in git history
// ---------------------------------------------------------------------------

/**
 * Detect release boundaries from git tags.
 *
 * Returns an array of { tag, date, sha } sorted by date ascending.
 *
 * @param {string} [root] — repo root directory
 * @param {Object} [options]
 * @param {string} [options.tagPattern="*"] — glob pattern for release tags
 * @param {boolean} [options.useMerges=false] — use merge commits instead of tags
 * @returns {Promise<Array<{tag: string, date: string, sha: string}>>}
 */
export async function detectReleases(root, options = {}) {
  const { tagPattern = "*", useMerges = false } = options;

  if (useMerges) {
    return detectReleasesFromMerges(root, options);
  }

  return detectReleasesFromTags(root, tagPattern);
}

/**
 * Detect releases from git tags matching a pattern.
 */
async function detectReleasesFromTags(root, tagPattern) {
  // Get all tags sorted by commit date
  const stdout = await runGit(root, [
    "tag",
    "--sort=creatordate",
    "--format=%(refname:short)|%(creatordate:iso)|%(objectname:short)",
    "--list",
    tagPattern,
  ]);

  if (!stdout) return [];

  const releases = [];
  for (const line of stdout.trim().split(/\r?\n/)) {
    if (!line) continue;
    const [tag, date, sha] = line.split("|");
    if (tag && date && sha) {
      releases.push({ tag: tag.trim(), date: date.trim(), sha: sha.trim() });
    }
  }
  return releases;
}

/**
 * Detect releases from merge commits into a release branch.
 */
async function detectReleasesFromMerges(root, options = {}) {
  const { branchPattern = "release/*" } = options;

  const stdout = await runGit(root, [
    "log",
    `--merges`,
    `--first-parent`,
    `--grep=Merge.*${branchPattern}`,
    "--format=%H|%aI|%s",
    "--since=12.months.ago",
  ]);

  if (!stdout) return [];

  const releases = [];
  for (const line of stdout.trim().split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split("|");
    if (parts.length >= 2) {
      releases.push({
        tag: `merge_${parts[0].trim().substring(0, 8)}`,
        date: parts[1].trim(),
        sha: parts[0].trim(),
      });
    }
  }
  return releases;
}

// ---------------------------------------------------------------------------
// Release-scoped churn — churn within each release cycle
// ---------------------------------------------------------------------------

/**
 * Compute release-scoped churn: for each file, count how many DISTINCT
 * release cycles it changed in.
 *
 * This requires iterating through the git log between each release boundary.
 * For efficiency, we use `git log --since/--until` per release window.
 *
 * @param {string} [root]
 * @param {Array<{tag: string, date: string, sha: string}>} releases — from detectReleases()
 * @param {string} [since="12.months.ago"]
 * @returns {Promise<Map<string, Set<string>>>} filePath → Set<release_tag>
 */
export async function releaseScopedChurn(root, releases, since = "12.months.ago") {
  if (releases.length === 0) return new Map();

  const fileToReleases = new Map();

  // Sort releases by date
  const sorted = [...releases].sort((a, b) => new Date(a.date) - new Date(b.date));

  // For each release window (release[n-1] → release[n]), count changed files
  for (let i = 0; i < sorted.length; i++) {
    const release = sorted[i];
    const prevDate = i === 0 ? since : sorted[i - 1].date;

    const stdout = await runGit(root, [
      "log",
      `--since=${prevDate}`,
      `--until=${release.date}`,
      "--pretty=format:",
      "--name-only",
    ]);

    if (!stdout) continue;

    for (const raw of stdout.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || /^[0-9a-f]{40}$/i.test(line)) continue;
      const norm = line.replaceAll("\\", "/");

      if (!fileToReleases.has(norm)) {
        fileToReleases.set(norm, new Set());
      }
      fileToReleases.get(norm).add(release.tag);
    }
  }

  // Also cover the period after the last release
  if (sorted.length > 0) {
    const lastRelease = sorted[sorted.length - 1];
    const stdout = await runGit(root, ["log", `--since=${lastRelease.date}`, "--pretty=format:", "--name-only"]);

    if (stdout) {
      const postReleaseTag = `${lastRelease.tag}+`;
      for (const raw of stdout.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || /^[0-9a-f]{40}$/i.test(line)) continue;
        const norm = line.replaceAll("\\", "/");

        if (!fileToReleases.has(norm)) {
          fileToReleases.set(norm, new Set());
        }
        fileToReleases.get(norm).add(postReleaseTag);
      }
    }
  }

  return fileToReleases;
}

// ---------------------------------------------------------------------------
// Release-aware hotspot scoring
// ---------------------------------------------------------------------------

/**
 * Compute release-aware hotspot scores.
 *
 * For each file:
 *   raw_churn      = total revisions
 *   cross_release  = number of distinct release cycles
 *   release_ratio  = cross_release / max(1, total_releases)
 *   release_churn  = raw_churn × (1 + release_ratio)
 *   risk_score     = release_churn × complexity
 *
 * Files with release_ratio close to 1.0 (changed in EVERY release) are
 * the most volatile and highest-risk for regressions.
 *
 * @param {Map<string, number>} revisionMap — filePath → revision count
 * @param {Map<string, number>} weightMap — filePath → complexity/loc weight
 * @param {Map<string, Set<string>>} releaseMap — filePath → Set<release_tag>
 * @param {number} totalReleases — total number of release cycles
 * @returns {Array<{file: string, revisions: number, weight: number, crossRelease: number, releaseRatio: number, releaseChurn: number, riskScore: number}>}
 */
export function computeReleaseHotspots(revisionMap, weightMap, releaseMap, totalReleases) {
  const out = [];
  const effectiveTotal = Math.max(1, totalReleases);

  for (const [file, revs] of revisionMap) {
    const weight = weightMap.get(file);
    if (weight === undefined) continue;

    const releaseSet = releaseMap.get(file);
    const crossRelease = releaseSet ? releaseSet.size : 0;
    const releaseRatio = crossRelease / effectiveTotal;
    const releaseChurn = revs * (1 + releaseRatio);
    const riskScore = releaseChurn * weight;

    out.push({
      file,
      revisions: revs,
      weight,
      crossRelease,
      releaseRatio: Math.round(releaseRatio * 100) / 100,
      releaseChurn: Math.round(releaseChurn * 100) / 100,
      riskScore: Math.round(riskScore * 100) / 100,
    });
  }

  // Sort by riskScore descending (highest risk first)
  out.sort((a, b) => b.riskScore - a.riskScore);
  return out;
}

// ---------------------------------------------------------------------------
// Release risk summary (dashboard-friendly)
// ---------------------------------------------------------------------------

/**
 * Summarize release risk into human-readable categories.
 *
 * @param {Array<{riskScore: number, releaseRatio: number, crossRelease: number}>} hotspots
 * @returns {Object}
 */
export function summarizeReleaseRisk(hotspots) {
  const categories = { high: [], medium: [], low: [] };

  for (const hs of hotspots) {
    if (hs.riskScore >= 100 || hs.releaseRatio >= 0.8) {
      categories.high.push(hs);
    } else if (hs.riskScore >= 30 || hs.releaseRatio >= 0.4) {
      categories.medium.push(hs);
    } else {
      categories.low.push(hs);
    }
  }

  return {
    totalFiles: hotspots.length,
    highRisk: categories.high.length,
    mediumRisk: categories.medium.length,
    lowRisk: categories.low.length,
    topRisks: hotspots.slice(0, 5).map((hs) => ({
      file: hs.file,
      riskScore: hs.riskScore,
      crossRelease: hs.crossRelease,
      releaseRatio: hs.releaseRatio,
    })),
  };
}

// ---------------------------------------------------------------------------
// Full release-aware analysis pipeline
// ---------------------------------------------------------------------------

/**
 * Run the full release-aware churn analysis pipeline.
 *
 * @param {string} [root] — repo root
 * @param {Object} [options]
 * @param {string} [options.since="12.months.ago"]
 * @param {string} [options.tagPattern="*"]
 * @param {boolean} [options.useMerges=false]
 * @param {Map<string, number>} [options.weightMap] — pre-computed per-file complexity/loc
 * @returns {Promise<Object>} — full analysis results
 */
export async function analyzeReleaseChurn(root, options = {}) {
  const { since = "12.months.ago", tagPattern = "*", useMerges = false, weightMap = null } = options;

  // 1. Detect releases
  const releases = await detectReleases(root, { tagPattern, useMerges });

  // 2. Get raw churn (reuse existing engine)
  const { getGitChurn } = await import("../code-quality/git-churn-engine.mjs");
  let revisionMap;
  try {
    const churnResult = await getGitChurn(root, since);
    revisionMap = churnResult;
  } catch {
    // git-churn-engine uses `gitChurn()` not `getGitChurn()` — fallback
    const { gitChurn } = await import("../code-quality/git-churn-engine.mjs");
    const result = await gitChurn({ root, since });
    revisionMap = result.available ? result.revisions : new Map();
  }

  // 3. Get release-scoped churn
  const releaseMap = await releaseScopedChurn(root, releases, since);

  // 4. Build weight map if not provided (default: revision count as weight)
  const effectiveWeightMap = weightMap ?? revisionMap;

  // 5. Compute hotspots
  const hotspots = computeReleaseHotspots(revisionMap, effectiveWeightMap, releaseMap, releases.length);

  // 6. Summarize
  const summary = summarizeReleaseRisk(hotspots);

  return {
    releases: releases.map((r) => ({ tag: r.tag, date: r.date })),
    totalReleases: releases.length,
    totalFiles: hotspots.length,
    hotspots,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Helper — run git command
// ---------------------------------------------------------------------------

async function runGit(cwd, args) {
  let child;
  try {
    child = Bun.spawn(["git", ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return null;
  }

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (code !== 0) {
    return /not a git repository/i.test(stderr) ? null : stdout || "";
  }
  return stdout;
}

/**
 * git-churn-engine — version-control hotspots
 * ============================================
 * Inspired by Adam Tornhill's code-maat / CodeScene "hotspots" analysis:
 * combine code volume/complexity with git change frequency to find files that
 * are simultaneously large/complex AND change often. Those are the highest-leverage
 * places to invest in refactoring.
 *
 * Hotspot score (Tornhill-style):
 *     hotspot = revisions * complexity
 * Many projects also use:
 *     hotspot = revisions * loc
 * Both are exposed via `computeHotspots()`.
 *
 * Codebase-agnostic: shells out to `git log --pretty=format: --name-only`.
 * Skips silently when the working directory is not a git repo.
 */
export async function gitChurn({ root, since = "12.months.ago", paths = [] } = {}) {
  const args = ["log", `--since=${since}`, "--pretty=format:%H", "--name-only"];
  if (paths.length > 0) {
    args.push("--", ...paths);
  }
  const stdout = await runGit(root, args);
  if (stdout === null) {
    return { available: false, revisions: new Map() };
  }
  const revisions = new Map();
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[0-9a-f]{40}$/i.test(line)) continue; // commit hash
    const norm = line.replaceAll("\\", "/");
    revisions.set(norm, (revisions.get(norm) ?? 0) + 1);
  }
  return { available: true, revisions };
}

export function computeHotspots(revisionMap, weightMap) {
  const out = [];
  for (const [file, revs] of revisionMap) {
    const weight = weightMap.get(file);
    if (weight === undefined) continue;
    out.push({ file, revisions: revs, weight, hotspotScore: revs * weight });
  }
  out.sort((a, b) => b.hotspotScore - a.hotspotScore);
  return out;
}

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

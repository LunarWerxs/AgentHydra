import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "../atomic-write";
import { detectProject, type Detection } from "../detect";
import { DevWebUIFileSchema } from "../schema";

// ---------------------------------------------------------------------------
// Resolve a user-supplied path (pasted or dropped) to an absolute .devwebui
// file. Accepts the file itself, a folder containing exactly one, or a
// file:// URL (which is what browsers hand over on drag-and-drop).
// ---------------------------------------------------------------------------
export type LoadTarget =
  | { kind: "file"; file: string } // an existing .devwebui to load
  | { kind: "scaffold"; dir: string; fileName: string; proposal: Detection } // none here, but we can build one
  | { kind: "none"; message: string }; // nothing usable

/**
 * Resolve a pasted/dropped/cloned path into something actionable. Accepts a
 * .devwebui file, a folder (load its .devwebui or — if none — propose one from
 * the project's dev scripts), or any other file (treated as its parent folder,
 * so dropping a package.json / vite.config "just works").
 */
export async function resolveLoadTarget(input: string): Promise<LoadTarget> {
  const cleaned = fileUrlToLocalPath((input ?? "").trim());
  if (!cleaned)
    return { kind: "none", message: "Provide a path to a .devwebui file or its folder." };
  const abs = path.resolve(cleaned);

  const st = await stat(abs).catch(() => null);
  if (!st) return { kind: "none", message: `Path not found: ${abs}` };

  let dir = abs;
  if (st.isFile()) {
    if (abs.toLowerCase().endsWith(".devwebui")) return { kind: "file", file: abs };
    dir = path.dirname(abs); // dropped a package.json / vite.config / other file
  }

  const hits = (await readdir(dir, { withFileTypes: true }))
    .filter((d) => (d.isFile() || d.isSymbolicLink()) && d.name.toLowerCase().endsWith(".devwebui"))
    .map((d) => d.name);
  if (hits.length === 1) return { kind: "file", file: path.join(dir, hits[0]) };
  if (hits.length > 1)
    return {
      kind: "none",
      message: `Multiple .devwebui files in ${dir}: ${hits.join(", ")}. Paste the path to the one you want.`,
    };

  const proposal = await detectProject(dir);
  if (proposal)
    return { kind: "scaffold", dir, fileName: suggestFileName(proposal.name, dir), proposal };

  return {
    kind: "none",
    message: `No .devwebui file found in ${dir}, and no dev script to build one from. Add a .devwebui (see AI_GUIDE.md).`,
  };
}

function suggestFileName(_name: string, _dir: string): string {
  // One canonical, repo-rooted dotfile per codebase — like .gitignore. We OWN
  // this file (DevWebUI's source of truth), so it's always just `.devwebui`,
  // never `<name>.devwebui`.
  return ".devwebui";
}

/** Validate a proposed project and write it as `<dir>/<fileName>` (never overwrites). */
export function scaffoldDevWebUIFile(dir: string, fileName: string, data: unknown): string {
  let safeName = path.basename(fileName || "project.devwebui");
  if (!safeName.toLowerCase().endsWith(".devwebui")) safeName += ".devwebui";
  const target = path.join(path.resolve(dir), safeName);
  if (existsSync(target)) throw new Error(`${target} already exists.`);
  const valid = DevWebUIFileSchema.parse(data); // name + >=1 valid process
  writeJsonAtomic(target, valid);
  return target;
}

/** Turn a file:// URL (handed over by browser drag-and-drop) into a local path; pass others through. */
export function fileUrlToLocalPath(s: string): string {
  if (!/^file:\/\//i.test(s)) return s;
  try {
    const u = new URL(s);
    let p = decodeURIComponent(u.pathname);
    if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1); // "/D:/x" -> "D:/x"
    if (u.host) return `\\\\${u.host}${p.replace(/\//g, "\\")}`; // UNC: \\host\share\...
    return p;
  } catch {
    return s.replace(/^file:\/\//i, "");
  }
}

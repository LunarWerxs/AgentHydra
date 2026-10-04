import fs from "node:fs/promises";
import path from "node:path";
import { normalizePath } from "./path.mjs";

export function toPosixPath(value) {
  return normalizePath(value);
}

export async function pathExists(filePath) {
  // fs.access works for both files and directories; Bun.file().exists() returns
  // false for directories, which would break walkFiles' directory probing.
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function walkFiles({
  root,
  roots,
  extensions,
  skipSegments = [".git", "coverage", "dist", "node_modules", "tmp"],
}) {
  const extensionSet = new Set(extensions);
  const skipSet = new Set(skipSegments);
  const files = new Set();

  for (const scanRoot of roots) {
    const absoluteScanRoot = path.resolve(root, scanRoot);
    let stat;
    try {
      stat = await fs.stat(absoluteScanRoot);
    } catch {
      continue;
    }

    if (stat.isFile()) {
      if (!extensionSet.size || extensionSet.has(path.extname(absoluteScanRoot))) {
        files.add(toPosixPath(path.relative(root, absoluteScanRoot)));
      }
      continue;
    }

    const glob = new Bun.Glob("**/*");
    for await (const relPath of glob.scan({
      cwd: absoluteScanRoot,
      dot: false,
      onlyFiles: true,
    })) {
      const segments = relPath.split(/[/\\]/);
      if (segments.some((segment) => skipSet.has(segment))) continue;
      if (extensionSet.size && !extensionSet.has(path.extname(relPath))) continue;

      const absolutePath = path.resolve(absoluteScanRoot, relPath);
      files.add(toPosixPath(path.relative(root, absolutePath)));
    }
  }

  return [...files].sort((left, right) => left.localeCompare(right));
}

export async function countFileLines(root, filePath) {
  const text = await Bun.file(path.resolve(root, filePath)).text();
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}

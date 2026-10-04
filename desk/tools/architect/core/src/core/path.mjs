import path from "node:path";

export function normalizePath(filePath) {
  return filePath.replaceAll(path.sep, "/");
}

export function relativePath(root, filePath) {
  return normalizePath(path.relative(root, filePath));
}

export function resolveFromRoot(root, filePath) {
  return path.resolve(root, filePath);
}

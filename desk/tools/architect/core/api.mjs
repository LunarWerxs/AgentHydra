/**
 * Architect Core — stable check-authoring surface.
 *
 * The workspace-custom layer (the sibling `../local/` pack) imports core
 * primitives through THIS one file, via a relative path that assumes the fixed
 * sibling layout `architect/{core,local}/`:
 *
 *   from local/augment.mjs              →  ../core/api.mjs
 *   from local/checks/<cat>/<check>.mjs →  ../../../core/api.mjs
 *
 * Why a single surface: core stays copyable and its internals can move without
 * breaking any workspace's local pack — only this file's re-exports are the
 * contract. Need something not re-exported here? Import it directly from
 * `../../../core/src/core/<module>.mjs` and, if it's broadly useful, add it here.
 */

export { createFinding } from "./src/core/finding.mjs";
export { buildImportGraph, loadTsconfigAliases } from "./src/core/import-graph.mjs";
export { walkFiles, pathExists, toPosixPath } from "./src/core/files.mjs";

/**
 * Local policy augment — the specialization layer ("training data") for The
 * Architect's standard model. Copy this file verbatim into any new workspace;
 * it is workspace-agnostic and needs no edits.
 *
 * JOB: inject this repo's tsconfig path aliases (@core/*, @shared/*, @ui/*, …)
 * into every import-graph-based check, so reachability / dead-code analysis
 * resolves the SAME specifiers the TS compiler honors. Without this, every
 * alias import looks unresolved and the graph reports false orphans.
 *
 * WHY an augment (not hardcoded aliases in the JSON): tsconfig is the single
 * source of truth. `loadTsconfigAliases` re-derives the map on every run, so a
 * new alias in tsconfig.json is picked up automatically — no policy edit, no
 * drift.
 *
 * No tsconfig / no aliases? This is a no-op (returns the config untouched), so
 * it is safe to keep in a plain-JS repo too.
 */

import { loadTsconfigAliases } from "../core/api.mjs";

// Every check that builds an import graph and therefore needs alias resolution.
const GRAPH_CHECK_IDS = [
	"circular-deps",
	"dead-code",
	"dep-rules",
	"boot-graph",
	"unused-exports",
	"orphan-files",
	"module-rules",
	"feature-boundaries",
	"dependency-hygiene",
];

export default async function augment(config, { root }) {
	const aliases = await loadTsconfigAliases(root, "tsconfig.json");
	if (!aliases || Object.keys(aliases).length === 0) return config;

	config.checks = config.checks || {};
	for (const id of GRAPH_CHECK_IDS) {
		const check = config.checks[id];
		if (!check) continue;
		// dead-code is an umbrella: it reads aliases from nested orphanFiles /
		// unusedExports sub-configs, not the flat key. Inject into both.
		if (id === "dead-code") {
			if (check.orphanFiles) {
				check.orphanFiles.aliases = { ...aliases, ...(check.orphanFiles.aliases || {}) };
			}
			if (check.unusedExports) {
				check.unusedExports.aliases = { ...aliases, ...(check.unusedExports.aliases || {}) };
			}
			continue;
		}
		check.aliases = { ...aliases, ...(check.aliases || {}) };
	}
	return config;
}

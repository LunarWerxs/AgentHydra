/**
 * Boot Graph — connections-arkitect check
 * ========================================
 * Walks the STATIC import graph from configured entry points (default
 * src/main.ts) and flags files that statically import known-heavy deps
 * (libphonenumber-js, luxon, @tiptap/*, dompurify, minisearch, @aws-sdk/*,
 * @ionic/*, ionicons, maplibre-gl, papaparse, qrcode, rrule, tz-lookup).
 *
 * Heavy deps belong behind a dynamic `import(...)` (lazy route,
 * `defineAsyncComponent`, per-callsite loader) rather than nailed onto every
 * page's boot path. This check is preventive: it surfaces the static-import
 * chain BEFORE you ship, instead of finding the cost in a bundle-size
 * regression after the fact.
 *
 * Usage:
 *   bun packages/connections-arkitect/bin/audit.mjs --check boot-graph
 */
import { runBootGraphSection } from "@saydeploy/architect/engines/performance/boot-graph-engine";

function countByRuleKey(findings) {
  const out = {};
  for (const f of findings) {
    const ruleBucket = (out[f.ruleId] ??= {});
    ruleBucket[f.metadata.baselineKey] = (ruleBucket[f.metadata.baselineKey] ?? 0) + 1;
  }
  return out;
}

function renderChain(chain) {
  if (!chain || chain.length === 0) return "(entry)";
  if (chain.length === 1) return `${chain[0]} (entry)`;
  // Show entry → ... → file. Trim very long chains.
  if (chain.length <= 4) return chain.join(" → ");
  return `${chain[0]} → … → ${chain[chain.length - 2]} → ${chain[chain.length - 1]}`;
}

function renderReport({ findings, drift, hasBaseline, filesInBootGraph, entryPoints, byHeavyDep }) {
  const lines = [
    "# Boot Graph Audit",
    "",
    "_Heavy dependencies statically reachable from the app entry. These are loaded on every page._",
    "",
    `- Entry points: ${entryPoints.map((p) => `\`${p}\``).join(", ")}`,
    `- Files in boot graph: ${filesInBootGraph}`,
    `- Heavy static imports: ${findings.length}`,
    `- Drift tracking: ${hasBaseline ? `${drift.length} new static imports` : "disabled"}`,
    "",
  ];

  if (drift.length > 0) {
    lines.push("## Drift — NEW heavy static imports since baseline", "");
    for (const d of drift) {
      lines.push(`- \`${d.key}\``);
    }
    lines.push("");
  }

  const depEntries = Object.entries(byHeavyDep).sort(([, a], [, b]) => {
    const aSize = a[0]?.metadata.sizeGzKb ?? 0;
    const bSize = b[0]?.metadata.sizeGzKb ?? 0;
    return bSize - aSize;
  });

  for (const [dep, list] of depEntries) {
    const sizeKb = list[0]?.metadata.sizeGzKb ?? 0;
    lines.push(`## \`${dep}\` (~${sizeKb} KB gz) — ${list.length} static importer${list.length === 1 ? "" : "s"}`, "");
    lines.push(`_${list[0]?.message.split("— ")[1] ?? ""}_`, "");
    for (const f of list.slice(0, 30)) {
      const loc = `${f.filePath}:${f.line}`;
      const chain = renderChain(f.metadata.chain);
      lines.push(`- \`${loc}\``);
      lines.push(`  chain: ${chain}`);
    }
    if (list.length > 30) lines.push(`- …and ${list.length - 30} more`);
    lines.push("");
  }

  // Prefetch-storm findings live alongside the heavy-import findings but
  // describe a different failure mode — they're not categorized by heavy
  // dep so they don't show up in `byHeavyDep`.
  const stormFindings = findings.filter((f) => f.ruleId === "boot-graph-prefetch-storm");
  if (stormFindings.length > 0) {
    lines.push(`## Prefetch storms — ${stormFindings.length} finding${stormFindings.length === 1 ? "" : "s"}`, "");
    lines.push(
      "_`preload*()` / `prefetch*()` chains scheduled within the first few seconds of mount blow up the request count on the user's first paint window — each preload pulls a whole route's chunks + per-resource API/image fetches._",
      "",
    );
    for (const f of stormFindings.slice(0, 30)) {
      lines.push(`- \`${f.filePath}:${f.line}\` — ${f.message}`);
    }
    if (stormFindings.length > 30) lines.push(`- …and ${stormFindings.length - 30} more`);
    lines.push("");
  }

  if (findings.length === 0) {
    lines.push("No heavy static imports reachable from the entry. Boot graph stays lean.", "");
  } else {
    lines.push("## How to fix", "");
    lines.push(
      "- **At a callsite that uses the heavy dep**: wrap the import in a lazy loader (`let modPromise; function load() { modPromise ??= import('heavy'); return modPromise }`) and `await` it where the value is needed. Only flows that actually use the dep pay the cost.",
      "- **For widely-used components (modals, rich-text)**: convert the component to `defineAsyncComponent(() => import('...'))` so it only loads when rendered.",
      "- **For barrel files (`export * from`)**: drop the re-export of any sub-module that imports a heavy dep. Update its direct consumers to import from the specific file.",
      "- **For split-purpose utilities** (e.g. `phone.ts` exposed both `digitsOnlyPhone` (no lib) and `normalizePhoneToE164` (uses libphonenumber)): split the dep-free helpers into a sibling file so callers that don't need the heavy dep can import without it.",
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

export const audit = {
  id: "boot-graph",
  title: "Boot Graph — Heavy Static Imports",
  category: "architecture",
  defaultConfig: {
    includeInAll: true,
    entryPoints: ["src/main.ts"],
    aliases: {
      "@/": "src/",
      "@lunawerx/ui/": "packages/connections-ui/src/",
    },
    allowlistPath: "packages/connections-arkitect/policies/connections/allowlists/boot-graph-allowlists.json",
    outputPath: "tmp/audits/BOOT_GRAPH_AUDIT.md",
  },
  async run(context) {
    const cfg = context.checkConfig;
    const root = context.root;

    const result = await runBootGraphSection({
      root,
      sectionConfig: cfg,
    });

    const { findings, filesInBootGraph, entryPoints, byHeavyDep } = result;

    const current = countByRuleKey(findings);
    const baselineRules = (context.baseline && context.baseline.rules) || {};
    const hasBaseline = Object.keys(baselineRules).length > 0;
    const drift = [];
    if (hasBaseline) {
      for (const [ruleId, keys] of Object.entries(current)) {
        for (const [key, count] of Object.entries(keys)) {
          const base = baselineRules[ruleId]?.[key] ?? 0;
          if (count > base) drift.push({ ruleId, key, count, base });
        }
      }
    }

    const summary = findings.reduce(
      (acc, f) => {
        acc[f.severity] = (acc[f.severity] ?? 0) + 1;
        return acc;
      },
      { error: 0, warning: 0 },
    );

    return {
      failed: hasBaseline && drift.length > 0,
      findings,
      drift,
      jsonPayload: {
        findings,
        drift,
        summary,
        filesInBootGraph,
        entryPoints,
        heavyDepCount: Object.keys(byHeavyDep).length,
      },
      baselineDocument: { version: 1, generatedAt: new Date().toISOString(), rules: current },
      outputPath: cfg.outputPath,
      report: renderReport({
        findings,
        drift,
        hasBaseline,
        filesInBootGraph,
        entryPoints,
        byHeavyDep,
      }),
    };
  },
};

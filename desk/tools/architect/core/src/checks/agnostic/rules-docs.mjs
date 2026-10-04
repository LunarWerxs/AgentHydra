import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES_DOCS_DIR = path.resolve(HERE, "..", "..", "arkitect-core", "rules-docs");

export const audit = {
  id: "rules-docs",
  title: "Rules-Docs Catalog (codebase-agnostic)",
  category: "meta",
  defaultConfig: {
    enabled: true,
    includeInAll: false,
    outputPath: "tmp/audits/RULES_DOCS_CATALOG.md",
  },
  async run(context) {
    let entries;
    try {
      const files = (await fs.readdir(RULES_DOCS_DIR)).filter((name) => name.endsWith(".md")).sort();
      entries = await Promise.all(
        files.map(async (file) => {
          const absolute = path.join(RULES_DOCS_DIR, file);
          const content = await fs.readFile(absolute, "utf8");
          return {
            file,
            relativePath: path.relative(context.root, absolute).replace(/\\/g, "/"),
            sections: extractSections(content),
            bytes: content.length,
          };
        }),
      );
    } catch (error) {
      return {
        failed: false,
        report: `# Rules-Docs Catalog\n\nFailed to read ${RULES_DOCS_DIR}: ${error.message}\n`,
        outputPath: context.checkConfig.outputPath,
        jsonPayload: { entries: [], error: error.message },
      };
    }

    const report = renderMarkdown(entries);

    return {
      failed: false,
      report,
      outputPath: context.checkConfig.outputPath,
      jsonPayload: {
        totalDecks: entries.length,
        totalSections: entries.reduce((sum, entry) => sum + entry.sections.length, 0),
        entries,
      },
    };
  },
};

function extractSections(markdown) {
  return markdown
    .split("\n")
    .filter((line) => /^##\s+/.test(line))
    .map((line) => line.replace(/^##\s+/, "").trim());
}

function renderMarkdown(entries) {
  const totalSections = entries.reduce((sum, entry) => sum + entry.sections.length, 0);
  const lines = [
    "# Rules-Docs Catalog",
    "",
    "Cross-cutting engineering rule decks shipped with `arkitect-core/rules-docs/`.",
    "These are codebase-agnostic markdown references; project policies can opt in to",
    "any subset by importing them directly.",
    "",
    `- Decks: ${entries.length}`,
    `- Sections (\`## ...\`): ${totalSections}`,
    "",
    "## Decks",
    "",
    "| Deck | Sections | Path |",
    "| --- | ---: | --- |",
  ];

  for (const entry of entries) {
    const title = entry.file.replace(/\.md$/, "");
    lines.push(`| ${title} | ${entry.sections.length} | \`${entry.relativePath}\` |`);
  }

  lines.push("", "## Section index", "");
  for (const entry of entries) {
    const title = entry.file.replace(/\.md$/, "");
    lines.push(`### ${title}`, "");
    if (entry.sections.length === 0) {
      lines.push("_no `##` sections detected_", "");
      continue;
    }
    for (const section of entry.sections) {
      lines.push(`- ${section}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Inline suppression directives, inspired by fallow's ignore comments.
 *
 *   // arkitect-ignore-next-line <rule-id>[, <rule-id>…] [— <reason>]
 *   // arkitect-ignore-file <rule-id>[, <rule-id>…] [— <reason>]
 *
 * Multiple comma-separated rule ids are supported. `*` matches any rule.
 *
 * An optional human reason may follow the rule list after a dash/colon
 * separator (" — ", " – ", " -- ", " - ", or ": "). Rule ids are hyphenated
 * but never contain whitespace, so a dash/colon flanked by spaces
 * unambiguously begins the reason. Some checks REQUIRE a reason and treat a
 * reasonless suppression as its own finding — they read the reason via
 * `collectSuppressions(text)` rather than the boolean `applySuppressions`.
 *
 * Findings are filtered post-hoc by passing the file text and findings array
 * through `applySuppressions`.
 */

// The body matches any non-newline char, INCLUDING `*` — except a `*` that
// begins the `*/` block-comment terminator (so `/* … */` still ends cleanly).
// This is what lets the `*` wildcard rule (`arkitect-ignore-file *`) work.
const FILE_DIRECTIVE_RE = /(?:\/\/|\/\*|<!--|#)\s*arkitect-ignore-file\s+((?:[^\n*]|\*(?!\/))+?)(?:\*\/|-->|$)/g;
const LINE_DIRECTIVE_RE = /(?:\/\/|\/\*|<!--|#)\s*arkitect-ignore-next-line\s+((?:[^\n*]|\*(?!\/))+?)(?:\*\/|-->|$)/g;

// Reason separator: a dash (em/en/hyphen, 1–2) or colon flanked by space(s).
// Rule ids never contain whitespace, so an interior hyphen (e.g. `raw-button`)
// can never be mistaken for the reason boundary.
const REASON_SEPARATOR_RE = /\s+(?:[—–]|-{1,2})\s+|:\s+/;

/** @typedef {{ rules: string[], reason: string }} SuppressionEntry */

/** Split a directive body into its rule list and an optional trailing reason. */
function splitDirectiveBody(body) {
  const trimmed = body.trim();
  const match = REASON_SEPARATOR_RE.exec(trimmed);
  if (match && match.index > 0) {
    return {
      rules: parseRuleList(trimmed.slice(0, match.index)),
      reason: trimmed.slice(match.index + match[0].length).trim(),
    };
  }
  return { rules: parseRuleList(trimmed), reason: "" };
}

function parseRuleList(body) {
  return body
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function matchesRule(directiveRules, ruleId) {
  if (directiveRules.includes("*")) return true;
  return directiveRules.includes(ruleId);
}

function entriesMatchRule(entries, ruleId) {
  return entries.some((entry) => matchesRule(entry.rules, ruleId));
}

function findLineSuppressions(text) {
  const lineMap = new Map(); // 1-indexed target line -> SuppressionEntry[]
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    LINE_DIRECTIVE_RE.lastIndex = 0;
    let match;
    while ((match = LINE_DIRECTIVE_RE.exec(line))) {
      const target = index + 2; // 1-indexed, "next line" = index+2
      const existing = lineMap.get(target) ?? [];
      lineMap.set(target, [...existing, splitDirectiveBody(match[1])]);
    }
  }
  return lineMap;
}

function findFileSuppressions(text) {
  const entries = [];
  FILE_DIRECTIVE_RE.lastIndex = 0;
  let match;
  while ((match = FILE_DIRECTIVE_RE.exec(text))) {
    entries.push(splitDirectiveBody(match[1]));
  }
  return entries;
}

/**
 * Parse every inline directive in a file's text into structured, reason-bearing
 * entries. Callers that need to distinguish "justified (has a reason)" from
 * "invalid (reasonless)" suppressions use this; `applySuppressions` is the
 * boolean shortcut for callers that only need to drop suppressed findings.
 *
 * @param {string} text
 * @returns {{ file: SuppressionEntry[], lines: Map<number, SuppressionEntry[]> }}
 */
export function collectSuppressions(text) {
  return {
    file: findFileSuppressions(text),
    lines: findLineSuppressions(text),
  };
}

/**
 * Return the suppression entry that covers `(ruleId, line)` — a file-level
 * directive wins over a line-level one — or `null` if the finding is not
 * suppressed. Lets a check tell actionable (null) from justified (entry with a
 * reason) from invalid (entry with an empty reason).
 *
 * @param {{ file: SuppressionEntry[], lines: Map<number, SuppressionEntry[]> }} suppressions
 * @returns {SuppressionEntry | null}
 */
export function matchingSuppression(suppressions, line, ruleId) {
  const fileMatch = suppressions.file.find((entry) => matchesRule(entry.rules, ruleId));
  if (fileMatch) return fileMatch;
  const lineEntries = suppressions.lines.get(line) ?? [];
  return lineEntries.find((entry) => matchesRule(entry.rules, ruleId)) ?? null;
}

export function applySuppressions(findings, fileTextByPath) {
  if (!fileTextByPath || findings.length === 0) return findings;
  const cache = new Map();
  function suppressionsFor(filePath) {
    if (cache.has(filePath)) return cache.get(filePath);
    const text = fileTextByPath.get(filePath);
    const entry = text ? collectSuppressions(text) : { file: [], lines: new Map() };
    cache.set(filePath, entry);
    return entry;
  }

  return findings.filter((finding) => {
    const directives = suppressionsFor(finding.filePath);
    if (entriesMatchRule(directives.file, finding.ruleId)) return false;
    const lineEntries = directives.lines.get(finding.line) ?? [];
    if (lineEntries.length > 0 && entriesMatchRule(lineEntries, finding.ruleId)) return false;
    return true;
  });
}

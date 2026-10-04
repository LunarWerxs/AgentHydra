import fs from "node:fs";
import path from "node:path";

import { createFinding } from "@saydeploy/architect/core/finding";
import { normalizePath, relativePath } from "@saydeploy/architect/core/path";

export const STRIPE_ARCHITECTURE_DEFAULTS = {
  scanRoots: ["infra/lambda/src"],
  scanExtensions: [".ts"],
  outputPath: "tmp/audits/STRIPE_ARCHITECTURE_AUDIT.md",
  allowedRawStripeFiles: ["infra/lambda/src/_shared/stripe.ts"],
  allowedWebhookVerifierFiles: ["infra/lambda/src/_shared/stripe-webhook.ts"],
  allowedSecretEnvFiles: ["infra/lambda/src/_shared/stripe.ts", "infra/lambda/src/_shared/stripe-webhook.ts"],
  rawStripeApiPattern: "https://api\\.stripe\\.com|new URL\\(['/\"]\\/oauth\\/token['\"]",
  stripeSecretEnvPattern:
    "process\\.env\\.STRIPE_SECRET_KEY_ARN|process\\.env\\.STRIPE_WEBHOOK_SECRET_ARN|process\\.env\\.STRIPE_CONNECT_WEBHOOK_SECRET_ARN",
  stripeAccountHeaderPattern: "Stripe-Account",
};

const SKIP_DIRECTORY_NAMES = new Set(["node_modules", "dist", "coverage", ".git"]);

function walkSourceTree(root, rootRelative, extensions) {
  const absolute = path.resolve(root, rootRelative);
  if (!fs.existsSync(absolute)) return [];
  const stack = [absolute];
  const out = [];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIRECTORY_NAMES.has(entry.name)) continue;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(child);
        continue;
      }
      if (extensions.includes(path.extname(entry.name)) && !/\.spec\.ts$/.test(entry.name)) out.push(child);
    }
  }
  return out;
}

function lineNumberFor(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index && cursor < source.length; cursor += 1) {
    if (source[cursor] === "\n") line += 1;
  }
  return line;
}

function firstMatch(source, pattern) {
  pattern.lastIndex = 0;
  return pattern.exec(source);
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => " ".repeat(match.length))
    .replace(/(^|[^:])\/\/.*$/gm, (match, prefix) => `${prefix}${" ".repeat(Math.max(0, match.length - prefix.length))}`);
}

function renderReport({ findings, scannedFileCount }) {
  const lines = ["# Stripe Architecture", "", `Scanned ${scannedFileCount} Lambda source files.`, ""];
  if (findings.length === 0) {
    lines.push(
      "Stripe transport, Stripe secrets, connected-account headers, and incoming Stripe webhook HMAC verification are centralized.",
      "",
    );
    return lines.join("\n");
  }
  lines.push(`## Findings (${findings.length})`, "");
  for (const finding of findings) {
    lines.push(`- \`${finding.filePath}:${finding.line}\` — ${finding.message}`);
  }
  lines.push(
    "",
    "Stripe API calls must go through `infra/lambda/src/_shared/stripe.ts`. Incoming Stripe webhook HMAC verification must go through `infra/lambda/src/_shared/stripe-webhook.ts`.",
    "",
  );
  return lines.join("\n");
}

export function runStripeArchitectureAudit({ root, checkConfig = {} } = {}) {
  const absoluteRoot = path.resolve(root ?? process.cwd());
  const config = { ...STRIPE_ARCHITECTURE_DEFAULTS, ...checkConfig };
  const allowedRawStripeFiles = new Set((config.allowedRawStripeFiles ?? []).map(normalizePath));
  const allowedWebhookVerifierFiles = new Set((config.allowedWebhookVerifierFiles ?? []).map(normalizePath));
  const allowedSecretEnvFiles = new Set((config.allowedSecretEnvFiles ?? []).map(normalizePath));
  const rawStripeApiPattern = new RegExp(config.rawStripeApiPattern, "g");
  const stripeSecretEnvPattern = new RegExp(config.stripeSecretEnvPattern, "g");
  const stripeAccountHeaderPattern = new RegExp(config.stripeAccountHeaderPattern, "g");

  const files = (config.scanRoots ?? STRIPE_ARCHITECTURE_DEFAULTS.scanRoots).flatMap((rootRelative) =>
    walkSourceTree(absoluteRoot, rootRelative, config.scanExtensions ?? STRIPE_ARCHITECTURE_DEFAULTS.scanExtensions),
  );
  const findings = [];

  for (const fileAbsolute of files) {
    const fileRelative = relativePath(absoluteRoot, fileAbsolute);
    const text = fs.readFileSync(fileAbsolute, "utf8");
    const code = stripComments(text);

    const rawStripeMatch = firstMatch(code, rawStripeApiPattern);
    if (rawStripeMatch && !allowedRawStripeFiles.has(fileRelative)) {
      findings.push(
        createFinding({
          ruleId: "stripe-raw-api-outside-shared",
          severity: "error",
          filePath: fileRelative,
          line: lineNumberFor(text, rawStripeMatch.index),
          message: "Stripe API base URLs and OAuth token exchange must be centralized in _shared/stripe.ts.",
          metadata: { fileRelative },
        }),
      );
    }

    const secretMatch = firstMatch(code, stripeSecretEnvPattern);
    if (secretMatch && !allowedSecretEnvFiles.has(fileRelative)) {
      findings.push(
        createFinding({
          ruleId: "stripe-secret-env-outside-shared",
          severity: "error",
          filePath: fileRelative,
          line: lineNumberFor(text, secretMatch.index),
          message: "Stripe secret environment variables must be read only by shared Stripe helpers.",
          metadata: { fileRelative },
        }),
      );
    }

    const accountHeaderMatch = firstMatch(code, stripeAccountHeaderPattern);
    if (accountHeaderMatch && !allowedRawStripeFiles.has(fileRelative)) {
      findings.push(
        createFinding({
          ruleId: "stripe-account-header-outside-shared",
          severity: "error",
          filePath: fileRelative,
          line: lineNumberFor(text, accountHeaderMatch.index),
          message: "Stripe-Account header handling must stay centralized in _shared/stripe.ts.",
          metadata: { fileRelative },
        }),
      );
    }

    if (code.includes("Stripe-Signature") && code.includes("createHmac") && !allowedWebhookVerifierFiles.has(fileRelative)) {
      findings.push(
        createFinding({
          ruleId: "stripe-webhook-hmac-outside-shared",
          severity: "error",
          filePath: fileRelative,
          line: lineNumberFor(text, text.indexOf("Stripe-Signature")),
          message: "Stripe webhook HMAC verification must use _shared/stripe-webhook.ts.",
          metadata: { fileRelative },
        }),
      );
    }
  }

  findings.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line);
  return {
    failed: findings.length > 0,
    findings,
    jsonPayload: { scannedFileCount: files.length, findingCount: findings.length, findings },
    outputPath: config.outputPath,
    report: renderReport({ findings, scannedFileCount: files.length }),
  };
}

import fs from "node:fs";
import path from "node:path";

import { createFinding } from "@saydeploy/architect/core/finding";
import { normalizePath, relativePath } from "@saydeploy/architect/core/path";

export const AUTH_LOGIN_METHODS_DEFAULTS = {
  authRoots: ["src/components/sign-in"],
  authExtensions: [".ts", ".vue"],
  requiredTransitionsFile: "src/components/sign-in/signInFlowTransitions.ts",
  requiredTransitionsTokens: ["availableChallenges", "hasRealPassword", "PASSWORD"],
  smsAvailableToken: "smsAvailable",
  smsChallengeToken: "SMS_OTP",
  passwordToken: "password-login",
  passwordChallengeTokens: ["hasRealPassword", "PASSWORD"],
  smsGateScopePatterns: ["SignInPrimaryFlowPanel\\.vue$", "signInFlowTransitions\\.ts$"],
  passwordGateScopePatterns: ["SignInPrimaryFlowPanel\\.vue$", "signInFlowTransitions\\.ts$", "useSignInFlow\\.ts$"],
  skipFilePatterns: ["\\.spec\\.[cm]?[tj]sx?$", "(?:^|/)__tests__/", "/types\\.ts$"],
};

const SKIP_DIRECTORY_NAMES = new Set(["node_modules", "dist", "coverage"]);

function walk(root, rootRelative, extensions) {
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
      if (extensions.includes(path.extname(entry.name))) {
        out.push(child);
      }
    }
  }
  return out;
}

function matchesAny(value, compiledPatterns) {
  for (const pattern of compiledPatterns) {
    if (pattern.test(value)) return true;
  }
  return false;
}

function renderReport({ findings, scannedFileCount }) {
  const lines = [
    "# Auth Login Methods",
    "",
    `Scanned ${scannedFileCount} sign-in source files for Cognito-challenge gating.`,
    "",
  ];

  if (findings.length === 0) {
    lines.push(
      "Login-method gating shape is intact: the transitions module references the required tokens, and SMS gating uses both the verified-phone signal and the SMS_OTP Cognito challenge.",
      "",
    );
    return lines.join("\n");
  }

  lines.push(`## Findings (${findings.length})`, "");
  for (const finding of findings) {
    lines.push(`- \`${finding.filePath}\` — ${finding.message}`);
  }
  lines.push(
    "",
    "See [SYSTEM_CONTRACTS.md → Auth Login Contract](../../docs/architecture/SYSTEM_CONTRACTS.md#auth-login-contract). The UI must never invent a challenge Cognito did not advertise; password must hide for ghost-password-only accounts.",
    "",
  );
  return lines.join("\n");
}

export function runAuthLoginMethodsAudit({ root, checkConfig = {} } = {}) {
  const absoluteRoot = path.resolve(root ?? process.cwd());
  const authRoots = checkConfig.authRoots?.length ? checkConfig.authRoots : AUTH_LOGIN_METHODS_DEFAULTS.authRoots;
  const authExtensions = checkConfig.authExtensions?.length
    ? checkConfig.authExtensions
    : AUTH_LOGIN_METHODS_DEFAULTS.authExtensions;
  const requiredTransitionsFile =
    checkConfig.requiredTransitionsFile ?? AUTH_LOGIN_METHODS_DEFAULTS.requiredTransitionsFile;
  const requiredTransitionsTokens = checkConfig.requiredTransitionsTokens?.length
    ? checkConfig.requiredTransitionsTokens
    : AUTH_LOGIN_METHODS_DEFAULTS.requiredTransitionsTokens;
  const smsAvailableToken = checkConfig.smsAvailableToken ?? AUTH_LOGIN_METHODS_DEFAULTS.smsAvailableToken;
  const smsChallengeToken = checkConfig.smsChallengeToken ?? AUTH_LOGIN_METHODS_DEFAULTS.smsChallengeToken;
  const passwordToken = checkConfig.passwordToken ?? AUTH_LOGIN_METHODS_DEFAULTS.passwordToken;
  const passwordChallengeTokens = checkConfig.passwordChallengeTokens?.length
    ? checkConfig.passwordChallengeTokens
    : AUTH_LOGIN_METHODS_DEFAULTS.passwordChallengeTokens;
  const skipFilePatterns = (
    checkConfig.skipFilePatterns?.length ? checkConfig.skipFilePatterns : AUTH_LOGIN_METHODS_DEFAULTS.skipFilePatterns
  ).map((source) => new RegExp(source));
  const smsGateScopePatterns = (
    checkConfig.smsGateScopePatterns?.length
      ? checkConfig.smsGateScopePatterns
      : AUTH_LOGIN_METHODS_DEFAULTS.smsGateScopePatterns
  ).map((source) => new RegExp(source));
  const passwordGateScopePatterns = (
    checkConfig.passwordGateScopePatterns?.length
      ? checkConfig.passwordGateScopePatterns
      : AUTH_LOGIN_METHODS_DEFAULTS.passwordGateScopePatterns
  ).map((source) => new RegExp(source));

  const findings = [];

  const absoluteTransitionsPath = path.resolve(absoluteRoot, requiredTransitionsFile);
  if (!fs.existsSync(absoluteTransitionsPath)) {
    findings.push(
      createFinding({
        ruleId: "auth-login-methods-transitions-missing",
        severity: "error",
        filePath: normalizePath(requiredTransitionsFile),
        line: 0,
        message: `Sign-in transitions module ${requiredTransitionsFile} is missing. This module is the canonical Cognito-challenge gate.`,
      }),
    );
  } else {
    const transitionsText = fs.readFileSync(absoluteTransitionsPath, "utf8");
    for (const token of requiredTransitionsTokens) {
      if (!transitionsText.includes(token)) {
        findings.push(
          createFinding({
            ruleId: "auth-login-methods-transitions-missing-token",
            severity: "error",
            filePath: normalizePath(requiredTransitionsFile),
            line: 0,
            message: `Sign-in transitions module does not reference "${token}". Login-method visibility must combine Cognito challenge availability with verified-state flags.`,
            metadata: { token },
          }),
        );
      }
    }
  }

  const files = authRoots.flatMap((rootRelative) => walk(absoluteRoot, rootRelative, authExtensions));
  for (const fileAbsolute of files) {
    const fileRelative = relativePath(absoluteRoot, fileAbsolute);
    if (matchesAny(fileRelative, skipFilePatterns)) continue;
    const text = fs.readFileSync(fileAbsolute, "utf8");

    const inSmsGateScope = matchesAny(fileRelative, smsGateScopePatterns);
    if (inSmsGateScope && text.includes(smsAvailableToken) && !text.includes(smsChallengeToken)) {
      findings.push(
        createFinding({
          ruleId: "auth-login-methods-sms-missing-challenge",
          severity: "error",
          filePath: fileRelative,
          line: 0,
          message: `File references ${smsAvailableToken} but never checks ${smsChallengeToken}. SMS visibility must combine verified-phone state with the Cognito ${smsChallengeToken} challenge.`,
          metadata: { fileRelative },
        }),
      );
    }

    const inPasswordGateScope = matchesAny(fileRelative, passwordGateScopePatterns);
    if (inPasswordGateScope && text.includes(passwordToken)) {
      const hasPasswordGate = passwordChallengeTokens.some((token) => text.includes(token));
      if (!hasPasswordGate) {
        findings.push(
          createFinding({
            ruleId: "auth-login-methods-password-missing-gate",
            severity: "error",
            filePath: fileRelative,
            line: 0,
            message: `File handles "${passwordToken}" but does not reference any of [${passwordChallengeTokens.join(", ")}]. Ghost-password-only accounts must not see a password option.`,
            metadata: { fileRelative },
          }),
        );
      }
    }
  }

  findings.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.ruleId.localeCompare(b.ruleId));

  return {
    failed: findings.length > 0,
    findings,
    jsonPayload: {
      scannedFileCount: files.length,
      findingCount: findings.length,
      findings,
    },
    report: renderReport({
      findings,
      scannedFileCount: files.length,
    }),
  };
}

import { AUTH_LOGIN_METHODS_DEFAULTS, runAuthLoginMethodsAudit } from "@saydeploy/architect/engines/contracts/auth-login-methods-engine";

export const audit = {
  id: "auth-login-methods",
  title: "Auth Login Methods",
  category: "backend",
  requires: { projectNames: ["connections"] },
  defaultConfig: {
    ...AUTH_LOGIN_METHODS_DEFAULTS,
    outputPath: "tmp/audits/AUTH_LOGIN_METHODS_AUDIT.md",
  },
  async run(context) {
    const result = runAuthLoginMethodsAudit({
      root: context.root,
      checkConfig: context.checkConfig,
    });
    return {
      failed: result.failed,
      findings: result.findings,
      jsonPayload: result.jsonPayload,
      report: result.report,
      outputPath: context.checkConfig.outputPath,
    };
  },
};

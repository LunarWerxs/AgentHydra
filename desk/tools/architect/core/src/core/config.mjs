import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..", "..");

/**
 * Load the arkitect audit config. Resolution order:
 *   1. Explicit --config path
 *   2. Explicit --policy-dir path
 *   3. ARKITECT_POLICY_DIR env var
 *   4. Named policy under <root>/.arkitect/<policy>/
 *   5. <root>/.arkitect/arkitect.audit.config.json
 *   6. <root>/arkitect.config.json
 *   7. Named policy under this package's policies/<policy>/
 *
 * After load, any `augments` entries declared in the config (file paths
 * relative to the config's directory) are imported and applied in order.
 */
export async function loadAuditConfig({ root, configPath = "", policyDir = "", policy = "" }) {
  const resolvedPath = await resolveAuditConfigPath(root, { configPath, policyDir, policy });
  const config = JSON.parse(await fs.readFile(resolvedPath, "utf8"));
  return applyAugments(config, { configPath: resolvedPath, root });
}

export async function resolveAuditConfigPath(root, { configPath = "", policyDir = "", policy = "" } = {}) {
  const candidates = [];
  const normalizedPolicy = String(policy || process.env.ARKITECT_POLICY || "").trim();

  if (configPath) {
    candidates.push(path.resolve(root, configPath));
  }

  addPolicyDirCandidates(candidates, root, policyDir, normalizedPolicy);
  const envPolicyDir = process.env.ARKITECT_POLICY_DIR;
  addPolicyDirCandidates(candidates, root, envPolicyDir, normalizedPolicy);

  if (normalizedPolicy) {
    candidates.push(path.resolve(root, ".arkitect", normalizedPolicy, `${normalizedPolicy}.audit.config.json`));
  }

  candidates.push(path.resolve(root, ".arkitect", "arkitect.audit.config.json"));
  candidates.push(path.resolve(root, "arkitect.config.json"));

  if (normalizedPolicy) {
    candidates.push(path.resolve(PACKAGE_ROOT, "policies", normalizedPolicy, `${normalizedPolicy}.audit.config.json`));
  }

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  const tried = candidates.map((p) => path.relative(root, p)).join("\n  - ");
  throw new Error(
    `Unable to locate arkitect audit config. Tried (in order):\n  - ${tried}\n` +
      `Pass --config, set ARKITECT_POLICY_DIR, or place arkitect.config.json in the project root.`,
  );
}

function addPolicyDirCandidates(candidates, root, policyDir, policy) {
  if (!policyDir) return;
  const resolvedDir = path.resolve(root, policyDir);
  if (policy) {
    candidates.push(path.resolve(resolvedDir, policy, `${policy}.audit.config.json`));
  }
  candidates.push(path.resolve(resolvedDir, "arkitect.audit.config.json"));
  if (policy) {
    candidates.push(path.resolve(resolvedDir, `${policy}.audit.config.json`));
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function applyAugments(config, { configPath, root }) {
  const augments = Array.isArray(config?.augments) ? config.augments : [];
  if (augments.length === 0) return config;

  const configDir = path.dirname(configPath);
  let result = config;
  for (const entry of augments) {
    if (typeof entry !== "string" || !entry) continue;
    const absolute = path.isAbsolute(entry) ? entry : path.resolve(configDir, entry);
    const module = await import(pathToFileURL(absolute).href);
    const augment = module.default ?? module.augment;
    if (typeof augment !== "function") {
      throw new Error(`Augment "${entry}" must export a default function. Got ${typeof augment}.`);
    }
    result = (await augment(result, { configDir, root, configPath })) ?? result;
  }
  return result;
}

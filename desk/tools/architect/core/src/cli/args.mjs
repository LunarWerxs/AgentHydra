export function parseAuditCliArgs(argv) {
  const options = {
    all: false,
    checkId: "",
    command: "help",
    format: "",
    outputPath: "",
    configPath: "",
    policyDir: "",
    policy: "",
    quiet: false,
    rawCheckArgs: [],
    failOnDrift: false,
    /**
     * Max number of audits to run concurrently. Default 8 — most checks are
     * pure file-read + regex so they parallelize cleanly. Set to 1 for
     * deterministic serial output when debugging a flaky check.
     */
    concurrency: 8,
  };

  const passthrough = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "list" || arg === "help" || arg === "--help" || arg === "-h") {
      options.command = arg === "list" ? "list" : "help";
      continue;
    }

    if (arg === "--all") {
      options.all = true;
      options.command = "run";
      continue;
    }

    if (arg === "--check") {
      options.checkId = argv[index + 1] ?? "";
      options.command = "run";
      index += 1;
      continue;
    }

    if (arg.startsWith("--check=")) {
      options.checkId = arg.slice("--check=".length);
      options.command = "run";
      continue;
    }

    if (arg === "--format" || arg === "--output-format") {
      options.format = argv[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg.startsWith("--format=")) {
      options.format = arg.slice("--format=".length);
      continue;
    }

    if (arg === "--output") {
      options.outputPath = argv[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg.startsWith("--output=")) {
      options.outputPath = arg.slice("--output=".length);
      continue;
    }

    if (arg === "--config") {
      options.configPath = argv[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg.startsWith("--config=")) {
      options.configPath = arg.slice("--config=".length);
      continue;
    }

    if (arg === "--policy-dir") {
      options.policyDir = argv[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg.startsWith("--policy-dir=")) {
      options.policyDir = arg.slice("--policy-dir=".length);
      continue;
    }

    if (arg === "--policy") {
      options.policy = argv[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg.startsWith("--policy=")) {
      options.policy = arg.slice("--policy=".length);
      continue;
    }

    if (arg === "--fail-on-drift") {
      options.failOnDrift = true;
      continue;
    }

    if (arg === "--quiet") {
      options.quiet = true;
      continue;
    }

    if (arg === "--concurrency") {
      options.concurrency = clampConcurrency(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith("--concurrency=")) {
      options.concurrency = clampConcurrency(arg.slice("--concurrency=".length));
      continue;
    }

    if (arg === "--serial") {
      options.concurrency = 1;
      continue;
    }

    if (!options.checkId && !arg.startsWith("-")) {
      options.checkId = arg;
      continue;
    }

    passthrough.push(arg);
  }

  options.rawCheckArgs = passthrough;
  return options;
}

function clampConcurrency(value) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > 32) return 32;
  return n;
}

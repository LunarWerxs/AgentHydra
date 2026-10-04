import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import puppeteer from "puppeteer-core";
import { screenshotScenarios } from "./scenarios.mjs";

const root = process.cwd();
const chromePath = "C:/Program Files/Google/Chrome/Application/chrome.exe";

export async function runScreenshotCli(argv = []) {
  const options = parseArgs(argv);

  if (options.list) {
    for (const [name, scenario] of Object.entries(screenshotScenarios)) {
      console.log(`${name}\t${scenario.description}`);
    }
    return;
  }

  const scenario = screenshotScenarios[options.scenarioName];
  if (!scenario) {
    console.error(`Unknown screenshot audit scenario: ${options.scenarioName}`);
    console.error(`Available scenarios: ${Object.keys(screenshotScenarios).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const browser = await puppeteer.launch({
    executablePath: options.chromePath || chromePath,
    headless: true,
    args: ["--no-sandbox", "--window-size=1400,1000"],
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  });

  try {
    const result =
      scenario.kind === "visual-regression"
        ? await runVisualRegressionScenario(browser, scenario, options)
        : await runCaptureSetScenario(browser, scenario, options);

    console.log(JSON.stringify(result, null, 2));
    if (result.failed) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

async function runVisualRegressionScenario(browser, scenario, options) {
  await mkdir(scenario.currentDir, { recursive: true });
  await mkdir(scenario.diffDir, { recursive: true });

  let failed = false;
  const results = [];
  const page = await browser.newPage();
  await page.setViewport(scenario.viewport);
  await page.goto(scenario.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  if (scenario.waitFor) await page.waitForFunction(scenario.waitFor, { timeout: 30_000 });
  if (scenario.prepare) await scenario.prepare(page);

  const target = await scenario.target(page);
  if (!target) {
    throw new Error(`Scenario ${scenario.name} did not resolve a screenshot target element.`);
  }

  await target.scrollIntoView();
  await waitFor(400);

  for (const state of scenario.states) {
    if (state.before) await state.before(page);

    const currentPath = path.join(scenario.currentDir, `${state.name}.png`);
    await target.screenshot({ path: currentPath });
    const goldenPath = path.join(scenario.goldenDir, `${state.name}.png`);

    if (options.updateGoldens) {
      await mkdir(scenario.goldenDir, { recursive: true });
      await writeFile(goldenPath, await readFile(currentPath));
      results.push({ name: state.name, status: "golden-updated" });
      continue;
    }

    if (!existsSync(goldenPath)) {
      results.push({ name: state.name, status: "golden-missing" });
      failed = true;
      continue;
    }

    const diff = await diffPng(goldenPath, currentPath, path.join(scenario.diffDir, `${state.name}.diff.png`));
    if (diff.fractionDiffering > options.tolerance) {
      results.push({ name: state.name, status: "drift", ...diff });
      failed = true;
    } else {
      results.push({ name: state.name, status: "ok", fractionDiffering: diff.fractionDiffering });
    }
  }

  await page.close();

  if (!options.keepCurrent && !failed && !options.updateGoldens) {
    await rm(scenario.currentDir, { recursive: true, force: true });
    await rm(scenario.diffDir, { recursive: true, force: true });
  }

  return {
    failed,
    kind: scenario.kind,
    scenario: scenario.name,
    tolerance: options.tolerance,
    results,
  };
}

async function runCaptureSetScenario(browser, scenario, _options) {
  await mkdir(scenario.outDir, { recursive: true });
  const results = [];
  let failed = false;

  for (const capture of scenario.captures) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const viewport = capture.viewport ?? { width: 1440, height: 900, deviceScaleFactor: 1 };
    await page.setViewport(viewport);
    page.on("pageerror", (error) => console.log("PAGEERR", error.message));

    await page.evaluateOnNewDocument(
      (payload) => {
        try {
          window.localStorage.setItem("connections.theme-preference.v1", payload.theme);
          for (const [key, value] of Object.entries(payload.localStorage ?? {})) {
            window.localStorage.setItem(key, value);
          }
        } catch {
          // Best-effort localStorage bootstrap only.
        }
        document.documentElement?.setAttribute("data-resolved-theme", payload.theme);
        document.documentElement?.setAttribute("data-theme-preference", payload.theme);
      },
      { theme: capture.theme ?? "light", localStorage: capture.localStorage ?? {} },
    );

    await page.goto(resolveCaptureUrl(scenario, capture), { waitUntil: "networkidle0", timeout: 60_000 });
    await page.evaluate(() => document.fonts?.ready);
    await waitFor(capture.settleMs ?? 1_000);
    await page.keyboard.press("Escape").catch(() => {});
    await page.evaluate(() => {
      document.querySelectorAll("vite-error-overlay").forEach((element) => element.remove());
      document.activeElement?.blur?.();
    });
    await waitFor(200);

    if (capture.before) await capture.before(page);

    const assertion = capture.assert ? await capture.assert(page) : null;
    if (assertion?.failed) failed = true;

    if (capture.screenshot === false) {
      results.push({ name: capture.name, status: assertion?.failed ? "failed" : "checked", ...(assertion ?? {}) });
      await context.close();
      continue;
    }

    const clip = typeof capture.clip === "function" ? await capture.clip(page) : capture.clip;
    const outputPath = path.join(scenario.outDir, `${capture.name}.png`);
    const screenshotOptions = {
      path: outputPath,
      fullPage: capture.fullPage ?? false,
    };
    if (clip) screenshotOptions.clip = clip;
    await page.screenshot(screenshotOptions);
    results.push({
      name: capture.name,
      status: assertion?.failed ? "failed" : "captured",
      path: path.relative(root, outputPath).replaceAll(path.sep, "/"),
      ...(assertion ?? {}),
    });
    await context.close();
  }

  return {
    failed,
    kind: scenario.kind,
    scenario: scenario.name,
    outDir: path.relative(root, scenario.outDir).replaceAll(path.sep, "/"),
    results,
  };
}

function parseArgs(argv) {
  const options = {
    chromePath: "",
    keepCurrent: false,
    list: false,
    scenarioName: "shared-primitives-table",
    tolerance: 0.01,
    updateGoldens: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--list") options.list = true;
    else if (arg === "--keep-current") options.keepCurrent = true;
    else if (arg === "--update-goldens") options.updateGoldens = true;
    else if (arg === "--scenario") {
      options.scenarioName = argv[index + 1] ?? options.scenarioName;
      index += 1;
    } else if (arg.startsWith("--scenario=")) options.scenarioName = arg.slice("--scenario=".length);
    else if (arg === "--tolerance") {
      options.tolerance = Number.parseFloat(argv[index + 1] ?? `${options.tolerance}`);
      index += 1;
    } else if (arg.startsWith("--tolerance=")) options.tolerance = Number.parseFloat(arg.slice("--tolerance=".length));
    else if (arg === "--chrome") {
      options.chromePath = argv[index + 1] ?? "";
      index += 1;
    } else if (arg.startsWith("--chrome=")) options.chromePath = arg.slice("--chrome=".length);
    else throw new Error(`Unknown screenshot audit argument: ${arg}`);
  }

  return options;
}

function resolveCaptureUrl(scenario, capture) {
  if (capture.url) return capture.url;
  return `${scenario.baseUrl}${capture.path ?? "/"}`;
}

async function diffPng(goldenPath, currentPath, diffOut, channelTolerance = 16) {
  const golden = PNG.sync.read(await readFile(goldenPath));
  const current = PNG.sync.read(await readFile(currentPath));

  if (golden.width !== current.width || golden.height !== current.height) {
    return {
      fractionDiffering: 1,
      diffPixels: golden.width * golden.height,
      totalPixels: golden.width * golden.height,
      reason: `dimension mismatch: golden ${golden.width}x${golden.height} vs current ${current.width}x${current.height}`,
    };
  }

  const total = golden.width * golden.height;
  const diff = new PNG({ width: golden.width, height: golden.height });
  let differing = 0;

  for (let i = 0; i < golden.data.length; i += 4) {
    const dr = Math.abs(golden.data[i] - current.data[i]);
    const dg = Math.abs(golden.data[i + 1] - current.data[i + 1]);
    const db = Math.abs(golden.data[i + 2] - current.data[i + 2]);
    const da = Math.abs(golden.data[i + 3] - current.data[i + 3]);
    const isDiff = dr > channelTolerance || dg > channelTolerance || db > channelTolerance || da > channelTolerance;

    if (isDiff) {
      differing += 1;
      diff.data[i] = 255;
      diff.data[i + 1] = 0;
      diff.data[i + 2] = 0;
      diff.data[i + 3] = 255;
    } else {
      diff.data[i] = golden.data[i];
      diff.data[i + 1] = golden.data[i + 1];
      diff.data[i + 2] = golden.data[i + 2];
      diff.data[i + 3] = 80;
    }
  }

  await writeFile(diffOut, PNG.sync.write(diff));
  return { fractionDiffering: differing / total, diffPixels: differing, totalPixels: total };
}

function waitFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { PNG } from "pngjs";
import puppeteer from "puppeteer-core";

const DEFAULT_URL = "http://localhost:4173/_connections/internal/spl26-shared-primitives-live-2026";
const DEFAULT_FIXED_ICON_TARGETS = Object.freeze([
  {
    name: "AppCheckbox",
    containerSelector: ".gc-app-checkbox",
    iconSelector: ".gc-app-checkbox__icon",
  },
  {
    name: "AppIconButton",
    containerSelector: ".gc-app-icon-button",
    iconSelector: ".gc-app-icon-button__icon, .gc-app-icon-button__custom-icon .ms-icon",
  },
  {
    name: "AppCircleIcon",
    containerSelector: ".gc-app-circle-icon",
    iconSelector: ".ms-icon",
  },
  {
    name: "AppNavigationDestination",
    containerSelector: ".gc-app-navigation-destination__icon-shell",
    iconSelector: ".gc-app-navigation-destination__icon",
  },
  {
    name: "AppChipIconOnly",
    containerSelector: ".gc-app-chip--label-hidden",
    iconSelector: ".gc-app-chip__selected-icon, .gc-app-chip__leading-icon, .gc-app-chip__trailing-icon",
    requireSquareContainer: true,
  },
]);

// Hosted-event public page renders the full HostedEventPublicPage (with fake
// data, no API) — the surface that carries the section/presence headings.
const DEFAULT_LABELED_URL =
  "http://localhost:4173/_connections/internal/spl26-shared-primitives-live-2026/hosted-event-preview";

// Icons paired with adjacent label text (NO fixed square container). Optical
// centering for these is judged against the label's cap-height band, not a box
// center — closing the gap that let hosted section-heading icons sit ~1px low
// while the box-center check reported them perfectly aligned.
const DEFAULT_LABELED_ICON_TARGETS = Object.freeze([
  {
    name: "HostedSectionHeading",
    headingSelector: ".hosted-section-heading",
    iconSelector: ".hosted-section-heading__icon",
  },
  {
    name: "HostedPresenceHeading",
    headingSelector: ".hosted-presence-heading",
    iconSelector: ".hosted-presence-heading__icon",
  },
]);

let ROOT = process.cwd();
let OUT_DIR = path.join(ROOT, "tmp", "icon-optics");
let DEVICE_SCALE_FACTOR = Number(process.env.ICON_OPTICS_DPR || 4);
let WARN_OFFSET_PX = Number(process.env.ICON_OPTICS_WARN_PX || 0.75);
let FAIL_OFFSET_PX = Number(process.env.ICON_OPTICS_FAIL_PX || 1.25);
let WARN_SQUARE_DELTA_PX = Number(process.env.ICON_OPTICS_WARN_SQUARE_DELTA_PX || 0.25);
let FAIL_SQUARE_DELTA_PX = Number(process.env.ICON_OPTICS_FAIL_SQUARE_DELTA_PX || 0.5);
let COLOR_DISTANCE_THRESHOLD = Number(process.env.ICON_OPTICS_COLOR_DISTANCE || 96);
let LABEL_WARN_OFFSET_PX = Number(process.env.ICON_OPTICS_LABEL_WARN_PX || 0.6);
let LABEL_FAIL_OFFSET_PX = Number(process.env.ICON_OPTICS_LABEL_FAIL_PX || 1);

let FIXED_ICON_TARGETS = [...DEFAULT_FIXED_ICON_TARGETS];
let LABELED_ICON_TARGETS = [...DEFAULT_LABELED_ICON_TARGETS];
let LABELED_URL = DEFAULT_LABELED_URL;

function hasFlag(name) {
  return process.argv.includes(name);
}

function readArg(name, fallback) {
  const prefix = `${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function resolveChromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ].filter(Boolean);

  const chromePath = candidates.find((candidate) => existsSync(candidate));
  if (!chromePath) {
    throw new Error("No Chromium/Chrome executable found. Set CHROME_PATH to run the icon optics audit.");
  }

  return chromePath;
}

function colorDistance(a, b) {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

function parseRgb(value) {
  const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) {
    return null;
  }

  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
  };
}

function analyzeCrop(filePath, iconColor) {
  const png = PNG.sync.read(readFileSync(filePath));
  const center = {
    x: (png.width - 1) / 2,
    y: (png.height - 1) / 2,
  };
  let count = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let sumX = 0;
  let sumY = 0;

  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const index = (png.width * y + x) * 4;
      const alpha = png.data[index + 3];
      if (alpha < 20) {
        continue;
      }

      const pixel = {
        r: png.data[index],
        g: png.data[index + 1],
        b: png.data[index + 2],
      };
      if (colorDistance(pixel, iconColor) > COLOR_DISTANCE_THRESHOLD) {
        continue;
      }

      count += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      sumX += x;
      sumY += y;
    }
  }

  if (!count) {
    return {
      count: 0,
      bbox: null,
      bboxCenterOffset: null,
      centroidOffset: null,
      maxOffset: Infinity,
    };
  }

  const bboxCenter = {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
  };
  const centroid = {
    x: sumX / count,
    y: sumY / count,
  };
  const bboxCenterOffset = {
    x: (bboxCenter.x - center.x) / DEVICE_SCALE_FACTOR,
    y: (bboxCenter.y - center.y) / DEVICE_SCALE_FACTOR,
  };
  const centroidOffset = {
    x: (centroid.x - center.x) / DEVICE_SCALE_FACTOR,
    y: (centroid.y - center.y) / DEVICE_SCALE_FACTOR,
  };

  return {
    count,
    bbox: {
      x: minX / DEVICE_SCALE_FACTOR,
      y: minY / DEVICE_SCALE_FACTOR,
      width: (maxX - minX + 1) / DEVICE_SCALE_FACTOR,
      height: (maxY - minY + 1) / DEVICE_SCALE_FACTOR,
    },
    bboxCenterOffset,
    centroidOffset,
    maxOffset: Math.max(Math.abs(bboxCenterOffset.x), Math.abs(bboxCenterOffset.y)),
  };
}

function cropViewportScreenshot(sourcePath, destinationPath, clip) {
  const source = PNG.sync.read(readFileSync(sourcePath));
  const scale = DEVICE_SCALE_FACTOR;
  const x = Math.max(0, Math.floor(clip.x * scale));
  const y = Math.max(0, Math.floor(clip.y * scale));
  const width = Math.min(source.width - x, Math.max(1, Math.ceil(clip.width * scale)));
  const height = Math.min(source.height - y, Math.max(1, Math.ceil(clip.height * scale)));

  if (width <= 0 || height <= 0) {
    throw new Error(`Invalid viewport crop ${JSON.stringify({ x, y, width, height, source: [source.width, source.height] })}`);
  }

  const cropped = new PNG({ width, height });
  PNG.bitblt(source, cropped, x, y, width, height, 0, 0);
  writeFileSync(destinationPath, PNG.sync.write(cropped));
}

// Vertical optical delta between an icon glyph and its adjacent label text.
// Icon and label share a color, so we separate them by x-position (icon left,
// text right) rather than color. The label center is taken over its cap-height
// band — the baseline is the lowest row still carrying the bulk of the ink, so
// descenders (g/j/p/q/y) don't drag the measured center down.
function analyzeLabeledCrop(filePath, geo) {
  const png = PNG.sync.read(readFileSync(filePath));
  const { width, height, data } = png;
  const lumAt = (x, y) => {
    const index = (width * y + x) * 4;
    if (data[index + 3] < 20) {
      return null;
    }
    return 0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2];
  };

  // Background = the dominant luminance band (mode). Robust whether the bg is a
  // dark page or a light card, and regardless of how much ink the crop holds —
  // unlike corner sampling (catches neighbours) or the mean/median (pulled by
  // ink in a tight crop). Handles dim, low-opacity icons too.
  const buckets = new Array(64).fill(0);
  let totalPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = lumAt(x, y);
      if (value == null) {
        continue;
      }
      buckets[Math.min(63, Math.floor(value / 4))] += 1;
      totalPixels += 1;
    }
  }
  if (totalPixels < 16) {
    return null;
  }
  let modeBucket = 0;
  for (let b = 1; b < 64; b += 1) {
    if (buckets[b] > buckets[modeBucket]) {
      modeBucket = b;
    }
  }
  const bg = modeBucket * 4 + 2;
  const THRESHOLD = 12;
  const isInk = (x, y) => {
    const value = lumAt(x, y);
    return value != null && Math.abs(value - bg) > THRESHOLD;
  };

  const iconX0 = Math.max(0, Math.min(width, geo.iconX0));
  const iconX1 = Math.max(0, Math.min(width, geo.iconX1));
  const textX0 = Math.max(0, Math.min(width - 1, geo.textX0));

  let iconTop = Infinity;
  let iconBot = -Infinity;
  let inkCount = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = iconX0; x < iconX1; x += 1) {
      if (isInk(x, y)) {
        if (y < iconTop) iconTop = y;
        if (y > iconBot) iconBot = y;
        inkCount += 1;
        break;
      }
    }
  }
  if (!Number.isFinite(iconTop)) {
    return null;
  }

  const rowWidth = new Array(height).fill(0);
  for (let y = 0; y < height; y += 1) {
    let n = 0;
    for (let x = textX0; x < width; x += 1) {
      if (isInk(x, y)) {
        n += 1;
      }
    }
    rowWidth[y] = n;
  }
  const maxRow = Math.max(...rowWidth);
  if (maxRow <= 0) {
    return null;
  }
  let textTop = -1;
  let baseline = -1;
  for (let y = 0; y < height; y += 1) {
    if (rowWidth[y] > 0) {
      textTop = y;
      break;
    }
  }
  for (let y = 0; y < height; y += 1) {
    if (rowWidth[y] >= 0.3 * maxRow) {
      baseline = y; // last "dense" row ≈ baseline; sparse descender rows excluded
    }
  }
  if (textTop < 0 || baseline < 0) {
    return null;
  }

  const iconCenter = (iconTop + iconBot) / 2;
  const textCenter = (textTop + baseline) / 2;
  return { deltaPx: iconCenter - textCenter, inkCount };
}

function formatOffset(offset) {
  if (!offset) {
    return "n/a";
  }

  const x = offset.x.toFixed(2).padStart(5);
  const y = offset.y.toFixed(2).padStart(5);
  return `x=${x}px y=${y}px`;
}

function formatRow(result) {
  const name = result.name.padEnd(24);
  const icon = String(result.iconText || "")
    .trim()
    .padEnd(18);
  const severity = result.severity.padEnd(7);
  const squareDelta = Number.isFinite(result.squareDeltaPx) ? ` square-delta ${result.squareDeltaPx.toFixed(2)}px` : "";
  return `${severity} ${name} ${icon} bbox ${formatOffset(result.analysis.bboxCenterOffset)} centroid ${formatOffset(
    result.analysis.centroidOffset,
  )}${squareDelta} ${result.context}`;
}

async function collectCandidates(page) {
  return page.evaluate((targets) => {
    const seen = new Set();
    const results = [];

    function rectToObject(rect) {
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    }

    function articleHeading(element) {
      const article = element.closest("article");
      const heading = article?.querySelector("h3")?.textContent?.trim();
      return heading ? heading.replace(/\s+/g, " ") : "";
    }

    for (const target of targets) {
      for (const container of document.querySelectorAll(target.containerSelector)) {
        const icon = container.querySelector(target.iconSelector);
        if (!(container instanceof HTMLElement) || !(icon instanceof HTMLElement)) {
          continue;
        }
        if (container.classList.contains("demo-card__copy-link-button")) {
          continue;
        }
        const isVisible = (element) =>
          typeof element.checkVisibility === "function"
            ? element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
            : true;
        if (!isVisible(container) || !isVisible(icon)) {
          continue;
        }

        const containerStyle = getComputedStyle(container);
        const iconStyle = getComputedStyle(icon);
        if (
          containerStyle.display === "none" ||
          containerStyle.visibility === "hidden" ||
          Number(containerStyle.opacity) < 0.05 ||
          iconStyle.display === "none" ||
          iconStyle.visibility === "hidden" ||
          Number(iconStyle.opacity) < 0.05
        ) {
          continue;
        }

        const containerRect = container.getBoundingClientRect();
        const iconRect = icon.getBoundingClientRect();
        if (
          containerRect.width < 10 ||
          containerRect.height < 10 ||
          iconRect.width < 6 ||
          iconRect.height < 6 ||
          containerRect.width > 96 ||
          containerRect.height > 96
        ) {
          continue;
        }

        const key = [
          target.name,
          icon.textContent?.trim() ?? "",
          Math.round(containerRect.width),
          Math.round(containerRect.height),
          Math.round(iconRect.width),
          Math.round(iconRect.height),
          container.className,
          icon.className,
        ].join(":");
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        const id = `icon-optics-${results.length}`;
        container.dataset.iconOpticsId = id;

        results.push({
          id,
          name: target.name,
          iconSelector: target.iconSelector,
          requireSquareContainer: target.requireSquareContainer === true,
          squareDeltaPx: Math.abs(containerRect.width - containerRect.height),
          iconText: icon.textContent?.trim() ?? "",
          context: articleHeading(container),
          containerRect: rectToObject(containerRect),
          iconRect: rectToObject(iconRect),
          iconColor: iconStyle.color,
          iconClass: icon.className,
          containerClass: container.className,
        });
      }
    }

    return results;
  }, FIXED_ICON_TARGETS);
}

async function waitForHarness(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction(
    (targets) =>
      document.querySelectorAll("h3").length > 0 ||
      targets.some((target) => document.querySelector(target.containerSelector)),
    { timeout: 30_000 },
    FIXED_ICON_TARGETS,
  );
  await page.evaluate(async () => {
    if (document.fonts?.ready) {
      await document.fonts.ready;
    }
  });
}

async function waitForLabeledHarness(page, url) {
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60_000 });
  await page.waitForFunction(
    () => Boolean(document.querySelector(".hosted-section-heading, .hosted-presence-heading")),
    { timeout: 30_000 },
  );
  // The public page can mount a cookie-consent dialog that overlays content.
  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((element) =>
      /reject optional|accept all/i.test(element.textContent || ""),
    );
    button?.click();
  });
  await page.evaluate(async () => {
    if (document.fonts?.ready) {
      await document.fonts.ready;
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
}

async function collectLabeledCandidates(page, targets) {
  return page.evaluate((targets) => {
    const seen = new Set();
    const results = [];
    for (const target of targets) {
      for (const heading of document.querySelectorAll(target.headingSelector)) {
        const icon = heading.querySelector(target.iconSelector);
        if (!(heading instanceof HTMLElement) || !(icon instanceof HTMLElement)) {
          continue;
        }
        const headingRect = heading.getBoundingClientRect();
        const iconRect = icon.getBoundingClientRect();
        if (
          headingRect.width < 12 ||
          headingRect.height < 8 ||
          iconRect.width < 6 ||
          iconRect.height < 6 ||
          iconRect.right >= headingRect.right - 3 // need a visible label to the right of the icon
        ) {
          continue;
        }
        const iconText = (icon.textContent || "").trim();
        const key = `${target.name}:${Math.round(headingRect.x)}:${Math.round(headingRect.y)}:${iconText}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        const id = `labeled-icon-${results.length}`;
        heading.dataset.labeledIconId = id;
        const labelText = (heading.textContent || "").replace(iconText, "").replace(/\s+/g, " ").trim();
        results.push({ id, name: target.name, iconText, labelText });
      }
    }
    return results;
  }, targets);
}

async function measureLabeled(page, id) {
  return page.evaluate((id) => {
    const heading = document.querySelector(`[data-labeled-icon-id="${id}"]`);
    if (!(heading instanceof HTMLElement)) {
      return null;
    }
    heading.scrollIntoView({ block: "center", inline: "nearest" });
    const icon = heading.querySelector(".ms-icon");
    if (!(icon instanceof HTMLElement)) {
      return null;
    }
    const headingRect = heading.getBoundingClientRect();
    const iconRect = icon.getBoundingClientRect();
    return {
      heading: { x: headingRect.x, y: headingRect.y, width: headingRect.width, height: headingRect.height },
      icon: { x: iconRect.x, y: iconRect.y, width: iconRect.width, height: iconRect.height },
      textLeft: iconRect.right + 1,
    };
  }, id);
}

async function runLabeledOpticsAudit(page, saveCrops) {
  const results = [];
  if (!LABELED_ICON_TARGETS.length || !LABELED_URL) {
    return results;
  }

  try {
    await waitForLabeledHarness(page, LABELED_URL);
  } catch (error) {
    results.push({
      id: "labeled-skip",
      name: "LabeledIcons",
      kind: "labeled",
      iconText: "",
      context: `harness unavailable: ${error?.message ?? error}`,
      severity: "skip",
      analysis: { count: 0, bbox: null, bboxCenterOffset: null, centroidOffset: null, maxOffset: Infinity },
    });
    return results;
  }

  const candidates = await collectLabeledCandidates(page, LABELED_ICON_TARGETS);
  for (const candidate of candidates) {
    const measured = await measureLabeled(page, candidate.id);
    if (!measured) {
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Clip tightly to the icon's line box (the icon defines the heading line)
    // and extend right to the heading edge for the label. A tight vertical clip
    // avoids capturing neighbouring cards/avatars above or below the heading,
    // which would otherwise inject false ink and skew the measured center.
    const clipX = Math.max(0, measured.icon.x - 2);
    const clipY = Math.max(0, measured.icon.y - 2);
    const clipW = Math.max(8, measured.heading.x + measured.heading.width - measured.icon.x + 2);
    const clipH = measured.icon.height + 4;
    const clip = { x: clipX, y: clipY, width: clipW, height: clipH };
    mkdirSync(OUT_DIR, { recursive: true });
    const cropName = `${candidate.id}-${candidate.name}-${candidate.iconText || "icon"}.png`.replace(
      /[<>:"/\\|?*]/g,
      "_",
    );
    const cropPath = saveCrops ? path.join(OUT_DIR, cropName) : path.join(OUT_DIR, `${candidate.id}.png`);
    await page.screenshot({ path: cropPath, clip });

    const geo = {
      iconX0: Math.round((measured.icon.x - clipX) * DEVICE_SCALE_FACTOR),
      iconX1: Math.round((measured.icon.x + measured.icon.width - clipX) * DEVICE_SCALE_FACTOR),
      textX0: Math.round((measured.textLeft - clipX) * DEVICE_SCALE_FACTOR),
    };
    const analysis = analyzeLabeledCrop(cropPath, geo);
    if (!saveCrops) {
      rmSync(cropPath, { force: true });
    }

    const base = {
      id: candidate.id,
      name: candidate.name,
      kind: "labeled",
      iconText: candidate.iconText,
      context: candidate.labelText ?? "",
      cropPath: saveCrops ? cropPath : undefined,
    };
    if (!analysis) {
      results.push({
        ...base,
        severity: "skip",
        analysis: { count: 0, bbox: null, bboxCenterOffset: null, centroidOffset: null, maxOffset: Infinity },
      });
      continue;
    }

    const deltaY = analysis.deltaPx / DEVICE_SCALE_FACTOR;
    const maxOffset = Math.abs(deltaY);
    // Real optical drift is sub-pixel to ~2px. A larger reading means the crop
    // caught something it shouldn't — treat as a low-confidence skip, never a
    // false fail.
    const IMPLAUSIBLE_OFFSET_PX = 3;
    const severity =
      analysis.inkCount < 8 || maxOffset > IMPLAUSIBLE_OFFSET_PX
        ? "skip"
        : maxOffset > LABEL_FAIL_OFFSET_PX
          ? "fail"
          : maxOffset > LABEL_WARN_OFFSET_PX
            ? "warn"
            : "ok";
    results.push({
      ...base,
      severity,
      analysis: {
        count: analysis.inkCount,
        bbox: null,
        bboxCenterOffset: { x: 0, y: deltaY },
        centroidOffset: { x: 0, y: deltaY },
        maxOffset,
      },
    });
  }

  return results;
}

export async function runIconOpticsAudit(options = {}) {
  ROOT = path.resolve(options.root ?? process.cwd());
  OUT_DIR = path.resolve(ROOT, options.outDir ?? "tmp/icon-optics");
  DEVICE_SCALE_FACTOR = Number(options.deviceScaleFactor ?? process.env.ICON_OPTICS_DPR ?? 4);
  WARN_OFFSET_PX = Number(options.warnOffsetPx ?? process.env.ICON_OPTICS_WARN_PX ?? 0.75);
  FAIL_OFFSET_PX = Number(options.failOffsetPx ?? process.env.ICON_OPTICS_FAIL_PX ?? 1.25);
  WARN_SQUARE_DELTA_PX = Number(options.warnSquareDeltaPx ?? process.env.ICON_OPTICS_WARN_SQUARE_DELTA_PX ?? 0.25);
  FAIL_SQUARE_DELTA_PX = Number(options.failSquareDeltaPx ?? process.env.ICON_OPTICS_FAIL_SQUARE_DELTA_PX ?? 0.5);
  COLOR_DISTANCE_THRESHOLD = Number(options.colorDistanceThreshold ?? process.env.ICON_OPTICS_COLOR_DISTANCE ?? 96);
  FIXED_ICON_TARGETS = options.targets?.length ? [...options.targets] : [...DEFAULT_FIXED_ICON_TARGETS];
  LABEL_WARN_OFFSET_PX = Number(options.labelWarnOffsetPx ?? process.env.ICON_OPTICS_LABEL_WARN_PX ?? 0.6);
  LABEL_FAIL_OFFSET_PX = Number(options.labelFailOffsetPx ?? process.env.ICON_OPTICS_LABEL_FAIL_PX ?? 1);
  LABELED_ICON_TARGETS = Array.isArray(options.labeledTargets)
    ? [...options.labeledTargets]
    : [...DEFAULT_LABELED_ICON_TARGETS];
  LABELED_URL = options.labeledUrl === undefined ? DEFAULT_LABELED_URL : options.labeledUrl;

  const url = options.url ?? DEFAULT_URL;
  const saveCrops = Boolean(options.saveCrops);

  if (saveCrops) {
    rmSync(OUT_DIR, { recursive: true, force: true });
    mkdirSync(OUT_DIR, { recursive: true });
  }

  const browser = await puppeteer.launch({
    executablePath: options.chromePath ?? resolveChromePath(),
    headless: true,
    protocolTimeout: 120_000,
    args: ["--no-sandbox", "--window-size=1400,1000"],
  });

  const results = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: DEVICE_SCALE_FACTOR });
    await waitForHarness(page, url);

    const candidates = await collectCandidates(page);
    for (const candidate of candidates) {
      const iconColor = parseRgb(candidate.iconColor);
      if (!iconColor) {
        results.push({
          ...candidate,
          severity: "skip",
          analysis: {
            count: 0,
            bbox: null,
            bboxCenterOffset: null,
            centroidOffset: null,
            maxOffset: Infinity,
          },
          reason: `Could not parse icon color: ${candidate.iconColor}`,
        });
        continue;
      }

      const prepared = await page.evaluate(
        (id, iconSelector) => {
          const container = document.querySelector(`[data-icon-optics-id="${id}"]`);
          if (!(container instanceof HTMLElement)) {
            return false;
          }

          document.documentElement.style.scrollBehavior = "auto";
          const initialRect = container.getBoundingClientRect();
          const targetY = Math.max(0, window.scrollY + initialRect.top - window.innerHeight / 2 + initialRect.height / 2);
          window.scrollTo({ top: targetY, left: 0, behavior: "instant" });
          container.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
          const icon = container.querySelector(iconSelector);
          if (!(icon instanceof HTMLElement)) {
            return false;
          }

          for (const child of container.querySelectorAll("*")) {
            if (!(child instanceof HTMLElement) || child === icon || child.contains(icon) || icon.contains(child)) {
              continue;
            }

            child.dataset.iconOpticsPreviousVisibility = child.style.visibility;
            child.style.visibility = "hidden";
          }

          return true;
        },
        candidate.id,
        candidate.iconSelector,
      );
      if (!prepared) {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 120));

      const clip = await page.evaluate((id) => {
        const container = document.querySelector(`[data-icon-optics-id="${id}"]`);
        if (!(container instanceof HTMLElement)) {
          return null;
        }

        const rect = container.getBoundingClientRect();
        const centerElement = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        if (centerElement !== container && !container.contains(centerElement)) {
          return null;
        }

        return {
          x: Math.max(0, Math.floor(rect.x)),
          y: Math.max(0, Math.floor(rect.y)),
          width: Math.max(1, Math.ceil(rect.width)),
          height: Math.max(1, Math.ceil(rect.height)),
        };
      }, candidate.id);
      if (!clip) {
        continue;
      }

      const cropName = `${candidate.id}-${candidate.name}-${candidate.iconText || "icon"}.png`.replace(
        /[<>:"/\\|?*]/g,
        "_",
      );
      const cropPath = path.join(OUT_DIR, cropName);
      const screenshotPath = saveCrops ? cropPath : path.join(OUT_DIR, `${candidate.id}.png`);
      if (!saveCrops) {
        mkdirSync(OUT_DIR, { recursive: true });
      }
      const viewportPath = path.join(OUT_DIR, `${candidate.id}-viewport.png`);
      try {
        await page.screenshot({ path: viewportPath, fullPage: false });
        cropViewportScreenshot(viewportPath, screenshotPath, clip);
      } catch (error) {
        results.push({
          ...candidate,
          severity: "skip",
          analysis: {
            count: 0,
            bbox: null,
            bboxCenterOffset: null,
            centroidOffset: null,
            maxOffset: Infinity,
          },
          reason: `Could not capture icon crop: ${error?.message ?? error}`,
        });
        continue;
      } finally {
        rmSync(viewportPath, { force: true });
      }
      const analysis = analyzeCrop(screenshotPath, iconColor);
      if (!saveCrops) {
        rmSync(screenshotPath, { force: true });
      }

      const squareSeverity = candidate.requireSquareContainer
        ? candidate.squareDeltaPx > FAIL_SQUARE_DELTA_PX
          ? "fail"
          : candidate.squareDeltaPx > WARN_SQUARE_DELTA_PX
            ? "warn"
            : "ok"
        : "ok";

      const opticalSeverity =
        !Number.isFinite(analysis.maxOffset) || analysis.count < 8
          ? "skip"
          : analysis.maxOffset > FAIL_OFFSET_PX
            ? "fail"
            : analysis.maxOffset > WARN_OFFSET_PX
              ? "warn"
              : "ok";

      const severity =
        squareSeverity === "fail" || opticalSeverity === "fail"
          ? "fail"
          : squareSeverity === "warn" || opticalSeverity === "warn"
            ? "warn"
            : opticalSeverity;

      results.push({
        ...candidate,
        severity,
        squareSeverity,
        opticalSeverity,
        analysis,
        cropPath: saveCrops ? screenshotPath : undefined,
      });
    }

    // Labeled icons (icon + adjacent text, e.g. hosted section headings) are
    // measured against the label's cap-height, not a box center.
    const labeledResults = await runLabeledOpticsAudit(page, saveCrops);
    results.push(...labeledResults);
  } finally {
    await browser.close();
  }

  const sorted = [...results].sort((a, b) => {
    const left = Number.isFinite(a.analysis.maxOffset) ? a.analysis.maxOffset : -1;
    const right = Number.isFinite(b.analysis.maxOffset) ? b.analysis.maxOffset : -1;
    return right - left;
  });
  const actionable = sorted.filter((result) => result.severity === "fail" || result.severity === "warn");
  const failed = sorted.filter((result) => result.severity === "fail");

  return {
    failed: failed.length > 0,
    jsonPayload: {
      url,
      thresholds: {
        warnOffsetPx: WARN_OFFSET_PX,
        failOffsetPx: FAIL_OFFSET_PX,
        warnSquareDeltaPx: WARN_SQUARE_DELTA_PX,
        failSquareDeltaPx: FAIL_SQUARE_DELTA_PX,
      },
      results: sorted,
    },
    report: renderReport({ url, sorted, actionable }),
  };
}

function renderReport({ url, sorted, actionable }) {
  const lines = [];
  lines.push(`Icon optics audit: ${url}`);
  const targetNames = [
    ...FIXED_ICON_TARGETS.map((target) => target.name),
    ...LABELED_ICON_TARGETS.map((target) => target.name),
  ];
  lines.push(`Targets: ${targetNames.join(", ")}`);
  lines.push(
    `Thresholds: box offset warn > ${WARN_OFFSET_PX}px, fail > ${FAIL_OFFSET_PX}px; square delta warn > ${WARN_SQUARE_DELTA_PX}px, fail > ${FAIL_SQUARE_DELTA_PX}px; label offset warn > ${LABEL_WARN_OFFSET_PX}px, fail > ${LABEL_FAIL_OFFSET_PX}px`,
  );
  lines.push(`Measured ${sorted.length} icon targets (fixed containers + labeled headings).`);

  if (actionable.length) {
    lines.push("");
    lines.push("Outliers:");
    for (const result of actionable.slice(0, 20)) {
      lines.push(formatRow(result));
    }
  } else {
    lines.push("");
    lines.push("No icon optical-centering outliers found.");
  }

  lines.push("");
  lines.push("Largest offsets:");
  for (const result of sorted.filter((item) => item.severity !== "skip").slice(0, 12)) {
    lines.push(formatRow(result));
  }

  const skipped = sorted.filter((result) => result.severity === "skip");
  if (skipped.length) {
    lines.push("");
    lines.push(`Skipped ${skipped.length} icons with too few detectable icon pixels or unparsable colors.`);
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const result = await runIconOpticsAudit({
    url: readArg("--url", DEFAULT_URL),
    saveCrops: hasFlag("--save-crops"),
  });
  const json = hasFlag("--json");

  if (json) {
    console.log(JSON.stringify(result.jsonPayload, null, 2));
  } else {
    console.log(result.report.trimEnd());
  }

  if (hasFlag("--fail-on-drift") && result.failed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

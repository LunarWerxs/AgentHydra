import path from "node:path";

const root = process.cwd();
const localBaseUrl = "http://localhost:4173";

function tmpDir(name) {
  return path.join(root, "tmp", "screenshots", name);
}

function exploreScenario({ name, description, outDir, captures }) {
  return {
    name,
    description,
    kind: "capture-set",
    outDir,
    baseUrl: localBaseUrl,
    captures,
  };
}

export const screenshotScenarios = {
  "shared-primitives-table": {
    name: "shared-primitives-table",
    description: "Shared primitives AppTable state visual regression.",
    kind: "visual-regression",
    url: `${localBaseUrl}/_connections/internal/spl26-shared-primitives-live-2026`,
    goldenDir: path.join(root, "tests", "golden", "shared-primitives"),
    currentDir: path.join(tmpDir("shared-primitives-table"), "current"),
    diffDir: path.join(tmpDir("shared-primitives-table"), "diff"),
    viewport: { width: 1400, height: 1000, deviceScaleFactor: 1 },
    waitFor: () => document.querySelectorAll("h3").length > 0,
    prepare: async (page) => {
      await page.evaluate(() => location.reload());
      await page.waitForFunction(() => document.querySelectorAll("h3").length > 0, { timeout: 30_000 });
      await page.evaluate(() => {
        const filters = document.querySelectorAll("input");
        for (const input of filters) {
          const placeholder = input.placeholder?.toLowerCase() ?? "";
          if (placeholder.includes("filter") || placeholder.includes("search")) {
            input.value = "AppTable";
            input.dispatchEvent(new Event("input", { bubbles: true }));
            break;
          }
        }
      });
      await waitFor(500);
    },
    target: async (page) => {
      const handle = await page.evaluateHandle(() => {
        const headings = [...document.querySelectorAll("h3")];
        const heading = headings.find((h) => {
          const text = h.textContent?.trim() ?? "";
          return (
            /^AppTable(?:\D|$)/.test(text) &&
            !text.startsWith("AppTableDrag") &&
            !text.startsWith("AppTableDetail") &&
            !text.startsWith("AppTablePref")
          );
        });
        return heading?.closest("article") ?? heading?.parentElement ?? null;
      });
      return handle.asElement();
    },
    states: [
      { name: "baseline" },
      {
        name: "row-detail-on",
        before: async (page) => {
          const detailBtn = await page.$('[data-testid="shared-live-table-row-detail-on"]');
          if (detailBtn) await detailBtn.click();
          await waitFor(400);
        },
      },
      {
        name: "first-row-clicked",
        before: async (page) => {
          await page.evaluate(() => {
            const tableArticle = [...document.querySelectorAll("article")].find((article) =>
              /^AppTable(?:\D|$)/.test(article.querySelector("h3")?.textContent?.trim() ?? ""),
            );
            const firstRow = tableArticle?.querySelector('[data-testid$="-row-c-101"]');
            if (firstRow instanceof HTMLElement) {
              const cell = firstRow.querySelector(".gc-app-table-row__cell");
              const target = cell instanceof HTMLElement ? cell : firstRow;
              const rect = target.getBoundingClientRect();
              target.dispatchEvent(
                new MouseEvent("click", {
                  bubbles: true,
                  cancelable: true,
                  clientX: rect.left + rect.width / 2,
                  clientY: rect.top + rect.height / 2,
                }),
              );
            }
          });
          await waitFor(600);
        },
      },
    ],
  },

  "explore-f3": exploreScenario({
    name: "explore-f3",
    description: "Explore F3 category drawer and typeahead states.",
    outDir: path.join(root, "tmp", "explore-f3"),
    captures: [
      {
        name: "01-category-drawer-light",
        path: "/explore",
        theme: "light",
        before: async (page) => {
          await clickButtonStartingWith(page, "All categories");
          await waitFor(500);
        },
      },
      {
        name: "02-category-drawer-dark",
        path: "/explore",
        theme: "dark",
        before: async (page) => {
          await clickButtonStartingWith(page, "All categories");
          await waitFor(500);
        },
      },
      {
        name: "03-typeahead-house-light",
        path: "/explore",
        theme: "light",
        before: async (page) => {
          await focusSelector(page, ".discover-beta-search-bar__input");
          await page.keyboard.type("house", { delay: 50 });
          await waitFor(600);
        },
      },
      {
        name: "04-typeahead-michael-dark",
        path: "/explore",
        theme: "dark",
        before: async (page) => {
          await focusSelector(page, ".discover-beta-search-bar__input");
          await page.keyboard.type("michael", { delay: 50 });
          await waitFor(600);
        },
      },
      {
        name: "05-category-drawer-mobile",
        path: "/explore",
        theme: "light",
        viewport: { width: 390, height: 844, deviceScaleFactor: 2 },
        fullPage: true,
        before: async (page) => {
          await clickButtonStartingWith(page, "All categories", { scroll: true });
          await waitFor(500);
        },
      },
      {
        name: "06-typeahead-mobile",
        path: "/explore",
        theme: "light",
        viewport: { width: 390, height: 844, deviceScaleFactor: 2 },
        before: async (page) => {
          await focusSelector(page, ".discover-beta-search-bar__input");
          await page.keyboard.type("h", { delay: 50 });
          await waitFor(600);
        },
      },
    ],
  }),

  "explore-f7": exploreScenario({
    name: "explore-f7",
    description: "Explore F7 voice, typography, amber accents, footer, bloom, and texture checks.",
    outDir: path.join(root, "tmp", "explore-f7"),
    captures: [
      { name: "01-fold-light", path: "/explore", theme: "light" },
      { name: "02-fold-dark", path: "/explore", theme: "dark" },
      { name: "03-full-light", path: "/explore", theme: "light", fullPage: true },
      { name: "04-full-dark", path: "/explore", theme: "dark", fullPage: true },
      { name: "05-empty-state", path: "/explore?category=NoSuchCategoryXyz123", theme: "light" },
      {
        name: "06-mobile-light",
        path: "/explore",
        theme: "light",
        viewport: { width: 390, height: 844, deviceScaleFactor: 1 },
        fullPage: true,
      },
      {
        name: "07-mobile-dark",
        path: "/explore",
        theme: "dark",
        viewport: { width: 390, height: 844, deviceScaleFactor: 1 },
        fullPage: true,
      },
      {
        name: "08-footer",
        path: "/explore",
        theme: "light",
        clip: { x: 0, y: 700, width: 1440, height: 200 },
        before: async (page) => {
          await page.evaluate(() => {
            document
              .querySelector(".discover-beta-footer-note")
              ?.scrollIntoView({ block: "center", behavior: "instant" });
          });
          await waitFor(300);
        },
      },
      {
        name: "09-bloom-hover",
        path: "/explore",
        theme: "light",
        before: async (page) => {
          await page.evaluate(() => {
            document.querySelector("article.discover-beta-card--cover-led")?.scrollIntoView({
              block: "center",
              behavior: "instant",
            });
          });
          await waitFor(300);
          const box = await page.evaluate(() => {
            const card = document.querySelector("article.discover-beta-card--cover-led");
            if (!card) return null;
            const rect = card.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          });
          if (box) {
            await page.mouse.move(box.x, box.y);
            await waitFor(600);
          }
        },
      },
      {
        name: "10-noise-closeup",
        path: "/explore",
        theme: "dark",
        clip: { x: 800, y: 200, width: 400, height: 400 },
      },
    ],
  }),

  "qr-card-responsive": exploreScenario({
    name: "qr-card-responsive",
    description: "AppQrCodeCard responsive crop checks across mobile, tablet, and desktop widths.",
    outDir: path.join(root, "tmp", "qr-card"),
    captures: [
      qrCardCapture("qr-card-mobile-360", { width: 360, height: 900, deviceScaleFactor: 2 }),
      qrCardCapture("qr-card-mobile-420", { width: 420, height: 900, deviceScaleFactor: 2 }),
      qrCardCapture("qr-card-tablet-600", { width: 600, height: 900, deviceScaleFactor: 2 }),
      qrCardCapture("qr-card-desktop-900", { width: 900, height: 900, deviceScaleFactor: 2 }),
    ],
  }),

  "qr-logo-states": exploreScenario({
    name: "qr-logo-states",
    description: "AppQrCodeCard center-logo visual states.",
    outDir: path.join(root, "tmp", "qr-states"),
    captures: [
      qrStateCapture("1-logo-on"),
      qrStateCapture("2-logo-off", {
        before: async (page) => {
          await clickTestId(page, "shared-primitives-live-qr-card-center-logo-off");
          await waitFor(600);
        },
      }),
      qrStateCapture("3-logo-on-again", {
        before: async (page) => {
          await clickTestId(page, "shared-primitives-live-qr-card-center-logo-on");
          await waitFor(600);
        },
      }),
      qrStateCapture("4-no-logo-on-placeholder", {
        before: async (page) => {
          await clickTestId(page, "shared-primitives-live-qr-card-logo-clear", { evaluate: true });
          await waitFor(600);
        },
      }),
      qrStateCapture("5-no-logo-off", {
        before: async (page) => {
          await clickTestId(page, "shared-primitives-live-qr-card-logo-clear", { evaluate: true });
          await waitFor(200);
          await clickTestId(page, "shared-primitives-live-qr-card-center-logo-off");
          await waitFor(600);
        },
      }),
      qrStateCapture("no-logo-on", {
        before: async (page) => {
          await clickTestId(page, "shared-primitives-live-qr-card-logo-clear", { evaluate: true });
          await waitFor(500);
          await clickTestId(page, "shared-primitives-live-qr-card-center-logo-on");
          await waitFor(600);
        },
      }),
      qrStateCapture("no-logo-off", {
        before: async (page) => {
          await clickTestId(page, "shared-primitives-live-qr-card-logo-clear", { evaluate: true });
          await waitFor(500);
          await clickTestId(page, "shared-primitives-live-qr-card-center-logo-off");
          await waitFor(600);
        },
      }),
    ],
  }),

  "qr-logo-behavior": exploreScenario({
    name: "qr-logo-behavior",
    description: "AppQrCodeCard center-logo toggle, no-logo, and transition behavior probes.",
    outDir: path.join(root, "tmp", "qr-behavior"),
    captures: [
      {
        name: "center-logo-toggle-src",
        ...qrBaseCapture(),
        screenshot: false,
        assert: async (page) => {
          const initial = await qrImageSrcLength(page);
          await clickTestId(page, "shared-primitives-live-qr-card-center-logo-off");
          await waitFor(800);
          const afterOff = await qrImageSrcLength(page);
          await clickTestId(page, "shared-primitives-live-qr-card-center-logo-on");
          await waitFor(800);
          const afterOn = await qrImageSrcLength(page);
          return {
            initial,
            afterOff,
            afterOn,
            changedWhenOff: initial !== afterOff,
            restoredWhenOn: initial === afterOn,
            failed: initial === 0 || initial === afterOff || initial !== afterOn,
          };
        },
      },
      {
        name: "no-logo-toggle-src",
        ...qrBaseCapture(),
        screenshot: false,
        assert: async (page) => {
          const initial = await qrImageSrcLength(page);
          await clickTestId(page, "shared-primitives-live-qr-card-logo-clear", { evaluate: true });
          await waitFor(500);
          const afterClear = await qrImageSrcLength(page);
          await clickTestId(page, "shared-primitives-live-qr-card-center-logo-off");
          await waitFor(500);
          const noLogoOff = await qrImageSrcLength(page);
          await clickTestId(page, "shared-primitives-live-qr-card-center-logo-on");
          await waitFor(500);
          const noLogoOn = await qrImageSrcLength(page);
          return {
            initial,
            afterClear,
            noLogoOff,
            noLogoOn,
            failed: initial === 0 || afterClear === 0 || noLogoOff === 0 || noLogoOn === 0,
          };
        },
      },
      {
        name: "logo-leave-transition-samples",
        ...qrBaseCapture(),
        screenshot: false,
        assert: async (page) => {
          const motionDuration = await page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue("--gc-motion-duration-item-morph").trim(),
          );
          await clickTestId(page, "shared-primitives-live-qr-card-logo-clear", { evaluate: true });
          await waitFor(600);
          const preCheck = await page.evaluate(() => {
            const overlay = document.querySelector(
              '[data-testid="shared-primitives-live-qr-card-preview"] .gc-app-qr-code__logo-frame',
            );
            return {
              exists: Boolean(overlay),
              classes: overlay?.className ?? "",
              opacity: overlay ? getComputedStyle(overlay).opacity : null,
            };
          });
          const samples = await page.evaluate(async () => {
            const findOverlay = () =>
              document.querySelector(
                '[data-testid="shared-primitives-live-qr-card-preview"] .gc-app-qr-code__logo-frame',
              );
            const out = [];
            document.querySelector('[data-testid="shared-primitives-live-qr-card-center-logo-off"]')?.click();
            const start = performance.now();
            for (let index = 0; index < 30; index += 1) {
              const overlay = findOverlay();
              out.push({
                t: Math.round(performance.now() - start),
                opacity: overlay ? getComputedStyle(overlay).opacity : "removed",
                classes: overlay?.className?.replace("gc-app-qr-code__logo-frame", "").trim() ?? "",
              });
              await new Promise((resolve) => requestAnimationFrame(resolve));
            }
            return out;
          });
          return {
            motionDuration,
            preCheck,
            sampleCount: samples.length,
            samples,
            failed: !preCheck.exists || samples.length < 10,
          };
        },
      },
    ],
  }),

  "myconnect-fab": exploreScenario({
    name: "myconnect-fab",
    description: "MyConnect public FAB closed/open states for a known profile.",
    outDir: path.join(root, "tmp", "myconnect-fab"),
    captures: [
      {
        name: "jake-crowley-closed",
        path: "/mc/jake-crowley",
        viewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
        settleMs: 1_500,
      },
      {
        name: "jake-crowley-open",
        path: "/mc/jake-crowley",
        viewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
        settleMs: 1_500,
        before: async (page) => {
          await clickTestId(page, "myconnect-public-actions-menu-toggle", { evaluate: true });
          await waitFor(600);
        },
      },
    ],
  }),

  "myconnect-fab-matrix": exploreScenario({
    name: "myconnect-fab-matrix",
    description: "MyConnect public FAB theme and accent matrix.",
    outDir: path.join(root, "tmp", "myconnect-fab-matrix"),
    captures: buildMyConnectFabMatrixCaptures(),
  }),

  "explore-redesign": exploreScenario({
    name: "explore-redesign",
    description: "Explore redesign desktop/mobile fold and full-page captures.",
    outDir: path.join(root, "tmp", "explore-redesign"),
    captures: [
      routeCapture("01-desktop-fold", "/explore", { width: 1440, height: 900 }),
      routeCapture("02-desktop-full", "/explore", { width: 1440, height: 900 }, { fullPage: true }),
      routeCapture("03-mobile-fold", "/explore", { width: 390, height: 844 }),
      routeCapture("04-mobile-full", "/explore", { width: 390, height: 844 }, { fullPage: true }),
    ],
  }),

  "frankensplore-sources": exploreScenario({
    name: "frankensplore-sources",
    description: "Frankensplore source comparison captures: legacy and current Explore.",
    outDir: path.join(root, "tmp", "frankensplore-sources"),
    captures: [
      routeCapture("legacy-fold", "/explore-legacy", { width: 1440, height: 900 }),
      routeCapture("legacy-full", "/explore-legacy", { width: 1440, height: 900 }, { fullPage: true }),
      routeCapture("explore-fold", "/explore", { width: 1440, height: 900 }),
    ],
  }),

  "frankensplore-final": exploreScenario({
    name: "frankensplore-final",
    description: "Frankensplore final comparison captures across current, legacy, mobile, and search states.",
    outDir: path.join(root, "tmp", "frankensplore-final"),
    captures: [
      routeCapture("01-explore-desktop", "/explore", { width: 1440, height: 900 }),
      routeCapture("02-legacy-desktop", "/explore-legacy", { width: 1440, height: 900 }),
      routeCapture("03-explore-desktop-full", "/explore", { width: 1440, height: 900 }, { fullPage: true }),
      routeCapture("04-legacy-desktop-full", "/explore-legacy", { width: 1440, height: 900 }, { fullPage: true }),
      routeCapture("05-explore-mobile", "/explore", { width: 390, height: 844 }),
      routeCapture("06-legacy-mobile", "/explore-legacy", { width: 390, height: 844 }),
      routeCapture("07-search-results", "/explore-legacy?q=founders", { width: 1440, height: 900 }),
    ],
  }),

  "frankensplore-wireframe": exploreScenario({
    name: "frankensplore-wireframe",
    description: "Local Frankensplore wireframe full-page capture.",
    outDir: path.join(root, "tmp", "frankensplore-wireframe-shots"),
    captures: [
      {
        name: "full-wireframe",
        url: `file:///${path.join(root, "tmp", "frankensplore-wireframe.html").replaceAll("\\", "/")}`,
        viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
        settleMs: 800,
        fullPage: true,
      },
    ],
  }),

  "explore-mobile-header": exploreScenario({
    name: "explore-mobile-header",
    description: "Explore mobile header responsive captures across light, dark, tablet, and desktop widths.",
    outDir: path.join(root, "tmp", "explore-mobile-header"),
    captures: [
      routeCapture("01-mobile-390-light", "/explore", { width: 390, height: 844 }, { fullPage: true }),
      routeCapture("02-mobile-390-dark", "/explore", { width: 390, height: 844 }, { theme: "dark", fullPage: true }),
      routeCapture("03-mobile-390-light-fold", "/explore", { width: 390, height: 844 }),
      routeCapture("04-mobile-360-light-fold", "/explore", { width: 360, height: 800 }),
      routeCapture("05-tablet-portrait-light", "/explore", { width: 600, height: 900 }),
      routeCapture("06-desktop-light-1440", "/explore", { width: 1440, height: 900 }),
    ],
  }),

  "m3-polish": exploreScenario({
    name: "m3-polish",
    description: "Shared primitives M3 polish captures for button, checkbox, switch, and FAB demos.",
    outDir: path.join(root, "tmp", "m3-polish"),
    captures: [
      harnessCardCapture("01-buttons", "AppButton"),
      harnessCardCapture("02-checkbox", "AppCheckbox"),
      harnessCardCapture("03-switch", "AppSwitch"),
      harnessCardCapture("04-fab", "AppFAB"),
    ],
  }),

  "m3-final-pass": exploreScenario({
    name: "m3-final-pass",
    description: "Shared primitives final-pass AppLoadingIndicator light/dark viewport captures.",
    outDir: path.join(root, "tmp", "m3-final-pass"),
    captures: [
      loaderViewportCapture("01-loader-viewport-light", "light"),
      loaderViewportCapture("02-loader-viewport-dark", "dark"),
    ],
  }),

  "field-state-tiers": exploreScenario({
    name: "field-state-tiers",
    description: "Shared primitives field state tier 2 and tier 3 focused/validation captures.",
    outDir: path.join(root, "tmp", "field-states"),
    captures: [
      fieldTier2Capture("t2-prefix", "prefix", "25.00"),
      fieldTier2Capture("t2-suffix", "suffix", "founder-dinner"),
      fieldTier2Capture("t2-counter", "counter"),
      fieldTier2Capture("t2-error-icon", "error-icon"),
      fieldTier3Capture("t3-loading", "loading"),
      fieldTier3Capture("t3-loading-focused", "loading", { focus: true }),
      fieldTier3Capture("t3-valid", "valid"),
      fieldTier3Capture("t3-valid-focused", "valid", { focus: true }),
    ],
  }),

  "workspace-mobile-selects": exploreScenario({
    name: "workspace-mobile-selects",
    description:
      "Workspace mobile dropdown captures and assertions for contact, events, host, and shared calendar flyout sizing.",
    outDir: path.join(root, "tmp", "workspace-mobile-selects"),
    captures: [
      workspaceMobileSelectCapture("01-contacts-audience", "/", { ariaLabel: "Contact audience", matchIndex: 0 }),
      workspaceMobileSelectCapture("02-events-lifecycle", "/events", { ariaLabel: "Event lifecycle" }),
      workspaceMobileSelectCapture("03-host-lifecycle", "/host", { ariaLabel: "Host event lifecycle" }),
      workspaceMobileSelectCapture("04-shared-calendar-lifecycle", "/calendar", {
        ariaLabel: "Shared calendar event lifecycle",
      }),
    ],
  }),

  "explore-audit": exploreScenario({
    name: "explore-audit",
    description:
      "Explore current page audit captures across breakpoints, dark mode, filters, grid, calendars, and compact density.",
    outDir: path.join(root, "tmp", "explore-audit"),
    captures: [
      routeCapture("01-desktop-full", "/explore", { width: 1440, height: 900 }, { fullPage: true, settleMs: 1_500 }),
      routeCapture("02-desktop-fold", "/explore", { width: 1440, height: 900 }, { settleMs: 1_500 }),
      routeCapture("03-laptop-fold", "/explore", { width: 1280, height: 800 }, { settleMs: 1_500 }),
      routeCapture("04-tablet-full", "/explore", { width: 834, height: 1100 }, { fullPage: true, settleMs: 1_500 }),
      routeCapture("05-mobile-full", "/explore", { width: 390, height: 844 }, { fullPage: true, settleMs: 1_500 }),
      routeCapture("06-wide-full", "/explore", { width: 1920, height: 1080 }, { fullPage: true, settleMs: 1_500 }),
      routeCapture(
        "07-desktop-dark",
        "/explore",
        { width: 1440, height: 900 },
        {
          fullPage: true,
          localStorage: { "connections.discover.theme": "dark" },
          settleMs: 1_500,
        },
      ),
      routeCapture(
        "08-filter-flyout",
        "/explore",
        { width: 1440, height: 900 },
        {
          before: async (page) => {
            await page.click('[data-testid="discover-advanced-filter-toggle"]').catch(() => {});
            await waitFor(600);
          },
          settleMs: 1_500,
        },
      ),
      routeCapture(
        "09-grid-view",
        "/explore?view=grid",
        { width: 1440, height: 900 },
        {
          fullPage: true,
          localStorage: { "connections.discover.view": "grid" },
          settleMs: 1_500,
        },
      ),
      routeCapture(
        "10-calendars",
        "/explore",
        { width: 1440, height: 900 },
        {
          fullPage: true,
          localStorage: { "connections.discover.display": "calendars" },
          settleMs: 1_500,
        },
      ),
      routeCapture(
        "11-compact-density",
        "/explore",
        { width: 1440, height: 900 },
        {
          localStorage: { "connections.discover.density": "compact" },
          settleMs: 1_500,
        },
      ),
    ],
  }),

  "explore-beta": exploreScenario({
    name: "explore-beta",
    description: "Explore beta breakpoints, dark mode, map view, weekend filter, and city dropdown captures.",
    outDir: path.join(root, "tmp", "explore-beta"),
    captures: [
      routeCapture(
        "01-desktop-full",
        "/explore-beta",
        { width: 1440, height: 900 },
        { fullPage: true, settleMs: 2_000 },
      ),
      routeCapture("02-desktop-fold", "/explore-beta", { width: 1440, height: 900 }, { settleMs: 2_000 }),
      routeCapture("03-laptop", "/explore-beta", { width: 1280, height: 800 }, { settleMs: 2_000 }),
      routeCapture("04-tablet", "/explore-beta", { width: 834, height: 1100 }, { fullPage: true, settleMs: 2_000 }),
      routeCapture("05-mobile", "/explore-beta", { width: 390, height: 844 }, { fullPage: true, settleMs: 2_000 }),
      routeCapture("06-wide", "/explore-beta", { width: 1920, height: 1080 }, { settleMs: 2_000 }),
      routeCapture(
        "07-dark-full",
        "/explore-beta",
        { width: 1440, height: 900 },
        {
          fullPage: true,
          localStorage: { "connections.discover-beta.theme": "dark" },
          settleMs: 2_000,
        },
      ),
      routeCapture(
        "08-map-view",
        "/explore-beta",
        { width: 1440, height: 900 },
        {
          before: async (page) => {
            await clickButtonExact(page, "Map");
            await waitFor(600);
          },
          settleMs: 1_500,
        },
      ),
      routeCapture(
        "09-weekend-filter",
        "/explore-beta",
        { width: 1440, height: 900 },
        {
          fullPage: true,
          before: async (page) => {
            await clickButtonExact(page, "This weekend");
            await waitFor(800);
          },
          settleMs: 1_500,
        },
      ),
      routeCapture(
        "10-city-open",
        "/explore-beta",
        { width: 1440, height: 900 },
        {
          before: async (page) => {
            await page.evaluate(() => {
              const button = [...document.querySelectorAll("button")].find((candidate) =>
                candidate.textContent?.includes("Houston"),
              );
              button?.click();
            });
            await waitFor(400);
          },
          settleMs: 1_500,
        },
      ),
    ],
  }),

  "explore-f6": exploreScenario({
    name: "explore-f6",
    description: "Explore F6 warmth-pass captures for ambient gradient, active pill, zone band, calendars, and mobile.",
    outDir: path.join(root, "tmp", "explore-f6"),
    captures: [
      routeCapture(
        "01-desktop-light-full",
        "/explore",
        { width: 1440, height: 900 },
        { theme: "light", fullPage: true },
      ),
      routeCapture("02-desktop-dark-full", "/explore", { width: 1440, height: 900 }, { theme: "dark", fullPage: true }),
      routeCapture("03-desktop-light-fold", "/explore", { width: 1440, height: 900 }, { theme: "light" }),
      routeCapture("04-desktop-dark-fold", "/explore", { width: 1440, height: 900 }, { theme: "dark" }),
      routeCapture(
        "05-active-pill-light",
        "/explore",
        { width: 1440, height: 900 },
        {
          theme: "light",
          before: activateExplorePill("Free"),
        },
      ),
      routeCapture(
        "06-active-pill-dark",
        "/explore",
        { width: 1440, height: 900 },
        {
          theme: "dark",
          before: activateExplorePill("Free"),
        },
      ),
      routeCapture(
        "07-zone-b-band-light",
        "/explore",
        { width: 1440, height: 900 },
        {
          theme: "light",
          before: scrollToExploreSelector(".discover-beta-zone-b-band", { block: "start", offsetY: -80 }),
        },
      ),
      routeCapture(
        "08-zone-b-band-dark",
        "/explore",
        { width: 1440, height: 900 },
        {
          theme: "dark",
          before: scrollToExploreSelector(".discover-beta-zone-b-band", { block: "start", offsetY: -80 }),
        },
      ),
      routeCapture(
        "09-calendars-light",
        "/explore",
        { width: 1440, height: 900 },
        {
          theme: "light",
          before: scrollToExploreSelector(".discover-beta-calendar-card", { block: "center" }),
        },
      ),
      routeCapture(
        "10-calendars-dark",
        "/explore",
        { width: 1440, height: 900 },
        {
          theme: "dark",
          before: scrollToExploreSelector(".discover-beta-calendar-card", { block: "center" }),
        },
      ),
      routeCapture("11-mobile-light", "/explore", { width: 390, height: 844 }, { theme: "light", fullPage: true }),
      routeCapture("12-mobile-dark", "/explore", { width: 390, height: 844 }, { theme: "dark", fullPage: true }),
    ],
  }),

  "explore-m3": exploreScenario({
    name: "explore-m3",
    description:
      "Explore M3 verification captures across themes, responsive widths, flyouts, hover, active filter, map, empty, and saved states.",
    outDir: path.join(root, "tmp", "explore-m3"),
    captures: [
      routeCapture("01-desktop-light", "/explore", { width: 1440, height: 900 }, { theme: "light" }),
      routeCapture("02-desktop-dark", "/explore", { width: 1440, height: 900 }, { theme: "dark" }),
      routeCapture(
        "03-desktop-dark-reloaded",
        "/explore",
        { width: 1440, height: 900 },
        {
          theme: "dark",
          before: async (page) => {
            await waitFor(600);
            await page.reload({ waitUntil: "networkidle0", timeout: 60_000 });
            await waitFor(800);
          },
        },
      ),
      routeCapture("04-laptop-light", "/explore", { width: 1280, height: 800 }),
      routeCapture("05-tablet-light", "/explore", { width: 834, height: 1100 }),
      routeCapture("06-mobile-light", "/explore", { width: 390, height: 844 }, { fullPage: true }),
      routeCapture("07-mobile-dark", "/explore", { width: 390, height: 844 }, { theme: "dark", fullPage: true }),
      routeCapture("08-ultrawide-light", "/explore", { width: 1920, height: 1080 }),
      routeCapture(
        "09-city-flyout-light",
        "/explore",
        { width: 1440, height: 900 },
        { before: openExploreCityDropdown },
      ),
      routeCapture(
        "10-city-flyout-dark",
        "/explore",
        { width: 1440, height: 900 },
        {
          theme: "dark",
          before: openExploreCityDropdown,
        },
      ),
      routeCapture(
        "11-filters-flyout-light",
        "/explore",
        { width: 1440, height: 900 },
        { before: openExploreFiltersDropdown },
      ),
      routeCapture(
        "12-filters-flyout-dark",
        "/explore",
        { width: 1440, height: 900 },
        {
          theme: "dark",
          before: openExploreFiltersDropdown,
        },
      ),
      routeCapture("13-card-hover", "/explore", { width: 1440, height: 900 }, { before: hoverExploreCard }),
      routeCapture("14-active-pill", "/explore", { width: 1440, height: 900 }, { before: activateExploreFirstPill }),
      routeCapture(
        "15-map-light",
        "/explore",
        { width: 1440, height: 900 },
        { before: switchExploreToMap, fullPage: true },
      ),
      routeCapture(
        "16-map-dark",
        "/explore",
        { width: 1440, height: 900 },
        {
          theme: "dark",
          before: switchExploreToMap,
          fullPage: true,
        },
      ),
      routeCapture("17-empty-state", "/explore?category=NoSuchCategoryXyz123", { width: 1440, height: 900 }),
      routeCapture(
        "18-saved",
        "/explore",
        { width: 1440, height: 900 },
        {
          before: async (page) => {
            await page.evaluate(() => document.querySelector('button[aria-label="Save event"]')?.click());
            await waitFor(400);
          },
        },
      ),
    ],
  }),

  "explore-beta-states": exploreScenario({
    name: "explore-beta-states",
    description:
      "Explore beta interactive states: theme toggles, city/filter menus, saved, hover, map, and mobile dark.",
    outDir: path.join(root, "tmp", "explore-beta-states"),
    captures: [
      routeCapture("01-light-default", "/explore-beta", { width: 1440, height: 900 }, { settleMs: 1_500 }),
      routeCapture(
        "02-toggle-dark",
        "/explore-beta",
        { width: 1440, height: 900 },
        {
          before: toggleThemeButton,
          settleMs: 1_500,
        },
      ),
      routeCapture(
        "03-dark-persisted",
        "/explore-beta",
        { width: 1440, height: 900 },
        {
          localStorage: { "connections.discover-beta.theme": "dark" },
          settleMs: 1_500,
        },
      ),
      routeCapture(
        "04-city-open-light",
        "/explore-beta",
        { width: 1440, height: 900 },
        {
          before: openExploreBetaCity,
          settleMs: 1_500,
        },
      ),
      routeCapture(
        "05-city-open-dark",
        "/explore-beta",
        { width: 1440, height: 900 },
        {
          localStorage: { "connections.discover-beta.theme": "dark" },
          before: openExploreBetaCity,
          settleMs: 1_500,
        },
      ),
      routeCapture(
        "06-filters-open-light",
        "/explore-beta",
        { width: 1440, height: 900 },
        {
          before: openExploreFiltersDropdown,
          settleMs: 1_500,
        },
      ),
      routeCapture(
        "07-filters-open-dark",
        "/explore-beta",
        { width: 1440, height: 900 },
        {
          localStorage: { "connections.discover-beta.theme": "dark" },
          before: openExploreFiltersDropdown,
          settleMs: 1_500,
        },
      ),
      routeCapture(
        "08-saved-state",
        "/explore-beta",
        { width: 1440, height: 900 },
        {
          before: clickSaveEvent,
          settleMs: 1_500,
        },
      ),
      routeCapture(
        "09-hover",
        "/explore-beta",
        { width: 1440, height: 900 },
        {
          before: hoverFirstArticle,
          settleMs: 1_500,
        },
      ),
      routeCapture(
        "10-map-dark",
        "/explore-beta",
        { width: 1440, height: 900 },
        {
          fullPage: true,
          localStorage: { "connections.discover-beta.theme": "dark" },
          before: async (page) => {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await waitFor(300);
            await clickButtonExact(page, "Map");
            await waitFor(800);
          },
          settleMs: 1_500,
        },
      ),
      routeCapture(
        "11-mobile-dark",
        "/explore-beta",
        { width: 390, height: 844 },
        {
          fullPage: true,
          localStorage: { "connections.discover-beta.theme": "dark" },
          settleMs: 1_500,
        },
      ),
      routeCapture(
        "12a-after-toggle-1",
        "/explore-beta",
        { width: 1440, height: 900 },
        {
          before: toggleThemeButton,
          settleMs: 1_500,
        },
      ),
      routeCapture(
        "12b-after-toggle-2",
        "/explore-beta",
        { width: 1440, height: 900 },
        {
          before: async (page) => {
            await toggleThemeButton(page);
            await toggleThemeButton(page);
          },
          settleMs: 1_500,
        },
      ),
    ],
  }),

  "explore-d3": exploreScenario({
    name: "explore-d3",
    description: "Explore D3 date-range chip and picker states.",
    outDir: path.join(root, "tmp", "explore-d3"),
    captures: [
      routeCapture("01-when-chip-light", "/explore", { width: 1440, height: 900 }, { theme: "light", settleMs: 1_200 }),
      routeCapture(
        "02-when-open-light",
        "/explore",
        { width: 1440, height: 900 },
        {
          theme: "light",
          before: clickWhenChip,
          settleMs: 1_200,
        },
      ),
      routeCapture(
        "03-when-open-dark",
        "/explore",
        { width: 1440, height: 900 },
        {
          theme: "dark",
          before: clickWhenChip,
          settleMs: 1_200,
        },
      ),
      routeCapture(
        "04-shortcut-applied-light",
        "/explore",
        { width: 1440, height: 900 },
        {
          before: async (page) => {
            await clickWhenChip(page);
            await clickDatePickerShortcut(page, "This weekend");
            await waitFor(500);
          },
          settleMs: 1_200,
        },
      ),
      routeCapture(
        "05-custom-range-visual-light",
        "/explore",
        { width: 1440, height: 900 },
        {
          before: selectCustomDateRange,
          settleMs: 1_200,
        },
      ),
      routeCapture(
        "06-custom-range-visual-dark",
        "/explore",
        { width: 1440, height: 900 },
        {
          theme: "dark",
          before: selectCustomDateRange,
          settleMs: 1_200,
        },
      ),
      routeCapture(
        "07-mobile-when-open",
        "/explore",
        { width: 390, height: 844 },
        {
          before: clickWhenChip,
          settleMs: 1_200,
        },
      ),
    ],
  }),

  "field-states-detailed": exploreScenario({
    name: "field-states-detailed",
    description: "Detailed AppTextField rest, hover, focus, filled, readonly, disabled, and invalid states.",
    outDir: path.join(root, "tmp", "field-states"),
    captures: [
      textFieldStateCapture("01-rest", resetTextFieldState),
      textFieldStateCapture("02-hover", hoverTextField),
      textFieldStateCapture("03-focus-empty", focusTextField),
      textFieldStateCapture("04-focus-filled", fillFocusedTextField),
      textFieldStateCapture("05-populated", populateBlurredTextField),
      textFieldStateCapture("06-populated-hover", populatedHoverTextField),
      textFieldStateCapture("07-readonly", readonlyTextField),
      textFieldStateCapture("08-disabled", disabledTextField),
      textFieldStateCapture("09-invalid", invalidTextField),
      textFieldStateCapture("10-invalid-hover", invalidHoverTextField),
    ],
  }),

  "frankensplore-progress": exploreScenario({
    name: "frankensplore-progress",
    description: "Frankensplore progress captures including search handoff and collapsed legacy sidebar.",
    outDir: path.join(root, "tmp", "frankensplore-progress"),
    captures: [
      routeCapture("explore-fold", "/explore", { width: 1440, height: 900 }),
      routeCapture("explore-full", "/explore", { width: 1440, height: 900 }, { fullPage: true }),
      routeCapture("legacy-fold", "/explore-legacy", { width: 1440, height: 900 }),
      routeCapture("legacy-full", "/explore-legacy", { width: 1440, height: 900 }, { fullPage: true }),
      routeCapture("search-handoff", "/explore", { width: 1440, height: 900 }, { before: searchExploreForFounders }),
      routeCapture(
        "legacy-sidebar-collapsed",
        "/explore-legacy",
        { width: 1440, height: 900 },
        {
          before: async (page) => {
            await page.evaluate(() => {
              const button = [...document.querySelectorAll("button")].find((candidate) =>
                (candidate.getAttribute("aria-label") ?? "").includes("Collapse filters"),
              );
              button?.click();
            });
            await waitFor(600);
          },
        },
      ),
    ],
  }),

  "field-card-snaps": exploreScenario({
    name: "field-card-snaps",
    description: "Focused field-card crops for prefix, suffix, error-icon, and valid states.",
    outDir: path.join(root, "tmp", "field-card-snaps"),
    captures: [
      fieldSnapCapture("field-prefix", "[data-screenshot-tier-2='prefix']", "49"),
      fieldSnapCapture("field-suffix", "[data-screenshot-tier-2='suffix']", "founder-dinner"),
      fieldSnapCapture("field-error-icon", "[data-screenshot-tier-2='error-icon']"),
      fieldSnapCapture("field-valid", "[data-screenshot-tier-3='valid']"),
    ],
  }),
};

function routeCapture(name, routePath, viewport, options = {}) {
  return {
    name,
    path: routePath,
    viewport: { ...viewport, deviceScaleFactor: 1 },
    settleMs: options.settleMs ?? 1_800,
    fullPage: options.fullPage ?? false,
    theme: options.theme ?? "light",
    before: options.before,
    clip: options.clip,
    localStorage: options.localStorage,
  };
}

function workspaceMobileSelectCapture(name, routePath, target, options = {}) {
  const descriptor = normalizeComboboxTarget(target);

  return {
    name,
    path: routePath,
    viewport: { width: 390, height: 844, deviceScaleFactor: 1 },
    settleMs: options.settleMs ?? 1_800,
    theme: options.theme ?? "light",
    localStorage: {
      "connections.auth.session": JSON.stringify(createWorkspaceAuditStoredSession()),
      ...(options.localStorage ?? {}),
    },
    before: async (page) => {
      if (options.before) await options.before(page);
      await openComboboxByTarget(page, descriptor);
    },
    assert: async (page) => inspectOpenCombobox(page, descriptor),
    clip: (page) => clipOpenCombobox(page, descriptor),
  };
}

function normalizeComboboxTarget(target) {
  if (typeof target === "string") {
    return { ariaLabel: target, matchIndex: 0 };
  }

  return {
    ariaLabel: target.ariaLabel,
    matchIndex: target.matchIndex ?? 0,
  };
}

function createWorkspaceAuditMockJwt(payload) {
  const json = JSON.stringify(payload);
  const base64 = Buffer.from(json, "utf8").toString("base64");
  return `test.${base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "")}.signature`;
}

function createWorkspaceAuditStoredSession() {
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60;

  return {
    access_token: createWorkspaceAuditMockJwt({
      token_use: "access",
      exp: expiresAt,
      sub: "workspace-audit-user",
      email: "workspace-audit@example.com",
    }),
    expires_at: expiresAt,
    user: {
      id: "workspace-audit-user",
      email: "workspace-audit@example.com",
      app_metadata: {},
    },
  };
}

function sharedPrimitiveCaptureBase(options = {}) {
  return {
    path: "/_connections/internal/spl26-shared-primitives-live-2026",
    viewport: options.viewport ?? { width: 1280, height: 900, deviceScaleFactor: 2 },
    settleMs: options.settleMs ?? 1_000,
    theme: options.theme ?? "light",
  };
}

function harnessCardCapture(name, headingText) {
  return {
    ...sharedPrimitiveCaptureBase(),
    name,
    before: async (page) => {
      await page.waitForSelector(".demo-card", { timeout: 30_000 });
      await scrollHarnessCardIntoView(page, headingText);
      await waitFor(350);
    },
    clip: (page) => harnessCardClip(page, headingText, 16),
  };
}

function loaderViewportCapture(name, theme) {
  return {
    ...sharedPrimitiveCaptureBase({
      theme,
      viewport: { width: 800, height: 600, deviceScaleFactor: 2 },
      settleMs: 2_500,
    }),
    name,
    before: async (page) => {
      await page.keyboard.press("Escape").catch(() => {});
      await removeViteOverlay(page);
      const offsetY = await page.evaluate(() => {
        const heading = Array.from(document.querySelectorAll("h3")).find((candidate) =>
          candidate.textContent?.trim().startsWith("AppLoadingIndicator"),
        );
        const article = heading?.closest("article") ?? heading?.parentElement;
        return article ? article.getBoundingClientRect().top + window.scrollY : null;
      });
      if (offsetY !== null) await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - 80)), offsetY);
      await waitFor(800);
    },
  };
}

function fieldTier2Capture(name, tier, text = "") {
  const selector = `[data-screenshot-tier-2="${tier}"]`;
  return {
    ...sharedPrimitiveCaptureBase(),
    name,
    before: async (page) => {
      await page.waitForSelector(selector, { timeout: 30_000 });
      await scrollSelectorIntoView(page, selector);
      await waitFor(600);
      if (text) {
        await focusInputInside(page, selector);
        await page.keyboard.type(text);
        await waitFor(250);
      }
    },
    clip: (page) => selectorClip(page, selector),
  };
}

function fieldTier3Capture(name, tier, { focus = false } = {}) {
  const selector = `[data-screenshot-tier-3="${tier}"]`;
  return {
    ...sharedPrimitiveCaptureBase(),
    name,
    before: async (page) => {
      await page.waitForSelector(selector, { timeout: 30_000 });
      await scrollSelectorIntoView(page, selector);
      await waitFor(600);
      if (focus) {
        await focusInputInside(page, selector);
        await waitFor(300);
      }
    },
    clip: (page) => selectorClip(page, selector),
  };
}

async function scrollHarnessCardIntoView(page, headingText) {
  await page.evaluate((text) => {
    const heading = [...document.querySelectorAll("h3")].find((candidate) =>
      candidate.textContent?.trim().startsWith(text),
    );
    (heading?.closest("article") ?? heading)?.scrollIntoView({ block: "center", behavior: "instant" });
  }, headingText);
}

async function harnessCardClip(page, headingText, padding = 16) {
  return page.evaluate(
    ({ text, pad }) => {
      const heading = [...document.querySelectorAll("h3")].find((candidate) =>
        candidate.textContent?.trim().startsWith(text),
      );
      const article = heading?.closest("article") ?? heading?.parentElement;
      if (!article) return null;
      const rect = article.getBoundingClientRect();
      return {
        x: Math.max(0, rect.x - pad),
        y: Math.max(0, rect.y - pad),
        width: Math.min(window.innerWidth, rect.width + pad * 2),
        height: Math.min(window.innerHeight, rect.height + pad * 2),
      };
    },
    { text: headingText, pad: padding },
  );
}

async function selectorClip(page, selector, padding = 16) {
  return page.evaluate(
    ({ targetSelector, pad }) => {
      const element = document.querySelector(targetSelector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        x: Math.max(0, rect.x - pad),
        y: Math.max(0, rect.y - pad),
        width: Math.min(window.innerWidth, rect.width + pad * 2),
        height: Math.min(window.innerHeight, rect.height + pad * 2),
      };
    },
    { targetSelector: selector, pad: padding },
  );
}

async function scrollSelectorIntoView(page, selector) {
  await page.evaluate((targetSelector) => {
    document.querySelector(targetSelector)?.scrollIntoView({ block: "center", behavior: "instant" });
  }, selector);
}

async function focusInputInside(page, selector) {
  await page.evaluate((targetSelector) => {
    const host = document.querySelector(targetSelector);
    host?.querySelector("input,textarea")?.focus();
  }, selector);
}

async function removeViteOverlay(page) {
  await page.evaluate(() => {
    document.querySelectorAll("vite-error-overlay").forEach((element) => element.remove());
  });
}

function buildMyConnectFabMatrixCaptures() {
  const accents = [
    { id: "pure-white", color: "#ffffff" },
    { id: "off-white", color: "#fafafa" },
    { id: "very-light-pastel", color: "#fde2e4" },
    { id: "light-pastel-blue", color: "#a8c7fa" },
    { id: "mid-saturated-green", color: "#34a853" },
    { id: "mid-saturated-orange", color: "#fb8c00" },
    { id: "deep-navy", color: "#0f172a" },
    { id: "deep-violet", color: "#3b0764" },
    { id: "warm-brown", color: "#8b5a2b" },
    { id: "near-black", color: "#0a0a0a" },
  ];
  const themes = ["light", "dark"];

  return themes.flatMap((theme) =>
    accents.map((accent) => ({
      name: `${theme}__${accent.id}`,
      path: "/mc/jake-crowley",
      theme,
      viewport: { width: 720, height: 720, deviceScaleFactor: 1 },
      settleMs: 1_200,
      before: async (page) => {
        await page.evaluate(
          ({ accentColor, mode }) => {
            const rootElement = document.documentElement;
            rootElement.setAttribute("data-resolved-theme", mode);
            rootElement.setAttribute("data-theme-preference", mode);
            rootElement.style.colorScheme = mode;
            if (mode === "light") {
              rootElement.style.setProperty("--md-sys-color-surface-container-high", "#f7faff");
              rootElement.style.setProperty("--md-sys-color-on-surface", "#1f1f1f");
            } else {
              rootElement.style.setProperty("--md-sys-color-surface-container-high", "#2b2c2d");
              rootElement.style.setProperty("--md-sys-color-on-surface", "#e3e3e3");
            }

            const host = document.querySelector(".myconnect-public-page");
            if (!host) return;
            host.style.setProperty("--myconnect-accent", accentColor);
            const hex = accentColor.replace("#", "");
            const red = Number.parseInt(hex.substring(0, 2), 16);
            const green = Number.parseInt(hex.substring(2, 4), 16);
            const blue = Number.parseInt(hex.substring(4, 6), 16);
            const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
            host.style.setProperty("--myconnect-accent-foreground", luminance > 0.5 ? "#1f1f1f" : "#ffffff");
          },
          { accentColor: accent.color, mode: theme },
        );
        await waitFor(200);
        await clickTestId(page, "myconnect-public-actions-menu-toggle", { evaluate: true });
        await waitFor(600);
      },
      clip: async (page) =>
        page.evaluate(() => {
          const element = document.querySelector(".myconnect-public-floating-actions");
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          const pad = 24;
          return {
            x: Math.max(0, Math.floor(rect.x - pad)),
            y: Math.max(0, Math.floor(rect.y - 360)),
            width: Math.min(window.innerWidth, Math.ceil(rect.width + pad * 2)),
            height: Math.min(window.innerHeight, Math.ceil(rect.height + 360 + pad)),
          };
        }),
    })),
  );
}

function qrCardCapture(name, viewport) {
  return {
    ...qrBaseCapture(),
    name,
    viewport,
    clip: qrCardClip,
  };
}

function qrStateCapture(name, options = {}) {
  return {
    ...qrBaseCapture(),
    name,
    before: async (page) => {
      if (options.before) await options.before(page);
    },
    clip: qrCardClip,
  };
}

function qrBaseCapture() {
  return {
    path: "/_connections/internal/spl26-shared-primitives-live-2026#AppQrCodeCard",
    theme: "light",
    viewport: { width: 1200, height: 900, deviceScaleFactor: 1 },
    settleMs: 1_500,
    before: async (page) => {
      await scrollQrPreviewIntoView(page);
    },
  };
}

async function scrollQrPreviewIntoView(page) {
  await page.evaluate(() => {
    (
      document.querySelector('[data-testid="shared-primitives-live-qr-card-preview"]') ??
      document.getElementById("AppQrCodeCard")
    )?.scrollIntoView({ block: "center", behavior: "instant" });
  });
  await waitFor(300);
}

async function qrCardClip(page) {
  await scrollQrPreviewIntoView(page);
  return page.evaluate(() => {
    const root =
      document.querySelector('[data-testid="shared-primitives-live-qr-card-preview"]') ??
      document.querySelector(".gc-app-qr-code-card") ??
      document.getElementById("AppQrCodeCard");
    if (!root) return null;
    const card = root.closest(".gc-app-qr-code-card") ?? root;
    const rect = card.getBoundingClientRect();
    return {
      x: Math.max(0, rect.x - 16),
      y: Math.max(0, rect.y - 16),
      width: Math.min(window.innerWidth, rect.width + 32),
      height: rect.height + 32,
    };
  });
}

async function qrImageSrcLength(page) {
  return page.evaluate(() => {
    const image = document.querySelector('[data-testid="shared-primitives-live-qr-card-image"]');
    return image?.getAttribute("src")?.length ?? 0;
  });
}

async function clickButtonStartingWith(page, text, { scroll = false } = {}) {
  await page.evaluate(
    ({ buttonText, shouldScroll }) => {
      const button = Array.from(document.querySelectorAll("button")).find((candidate) =>
        candidate.textContent?.trim().startsWith(buttonText),
      );
      if (shouldScroll) button?.scrollIntoView({ block: "center" });
      button?.click();
    },
    { buttonText: text, shouldScroll: scroll },
  );
}

async function focusSelector(page, selector) {
  await page.evaluate((targetSelector) => {
    document.querySelector(targetSelector)?.focus?.();
  }, selector);
}

async function clickButtonExact(page, text) {
  await page.evaluate((buttonText) => {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === buttonText,
    );
    button?.click();
  }, text);
}

async function openComboboxByTarget(page, target) {
  await page.waitForFunction(
    ({ ariaLabel, matchIndex }) =>
      Array.from(document.querySelectorAll('button[role="combobox"]'))
        .filter(
          (candidate) =>
            candidate.getAttribute("aria-label") === ariaLabel && candidate.getBoundingClientRect().width > 0,
        )
        .at(matchIndex) instanceof HTMLElement,
    { timeout: 30_000 },
    target,
  );

  await page.evaluate(({ ariaLabel, matchIndex }) => {
    const trigger = Array.from(document.querySelectorAll('button[role="combobox"]'))
      .filter((candidate) => candidate.getAttribute("aria-label") === ariaLabel)
      .at(matchIndex);
    trigger?.scrollIntoView({ block: "center", behavior: "instant" });
    trigger?.click();
  }, target);

  await page.waitForFunction(
    ({ ariaLabel, matchIndex }) => {
      const isVisible = (element) =>
        element instanceof HTMLElement &&
        getComputedStyle(element).display !== "none" &&
        getComputedStyle(element).visibility !== "hidden" &&
        element.getBoundingClientRect().width > 0 &&
        element.getBoundingClientRect().height > 0;

      const trigger = Array.from(document.querySelectorAll('button[role="combobox"]'))
        .filter((candidate) => candidate.getAttribute("aria-label") === ariaLabel)
        .at(matchIndex);
      if (!(trigger instanceof HTMLElement)) {
        return false;
      }

      const panelId = trigger.getAttribute("aria-controls");
      const panel = panelId ? document.getElementById(panelId) : null;
      return (
        isVisible(panel) &&
        Array.from(panel?.querySelectorAll('[role="option"], .gc-select__menu-action-row') ?? []).some(isVisible)
      );
    },
    { timeout: 30_000 },
    target,
  );

  await waitFor(250);
}

async function inspectOpenCombobox(page, target) {
  return page.evaluate(({ ariaLabel, matchIndex }) => {
    const isVisible = (element) =>
      element instanceof HTMLElement &&
      getComputedStyle(element).display !== "none" &&
      getComputedStyle(element).visibility !== "hidden" &&
      element.getBoundingClientRect().width > 0 &&
      element.getBoundingClientRect().height > 0;

    const trigger = Array.from(document.querySelectorAll('button[role="combobox"]'))
      .filter((candidate) => candidate.getAttribute("aria-label") === ariaLabel)
      .at(matchIndex);
    if (!(trigger instanceof HTMLElement)) {
      return {
        ariaLabel,
        matchIndex,
        failed: true,
        reason: "Missing combobox trigger",
      };
    }

    const panelId = trigger.getAttribute("aria-controls");
    const panel = panelId ? document.getElementById(panelId) : null;
    if (!(panel instanceof HTMLElement) || !isVisible(panel)) {
      return {
        ariaLabel,
        matchIndex,
        failed: true,
        reason: "Missing open combobox panel",
      };
    }

    const menuContent = panel.querySelector(".gc-select__menu-content");
    const rowElements = Array.from(panel.querySelectorAll('[role="option"], .gc-select__menu-action-row')).filter(
      isVisible,
    );

    if (!rowElements.length) {
      return {
        ariaLabel,
        matchIndex,
        failed: true,
        reason: "Combobox panel has no visible option rows",
      };
    }

    const viewportWidth = window.innerWidth;
    const triggerRect = trigger.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const panelOverflowLeftPx = Math.max(0, Math.round(0 - panelRect.left));
    const panelOverflowRightPx = Math.max(0, Math.round(panelRect.right - viewportWidth));
    const contentOverflowPx =
      menuContent instanceof HTMLElement
        ? Math.max(0, Math.round(menuContent.scrollWidth - menuContent.clientWidth))
        : 0;
    const triggerWidthGapPx = Math.max(0, Math.round(triggerRect.width - panelRect.width));

    const rows = rowElements.map((row) => {
      const rect = row.getBoundingClientRect();
      const rowViewportOverflowPx = Math.max(0, Math.round(rect.right - viewportWidth));
      const clippedPx = Math.max(0, Math.round(row.scrollWidth - row.clientWidth));
      return {
        text: (row.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80),
        clientWidth: Math.round(row.clientWidth),
        scrollWidth: Math.round(row.scrollWidth),
        clippedPx,
        viewportOverflowPx: rowViewportOverflowPx,
      };
    });

    const clippedRows = rows.filter((row) => row.clippedPx > 2 || row.viewportOverflowPx > 0);
    const reasons = [];
    if (panelOverflowLeftPx > 0 || panelOverflowRightPx > 0) reasons.push("panel overflows viewport");
    if (contentOverflowPx > 2) reasons.push("panel content overflows horizontally");
    if (clippedRows.length > 0) reasons.push("option rows are clipped");
    if (triggerWidthGapPx > 1) reasons.push("panel is narrower than trigger");

    return {
      ariaLabel,
      matchIndex,
      failed: reasons.length > 0,
      reason: reasons.join("; "),
      viewportWidth: Math.round(viewportWidth),
      triggerWidth: Math.round(triggerRect.width),
      panelWidth: Math.round(panelRect.width),
      panelOverflowLeftPx,
      panelOverflowRightPx,
      contentOverflowPx,
      clippedRows,
      rows,
    };
  }, target);
}

async function clipOpenCombobox(page, target) {
  return page.evaluate(({ ariaLabel, matchIndex }) => {
    const isVisible = (element) =>
      element instanceof HTMLElement &&
      getComputedStyle(element).display !== "none" &&
      getComputedStyle(element).visibility !== "hidden" &&
      element.getBoundingClientRect().width > 0 &&
      element.getBoundingClientRect().height > 0;

    const trigger = Array.from(document.querySelectorAll('button[role="combobox"]'))
      .filter((candidate) => candidate.getAttribute("aria-label") === ariaLabel)
      .at(matchIndex);
    if (!(trigger instanceof HTMLElement)) {
      return null;
    }

    const panelId = trigger.getAttribute("aria-controls");
    const panel = panelId ? document.getElementById(panelId) : null;
    const targets = [trigger, panel].filter(isVisible);
    if (!targets.length) {
      return null;
    }

    const padding = 16;
    const rects = targets.map((element) => element.getBoundingClientRect());
    const left = Math.max(0, Math.min(...rects.map((rect) => rect.left)) - padding);
    const top = Math.max(0, Math.min(...rects.map((rect) => rect.top)) - padding);
    const right = Math.min(window.innerWidth, Math.max(...rects.map((rect) => rect.right)) + padding);
    const bottom = Math.min(window.innerHeight, Math.max(...rects.map((rect) => rect.bottom)) + padding);

    return {
      x: left,
      y: top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
    };
  }, target);
}

function activateExplorePill(label) {
  return async (page) => {
    await clickButtonExact(page, label);
    await waitFor(1_500);
  };
}

function scrollToExploreSelector(selector, { block = "center", offsetY = 0 } = {}) {
  return async (page) => {
    await page.evaluate(
      ({ targetSelector, scrollBlock, extraOffsetY }) => {
        document.querySelector(targetSelector)?.scrollIntoView({ block: scrollBlock, behavior: "instant" });
        if (extraOffsetY) window.scrollBy(0, extraOffsetY);
      },
      { targetSelector: selector, scrollBlock: block, extraOffsetY: offsetY },
    );
    await waitFor(300);
  };
}

async function openExploreCityDropdown(page) {
  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((candidate) =>
      candidate.className.includes("discover-beta-city-switcher"),
    );
    button?.click();
  });
  await waitFor(400);
}

async function openExploreFiltersDropdown(page) {
  await page.evaluate(() => {
    document.querySelector('button[aria-label="More filters"]')?.click();
  });
  await waitFor(400);
}

async function hoverExploreCard(page) {
  await page.evaluate(() => {
    const card = document.querySelector("article.discover-beta-card--rail-hero, article.discover-beta-card--list");
    if (!card) return;
    const rect = card.getBoundingClientRect();
    window.scrollTo(0, Math.max(0, rect.top - 100));
  });
  await waitFor(200);
  const box = await page.evaluate(() => {
    const card = document.querySelector("article.discover-beta-card--rail-hero, article.discover-beta-card--list");
    if (!card) return null;
    const rect = card.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  if (box) await page.mouse.move(box.x, box.y);
  await waitFor(600);
}

async function activateExploreFirstPill(page) {
  await page.evaluate(() => {
    const pills = [...document.querySelectorAll("button")].filter((button) => {
      const text = button.textContent?.trim();
      return text === "Tonight" || text === "Free";
    });
    pills[0]?.click();
  });
  await waitFor(1_500);
}

async function switchExploreToMap(page) {
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button[role="tab"]')].find(
      (candidate) => candidate.textContent?.trim() === "Map",
    );
    button?.scrollIntoView({ block: "center" });
    button?.click();
  });
  await waitFor(800);
}

async function toggleThemeButton(page) {
  await page.evaluate(() => document.querySelector('button[aria-label="Toggle theme"]')?.click());
  await waitFor(600);
}

async function openExploreBetaCity(page) {
  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("Houston"),
    );
    button?.click();
  });
  await waitFor(400);
}

async function clickSaveEvent(page) {
  await page.evaluate(() => document.querySelector('button[aria-label="Save event"]')?.click());
  await waitFor(300);
}

async function hoverFirstArticle(page) {
  await page.evaluate(() => {
    const article = document.querySelector("article");
    if (!article) return;
    const rect = article.getBoundingClientRect();
    article.dispatchEvent(
      new MouseEvent("mouseover", {
        bubbles: true,
        clientX: rect.left + 50,
        clientY: rect.top + 50,
      }),
    );
  });
  await waitFor(400);
  await page.mouse.move(200, 300);
  await waitFor(300);
}

async function clickWhenChip(page) {
  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) =>
        candidate.className.includes("discover-beta-pill-row__more") && candidate.textContent?.includes("When"),
    );
    button?.click();
  });
  await waitFor(500);
}

async function clickDatePickerShortcut(page, text) {
  await page.evaluate((shortcutText) => {
    const button = [...document.querySelectorAll(".app-date-range-picker__shortcut")].find(
      (candidate) => candidate.textContent?.trim() === shortcutText,
    );
    button?.click();
  }, text);
}

async function selectCustomDateRange(page) {
  await clickWhenChip(page);
  await page.evaluate(() => {
    const button = [...document.querySelectorAll(".app-date-range-picker__shortcut")].find((candidate) =>
      candidate.textContent?.trim().startsWith("Custom"),
    );
    button?.click();
  });
  await waitFor(300);
  await page.evaluate(() => {
    const days = [...document.querySelectorAll(".app-date-range-picker__day")].filter(
      (button) => !button.disabled && !button.classList.contains("app-date-range-picker__day--out-of-month"),
    );
    if (days.length >= 10) days[5].click();
  });
  await waitFor(200);
  await page.evaluate(() => {
    const days = [...document.querySelectorAll(".app-date-range-picker__day")].filter(
      (button) => !button.disabled && !button.classList.contains("app-date-range-picker__day--out-of-month"),
    );
    if (days.length >= 12) days[11].click();
  });
  await waitFor(300);
}

function textFieldStateCapture(name, stateFn) {
  return {
    ...sharedPrimitiveCaptureBase(),
    name,
    before: async (page) => {
      await prepareTextFieldTarget(page);
      await stateFn(page);
    },
    clip: (page) => selectorClip(page, "[data-screenshot-text-field-card]", 16),
  };
}

async function prepareTextFieldTarget(page) {
  await page.waitForSelector(".gc-floating-field", { timeout: 30_000 });
  await page.evaluate(() => {
    const heading = [...document.querySelectorAll("h3")].find((candidate) =>
      candidate.textContent?.trim().startsWith("AppTextField"),
    );
    heading?.scrollIntoView({ block: "center", behavior: "instant" });
    const card = heading?.closest("article");
    const field = card?.querySelector(".gc-floating-field");
    card?.setAttribute("data-screenshot-text-field-card", "1");
    field?.setAttribute("data-screenshot-text-field", "1");
  });
  await waitFor(600);
}

async function resetTextFieldState(page) {
  await page.evaluate(() => {
    const field = document.querySelector("[data-screenshot-text-field]");
    const input = field?.querySelector("input,textarea,select");
    if (input) {
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    field?.classList.remove("is-disabled", "is-readonly", "is-invalid");
  });
  await waitFor(200);
}

async function hoverTextField(page) {
  await resetTextFieldState(page);
  await moveToTextField(page);
  await waitFor(250);
}

async function focusTextField(page) {
  await resetTextFieldState(page);
  await focusInputInside(page, "[data-screenshot-text-field]");
  await waitFor(250);
}

async function fillFocusedTextField(page) {
  await focusTextField(page);
  await page.keyboard.type("Founder Dinner");
  await waitFor(250);
}

async function populateBlurredTextField(page) {
  await fillFocusedTextField(page);
  await page.evaluate(() => document.querySelector("[data-screenshot-text-field] input")?.blur());
  await page.mouse.move(0, 0);
  await waitFor(250);
}

async function populatedHoverTextField(page) {
  await populateBlurredTextField(page);
  await moveToTextField(page);
  await waitFor(250);
}

async function readonlyTextField(page) {
  await populateBlurredTextField(page);
  await page.evaluate(() => document.querySelector("[data-screenshot-text-field]")?.classList.add("is-readonly"));
  await waitFor(200);
}

async function disabledTextField(page) {
  await populateBlurredTextField(page);
  await page.evaluate(() => {
    const field = document.querySelector("[data-screenshot-text-field]");
    field?.classList.remove("is-readonly");
    field?.classList.add("is-disabled");
  });
  await waitFor(200);
}

async function invalidTextField(page) {
  await populateBlurredTextField(page);
  await page.evaluate(() => {
    const field = document.querySelector("[data-screenshot-text-field]");
    field?.classList.remove("is-disabled");
    field?.classList.add("is-invalid");
  });
  await waitFor(200);
}

async function invalidHoverTextField(page) {
  await invalidTextField(page);
  await moveToTextField(page);
  await waitFor(250);
}

async function moveToTextField(page) {
  const box = await page.evaluate(() => {
    const field = document.querySelector("[data-screenshot-text-field]");
    const rect = field?.getBoundingClientRect();
    return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
  });
  if (box) await page.mouse.move(box.x, box.y);
}

async function searchExploreForFounders(page) {
  await page.evaluate(() => {
    const input = document.querySelector("input[type='text'], input[type='search']");
    input?.focus();
  });
  await page.keyboard.type("founders", { delay: 30 });
  await page.keyboard.press("Enter");
  await waitFor(1_500);
}

function fieldSnapCapture(name, selector, value = "") {
  return {
    ...sharedPrimitiveCaptureBase({ viewport: { width: 1600, height: 1000, deviceScaleFactor: 2 } }),
    name,
    before: async (page) => {
      await page.waitForSelector(selector, { timeout: 30_000 });
      if (value) {
        await page.evaluate(
          ({ targetSelector, nextValue }) => {
            const input = document.querySelector(targetSelector)?.querySelector("input,textarea");
            if (!input) return;
            input.value = nextValue;
            input.dispatchEvent(new Event("input", { bubbles: true }));
          },
          { targetSelector: selector, nextValue: value },
        );
      }
      await scrollSelectorIntoView(page, selector);
      await waitFor(400);
    },
    clip: (page) => selectorClip(page, selector, 16),
  };
}

async function clickTestId(page, testId, { evaluate = false } = {}) {
  const selector = `[data-testid="${testId}"]`;
  if (evaluate) {
    await page.evaluate((targetSelector) => {
      document.querySelector(targetSelector)?.click();
    }, selector);
    return;
  }
  await page.click(selector);
}

function waitFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

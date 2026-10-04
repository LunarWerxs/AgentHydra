import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runMaterialSymbolsAudit } from "@saydeploy/architect/engines/design-system/material-symbols-engine";

export const audit = {
  id: "icon-policy",
  title: "Icon Policy",
  category: "design-system",
  defaultConfig: {
    sections: ["material-symbols"],
    outputPath: "tmp/audits/ICON_POLICY_AUDIT.md",
    "material-symbols": {
      roots: ["src"],
      extensions: [".vue", ".ts", ".css"],
      skipSegments: ["node_modules", "dist", "tmp", ".git"],
      skipFilePatterns: ["\\.spec\\.ts$", "\\.test\\.ts$", "[\\\\/]__tests__[\\\\/]"],
      dynamicSafelistPath: "src/lib/icons/material-symbols-safelist.ts",
      cachePath: "tmp/material-symbols-rounded.codepoints",
      policyPath: null,
      outputPath: "tmp/audits/MATERIAL_SYMBOLS_AUDIT.md",
      // Non-Material icon names used as service identifiers or placeholder
      // defaults. These are NOT Material Symbols and are intentionally excluded.
      allowedNonMaterialKeys: ["G", "Icon", "octocat", "S"],
      // Inline SVGs that cannot be replaced by Material Symbols because they
      // are branded third-party logos, data visualization charts, decorative
      // illustrations, or programmatic image generation (avatars, QR codes,
      // ticket artifacts, social cards). Each entry maps a file path to a
      // brief explanation.
      inlineSvgExceptions: {
        "src/app/schedule-utils.ts": "programmatic avatar generation",
        "src/components/public/explore/ExplorePage.vue": "Connections brand logo",
        "src/components/public/hosted-event-public/HostedEventPublicHostStrip.vue":
          "Instagram + LinkedIn brand icons (4 instances)",
        "src/components/public/hosted-event-public/HostedEventPublicMetaSidebar.vue":
          "Google/Outlook/M365/Yahoo/Apple Calendar brand icons (5 instances)",
        "src/components/public/network-demo/NetworkDemoLiveDemoSection.vue": "custom indeterminate progress spinner",
        "src/components/public/shared/fields/PublicFieldRenderer.vue": "data-driven dynamic social profile SVG",
        "src/components/public/shared/PublicTinyHeaderCard.vue": "Connections brand logo",
        "src/components/public/welcome/WelcomeStepConnect.vue": "Google + Microsoft branded provider logos",
        "src/components/public/welcome/WelcomeStepPhantomGraph.vue": "decorative network graph illustration",
        "src/components/shared/analytics/AnalyticsLineChart.vue": "data visualization chart component",
        "src/components/shared/analytics/beta/AnalyticsBrush.vue": "data visualization chart component",
        "src/components/shared/analytics/beta/AnalyticsDonut.vue": "data visualization chart component",
        "src/components/shared/analytics/beta/AnalyticsSparkline.vue": "data visualization chart component",
        "src/components/shared/analytics/beta/AnalyticsTimeSeries.vue": "data visualization chart component",
        "src/components/sign-in/DemoWorkspacePreview.vue": "decorative background curves",
        "src/components/workspace/shell/WorkspaceShellDisplayDialogs.vue": "programmatic avatar generation",
        "src/lib/host/hosted-event-ticket-artifact.ts": "programmatic ticket image generation",
        "src/lib/profile/builder-qr.ts": "programmatic QR code generation",
        "src/shared-primitives-live/sections/DataWorkspaceSection.vue": "demo preview placeholder art",
        "src/shared-primitives-live/sections/DialogsOverlaysSection.vue": "demo preview placeholder art",
        "src/shared-primitives-live/sections/DocumentationSyncSection.vue": "demo preview placeholder art",
        "src/shared-primitives-live/sections/FieldsInputsSection.vue": "demo preview placeholder art",
        "src/shared-primitives-live/sections/HostedEventSignupSection.vue": "demo preview placeholder art",
        "src/shared-primitives-live/sections/LayoutSurfacesSection.vue": "demo preview placeholder art",
        "src/shared-primitives-live/sections/SelectionFeedbackSection.vue": "demo preview placeholder art",
        "src/shared-primitives-live/social/hosted-event-social-card.ts": "programmatic social card image generation",
        "src/SharedPrimitivesLiveHarness.vue": "demo preview placeholder art",
      },
    },
    "icon-optics": {
      url: "http://localhost:4173/_connections/internal/spl26-shared-primitives-live-2026",
      outDir: "tmp/icon-optics",
      deviceScaleFactor: 4,
      warnOffsetPx: 0.75,
      failOffsetPx: 1.25,
      warnSquareDeltaPx: 0.25,
      failSquareDeltaPx: 0.5,
      colorDistanceThreshold: 96,
      // Labeled icons (icon + adjacent text) — measured against the label's
      // cap-height band on the hosted-event public page, which carries the
      // section/presence headings. Box-centered targets can't catch this.
      labelWarnOffsetPx: 0.6,
      labelFailOffsetPx: 1,
      labeledUrl:
        "http://localhost:4173/_connections/internal/spl26-shared-primitives-live-2026/hosted-event-preview",
      labeledTargets: [
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
      ],
      saveCrops: false,
      outputPath: "tmp/audits/ICON_OPTICS_AUDIT.md",
      targets: [
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
      ],
    },
  },
  async run(context) {
    const sections = resolveSections(context);
    const results = [];

    if (sections.includes("material-symbols")) {
      const config = context.checkConfig["material-symbols"] ?? {};
      const policy = readPolicy(context.root, config.policyPath);
      results.push({
        section: "material-symbols",
        ...(await runMaterialSymbolsAudit({
          root: context.root,
          ...config,
          ...policy,
        })),
      });
    }

    if (sections.includes("icon-optics")) {
      const { runIconOpticsAudit } = await import(
        "@saydeploy/architect/engines/design-system/icon-optics-engine"
      );
      const config = context.checkConfig["icon-optics"] ?? {};
      results.push({
        section: "icon-optics",
        ...(await runIconOpticsAudit({
          root: context.root,
          ...config,
          ...readIconOpticsArgs(context.checkArgs),
        })),
      });
    }

    return {
      failed: results.some((result) => result.failed),
      jsonPayload: {
        sections,
        results: results.map((result) => ({
          section: result.section,
          failed: result.failed,
          ...result.jsonPayload,
        })),
      },
      outputPath:
        sections.length === 1
          ? (context.checkConfig[sections[0]]?.outputPath ?? context.checkConfig.outputPath)
          : context.checkConfig.outputPath,
      report: results.map((result) => result.report.trimEnd()).join("\n\n"),
    };
  },
};

function resolveSections(context) {
  const requested = [];
  for (const arg of context.checkArgs) {
    const section = arg.startsWith("--section=") ? arg.slice("--section=".length) : arg;
    if ((section === "material-symbols" || section === "icon-optics") && !requested.includes(section)) {
      requested.push(section);
    }
  }

  return requested.length ? requested : (context.checkConfig.sections ?? audit.defaultConfig.sections);
}

function readPolicy(root, policyPath) {
  if (!policyPath) {
    return {};
  }

  return JSON.parse(readFileSync(resolve(root, policyPath), "utf8"));
}

function readIconOpticsArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--save-crops") {
      options.saveCrops = true;
      continue;
    }
    if (arg === "--url") {
      options.url = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--url=")) {
      options.url = arg.slice("--url=".length);
    }
  }
  return options;
}

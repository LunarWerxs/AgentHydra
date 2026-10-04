import { runMotionPhysicsAudit } from "@saydeploy/architect/engines/design-system/motion-physics-engine";
import { runMaterialMotionPrimitiveAudit } from "@saydeploy/architect/engines/design-system/material-motion-primitive-engine";
import { runTransitionFadeSnapAudit } from "@saydeploy/architect/engines/design-system/transition-fade-snap-engine";
import { runDismissibleBannerCollapseAudit } from "@saydeploy/architect/engines/design-system/dismissible-banner-collapse-engine";
import { runBroadTransitionClassAudit } from "@saydeploy/architect/engines/design-system/broad-transition-class-engine";
import { runViewTransitionAudit } from "@saydeploy/architect/engines/design-system/view-transition-engine";
import { LEGACY_SHARED_COMPONENTS_ROOT, UI_PACKAGE_ROOT } from "@saydeploy/architect/core/primitive-locations";

const SECTION_ALIASES = {
  physics: "physics",
  "motion-physics": "physics",
  primitives: "primitives",
  primitive: "primitives",
  "material-primitives": "primitives",
  "material-motion-primitives": "primitives",
  "fade-snap": "fade-snap",
  transition: "fade-snap",
  "transition-fade-snap": "fade-snap",
  "banner-collapse": "banner-collapse",
  "dismissible-banner": "banner-collapse",
  "dismissible-collapse": "banner-collapse",
  "broad-transition": "broad-transition",
  "transition-all": "broad-transition",
  "view-transition": "view-transition",
  "view-transitions": "view-transition",
  viewtransition: "view-transition",
  "start-view-transition": "view-transition",
};

export const audit = {
  id: "motion-policy",
  title: "Motion Policy",
  category: "design-system",
  requires: { projectNames: ["connections"] },
  defaultConfig: {
    sections: ["physics", "primitives", "fade-snap", "banner-collapse", "broad-transition", "view-transition"],
    outputPath: "tmp/audits/MOTION_POLICY_AUDIT.md",
    physics: {
      roots: [
        "src/styles",
        LEGACY_SHARED_COMPONENTS_ROOT,
        UI_PACKAGE_ROOT,
        "src/SharedPrimitivesLiveHarness.vue",
        "src/shared-primitives-live",
      ],
      tokenFile: "src/styles/core/tokens.css",
      outputPath: "tmp/audits/MOTION_PHYSICS_AUDIT.md",
    },
    "fade-snap": {
      roots: ["src"],
      transitionCss: "src/styles/core/transitions.css",
      outputPath: "tmp/audits/TRANSITION_FADE_SNAP_AUDIT.md",
    },
    primitives: {
      roots: ["src/components", "packages/connections-ui/src/components", "src/styles/core/transitions.css"],
      outputPath: "tmp/audits/MATERIAL_MOTION_PRIMITIVES_AUDIT.md",
    },
    "banner-collapse": {
      roots: ["src/components", "packages/connections-ui/src/components"],
      outputPath: "tmp/audits/DISMISSIBLE_BANNER_COLLAPSE_AUDIT.md",
    },
    "broad-transition": {
      roots: ["src", "packages"],
      outputPath: "tmp/audits/BROAD_TRANSITION_CLASS.md",
    },
    "view-transition": {
      roots: ["src", "packages/connections-ui/src"],
      outputPath: "tmp/audits/VIEW_TRANSITION_AUDIT.md",
    },
  },
  async run(context) {
    const sections = resolveSections(context);
    const results = [];

    if (sections.includes("physics")) {
      results.push({
        section: "physics",
        ...(await runMotionPhysicsAudit({
          root: context.root,
          roots: context.checkConfig.physics?.roots,
          tokenFile: context.checkConfig.physics?.tokenFile,
        })),
      });
    }

    if (sections.includes("primitives")) {
      results.push({
        section: "primitives",
        ...(await runMaterialMotionPrimitiveAudit({
          root: context.root,
          roots: context.checkConfig.primitives?.roots,
        })),
      });
    }

    if (sections.includes("fade-snap")) {
      results.push({
        section: "fade-snap",
        ...(await runTransitionFadeSnapAudit({
          root: context.root,
          roots: context.checkConfig["fade-snap"]?.roots,
          transitionCss: context.checkConfig["fade-snap"]?.transitionCss,
        })),
      });
    }

    if (sections.includes("banner-collapse")) {
      results.push({
        section: "banner-collapse",
        ...(await runDismissibleBannerCollapseAudit({
          root: context.root,
          roots: context.checkConfig["banner-collapse"]?.roots,
        })),
      });
    }

    if (sections.includes("broad-transition")) {
      results.push({
        section: "broad-transition",
        ...(await runBroadTransitionClassAudit({
          root: context.root,
          roots: context.checkConfig["broad-transition"]?.roots,
        })),
      });
    }

    if (sections.includes("view-transition")) {
      results.push({
        section: "view-transition",
        ...(await runViewTransitionAudit({
          root: context.root,
          roots: context.checkConfig["view-transition"]?.roots,
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
      outputPath: resolveOutputPath(context, sections),
      report: results.map((result) => result.report.trimEnd()).join("\n\n"),
    };
  },
};

function resolveSections(context) {
  const requested = [];
  for (const arg of context.checkArgs) {
    const section = arg.startsWith("--section=") ? arg.slice("--section=".length) : arg;
    if (section.startsWith("--")) {
      continue;
    }
    const normalized = SECTION_ALIASES[section];
    if (normalized && !requested.includes(normalized)) {
      requested.push(normalized);
    }
  }

  if (requested.length > 0) {
    return requested;
  }

  return context.checkConfig.sections ?? audit.defaultConfig.sections;
}

function resolveOutputPath(context, sections) {
  if (sections.length === 1) {
    return context.checkConfig[sections[0]]?.outputPath ?? context.checkConfig.outputPath;
  }

  return context.checkConfig.outputPath;
}

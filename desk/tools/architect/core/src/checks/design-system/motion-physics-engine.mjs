import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();

const CHECK_ID = "motion-physics-engine";

// JE-UI-002 regression signatures for menu/popover flyout LEAVE motion:
//  1. A `filter: blur` on any menu-flyout enter/leave pose — the user dislikes
//     the blur and a filter on the leaving panel is a known stutter source.
//  2. The slow expressive overlay/long transform driving the LEAVE — leave must
//     ride the dedicated fast token so closing feels immediate (M3: exit < enter).
const MENU_LEAVE_BLUR = /\.gc-menu-flyout-(?:enter|leave)-(?:from|to)\s*\{[^}]*filter:\s*blur/;
const MENU_LEAVE_SLOW_TRANSFORM =
  /\.gc-menu-flyout-leave-active\s*\{[^}]*transform\s+var\((?:--gc-motion-duration-overlay|--md-sys-motion-duration-long)\)/;

function collectCssFiles(dir, acc) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectCssFiles(full, acc);
    } else if (entry.name.endsWith(".css")) {
      acc.push(full);
    }
  }
  return acc;
}

function run() {
  const cssFiles = collectCssFiles(join(ROOT, "packages/connections-ui/src/styles"), []);
  cssFiles.push(...collectCssFiles(join(ROOT, "src/styles"), []));

  const findings = [];

  for (const file of cssFiles) {
    const css = readFileSync(file, "utf8");

    if (MENU_LEAVE_BLUR.test(css)) {
      findings.push({
        file: relative(ROOT, file),
        rule: "menu-leave-blur",
        message: "Menu/popover flyout leave reintroduced filter: blur — JE-UI-002 regression.",
        severity: "error",
      });
    }

    if (MENU_LEAVE_SLOW_TRANSFORM.test(css)) {
      findings.push({
        file: relative(ROOT, file),
        rule: "menu-leave-slow-transform",
        message: "Menu/popover flyout leave uses the slow overlay/long transform — JE-UI-002 regression.",
        severity: "error",
      });
    }
  }

  return { findings };
}

export const check = {
  id: CHECK_ID,
  run,
};

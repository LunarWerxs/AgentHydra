// Guardrail for a real bug we hit (2026-07-16): the Sessions "filter by instance" dropdown opened
// off-screen (and, being a MODAL popper, also froze the whole app's pointer events) when nested
// inside <IconTooltip>. Live DOM instrumentation ruled out the first theory (a lost click handler
// on the kit <Button>): the merged onClick array was intact and Enter/synthetic clicks both fired.
//
// The real cause: reka positions a popper by having its trigger's anchor component (MenuAnchor /
// PopperAnchor) call injectPopperRootContext(), which walks the VUE COMPONENT TREE for the NEAREST
// PopperRoot. IconTooltip (web/src/shell/IconTooltip.vue) renders its own <Tooltip>, which is
// itself a PopperRoot. So when a menu/popover root WRAPS AROUND an <IconTooltip> that contains that
// root's trigger:
//
//   <DropdownMenu>                                          <- PopperRoot(MENU)
//     <IconTooltip>                                         <- PopperRoot(TOOLTIP), nested inside
//       <DropdownMenuTrigger as-child><button/></DropdownMenuTrigger>  <- anchors to the NEAREST
//     </IconTooltip>                                           root: the tooltip's, not the menu's
//     <DropdownMenuContent/>
//   </DropdownMenu>
//
// the tooltip steals the anchor and the menu's own PopperRoot never gets one. floating-ui then
// leaves the content at its unpositioned initial `transform: translate(0, -200%)` (off-screen
// above the viewport). DropdownMenu is modal by default, so it also sets `body { pointer-events:
// none }`: the user sees no menu AND the app stops responding to the mouse. A Popover nested the
// same way fails silently (not modal). A Tooltip next to either positions fine, which is what
// proved the anchor was being stolen rather than floating-ui being broken.
//
// The fix: the popper root must live INSIDE IconTooltip's slot, wrapped in a plain element (so the
// tooltip still has something to anchor to), putting PopperRoot(menu) between the tooltip's anchor
// and the MenuAnchor:
//
//   <IconTooltip label="...">
//     <span class="inline-flex">              <- the tooltip's own anchor element
//       <DropdownMenu>                        <- now the nearest PopperRoot for MenuAnchor
//         <DropdownMenuTrigger as-child><button/></DropdownMenuTrigger>
//         <DropdownMenuContent/>
//       </DropdownMenu>
//     </span>
//   </IconTooltip>
//
// This check is a text scan, not an AST: it flags any <IconTooltip> block that contains a reka
// `*Trigger` without also containing that trigger's matching root component (DropdownMenu / Popover
// / Select / HoverCard / Combobox / Menubar / ContextMenu / Tooltip) inside the same block, i.e.
// the trigger's root is missing or lives outside the tooltip, which is the broken nesting.
//
// Self-contained by design: it imports nothing from the arkitect core (a bare
// `import "connections-arkitect"` doesn't resolve from a check that lives in the repo rather than
// the runner's node_modules), and returns plain finding objects, which the runner accepts as-is.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ID = "reka-popper-root-outside-tooltip";

// Trigger tag name -> its matching popper root component name.
const TRIGGER_TO_ROOT = {
  DropdownMenuTrigger: "DropdownMenu",
  PopoverTrigger: "Popover",
  SelectTrigger: "Select",
  HoverCardTrigger: "HoverCard",
  ComboboxTrigger: "Combobox",
  ComboboxAnchor: "Combobox",
  MenubarTrigger: "Menubar",
  ContextMenuTrigger: "ContextMenu",
  TooltipTrigger: "Tooltip",
};

const TRIGGER_TAG = new RegExp(`<(${Object.keys(TRIGGER_TO_ROOT).join("|")})\\b`, "g");

// Dirs never worth scanning. web/src/components/ui is the generated shadcn kit; misc/ is Windows
// launcher tooling; both are also excluded in arkitect.config.json.
const SKIP_DIRS = new Set([
  "node_modules", "dist", ".git", "tmp", ".arkitect", "coverage", "build", "ui", "misc",
]);

const lineAt = (text, index) => text.slice(0, index).split("\n").length;

/** Recursively yield every .vue file under `dir`, skipping build/vendor/generated trees. */
function* vueFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* vueFiles(p);
    } else if (e.name.endsWith(".vue")) {
      yield p;
    }
  }
}

/** For each top-level <IconTooltip>...</IconTooltip> block, find a reka *Trigger inside it whose
 *  matching root component tag is absent from that same block (root missing entirely, or wrapping
 *  the IconTooltip from outside rather than sitting inside it). Returns finding offsets. */
export function findViolations(text) {
  const hits = [];

  for (const block of text.matchAll(/<IconTooltip\b[\s\S]*?<\/IconTooltip>/g)) {
    const blockText = block[0];
    const blockStart = block.index;

    TRIGGER_TAG.lastIndex = 0;
    for (const tg of blockText.matchAll(TRIGGER_TAG)) {
      const triggerName = tg[1];
      const rootName = TRIGGER_TO_ROOT[triggerName];
      // Tooltip's own trigger is what IconTooltip itself renders internally, not a nested popper.
      if (rootName === "Tooltip") continue;
      const rootTag = new RegExp(`<${rootName}\\b`);
      if (!rootTag.test(blockText)) {
        hits.push({ index: blockStart + tg.index, triggerName, rootName });
      }
    }
  }

  return hits.sort((a, b) => a.index - b.index);
}

export const audit = {
  id: ID,
  title: "reka popper root must live inside IconTooltip, not wrap around it",
  category: "custom",
  domain: "code",
  requires: {},
  gating: true, // block --fail-on-drift: this exact shape silently breaks a control (and freezes the app for modal poppers)
  async run(ctx) {
    const root = ctx?.root ?? process.cwd();
    const start = existsSync(join(root, "web", "src")) ? join(root, "web", "src") : root;
    const findings = [];

    for (const file of vueFiles(start)) {
      let text;
      try {
        if (statSync(file).size > 2_000_000) continue; // no .vue is this big; skip anything pathological
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (!text.includes("IconTooltip") || !text.includes("Trigger")) continue;
      const rel = relative(root, file).replace(/\\/g, "/");
      for (const hit of findViolations(text)) {
        findings.push({
          id: ID,
          title: "reka *Trigger inside IconTooltip is missing its own popper root (menu/popover opens off-screen)",
          severity: "error",
          file: rel,
          line: lineAt(text, hit.index),
          message:
            `<${hit.triggerName}> sits inside an <IconTooltip> block without its matching <${hit.rootName}> ` +
            "root also inside that block. reka's MenuAnchor/PopperAnchor walks the component tree for the " +
            "NEAREST PopperRoot; if that root is missing or wraps the IconTooltip from outside, the " +
            "IconTooltip's own Tooltip root gets anchored instead, and the real content stays at its " +
            "unpositioned translate(0, -200%) (off-screen), freezing pointer events too if the popper is modal.",
          fix:
            `Move <${hit.rootName}> inside the <IconTooltip> slot, wrapped in a plain element for the ` +
            `tooltip to anchor to: <IconTooltip><span class="inline-flex"><${hit.rootName}><${hit.triggerName} ` +
            `as-child>...</${hit.triggerName}>...</${hit.rootName}></span></IconTooltip>.`,
        });
      }
    }

    const failed = findings.length > 0;
    const report = failed
      ? `Found ${findings.length} reka trigger(s) inside IconTooltip missing their popper root:\n` +
        findings.map((f) => `- ${f.file}:${f.line}`).join("\n")
      : "No reka popper roots are wrapped around an IconTooltip. ✓";

    return { failed, findings, report };
  },
};

// Standalone CLI (used by CI): `bun|node <thisfile>` prints the report and exits 1 on any
// violation. During an arkitect run the module is only IMPORTED (process.argv[1] = the arkitect
// bin, not this file), so this block is inert there; it fires only on a direct invocation.
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const res = await audit.run({ root: process.cwd() });
  console.log(res.report);
  if (res.failed) process.exit(1);
}

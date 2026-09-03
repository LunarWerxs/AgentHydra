import {
  computed,
  getCurrentScope,
  onScopeDispose,
  ref,
  toValue,
  watch,
  type MaybeRefOrGetter,
  type Ref,
} from "vue";
import { useMediaQuery, useWindowSize } from "@vueuse/core";
import { contributeContentInset } from "@/lib/content-inset";

/**
 * usePushPanel, the shared "settings slide-in that PUSHES content" behaviour.
 *
 * On desktop the panel docks to the right edge and the page content is shifted
 * left by the panel's width (an animated `padding-right` on the app shell root).
 * On mobile it becomes a bottom sheet and nothing is pushed. The chosen side is
 * LOCKED at open time so a mid-open viewport resize can't break the animation.
 *
 * Apps whose shell is CENTERED at a max width should pass `shellMaxWidth`: the
 * panel docks to the viewport's right edge, so on a wide monitor it may overlap
 * the centered shell only partially (or not at all). The shift then becomes just
 * that overlap instead of the full panel width — without it, opening the panel
 * squeezes the content against a band of dead space (bug class caught in
 * agenthydra 2026-07-10: Instances table crushed to half width by a 480px pad
 * while the panel overlapped the shell by ~30px).
 *
 * Usage (in an app shell):
 *   const open = ref(false);
 *   const { side, containerStyle } = usePushPanel(open, { shellMaxWidth: () => 1000 });
 *   // <div class="transition-[padding] duration-300 ease-in-out" :style="containerStyle"> ... </div>
 *   // <SettingsPanel v-model:open="open" :side="side"> ... </SettingsPanel>
 */
export type PushPanelSide = "right" | "bottom";

export interface UsePushPanelOptions {
  /** Breakpoint at/above which the panel docks to the side and pushes content. */
  desktopQuery?: string;
  /** Panel width in px when docked on the side (also drives the content shift). */
  widthPx?: number;
  /** Max content width of a CENTERED app shell (px). When set, the content shift is
   *  only the panel's actual overlap with the shell (possibly 0 on wide viewports).
   *  Omit for full-width shells — the shift is then always the panel width. */
  shellMaxWidth?: MaybeRefOrGetter<number | null | undefined>;
}

export const DEFAULT_DESKTOP_QUERY = "(min-width: 768px)";
export const DEFAULT_PANEL_WIDTH = 420;

// Open right-docked push panels register their configured width here so the Sidebar
// DEV guard can detect an app that wired different widths into Sidebar and usePushPanel
// (the shift math lives here, so the guard can't recompute it from the inset var).
const openPushWidths = new Set<() => number>();

/** DEV-guard helper: widest currently-open right-docked push panel (0 when none). */
export function maxOpenPushPanelWidth(): number {
  let max = 0;
  for (const get of openPushWidths) max = Math.max(max, get());
  return max;
}

export function usePushPanel(open: Ref<boolean>, options: UsePushPanelOptions = {}) {
  const query = options.desktopQuery ?? DEFAULT_DESKTOP_QUERY;
  const width = options.widthPx ?? DEFAULT_PANEL_WIDTH;

  const isDesktop = useMediaQuery(query);
  const side = ref<PushPanelSide>(isDesktop.value ? "right" : "bottom");
  watch(open, (isOpen) => {
    if (isOpen) side.value = isDesktop.value ? "right" : "bottom";
  });

  const { width: viewportWidth } = useWindowSize();

  const shiftPx = computed(() => {
    if (!open.value || side.value !== "right") return 0;
    const shellMax = toValue(options.shellMaxWidth);
    if (!shellMax) return width;
    // Centered shell: push only by the slice of the panel that overlaps it. The gap
    // between the shell's right edge and the viewport's right edge absorbs the rest.
    const vw = viewportWidth.value;
    const gap = Math.max(0, (vw - Math.min(vw, shellMax)) / 2);
    return Math.max(0, width - gap);
  });
  const containerStyle = computed<{ paddingRight?: string }>(() => ({
    paddingRight: shiftPx.value ? `${shiftPx.value}px` : undefined,
  }));

  // A docked panel covers the viewport's right edge — publish the shift so centered
  // dialogs re-center over the remaining content (lib/content-inset.ts). With a
  // centered shell this is the overlap, which lands dialogs over the visible slice
  // of the shell rather than the visible slice of the viewport — same intent.
  const stopInset = contributeContentInset(shiftPx);
  const openWidth = () => (open.value && side.value === "right" ? width : 0);
  openPushWidths.add(openWidth);
  if (getCurrentScope())
    onScopeDispose(() => {
      stopInset();
      openPushWidths.delete(openWidth);
    });

  return { side, shiftPx, containerStyle, widthPx: width };
}

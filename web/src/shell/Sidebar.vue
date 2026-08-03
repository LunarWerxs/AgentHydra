<script setup lang="ts">
import type { CSSProperties, HTMLAttributes } from "vue";
import { computed, watch } from "vue";
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from "reka-ui";
import { X } from "@lucide/vue";
import { cn } from "@/lib/utils";
import { type PushPanelSide, DEFAULT_PANEL_WIDTH, maxOpenPushPanelWidth } from "./usePushPanel";

/**
 * Sidebar, the ONE slide-in panel every LunarWerx app uses (settings, drawers,
 * viewers). No bespoke per-app sidebar code.
 *
 * mode="push" (default, desktop side="right"): non-modal, NO backdrop. The panel
 *   slides in from the edge over 300ms; pair with usePushPanel so the shell's
 *   content padding animates over the same 300ms, the panel and page move
 *   together (no snap-then-shift). Outside clicks do NOT close it (close via ✕ /
 *   Escape / the trigger), which also prevents the open-then-vanish flash when it's
 *   opened from an external button.
 * mode="overlay": modal, dimmed backdrop, slides in on top (for wide drawers that
 *   are too wide to push sensibly).
 * side="bottom" (mobile): always a modal bottom sheet with a backdrop.
 */
const props = withDefaults(
  defineProps<{
    open?: boolean;
    side?: PushPanelSide;
    mode?: "push" | "overlay";
    title?: string;
    description?: string;
    widthPx?: number;
    rightOffsetPx?: number;
    class?: HTMLAttributes["class"];
    /** Override the body wrapper classes (e.g. content-heavy drawers that manage
     *  their own scroll). Defaults to a padded, vertically-scrolling region. */
    bodyClass?: HTMLAttributes["class"];
  }>(),
  {
    open: false,
    side: "right",
    mode: "push",
    title: "",
    widthPx: DEFAULT_PANEL_WIDTH,
    rightOffsetPx: 0,
  },
);

const emit = defineEmits<{ "update:open": [boolean] }>();

const isBottom = computed(() => props.side === "bottom");
// Backdrop + focus-trap whenever we're not a desktop push panel.
const overlayed = computed(() => isBottom.value || props.mode === "overlay");

const contentStyle = computed<CSSProperties>(() => {
  if (isBottom.value) return {};
  return {
    width: "100%",
    maxWidth: `${props.widthPx}px`,
    right: props.rightOffsetPx ? `${props.rightOffsetPx}px` : undefined,
  };
});

// A push panel never dismisses on an outside click, only ✕ / Escape / the trigger
// toggle. (This also swallows the opening click from an external trigger, so it can't
// open-then-vanish.) Modal overlays, the mobile bottom sheet and wide overlay drawers, 
// keep the normal tap-outside-to-close affordance.
function guardOutside(e: Event) {
  if (!overlayed.value) e.preventDefault();
}

// DEV guard: a right-docked push panel must be matched by a usePushPanel configured
// with (at least) THIS panel's width, or the content shift and modal centering
// disagree with the rendered panel (bug class caught in agenthydra 2026-07-10:
// width-px=480 panel over a bare usePushPanel() = 420). Compared against the
// CONFIGURED width, not the --content-inset-right var: with shellMaxWidth the
// correct shift is the panel↔shell overlap, legitimately smaller than the panel.
if (import.meta.env.DEV) {
  watch(
    () => props.open,
    (isOpen) => {
      if (!isOpen || props.side !== "right" || props.mode !== "push") return;
      // setTimeout, not rAF: the shell's open-state flush is what registers the
      // width, and rAF never fires in hidden/background tabs.
      window.setTimeout(() => {
        if (!props.open) return;
        if (maxOpenPushPanelWidth() < props.widthPx) {
          console.warn(
            `[Sidebar] push panel is ${props.widthPx}px wide but no open usePushPanel is ` +
              `configured for at least that width. Pass the same width to the shell's ` +
              `usePushPanel({ widthPx: ${props.widthPx} }) so the content shift, panel width ` +
              `and modal centering agree.`,
          );
        }
      }, 200);
    },
  );
}
</script>

<template>
  <DialogRoot :open="open" :modal="overlayed" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay
        v-if="overlayed"
        class="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0"
      />
      <DialogContent
        data-slot="sidebar"
        :data-side="side"
        :style="contentStyle"
        :class="cn(
          'bg-background text-foreground fixed z-50 flex flex-col shadow-xl outline-none ease-in-out data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:duration-300 data-[state=closed]:duration-300',
          isBottom
            ? 'inset-x-0 bottom-0 max-h-[92vh] rounded-t-2xl border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom'
            : 'inset-y-0 right-0 h-full border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right',
          props.class,
        )"
        @pointer-down-outside="guardOutside"
        @interact-outside="guardOutside"
      >
        <!-- glassy header: translucent + blurred, with the default body pulled up
             underneath it (-mt/pt pair) so scrolled content shimmers through. Custom
             bodyClass consumers keep the plain in-flow header (no overlap surprises). -->
        <header
          class="relative z-10 flex h-12 shrink-0 items-center gap-2 bg-background/70 px-4 pr-12 backdrop-blur-md"
        >
          <slot name="header">
            <slot name="title-icon" />
            <DialogTitle class="text-xs font-semibold">{{ title }}</DialogTitle>
          </slot>
          <!-- keep a title for a11y even when a custom #header is provided -->
          <DialogTitle v-if="$slots.header" class="sr-only">{{ title }}</DialogTitle>
          <DialogDescription class="sr-only">{{ description || title }}</DialogDescription>
        </header>

        <div :class="bodyClass || 'scroll-slim -mt-12 min-h-0 flex-1 overflow-y-auto p-3.5 pt-15'">
          <slot />
        </div>

        <footer v-if="$slots.footer" class="shrink-0 px-4 py-2.5">
          <slot name="footer" />
        </footer>

        <DialogClose
          class="ring-offset-background focus:ring-ring absolute top-3 right-3 z-20 rounded-sm p-1 opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:outline-hidden"
          aria-label="Close"
          title="Close"
        >
          <X class="size-4" />
        </DialogClose>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

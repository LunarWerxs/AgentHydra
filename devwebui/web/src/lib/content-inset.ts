import { computed, shallowReactive, watchEffect, type Ref } from "vue";

/**
 * Tracks how many pixels of the viewport's right edge are covered by docked push panels
 * (settings drawer, file viewer, …) and mirrors the total into a `--content-inset-right`
 * CSS var on <html>. Centered overlays (ui/dialog, ui/alert-dialog) subtract it so modals
 * center over the *visible* content area instead of the full viewport — they're portaled
 * and position:fixed, so a CSS var is the only signal that reaches them.
 *
 * usePushPanel contributes automatically; bespoke panels (e.g. RepoYeti's file viewer)
 * register their own reactive width. Contributions are additive.
 */
const sources = shallowReactive(new Set<Ref<number>>());

const total = computed(() => {
  let sum = 0;
  for (const s of sources) sum += s.value || 0;
  return sum;
});

let started = false;
function ensureWatcher(): void {
  if (started || typeof document === "undefined") return;
  started = true;
  // Module-level effect, app lifetime — same posture as lib/theme.ts's watchers.
  watchEffect(() => {
    document.documentElement.style.setProperty("--content-inset-right", `${total.value}px`);
  });
}

/** Register a reactive right-inset contributor (px). Returns an unregister function. */
export function contributeContentInset(px: Ref<number>): () => void {
  sources.add(px);
  ensureWatcher();
  return () => {
    sources.delete(px);
  };
}

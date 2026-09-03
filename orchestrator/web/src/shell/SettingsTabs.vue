<script setup lang="ts" generic="T extends string">
// Segmented tab bar for a settings panel: flat buttons in a bordered pill row with the
// active tab lifted onto the page background. Promoted from RepoYeti's Settings
// (2026-07-10) when DevWebUI needed the identical bar; the tab CONTENT stays app-local,
// only the bar is kit. Rule for consumers: keep every tab's sections MOUNTED behind
// v-show (not v-if) whenever a section loads its data from an open-watcher, or a
// section first mounted by a later tab click never runs that watcher.
//
// The active segment is a sliding indicator (absolutely positioned div measured against
// the active button's offsetLeft/offsetWidth) rather than a per-button background swap,
// so switching tabs animates instead of jump-cutting. Re-measures on tabs/model change and
// window resize (ResizeObserver would be overkill for a handful of flex-basis buttons).
import { nextTick, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from 'vue';

const props = defineProps<{ tabs: readonly { id: T; label: string }[] }>();

const model = defineModel<T>({ required: true });

const tablistEl = ref<HTMLElement | null>(null);
const buttonEls = ref<Record<string, HTMLElement | undefined>>({});
const indicatorStyle = ref<{ transform: string; width: string }>({ transform: 'translateX(0px)', width: '0px' });
const indicatorReady = ref(false);

function setButtonEl(id: T, el: Element | ComponentPublicInstance | null) {
  buttonEls.value[id] = (el as HTMLElement) || undefined;
}

function measure() {
  const active = buttonEls.value[model.value];
  if (!active || !tablistEl.value) return;
  // The indicator is absolutely positioned, so its origin is the tablist's PADDING box, while
  // this measured delta is border-edge to border-edge — hence the clientLeft (= border-left
  // width) subtraction. Previously the indicator sat at `left-1` AND translated by the full
  // offset, double-counting the container's 4px pad and sliding every pill right of its own
  // label (dead space on the right of a wide tab like "Automation", none on the left).
  // Rect-based rather than offsetLeft so a zoomed/transformed ancestor stays consistent.
  const listRect = tablistEl.value.getBoundingClientRect();
  const rect = active.getBoundingClientRect();
  const left = rect.left - listRect.left - tablistEl.value.clientLeft;
  indicatorStyle.value = { transform: `translateX(${left}px)`, width: `${rect.width}px` };
  indicatorReady.value = true;
}

function onResize() {
  measure();
}

watch(
  () => [model.value, props.tabs.map((tb) => tb.id).join('|')],
  () => void nextTick(measure),
  { immediate: true },
);

onMounted(() => {
  void nextTick(measure);
  window.addEventListener('resize', onResize);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
});
</script>

<template>
  <div
    ref="tablistEl"
    role="tablist"
    class="relative flex shrink-0 gap-1 rounded-lg border border-border/60 bg-secondary/30 p-1"
  >
    <div
      v-if="indicatorReady"
      class="pointer-events-none absolute inset-y-1 left-0 rounded-md bg-background shadow-sm transition-[transform,width] duration-200 ease-out"
      :style="indicatorStyle"
      aria-hidden="true"
    />
    <button
      v-for="tb in tabs"
      :key="tb.id"
      :ref="(el) => setButtonEl(tb.id, el)"
      type="button"
      role="tab"
      :aria-selected="model === tb.id"
      class="relative z-10 flex-1 rounded-md px-1 py-1.5 text-[12.5px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40"
      :class="model === tb.id ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'"
      @click="model = tb.id"
    >
      {{ tb.label }}
    </button>
  </div>
</template>

<script setup lang="ts">
// Animated expand/collapse for panels that contain a `position: sticky` element — the instance
// tables (whose header is `sticky top-0`) and the queue card's run viewer.
//
// WHY THIS EXISTS ALONGSIDE @/shell/ExpandTransition.vue
//
// Same CSS grid-rows 0fr↔1fr trick, same feel, one difference that is the entire point: the kit's
// version keeps `overflow: hidden` on its inner wrapper FOREVER, and an element with a non-visible
// overflow becomes the scrollport that `position: sticky` resolves against. Wrap a table in it and
// the sticky header silently stops sticking — which is exactly why these tables were left as bare
// `v-show` snaps with a rotating chevron as the only feedback.
//
// Here the clip is applied ONLY while the transition is actually running (Vue adds the
// `-enter-active` / `-leave-active` classes for precisely that window). Open and idle, the wrapper
// is `overflow: visible` and sticky behaves exactly as it does with no wrapper at all. The
// ~200ms in between is the one moment nothing is being scrolled, so there is nothing to break.
//
// The freed clip also fixes a second thing on the way past: popovers, selects and focus rings that
// render inside an expanded block are no longer cut off at its edge.
//
// Deliberately NOT pushed up into the kit: that would rewrite a shared component vendored into
// five sibling apps for a problem only this app currently has. If a sibling grows a sticky header
// inside a collapsible, that is the moment to promote this and delete it from here.
//
// THE TABLE'S OWN BOX BROKE STICKY TOO
//
// The kit's Table wraps every <table> in an `overflow-x: auto` div, and a horizontal scroller is a
// scroll container in both axes, so the header stuck to THAT div (which never scrolls vertically)
// and rode off the top with the rows (measured 2026-09-26: thead top 294 -> -6 after a 300px
// scroll). So the box is left `overflow: visible` while its table fits, and becomes a scroller only
// when the table is genuinely wider than the view: the header sticks in the normal case, and a
// too-narrow window still scrolls the table sideways inside its own box, never the whole page.
import { onBeforeUnmount, ref, watch } from 'vue'

defineProps<{ open: boolean }>()

const clip = ref<HTMLElement | null>(null)
const fits = ref(true)
let observer: ResizeObserver | null = null

// The clip is observed as well as the tables: a window resize changes its width, and a table
// that renders later changes its height, which is when it gets picked up here.
function measure(): void {
  const el = clip.value
  if (!el || !observer) return
  const tables = [...el.querySelectorAll<HTMLElement>('[data-slot="table"]')]
  for (const t of tables) observer.observe(t)
  fits.value = tables.every((t) => t.offsetWidth <= el.clientWidth)
}

watch(clip, (el) => {
  observer?.disconnect()
  observer = null
  if (!el) return
  observer = new ResizeObserver(measure)
  observer.observe(el)
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <Transition name="expand-area">
    <div v-if="open" class="expand-area-grid">
      <div ref="clip" class="expand-area-clip min-h-0" :class="{ 'expand-area-fits': fits }">
        <slot />
      </div>
    </div>
  </Transition>
</template>

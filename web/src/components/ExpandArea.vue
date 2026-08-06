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
defineProps<{ open: boolean }>()
</script>

<template>
  <Transition name="expand-area">
    <div v-if="open" class="expand-area-grid">
      <div class="expand-area-clip min-h-0"><slot /></div>
    </div>
  </Transition>
</template>

<style scoped>
.expand-area-grid {
  display: grid;
  grid-template-rows: 1fr;
}

/* Only while the transition runs — see the header comment. */
.expand-area-enter-active .expand-area-clip,
.expand-area-leave-active .expand-area-clip {
  overflow: hidden;
}

/* 0.22s ease-out matches the kit's --animate-collapsible-down, so a section that opens here and a
   reka Collapsible elsewhere in the same view move at the same speed. The opacity ramp is shorter
   than the height one and eased out, so the content has arrived before the box stops growing —
   the difference between "it slid in" and "it stretched". */
.expand-area-enter-active,
.expand-area-leave-active {
  transition:
    grid-template-rows 0.22s ease-out,
    opacity 0.16s ease-out;
}

.expand-area-enter-from,
.expand-area-leave-to {
  grid-template-rows: 0fr;
  opacity: 0;
}

/* The app already honours this for theme swaps (styles/kit-base.css); motion added here has to
   honour it too. Not `none` — a 0.01ms transition still fires transitionend, so nothing that
   waits on the animation completing can hang. */
@media (prefers-reduced-motion: reduce) {
  .expand-area-enter-active,
  .expand-area-leave-active {
    transition-duration: 0.01ms;
  }
}
</style>

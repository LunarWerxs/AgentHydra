<script setup lang="ts">
// One picture at full size over the window: a click anywhere or Escape closes it.
import { onBeforeUnmount, watch } from 'vue'
import { X } from '@lucide/vue'
import { closeLightbox, lightbox } from '../lib/media'

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') closeLightbox()
}
watch(
  () => !!lightbox.value,
  (open) => (open ? window.addEventListener('keydown', onKey) : window.removeEventListener('keydown', onKey)),
)
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  closeLightbox()
})
</script>

<template>
  <Teleport to="body">
    <Transition enter-from-class="opacity-0" leave-to-class="opacity-0" enter-active-class="transition duration-150" leave-active-class="transition duration-150">
      <div
        v-if="lightbox"
        class="fixed inset-0 z-40 flex cursor-zoom-out items-center justify-center bg-black/80 p-10"
        role="dialog"
        aria-modal="true"
        :aria-label="lightbox.alt || 'Picture'"
        @click="closeLightbox"
      >
        <img :src="lightbox.src" :alt="lightbox.alt" class="max-h-full max-w-full rounded-8 object-contain shadow-[var(--shadow-menu)]" />
        <button type="button" class="tx-action absolute right-4 top-4" aria-label="Close" @click.stop="closeLightbox">
          <X class="size-4" />
        </button>
      </div>
    </Transition>
  </Teleport>
</template>

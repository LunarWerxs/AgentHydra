<script setup lang="ts">
import { computed } from 'vue'
import { Volume2, VolumeX } from '@lucide/vue'
import { setUnattributedMuted, unattributedMuted, unattributedSound } from '@/lib/chat-audio'
import { Tip } from '@/components/ui/tooltip'

// Sound from the headless Chrome pages no chat owns: one speaker for all of them, shown only while some make sound.
// Its tooltip lists each profile and the page's host; a click mutes or unmutes those pages.
const pages = computed(() => unattributedSound())
const muted = computed(() => unattributedMuted())
const label = computed(() => {
  const lines = pages.value.map((p) => `${profileName(p.profile)}: ${hostOf(p.url)}`)
  return [muted.value ? 'Unmute pages no chat owns' : 'Mute pages no chat owns', ...lines].join('\n')
})

function profileName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}
</script>

<template>
  <Tip v-if="pages.length > 0" :label="label" side="top">
    <button
      type="button"
      data-testid="headless-audio"
      :aria-label="muted ? 'Unmute pages no chat owns' : 'Mute pages no chat owns'"
      :aria-pressed="muted"
      class="ms-auto flex size-6 shrink-0 items-center justify-center rounded-(--radius-6) hover:bg-fill-hover hover:text-text"
      :class="muted ? 'text-text-muted' : 'text-text-2'"
      @click="setUnattributedMuted(!muted)"
    >
      <VolumeX v-if="muted" class="size-4" />
      <Volume2 v-else class="size-4" />
    </button>
  </Tip>
</template>

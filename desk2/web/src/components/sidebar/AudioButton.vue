<script setup lang="ts">
import { computed } from 'vue'
import { Volume2, VolumeX } from '@lucide/vue'
import { speakerFor, toggleMuted } from '@/lib/chat-audio'
import { Tip } from '@/components/ui/tooltip'

// A chat's speaker, as a browser tab's: shown while the chat plays sound (a video in it, a page in its browser pane) or
// is muted; one click mutes or unmutes just this chat, without opening it. It sits at the row's right end and moves
// left of the three dots while those show (the row's hover or open menu, `open`).
const props = defineProps<{ chatId: string; open?: boolean }>()
const speaker = computed(() => speakerFor(props.chatId))
</script>

<template>
  <Tip v-if="speaker" :label="speaker.label" side="top">
    <button
      type="button"
      data-testid="chat-audio"
      :aria-label="speaker.label"
      :aria-pressed="speaker.muted"
      class="absolute top-[3px] flex size-5 items-center justify-center rounded-[var(--radius-5)] hover:bg-fill-hover hover:text-text group-hover/row:right-[23px]"
      :class="[open ? 'right-[23px]' : 'right-[3px]', speaker.muted ? 'text-text-muted' : 'text-text-2']"
      @click.stop="toggleMuted(chatId)"
      @keydown.enter.stop
    >
      <VolumeX v-if="speaker.muted" class="size-4" />
      <Volume2 v-else class="size-4" />
    </button>
  </Tip>
</template>

<script setup lang="ts">
import { newSessionGlyphs } from '@/lib/icons'
import type { Tip } from './logic'

// The tip banner between the env pills and the new-session box (new-session-tip-and-composer.png):
// h40, r10, #ffffff0d, a 20px lightbulb tile, the tip in 13/500, Try it and Dismiss on the right.
defineProps<{ tip: Tip }>()
const emit = defineEmits<{ try: [tip: Tip]; dismiss: [tip: Tip] }>()
</script>

<template>
  <div role="note" aria-label="Tip" class="flex h-10 min-w-0 items-center rounded-(--radius-10) bg-fill-5 ps-2 pe-2 text-[13px] leading-4.75">
    <span class="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-(--fill-secondary) text-text-2" aria-hidden="true">
      <newSessionGlyphs.tip class="size-4" />
    </span>
    <p class="relative top-[-1.5px] ms-1.25 min-w-0 flex-1 truncate font-medium text-text">
      {{ tip.text }}<template v-if="tip.link">
        <span class="text-(--accent-text)"> {{ tip.link }}</span>
      </template>
    </p>
    <button
      v-if="tip.action"
      type="button"
      class="ms-3 flex h-6 shrink-0 items-center rounded-(--radius-6) px-1.5 font-medium text-text transition-colors duration-60 hover:bg-(--fill-hover)"
      @click="emit('try', tip)"
    >
      <span class="relative top-[-1.5px]">Try it</span>
    </button>
    <button
      type="button"
      class="ms-3 flex size-6 shrink-0 items-center justify-center rounded-(--radius-6) text-text-muted transition-colors duration-60 hover:bg-(--fill-hover) hover:text-text"
      aria-label="Dismiss"
      title="Dismiss this tip"
      @click="emit('dismiss', tip)"
    >
      <newSessionGlyphs.dismiss class="size-4" />
    </button>
  </div>
</template>

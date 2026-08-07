<script setup lang="ts">
// The permanent instance NUMBER chip (`#7`), shared by all three instance tables — desktop, CLI
// and Codex. One component rather than three copies because the number is the ONE identifier that
// spans them: it comes from a single sequence (server/src/core/instance-numbers.ts), so `#7` in the
// Codex table can never collide with `#7` in the desktop table, and the chip must look and behave
// identically wherever it appears or that guarantee stops being legible.
//
// It is read-aloud UI. Its whole reason to exist is that a folder path and a uuid cannot be said
// out loud to an AI, and the folder NAME is not trustworthy — an instance signed into a different
// account than the one its folder was named after goes on displaying the old name. So the chip is
// deliberately prominent, monospaced, and copies on click.
import { Check } from '@lucide/vue'
import { onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const props = defineProps<{
  /** The number itself. 0 means the registry could not assign one (an unwritable data dir); the
   *  chip hides rather than showing a `#0` that no tool would resolve. */
  num: number
}>()

const { t } = useI18n()

const copied = ref(false)
let timer: number | undefined

function copy() {
  // The bare number, not `#7`: it is what gets pasted into `instance: 7` or typed at an agent, and
  // an MCP call accepts either but the chat message reads better without the hash already there.
  navigator.clipboard?.writeText(String(props.num)).catch(() => {})
  copied.value = true
  window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    copied.value = false
  }, 1200)
}

onUnmounted(() => window.clearTimeout(timer))
</script>

<template>
  <Tooltip v-if="num > 0">
    <TooltipTrigger as-child>
      <button
        type="button"
        class="inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded border border-border bg-muted/60 px-1 py-px font-mono text-[11px] leading-none text-muted-foreground tabular-nums transition-colors hover:border-foreground/30 hover:text-foreground"
        :aria-label="t('instances.numberCopyAria', { num })"
        @click.stop="copy"
      >
        <Check v-if="copied" class="size-3 text-success" />
        <template v-else>#{{ num }}</template>
      </button>
    </TooltipTrigger>
    <TooltipContent>
      <p class="font-medium">{{ t('instances.numberTooltipTitle', { num }) }}</p>
      <p class="mt-0.5 max-w-64 text-xs text-muted-foreground">
        {{ t('instances.numberTooltipBody') }}
      </p>
    </TooltipContent>
  </Tooltip>
</template>

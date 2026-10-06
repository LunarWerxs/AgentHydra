<script setup lang="ts">
// The Tokens header's 5h / Week / Total choice, one per table (composables/useTokenWindow.ts). The
// header text (the default slot: the sort button) keeps its click; hovering or focusing it opens a
// flyout under it that lists the three windows. No note beside the header names the current one: it
// cost the column width (owner, 2026-10-06), and the flyout's checkmark says it.
// Hover timing follows UsageBadge: a short open delay so sweeping across the header does not flash
// the flyout, a close delay so travelling from the header into it does not dismiss it.
import { Check } from '@lucide/vue'
import { onUnmounted, ref } from 'vue'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useCliTokenWindow, useDesktopTokenWindow } from '@/composables/useTokenWindow'
import { TOKEN_WINDOWS, type TokenWindow } from '@/lib/token-window'

const props = defineProps<{ kind: 'cli' | 'desktop' }>()
const model = props.kind === 'cli' ? useCliTokenWindow() : useDesktopTokenWindow()
const labelKey = { '5h': 'tokensWindow5h', week: 'tokensWindowWeek', total: 'tokensWindowTotal' }
const hintKey = {
  '5h': 'tokensWindow5hHint',
  week: 'tokensWindowWeekHint',
  total: 'tokensWindowTotalHint',
}

const OPEN_DELAY_MS = 200
const CLOSE_DELAY_MS = 150

const open = ref(false)
/** Keyboard opening (ArrowDown) moves focus into the list; hover and plain focus never take it. */
const takeFocus = ref(false)
let timer: number | null = null

function clearTimer(): void {
  if (timer !== null) window.clearTimeout(timer)
  timer = null
}
onUnmounted(clearTimer)

function later(value: boolean, ms: number): void {
  clearTimer()
  if (open.value === value) return
  timer = window.setTimeout(() => {
    open.value = value
  }, ms)
}
const onEnter = (): void => later(true, OPEN_DELAY_MS)
const onLeave = (): void => later(false, CLOSE_DELAY_MS)

function onFocusOut(e: FocusEvent): void {
  // Focus moving on to the flyout (portaled) is not leaving.
  const next = e.relatedTarget as HTMLElement | null
  if (next?.closest('[data-token-flyout]')) return
  onLeave()
}

function onArrowDown(): void {
  clearTimer()
  takeFocus.value = true
  open.value = true
}

function onOpenChange(v: boolean): void {
  clearTimer()
  open.value = v
  if (!v) takeFocus.value = false
}

function pick(w: TokenWindow): void {
  model.value = w
  clearTimer()
  open.value = false
  takeFocus.value = false
}

function onAutoFocus(e: Event): void {
  if (!takeFocus.value) e.preventDefault()
}
</script>

<template>
  <Popover :open="open" @update:open="onOpenChange">
    <PopoverAnchor as-child>
      <span
        class="inline-flex items-center gap-1"
        @mouseenter="onEnter"
        @mouseleave="onLeave"
        @focusin="onEnter"
        @focusout="onFocusOut"
        @keydown.down.prevent="onArrowDown"
      >
        <slot />
      </span>
    </PopoverAnchor>
    <PopoverContent
      data-token-flyout
      align="start"
      class="w-auto min-w-44 gap-0.5 p-1"
      role="radiogroup"
      :aria-label="$t('cliInstances.tokensWindowLabel')"
      :trap-focus="false"
      @open-auto-focus="onAutoFocus"
      @mouseenter="onEnter"
      @mouseleave="onLeave"
      @focusout="onFocusOut"
    >
      <button
        v-for="w in TOKEN_WINDOWS"
        :key="w"
        type="button"
        role="radio"
        :aria-checked="model === w"
        :title="$t(`cliInstances.${hintKey[w]}`)"
        class="flex items-start gap-2 rounded-md px-2 py-1.5 text-start hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        @click="pick(w)"
      >
        <Check class="mt-0.5 size-3 shrink-0" :class="model === w ? '' : 'opacity-0'" />
        <span class="flex flex-col">
          <span class="font-medium">{{ $t(`cliInstances.${labelKey[w]}`) }}</span>
          <span class="text-muted-foreground">{{ $t(`cliInstances.${hintKey[w]}`) }}</span>
        </span>
      </button>
    </PopoverContent>
  </Popover>
</template>

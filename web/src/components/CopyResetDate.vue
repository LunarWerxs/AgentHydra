<script setup lang="ts">
// Click a Weekly cell, get its reset DATE on the clipboard as "09/18/2026". Shared by all three
// instance tables (desktop, CLI, Codex) so the column behaves the same wherever it appears.
//
// The countdown in the bar ("4d 9h") is what you read; the date is what you paste into a calendar or
// a message, and working it out from a countdown is arithmetic nobody should be doing by hand.
//
// A cell with no real reset instant renders its content untouched and is not a button: a control
// that silently does nothing is worse than none (see resetDateNumeric for why there is no guess).
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { UsageLimit } from '@/lib/api'
import { resetDateNumeric } from '@/lib/usage-reset'

const props = defineProps<{ limit: UsageLimit | null | undefined }>()

const { t } = useI18n()
const date = computed(() => resetDateNumeric(props.limit))

// The toast waits for the WRITE, rather than firing beside it. `navigator.clipboard` is undefined
// outside a secure context and the write rejects when permission is refused, and in both of those
// the fire-and-forget version told you "Copied 09/18/2026" over an empty clipboard - which is worse
// than no feedback, because you paste the old contents somewhere and trust them.
async function copy() {
  const value = date.value
  if (!value) return
  try {
    if (!navigator.clipboard) throw new Error('no clipboard in this context')
    await navigator.clipboard.writeText(value)
    toast.success(t('instances.toastResetDateCopied', { date: value }))
  } catch {
    toast.error(t('instances.toastResetDateCopyFailed', { date: value }))
  }
}
</script>

<template>
  <button
    v-if="date"
    type="button"
    class="block w-full cursor-pointer text-left transition-[filter] hover:brightness-125"
    :title="t('instances.resetDateCopyHint', { date })"
    @click.stop="copy"
  >
    <slot />
  </button>
  <slot v-else />
</template>

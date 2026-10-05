<script setup lang="ts">
// The reset icon beside a CLI account's name, the counterpart of the desktop table's banked-reset
// icon. It shows only what the CLI itself said the last time `/limit-reset` ran here (the usage
// endpoint will not say for a CLI login), from a person's run or the daily background check: a
// reset available or used just now (green), this week's already spent (grey, with when it comes
// back), or none offered (muted). Nothing is shown before the first run.
import { RotateCcw } from '@lucide/vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUsageMode } from '@/composables/useUsageMode'
import type { CliLimitResetResult } from '@/lib/api'
import { formatAgo } from '@/lib/relativeTime'
import IconTooltip from '@/shell/IconTooltip.vue'

const props = defineProps<{ result: CliLimitResetResult | null | undefined }>()
const { t } = useI18n()
const { now } = useUsageMode()

const view = computed(() => {
  const r = props.result
  if (!r || r.outcome === 'error') return null
  const date = r.nextAvailable ?? t('cliInstances.limitResetUnknownDate')
  const ago = formatAgo(now.value.getTime(), r.at)
  if (r.outcome === 'unavailable')
    return {
      tone: 'text-muted-foreground/60',
      label: t('cliInstances.limitResetNoneLabel'),
      hint: t('cliInstances.limitResetNoneHint', { ago }),
    }
  if (r.outcome === 'available')
    return {
      tone: 'text-success',
      label: t('cliInstances.limitResetAvailableLabel'),
      hint: t('cliInstances.limitResetAvailableHint', { message: r.message, ago }),
    }
  return r.outcome === 'reset'
    ? {
        tone: 'text-success',
        label: t('cliInstances.limitResetDoneLabel', { ago }),
        hint: t('cliInstances.limitResetDoneHint', { date }),
      }
    : {
        tone: 'text-muted-foreground',
        label: t('cliInstances.limitResetUsedLabel'),
        hint: t('cliInstances.limitResetUsedHint', { date, ago }),
      }
})
</script>

<template>
  <IconTooltip v-if="view" :label="view.label" :description="view.hint">
    <span class="inline-flex items-center" :aria-label="view.label">
      <RotateCcw class="size-3.5" :class="view.tone" />
    </span>
  </IconTooltip>
</template>

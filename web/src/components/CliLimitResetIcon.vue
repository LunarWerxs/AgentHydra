<script setup lang="ts">
// The reset icon beside a CLI account's name, the counterpart of the desktop table's banked-reset
// icon. It shows only what the CLI itself said the last time `/limit-reset` ran here (the usage
// endpoint will not say for a CLI login): used just now (green), or this week's already spent
// (grey, with when it comes back). Nothing is shown before the first run, or when none was offered.
import { RotateCcw } from '@lucide/vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CliLimitResetResult } from '@/lib/api'
import { formatAgo } from '@/lib/relativeTime'
import IconTooltip from '@/shell/IconTooltip.vue'

const props = defineProps<{ result: CliLimitResetResult | null | undefined }>()
const { t } = useI18n()

const view = computed(() => {
  const r = props.result
  if (!r || (r.outcome !== 'reset' && r.outcome !== 'used' && r.outcome !== 'available'))
    return null
  const date = r.nextAvailable ?? t('cliInstances.limitResetUnknownDate')
  const ago = formatAgo(Date.now(), r.at)
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

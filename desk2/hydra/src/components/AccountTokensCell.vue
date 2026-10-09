<script setup lang="ts">
// The Tokens cell of the CLI, desktop and Free tables: the signed-in account's figure for the span the
// table's switch has chosen (the sum), the four kinds on hover. Figures come from
// the analytics kit (kit/account-windows.ts); the row model carries the chosen span's parts. A Free
// login's are an estimate with no cache, so its row brings its own hover lines (`tokensNote`).
import { formatTokens } from '@/lib/climayte-status'
import type { InstanceRowModel } from '@/lib/instance-table'
import IconTooltip from '@/shell/IconTooltip.vue'

defineProps<{ row: InstanceRowModel }>()
</script>

<template>
<template>
  <span class="inline-flex items-center gap-1.5">
    <IconTooltip
      v-if="row.tokens"
      :label="$t('cliInstances.tokensLabel', { total: row.tokens.total.toLocaleString() })"
      :description="
        row.tokensNote?.breakdown ??
        $t('cliInstances.tokensBreakdown', {
          output: formatTokens(row.tokens.output),
          input: formatTokens(row.tokens.input),
          cacheRead: formatTokens(row.tokens.cacheRead),
          cacheWrite: formatTokens(row.tokens.cacheWrite),
        })
      "
      :detail="row.tokensNote?.source ?? $t('cliInstances.tokensSource')"
    >
      <span class="font-medium tabular-nums">{{ formatTokens(row.tokens.total) }}</span>
    </IconTooltip>
    <span v-else class="text-xs text-muted-foreground">—</span>
    <IconTooltip
      v-if="row.remoteWorkers"
      :label="$t('cliInstances.remoteWorkersLabel', { n: row.remoteWorkers })"
      :description="$t('cliInstances.remoteWorkersHint')"
    >
      <span class="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground tabular-nums">
        {{ $t('cliInstances.remoteWorkersLabel', { n: row.remoteWorkers }) }}
      </span>
    </IconTooltip>
  </span>
</template>

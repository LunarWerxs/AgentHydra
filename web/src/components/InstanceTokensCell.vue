<script setup lang="ts">
// The Tokens column's cell: what the account has run, from its own transcripts on this PC
// (cli-instance-tokens.ts). The column definition in lib/instance-table.ts is the one place this
// is wired in, so a richer cell replaces it there and nowhere else.

import { formatTokens } from '@/lib/climayte-status'
import type { InstanceRowModel } from '@/lib/instance-table'
import IconTooltip from '@/shell/IconTooltip.vue'

defineProps<{ row: InstanceRowModel }>()
</script>

<template>
  <IconTooltip
    v-if="row.tokens"
    :label="$t('cliInstances.tokensLabel', { total: row.tokens.total.toLocaleString() })"
    :description="
      $t('cliInstances.tokensBreakdown', {
        output: formatTokens(row.tokens.output),
        input: formatTokens(row.tokens.input),
        cacheRead: formatTokens(row.tokens.cacheRead),
        cacheWrite: formatTokens(row.tokens.cacheWrite),
      })
    "
    :detail="$t('cliInstances.tokensSource')"
  >
    <span class="font-medium tabular-nums">{{ formatTokens(row.tokens.total) }}</span>
  </IconTooltip>
  <span v-else class="text-xs text-muted-foreground">—</span>
</template>

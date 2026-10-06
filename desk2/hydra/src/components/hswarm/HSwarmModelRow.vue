<script setup lang="ts">
// Row for HSwarm model. Uses the shared InstanceRow styling and density.

import { Star } from '@lucide/vue'
import { TableCell, TableRow } from '@/components/ui/table'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import type { InstanceColumn } from '@/lib/instance-table'
import type { HSwarmModelRowModel } from '@/lib/hswarm-table'

const props = defineProps<{
  columns: InstanceColumn[]
  row: HSwarmModelRowModel
}>()
</script>

<template>
  <TableRow :variant="row.switched_off || !row.enabled ? 'faded' : 'default'" class="group/row">
    <template v-for="col in columns" :key="col.key">
      <TableCell v-if="col.key === 'modelEnabled'">
        <Switch
          :model-value="!row.switched_off && row.enabled"
          @update:model-value="row.onEnabledChange?.($event)"
          :aria-label="`Toggle ${row.name}`"
        />
      </TableCell>

      <TableCell v-else-if="col.key === 'modelPriority'">
        <Button
          v-if="row.auto || row.priority"
          variant="ghost"
          size="sm"
          class="h-7 px-2 text-xs font-semibold"
          @click="row.onToggleStar?.()"
        >
          <Star :class="{ 'fill-current': row.priority }" class="h-3 w-3" />
          {{ row.priority ? row.priority : '' }}
        </Button>
        <span v-else class="text-xs text-muted-foreground">–</span>
      </TableCell>

      <TableCell v-else-if="col.key === 'modelName'" class="max-w-0 font-medium">
        {{ row.label || row.name }}
      </TableCell>

      <TableCell v-else-if="col.key === 'modelProvider'" class="text-sm">
        {{ row.provider }}
      </TableCell>

      <TableCell v-else-if="col.key === 'modelKind'" class="text-sm">
        <span
          v-if="row.custom"
          class="inline-block rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-900 dark:bg-blue-900 dark:text-blue-100"
        >
          Custom
        </span>
        <span
          v-if="row.vision"
          class="inline-block rounded bg-purple-100 px-2 py-0.5 text-xs text-purple-900 dark:bg-purple-900 dark:text-purple-100"
        >
          Vision
        </span>
      </TableCell>

      <TableCell v-else-if="col.key === 'modelPrice'" class="text-right font-mono text-sm">
        {{ row.usd_per_1m ? `$${Number(row.usd_per_1m).toFixed(4)}` : '–' }}
      </TableCell>

      <TableCell v-else-if="col.key === 'modelContext'" class="text-right text-sm">
        {{ row.ctx ? `${row.ctx}k` : '–' }}
      </TableCell>
    </template>
  </TableRow>
</template>

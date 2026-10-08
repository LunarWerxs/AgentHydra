<script setup lang="ts">
// Row for HSwarm model. Uses the shared InstanceRow styling and density.

import { Star } from '@lucide/vue'
import { TableCell, TableRow } from '@/components/ui/table'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { InstanceColumn } from '@/lib/instance-table'
import type { HSwarmModelRowModel } from '@/lib/hswarm-table'

const props = defineProps<{
  columns: InstanceColumn[]
  row: HSwarmModelRowModel
}>()
</script>

<template>
  <TableRow :variant="row.switched_off || !row.enabled ? 'faded' : 'default'" class="group/row [&>td]:h-6.5">
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
          size="chip"
          @click="row.onToggleStar?.()"
        >
          <Star :class="{ 'fill-current': row.priority }" class="size-3" />
          {{ row.priority ? row.priority : '' }}
        </Button>
        <span v-else class="text-xs text-muted-foreground">–</span>
      </TableCell>

      <TableCell v-else-if="col.key === 'modelName'" class="max-w-0" weight="medium">
        {{ row.label || row.name }}
      </TableCell>

      <TableCell v-else-if="col.key === 'modelProvider'" size="xs" muted>
        {{ row.provider }}
      </TableCell>

      <TableCell v-else-if="col.key === 'modelKind'">
        <Badge v-if="row.custom" variant="info">
          {{ $t('hswarm.v.models.badgeCustom') }}
        </Badge>
        <Badge v-if="row.vision" variant="primary">
          {{ $t('hswarm.v.models.badgeVision') }}
        </Badge>
      </TableCell>

      <TableCell v-else-if="col.key === 'modelPrice'" align="end" size="xs" numeric muted>
        {{ row.usd_per_1m ? `$${Number(row.usd_per_1m).toFixed(4)}` : '–' }}
      </TableCell>

      <TableCell v-else-if="col.key === 'modelContext'" align="end" size="xs" numeric muted>
        {{ row.ctx ? `${row.ctx}k` : '–' }}
      </TableCell>
    </template>
  </TableRow>
</template>

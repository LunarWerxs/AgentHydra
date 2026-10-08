<script setup lang="ts">
// Row for HSwarm provider in the all-providers table. Uses the shared InstanceRow styling and density.
// Each cell renders based on the column key, like InstanceRow does for instances.

import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { TableCell, TableRow } from '@/components/ui/table'
import type { InstanceColumn } from '@/lib/instance-table'
import type { HSwarmProviderRowModel } from '@/lib/hswarm-table'

const props = defineProps<{
  columns: InstanceColumn[]
  row: HSwarmProviderRowModel
}>()

const dimmed = computed(() => !props.row.enabled)
</script>

<template>
  <TableRow :variant="dimmed ? 'faded' : 'default'" class="group/row">
    <template v-for="col in columns" :key="col.key">
      <TableCell v-if="col.key === 'providerState'">
        <Badge :variant="row.state.variant" size="md">{{ row.state.label }}</Badge>
      </TableCell>

      <TableCell v-else-if="col.key === 'providerName'" class="max-w-0">
        <button
          type="button"
          class="font-medium text-primary hover:underline truncate"
          @click="row.onOpen?.(['providers', row.name])"
        >
          {{ row.name }}
        </button>
      </TableCell>

      <TableCell v-else-if="col.key === 'readyCount'">
        <span class="font-mono text-sm">{{ row.readyCount ?? 0 }}</span>
      </TableCell>

      <TableCell v-else-if="col.key === 'restingCount'">
        <span class="font-mono text-sm">{{ row.restingCount ?? 0 }}</span>
      </TableCell>

      <TableCell v-else-if="col.key === 'disabledCount'">
        <span class="font-mono text-sm">{{ row.disabledCount ?? 0 }}</span>
      </TableCell>

      <TableCell v-else-if="col.key === 'keyCount'">
        <span class="font-mono text-sm">{{ row.keyCount }}</span>
      </TableCell>

      <TableCell v-else-if="col.key === 'enabled'">
        <Switch
          :model-value="row.enabled"
          :aria-label="row.name"
          @update:model-value="row.onEnabledChange?.($event)"
        />
      </TableCell>

      <TableCell v-else-if="col.key === 'actions'" align="end" />
    </template>
  </TableRow>
</template>

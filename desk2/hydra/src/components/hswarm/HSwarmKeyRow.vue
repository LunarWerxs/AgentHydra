<script setup lang="ts">
// Row for HSwarm API key. Uses the shared InstanceRow styling and density.

import { CheckCircle2, Eye, EyeOff, Trash2 } from '@lucide/vue'
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { TableCell, TableRow } from '@/components/ui/table'
import type { InstanceColumn } from '@/lib/instance-table'
import type { HSwarmKeyRowModel } from '@/lib/hswarm-table'

const props = defineProps<{
  columns: InstanceColumn[]
  row: HSwarmKeyRowModel
  multipleKeys?: boolean
}>()

const stateVariant = computed(() => {
  if (props.row.disabled) return 'destructive'
  if (props.row.state.variant) return props.row.state.variant
  return 'default' as const
})
</script>

<template>
  <TableRow class="group/row">
    <template v-for="col in columns" :key="col.key">
      <TableCell v-if="col.key === 'keyMasked'" class="font-mono text-xs max-w-0">
        {{ row.masked }}
      </TableCell>

      <TableCell v-else-if="col.key === 'keyFingerprint'" class="font-mono text-xs">
        {{ row.fingerprint }}
      </TableCell>

      <TableCell v-else-if="col.key === 'keyPriority'">
        <Input
          v-if="multipleKeys"
          type="number"
          :value="row.priority ?? ''"
          class="w-16 text-xs"
          @change="
            (e: Event) => {
              const v = (e.target as HTMLInputElement).value
              row.onPriorityChange?.(v ? parseInt(v) : null)
            }
          "
        />
        <span v-else class="text-xs text-muted-foreground">—</span>
      </TableCell>

      <TableCell v-else-if="col.key === 'keyState'">
        <Badge :variant="stateVariant" class="text-xs">
          {{ row.state.label }}
        </Badge>
      </TableCell>

      <TableCell v-else-if="col.key === 'actions'" class="text-right">
        <div class="flex justify-end gap-1">
          <Button
            size="sm"
            variant="ghost"
            @click="row.onEnabledChange?.(!row.disabled)"
            :title="row.disabled ? 'Enable' : 'Disable'"
          >
            <component :is="row.disabled ? Eye : EyeOff" class="size-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            @click="row.onCheck?.()"
            title="Probe balance"
          >
            <CheckCircle2 class="size-4" />
          </Button>
          <Button
            v-if="row.editable"
            size="sm"
            variant="ghost"
            @click="row.onRemove?.()"
            title="Remove key"
          >
            <Trash2 class="size-4" />
          </Button>
        </div>
      </TableCell>
    </template>
  </TableRow>
</template>

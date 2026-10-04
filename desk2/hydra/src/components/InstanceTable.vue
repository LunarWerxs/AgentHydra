<script setup lang="ts">
// The one instance table: every kind's Instances table (Claude desktop with its Codex and DeepSeek
// rows, the CLI logins) draws its header, first-load skeleton and empty state here, from a list of
// column definitions (lib/instance-table.ts). The default slot is the table's bodies: one <tbody> of
// InstanceRow per provider, so a kind differs only in the columns it lists and the rows it hands over.
// The skeleton stands in for a provider's rows only while they load; the other bodies stay drawn.
import type { Component } from 'vue'
import SortButton from '@/components/SortButton.vue'
import { Skeleton } from '@/components/ui/skeleton'
import type { TableVariants } from '@/components/ui/table'
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { SortDirection } from '@/composables/useSortable'
import type { InstanceColumn } from '@/lib/instance-table'
import { useTooltipConfig } from '@/lib/tooltip-config'
import InfoHint from '@/shell/InfoHint.vue'

withDefaults(
  defineProps<{
    columns: InstanceColumn[]
    indicatorFor: (key: string) => SortDirection
    density?: TableVariants['density']
    /** Draw first-load skeleton rows instead of the bodies. */
    skeleton?: boolean
    skeletonRows?: number
    /** Drawn after the bodies when there is nothing to list (or the filter took every row). */
    empty?: { icon: Component; title: string; hint: string } | null
  }>(),
  { skeletonRows: 3, empty: null },
)
const emit = defineEmits<{ sort: [key: string] }>()
const { enabled: tooltipsEnabled } = useTooltipConfig()
</script>

<template>
  <Table :density="density">
    <TableHeader sticky>
      <TableRow>
        <TableHead
          v-for="col in columns"
          :key="col.key"
          :class="col.headClass"
          :title="col.title && tooltipsEnabled ? $t(col.title) : undefined"
        >
          <span v-if="!col.sortable" class="inline-flex items-center gap-0.5">{{ $t(col.label) }}</span>
          <span v-else class="inline-flex items-center gap-0.5">
            <component :is="col.flyout ?? 'span'" v-bind="col.flyoutProps">
              <SortButton
                :direction="indicatorFor(col.key)"
                :quiet="col.key === 'status'"
                @sort="emit('sort', col.key)"
              >
                {{ col.label ? $t(col.label) : '●' }}
              </SortButton>
            </component>
            <InfoHint v-if="col.hint" :text="$t(col.hint)" />
          </span>
        </TableHead>
      </TableRow>
    </TableHeader>
    <TableBody v-if="skeleton">
      <TableRow v-for="i in skeletonRows" :key="i">
        <TableCell v-for="col in columns" :key="col.key">
          <div v-if="col.key === 'actions'" class="flex justify-end">
            <Skeleton :class="col.skeleton" />
          </div>
          <Skeleton v-else :class="col.skeleton" />
        </TableCell>
      </TableRow>
    </TableBody>
    <slot />
    <TableBody v-if="empty">
      <TableEmpty :colspan="columns.length">
        <div class="flex flex-col items-center gap-1 text-center">
          <component :is="empty.icon" class="mb-1 size-6 opacity-40" />
          <p class="font-medium text-foreground">{{ empty.title }}</p>
          <p class="text-xs text-muted-foreground">{{ empty.hint }}</p>
        </div>
      </TableEmpty>
    </TableBody>
  </Table>
</template>

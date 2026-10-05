<script setup lang="ts">
// The one instance table: every kind's Instances table (Claude desktop with its Codex and DeepSeek
// rows, the CLI logins) draws its header, first-load skeleton and empty state here, from a list of
// column definitions (lib/instance-table.ts). The default slot is the table's bodies: one <tbody> of
// InstanceRow per provider, so a kind differs only in the columns it lists and the rows it hands over.
// The skeleton stands in for a provider's rows only while they load; the other bodies stay drawn.
//
// `widths` holds a column at one width from the first paint. The table lays out by content, so a
// column whose cells fill in as the stats load (a "—" that becomes a chip and a bar, a spinner
// beside a number) used to widen as each one landed and every other column snapped sideways with
// it (owner, 2026-10-04). A width is a floor sized for the column's final content and its header:
// Name still takes the rest, and a cell that somehow outgrows it widens the column, never spills.
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
import type { InstanceColumn, InstanceColumnKey } from '@/lib/instance-table'
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
    /** A CSS width per column key, padding included; a column left out sizes to its content. */
    widths?: Partial<Record<InstanceColumnKey, string>>
  }>(),
  { skeletonRows: 3, empty: null, widths: undefined },
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
          :style="{ width: widths?.[col.key] }"
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
          <!-- The width is only a wish to a table laid out by content: while Name's long text asks
               for more than the row has, the browser shrank these columns to their skeletons and
               grew them back as the figures landed (measured 2026-10-04: Actions 92 px, then 118).
               A strut of the width, less the cell's padding, makes it the column's least width. -->
          <div
            v-if="widths?.[col.key]"
            aria-hidden="true"
            class="h-0"
            :style="{ width: `calc(${widths[col.key]} - ${density === 'compact' ? '0.75rem' : '1rem'})` }"
          />
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

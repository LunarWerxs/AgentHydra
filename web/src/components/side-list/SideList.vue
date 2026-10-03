<script setup lang="ts" generic="T">
/**
 * The sidebar shell the Sessions and CliMayte lists share: a header slot (search, filters,
 * toggles), a scrolling body (`scroll-slim`), optional grouped sections with a header line (name
 * and count), and an empty state. It fills the height of the view it sits in; the host decides the
 * width (about 22rem). Rows are `SideListRow`s, rendered by the caller.
 *
 * Attributes and listeners that are not props (pointerdown, keydown, `data-*`, `class`) land on the
 * scrolling body, not the shell, so a host can hang box-select or key handling on the list itself.
 */
import type { SideListGroup } from '@/lib/side-list'

defineOptions({ inheritAttrs: false })

withDefaults(
  defineProps<{
    /** Grouped rows. Omit for a flat list: put the rows in the default slot instead. */
    groups?: SideListGroup<T>[]
    /** Show the `empty` slot instead of the rows. */
    empty?: boolean
  }>(),
  { groups: undefined, empty: false },
)

defineSlots<{
  /** Above the scrolling body, never scrolls: search, filters, a hide-finished toggle. */
  header?: () => unknown
  /** First thing inside the scrolling body (a selection band, a stale banner). */
  before?: () => unknown
  /** The empty state; shown instead of the rows when `empty` is true. */
  empty?: () => unknown
  /** Flat rows (no `groups`), or content that follows the groups. */
  default?: () => unknown
  /** One row of a group. */
  row?: (props: { item: T; group: SideListGroup<T> }) => unknown
  /** The group header's name, when more than the plain `label` is wanted. */
  'group-label'?: (props: { group: SideListGroup<T> }) => unknown
}>()
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div v-if="$slots.header" class="shrink-0">
      <slot name="header" />
    </div>
    <div class="scroll-slim relative min-h-0 flex-1 overflow-y-auto" v-bind="$attrs">
      <slot name="before" />
      <slot v-if="empty" name="empty" />
      <template v-else>
        <section v-for="g in groups" :key="g.key" :aria-label="g.label">
          <!-- A header line, as CliMayte's task list has: the name (mono, truncated) and the count. -->
          <h3
            class="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-2xs font-medium text-muted-foreground"
          >
            <span class="mono truncate" :title="g.label">
              <slot name="group-label" :group="g">{{ g.label }}</slot>
            </span>
            <span class="shrink-0 tabular-nums">{{ g.count ?? g.items.length }}</span>
          </h3>
          <template v-for="(item, i) in g.items" :key="g.keyOf ? g.keyOf(item) : i">
            <slot name="row" :item="item" :group="g" />
          </template>
        </section>
        <slot />
      </template>
    </div>
  </div>
</template>

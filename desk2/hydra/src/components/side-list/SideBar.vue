<script setup lang="ts" generic="T">
/**
 * The left sidebar Sessions and CliMayte both run: the `<aside>` with its slim collapse rail and
 * toggle, the drag-resize handle (a persisted width, double-click resets) and, inside, a `SideList`
 * (header, grouped rows, empty state). The views only fill the slots.
 *
 * `storageKey` names this sidebar's remembered state (`<key>.sidebarWidth`, `<key>.sidebarCollapsed`),
 * so each view keeps its own width and collapsed state. Under 1024px wide the rail collapses by
 * itself, as it always did in Sessions. Attributes and listeners that are not props (pointerdown,
 * keydown, `class`) pass through to the scrolling list body, as `SideList` documents.
 */
import { PanelLeftClose, PanelLeftOpen } from '@lucide/vue'
import { useMediaQuery, useStorage } from '@vueuse/core'
import { ref, watch } from 'vue'
import SideList from '@/components/side-list/SideList.vue'
import { Button } from '@/components/ui/button'
import { clampWidth, SIDEBAR_DEFAULT } from '@/composables/useUiPrefs'
import type { SideListGroup } from '@/lib/side-list'
import IconTooltip from '@/shell/IconTooltip.vue'

defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    /** Prefix of the persisted width and collapsed state, e.g. `agenthydra.sessions`. */
    storageKey: string
    groups?: SideListGroup<T>[]
    empty?: boolean
  }>(),
  { groups: undefined, empty: false },
)

defineSlots<{
  header?: () => unknown
  before?: () => unknown
  empty?: () => unknown
  default?: () => unknown
  row?: (props: { item: T; group: SideListGroup<T> }) => unknown
  'group-label'?: (props: { group: SideListGroup<T> }) => unknown
}>()

const width = useStorage(`${props.storageKey}.sidebarWidth`, SIDEBAR_DEFAULT)
width.value = clampWidth(width.value)
const storedCollapsed = useStorage(`${props.storageKey}.sidebarCollapsed`, false)

// Narrow screens start (and go back to) collapsed; wide ones follow what was last chosen.
const isWide = useMediaQuery('(min-width: 1024px)')
const collapsed = ref(!isWide.value || storedCollapsed.value)
watch(isWide, (wide) => {
  collapsed.value = !wide || storedCollapsed.value
})
function toggle() {
  collapsed.value = !collapsed.value
  if (isWide.value) storedCollapsed.value = collapsed.value
}

const resizing = ref(false)
function startResize(e: PointerEvent) {
  const startX = e.clientX
  const startWidth = width.value
  resizing.value = true
  const onMove = (ev: PointerEvent) => {
    width.value = clampWidth(startWidth + ev.clientX - startX)
  }
  const onUp = () => {
    resizing.value = false
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

// The dragged width rides the aside as --sidebar-w; `.sessions-sidebar-w` (style.css) caps it at the
// viewport, and the collapsed rail is w-11. The width transition animates the toggle but is
// suspended during a drag so resizing tracks the pointer 1:1.
</script>

<template>
  <!-- bg-sidebar, not transparent: the list is the recessed ground of the two-pane split. -->
  <aside
    class="relative min-h-0 shrink-0 overflow-hidden border-e border-border bg-sidebar"
    :class="[collapsed ? 'w-11' : 'sessions-sidebar-w', resizing ? '' : 'transition-width duration-300 ease-in-out']"
    :style="{ '--sidebar-w': `${width}px` }"
  >
    <IconTooltip :label="collapsed ? $t('sessions.expandSidebar') : $t('sessions.collapseSidebar')">
      <Button variant="ghost" size="icon" class="absolute right-2 top-1.5 z-10" @click="toggle">
        <PanelLeftOpen v-if="collapsed" />
        <PanelLeftClose v-else />
      </Button>
    </IconTooltip>

    <!-- expanded content keeps its full width while animating so it clips, not reflows -->
    <div
      class="sessions-sidebar-w flex h-full min-h-0 flex-col transition-opacity duration-200"
      :class="collapsed ? 'pointer-events-none opacity-0' : 'opacity-100'"
    >
      <SideList :groups="groups" :empty="empty" v-bind="$attrs">
        <template v-if="$slots.header" #header><slot name="header" /></template>
        <template #before><slot name="before" /></template>
        <template #empty><slot name="empty" /></template>
        <template #row="{ item, group }"><slot name="row" :item="item" :group="group" /></template>
        <template #group-label="{ group }"><slot name="group-label" :group="group" /></template>
        <slot />
      </SideList>
    </div>

    <!-- drag-resize handle (double-click resets) -->
    <div
      v-show="!collapsed"
      class="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize touch-none transition-colors"
      :class="resizing ? 'bg-accent' : 'hover:bg-accent/60'"
      :title="$t('sessions.resizeSidebar')"
      @pointerdown.prevent="startResize"
      @dblclick="width = SIDEBAR_DEFAULT"
    />
  </aside>
</template>

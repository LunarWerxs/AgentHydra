<script setup lang="ts">
import { computed } from 'vue'
import { Archive, Boxes, CalendarRange, CircleAlert, EyeOff, Hourglass, ListTodo, MessagesSquare, Monitor, RefreshCw, RotateCcw, Search, Settings2 } from '@lucide/vue'
import { icons } from '@/lib/icons'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { FILTER_LABELS, type SidebarFilter } from '@/components/sidebar/logic'
import { MENU_CONTENT, MENU_ITEM, MENU_SEPARATOR } from '@/components/sidebar/menuClasses'
import { useHiddenGroups } from '@/components/sidebar/hidden'
import { openHydra } from '@/components/hydra/api'
import {
  ARCHIVED_LABELS,
  ARCHIVED_VALUES,
  DISPATCHED_LABELS,
  DISPATCHED_VALUES,
  INSTANCE_DEFAULT,
  INSTANCE_OTHER,
  PERIOD_LABELS,
  PERIOD_VALUES,
  RATE_LIMIT_LABELS,
  RATE_LIMIT_VALUES,
  SHAPE_LABELS,
  SHAPE_VALUES,
  SOURCE_LABELS,
  SOURCE_VALUES,
  scopesNarrowed,
  summarize,
  toggle,
  type CloudScopes
} from './logic'
import { useCloud } from './store'

// The sidebar's Filter menu in Hydra Desk 2: the desk list's Show choice, then everything AgentHydra's
// Sessions ⋯ menu offers for the cloud list, plus Computer (which PC). Changing a cloud filter shows the
// cloud list, so what it did is on screen. Toggles keep the menu open so several go in one visit. Show
// hidden groups, between the two, is both lists': the groups a header's right-click hid (sidebar/hidden.ts).
const props = defineProps<{ filter: SidebarFilter }>()
const emit = defineEmits<{ 'update:filter': [filter: SidebarFilter] }>()

const cloud = useCloud()
const { hidden, showHidden, setShowHidden } = useHiddenGroups()
const hiddenTip = computed(() =>
  hidden.value.size || showHidden.value
    ? "Show the groups hidden with a group header's right-click, in both lists"
    : "Right-click a group's header and choose Hide to hide it"
)
const s = computed(() => cloud.scopes.value)
const claude = computed(() => s.value.source.includes('claude'))

function set(patch: Partial<CloudScopes>) {
  cloud.scopes.value = { ...cloud.scopes.value, ...patch }
  cloud.on.value = true
}

const instanceUniverse = computed(() => [INSTANCE_DEFAULT, ...cloud.instances.value.map((i) => i.name), INSTANCE_OTHER])
const instanceTicked = computed(() => s.value.instance ?? instanceUniverse.value)
const instanceLabel = (v: string) =>
  v === INSTANCE_DEFAULT ? 'Default login' : v === INSTANCE_OTHER ? 'Other instances' : (cloud.instances.value.find((i) => i.name === v)?.label ?? v)
function toggleInstance(v: string) {
  const next = toggle(instanceTicked.value, instanceUniverse.value, v)
  set({ instance: next.length === instanceUniverse.value.length ? null : next })
}
const pcTicked = computed(() => s.value.pcs ?? cloud.pcs.value)
function togglePc(pc: string) {
  const next = toggle(pcTicked.value, cloud.pcs.value, pc)
  set({ pcs: next.length === cloud.pcs.value.length ? null : next })
}

const sub = [
  { key: 'source', label: 'Source', icon: MessagesSquare, universe: SOURCE_VALUES, labels: SOURCE_LABELS as Record<string, string>, claudeOnly: false, note: '' },
  { key: 'dispatched', label: 'Queued work', icon: ListTodo, universe: DISPATCHED_VALUES, labels: DISPATCHED_LABELS as Record<string, string>, claudeOnly: true, note: '' },
  {
    key: 'rateLimit',
    label: 'Usage limits',
    icon: CircleAlert,
    universe: RATE_LIMIT_VALUES,
    labels: RATE_LIMIT_LABELS as Record<string, string>,
    claudeOnly: true,
    note: 'Claude sessions only, and only when the CLI itself reported the wall.'
  },
  {
    key: 'shape',
    label: 'Session shape',
    icon: Hourglass,
    universe: SHAPE_VALUES,
    labels: SHAPE_LABELS as Record<string, string>,
    claudeOnly: false,
    note: 'Narrows the sessions already loaded, not the window they came from.'
  },
  { key: 'archived', label: 'Archived', icon: Archive, universe: ARCHIVED_VALUES, labels: ARCHIVED_LABELS as Record<string, string>, claudeOnly: false, note: '' }
] as const
type SubKey = (typeof sub)[number]['key']
const ticked = (k: SubKey): readonly string[] => s.value[k]
function flip(k: SubKey, universe: readonly string[], v: string) {
  set({ [k]: toggle(ticked(k), universe, v) } as Partial<CloudScopes>)
}

const ITEM = `${MENU_ITEM} pr-2`
</script>

<template>
  <DropdownMenuLabel class="flex h-[23px] items-center px-2 py-0 text-[13px] font-medium text-text-muted">Desk list</DropdownMenuLabel>
  <DropdownMenuItem
    v-for="(label, key) in FILTER_LABELS"
    :key="key"
    role="menuitemradio"
    :aria-checked="!cloud.on.value && props.filter === key"
    :class="MENU_ITEM"
    @select="emit('update:filter', key), (cloud.on.value = false)"
  >
    <span class="flex-1">{{ label }}</span>
    <component :is="icons.check" v-if="!cloud.on.value && props.filter === key" class="ml-3" />
  </DropdownMenuItem>

  <DropdownMenuSeparator :class="MENU_SEPARATOR" />
  <DropdownMenuItem
    role="menuitemcheckbox"
    :aria-checked="showHidden"
    :disabled="!showHidden && hidden.size === 0"
    :title="hiddenTip"
    :class="ITEM"
    @select.prevent="setShowHidden(!showHidden)"
  >
    <EyeOff />
    <span class="flex-1">Show hidden groups</span>
    <component :is="icons.check" v-if="showHidden" class="ml-3" />
  </DropdownMenuItem>

  <DropdownMenuSeparator :class="MENU_SEPARATOR" />
  <DropdownMenuLabel class="flex h-[23px] items-center gap-1 px-2 py-0 text-[13px] font-medium text-text-muted">
    Cloud list<span class="font-normal">· both PCs</span>
  </DropdownMenuLabel>
  <DropdownMenuItem :class="ITEM" @select.prevent="(cloud.on.value = true), cloud.refresh()">
    <RefreshCw :class="cloud.loading.value ? 'animate-spin' : ''" />
    <span class="flex-1">Refresh</span>
  </DropdownMenuItem>
  <DropdownMenuItem
    role="menuitemcheckbox"
    :aria-checked="s.onlyThisView"
    title="Search only the sessions these filters show"
    :class="ITEM"
    @select.prevent="set({ onlyThisView: !s.onlyThisView })"
  >
    <Search />
    <span class="flex-1">Only this view</span>
    <component :is="icons.check" v-if="s.onlyThisView" class="ml-3" />
  </DropdownMenuItem>
  <DropdownMenuSeparator :class="MENU_SEPARATOR" />
  <DropdownMenuItem
    role="menuitemcheckbox"
    :aria-checked="cloud.selectMode.value"
    :class="ITEM"
    @select="(cloud.on.value = true), cloud.setSelectMode(!cloud.selectMode.value)"
  >
    <ListTodo />
    <span class="flex-1">Select multiple sessions</span>
    <component :is="icons.check" v-if="cloud.selectMode.value" class="ml-3" />
  </DropdownMenuItem>
  <DropdownMenuSeparator :class="MENU_SEPARATOR" />

  <template v-for="m in sub" :key="m.key">
    <DropdownMenuSub>
      <DropdownMenuSubTrigger :class="ITEM" :disabled="m.claudeOnly && !claude">
        <component :is="m.icon" />
        <span class="flex-1">{{ m.label }}</span>
        <span class="max-w-28 truncate pl-3 text-[12px] text-text-muted">{{ summarize(ticked(m.key), m.universe, (v) => m.labels[v] ?? v) }}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent :side-offset="4" :class="`${MENU_CONTENT} max-w-64`">
        <DropdownMenuItem :class="MENU_ITEM" @select.prevent="set({ [m.key]: [...m.universe] } as Partial<CloudScopes>)">All</DropdownMenuItem>
        <DropdownMenuItem :class="MENU_ITEM" @select.prevent="set({ [m.key]: [] } as Partial<CloudScopes>)">None</DropdownMenuItem>
        <DropdownMenuSeparator :class="MENU_SEPARATOR" />
        <DropdownMenuItem
          v-for="v in m.universe"
          :key="v"
          role="menuitemcheckbox"
          :aria-checked="ticked(m.key).includes(v)"
          :class="MENU_ITEM"
          @select.prevent="flip(m.key, m.universe, v)"
        >
          <span class="flex-1">{{ m.labels[v] }}</span>
          <component :is="icons.check" v-if="ticked(m.key).includes(v)" class="ml-3" />
        </DropdownMenuItem>
        <p v-if="m.note" class="px-2 py-1.5 text-[12px] leading-4 text-text-muted">{{ m.note }}</p>
      </DropdownMenuSubContent>
    </DropdownMenuSub>

    <!-- Instance sits after Source, as in AgentHydra: a fact about Claude sessions, so off without Claude. -->
    <DropdownMenuSub v-if="m.key === 'source'">
      <DropdownMenuSubTrigger :class="ITEM" :disabled="!claude">
        <Boxes />
        <span class="flex-1">Instance</span>
        <span class="max-w-28 truncate pl-3 text-[12px] text-text-muted">{{ summarize(instanceTicked, instanceUniverse, instanceLabel) }}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent :side-offset="4" :class="`${MENU_CONTENT} max-w-72`">
        <DropdownMenuItem :class="MENU_ITEM" @select.prevent="set({ instance: null })">All</DropdownMenuItem>
        <DropdownMenuItem :class="MENU_ITEM" @select.prevent="set({ instance: [] })">None</DropdownMenuItem>
        <DropdownMenuSeparator :class="MENU_SEPARATOR" />
        <DropdownMenuItem
          v-for="v in instanceUniverse"
          :key="v"
          role="menuitemcheckbox"
          :aria-checked="instanceTicked.includes(v)"
          :class="MENU_ITEM"
          @select.prevent="toggleInstance(v)"
        >
          <span class="min-w-0 flex-1 truncate">{{ instanceLabel(v) }}</span>
          <component :is="icons.check" v-if="instanceTicked.includes(v)" class="ml-3" />
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  </template>

  <DropdownMenuSub>
    <DropdownMenuSubTrigger :class="ITEM">
      <Monitor />
      <span class="flex-1">Computer</span>
      <span class="max-w-28 truncate pl-3 text-[12px] text-text-muted">{{ summarize(pcTicked, cloud.pcs.value, (v) => v) }}</span>
    </DropdownMenuSubTrigger>
    <DropdownMenuSubContent :side-offset="4" :class="`${MENU_CONTENT} max-w-64`">
      <DropdownMenuItem :class="MENU_ITEM" @select.prevent="set({ pcs: null })">Both</DropdownMenuItem>
      <DropdownMenuSeparator :class="MENU_SEPARATOR" />
      <DropdownMenuItem
        v-for="pc in cloud.pcs.value"
        :key="pc"
        role="menuitemcheckbox"
        :aria-checked="pcTicked.includes(pc)"
        :class="MENU_ITEM"
        @select.prevent="togglePc(pc)"
      >
        <span class="min-w-0 flex-1 truncate">{{ pc }}{{ pc === cloud.thisPc.value ? ' (this PC)' : '' }}</span>
        <component :is="icons.check" v-if="pcTicked.includes(pc)" class="ml-3" />
      </DropdownMenuItem>
      <p v-if="cloud.pcs.value.length < 2" class="px-2 py-1.5 text-[12px] leading-4 text-text-muted">
        No chat from another PC in this list yet: the other PC's Desktop chats arrive through AgentHydra's chat sync.
      </p>
    </DropdownMenuSubContent>
  </DropdownMenuSub>

  <DropdownMenuSub>
    <DropdownMenuSubTrigger :class="ITEM">
      <CalendarRange />
      <span class="flex-1">Time period</span>
      <span class="max-w-28 truncate pl-3 text-[12px] text-text-muted">{{ PERIOD_LABELS[s.period] }}</span>
    </DropdownMenuSubTrigger>
    <DropdownMenuSubContent :side-offset="4" :class="`${MENU_CONTENT} max-w-52`">
      <DropdownMenuItem
        v-for="p in PERIOD_VALUES"
        :key="p"
        role="menuitemradio"
        :aria-checked="s.period === p"
        :class="MENU_ITEM"
        @select="set({ period: p })"
      >
        <span class="flex-1">{{ PERIOD_LABELS[p] }}</span>
        <component :is="icons.check" v-if="s.period === p" class="ml-3" />
      </DropdownMenuItem>
    </DropdownMenuSubContent>
  </DropdownMenuSub>

  <DropdownMenuSeparator :class="MENU_SEPARATOR" />
  <DropdownMenuItem v-if="scopesNarrowed(s)" :class="ITEM" @select="cloud.reset()">
    <RotateCcw />
    <span class="flex-1">Reset cloud filters</span>
  </DropdownMenuItem>
  <DropdownMenuItem :class="ITEM" title="Opens AgentHydra beside the sidebar" @select="openHydra()">
    <Settings2 />
    <span class="flex-1">Session settings</span>
    <span class="pl-3 text-[12px] text-text-muted">AgentHydra</span>
  </DropdownMenuItem>
</template>

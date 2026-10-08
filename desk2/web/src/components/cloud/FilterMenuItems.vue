<script setup lang="ts">
import { computed } from 'vue'
import { Archive, Bot, Boxes, CalendarRange, CircleAlert, EyeOff, Hourglass, ListTodo, Monitor, RefreshCw, Network, RotateCcw, Search, Settings2 } from '@lucide/vue'
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
import { SUB_KIND_LABELS, subModes, type SubKind, type SubMode } from '@/components/sidebar/subitems'
import { openHydra } from '@/components/hydra/api'
import {
  ARCHIVED_LABELS,
  ARCHIVED_VALUES,
  DISPATCHED_LABELS,
  DISPATCHED_VALUES,
  INSTANCE_DEFAULT,
  INSTANCE_OTHER,
  localOnly,
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
// hidden groups, between the two, is both lists': the groups a header's right-click hid (sidebar/hidden.ts);
// so are Show only local and Computer, which leave the list shown as it is.
// Every item says what it does on hover (owner, 2026-10-05).
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
const local = computed(() => localOnly(s.value, cloud.thisPc.value))
const claude = computed(() => s.value.apps.includes('claude'))

function set(patch: Partial<CloudScopes>) {
  cloud.scopes.value = { ...cloud.scopes.value, ...patch }
  cloud.on.value = true
}
/** The Computer filter narrows both lists (Sidebar.vue deskOnPcs), so it leaves the list shown as it is. */
function setPcs(pcs: string[] | null) {
  cloud.scopes.value = { ...cloud.scopes.value, pcs }
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
  setPcs(next.length === cloud.pcs.value.length ? null : next)
}

const sub = [
  {
    key: 'dispatched',
    label: 'Queued work',
    icon: ListTodo,
    universe: DISPATCHED_VALUES,
    labels: DISPATCHED_LABELS as Record<string, string>,
    claudeOnly: true,
    note: '',
    tip: 'Sessions AgentHydra started from its queue, or ones run by hand'
  },
  {
    key: 'rateLimit',
    label: 'Usage limits',
    icon: CircleAlert,
    universe: RATE_LIMIT_VALUES,
    labels: RATE_LIMIT_LABELS as Record<string, string>,
    claudeOnly: true,
    note: 'Claude sessions only, and only when the CLI itself reported the wall.',
    tip: 'Sessions a usage limit stopped, ones it stopped and that resumed, or ones it never stopped'
  },
  {
    key: 'shape',
    label: 'Session shape',
    icon: Hourglass,
    universe: SHAPE_VALUES,
    labels: SHAPE_LABELS as Record<string, string>,
    claudeOnly: false,
    note: 'Narrows the sessions already loaded, not the window they came from.',
    tip: 'Sessions by size, from Quick to Marathon (messages and minutes), or Automation for queued work'
  },
  {
    key: 'archived',
    label: 'Archived',
    icon: Archive,
    universe: ARCHIVED_VALUES,
    labels: ARCHIVED_LABELS as Record<string, string>,
    claudeOnly: false,
    note: '',
    tip: 'Show sessions that are archived, not archived, or both'
  }
] as const
type SubKey = (typeof sub)[number]['key']
const ticked = (k: SubKey): readonly string[] => s.value[k]
function flip(k: SubKey, universe: readonly string[], v: string) {
  set({ [k]: toggle(ticked(k), universe, v) } as Partial<CloudScopes>)
}
const APP_TIPS: Record<string, string> = { claude: 'Claude chats', codex: "Codex (ChatGPT's coding app) chats", opencode: 'OpenCode chats' }
const appTip = (v: string, on: boolean) => `${on ? 'Hide' : 'Show'} ${APP_TIPS[v] ?? `${SOURCE_LABELS[v as keyof typeof SOURCE_LABELS]} sessions`}`

const FILTER_TIPS: Record<SidebarFilter, string> = {
  active: 'Show the chats that are not archived',
  archived: 'Show only the archived chats',
  all: 'Show every chat, the archived ones in a group at the end'
}

const ITEM = `${MENU_ITEM} pe-2`

// Sub-items: how each kind under a row shows, as its lines or as a count badge (sidebar/subitems.ts).
const SUB_CHOICES: { value: SubMode; label: string }[] = [
  { value: 'list', label: 'List' },
  { value: 'count', label: 'Count' }
]
const SUB_KINDS: { kind: SubKind; icon: typeof Bot; tip: string }[] = [
  { kind: 'tasks', icon: Bot, tip: "The CliMayte tasks a chat started: listed under it, or a count badge on its row that opens them" },
  { kind: 'jobs', icon: Network, tip: 'The HSwarm jobs a chat started: listed under it, or a count badge on its row that opens them' }
]
</script>

<template>
  <!-- One click per app; Claude alone until ticked otherwise (owner, 2026-10-05: "I need the ability to toggle on and off, certain items"). -->
  <DropdownMenuLabel class="flex h-5.75 items-center px-2 py-0 text-[13px] font-medium text-text-muted">Apps</DropdownMenuLabel>
  <DropdownMenuItem
    v-for="v in SOURCE_VALUES"
    :key="v"
    role="menuitemcheckbox"
    :aria-checked="s.apps.includes(v)"
    :title="appTip(v, s.apps.includes(v))"
    :class="ITEM"
    @select.prevent="set({ apps: toggle(s.apps, SOURCE_VALUES, v) })"
  >
    <span class="flex-1">{{ SOURCE_LABELS[v] }}</span>
    <component :is="icons.check" v-if="s.apps.includes(v)" class="ms-3" />
  </DropdownMenuItem>

  <DropdownMenuSeparator :class="MENU_SEPARATOR" />
  <DropdownMenuLabel class="flex h-5.75 items-center px-2 py-0 text-[13px] font-medium text-text-muted">Desk list</DropdownMenuLabel>
  <DropdownMenuItem
    v-for="(label, key) in FILTER_LABELS"
    :key="key"
    role="menuitemradio"
    :aria-checked="!cloud.on.value && props.filter === key"
    :title="FILTER_TIPS[key]"
    :class="MENU_ITEM"
    @select="emit('update:filter', key), (cloud.on.value = false)"
  >
    <span class="flex-1">{{ label }}</span>
    <component :is="icons.check" v-if="!cloud.on.value && props.filter === key" class="ms-3" />
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
    <component :is="icons.check" v-if="showHidden" class="ms-3" />
  </DropdownMenuItem>
  <!-- Both lists'; off until an answer names this PC, so it never ticks a placeholder name. -->
  <DropdownMenuItem
    role="menuitemcheckbox"
    :aria-checked="local"
    :disabled="!cloud.loaded.value"
    :title="`Only the sessions on this PC (${cloud.thisPc.value}), in both lists; none synced from another PC`"
    :class="ITEM"
    @select.prevent="setPcs(local ? null : [cloud.thisPc.value])"
  >
    <component :is="icons.local" />
    <span class="flex-1">Show only local</span>
    <component :is="icons.check" v-if="local" class="ms-3" />
  </DropdownMenuItem>

  <DropdownMenuSeparator :class="MENU_SEPARATOR" />
  <DropdownMenuLabel class="flex h-5.75 items-center px-2 py-0 text-[13px] font-medium text-text-muted">Sub-items</DropdownMenuLabel>
  <DropdownMenuSub v-for="k in SUB_KINDS" :key="k.kind">
    <DropdownMenuSubTrigger :class="ITEM" :title="k.tip">
      <component :is="k.icon" />
      <span class="flex-1">{{ SUB_KIND_LABELS[k.kind] }}</span>
      <span class="ps-3 text-[12px] text-text-muted">{{ subModes[k.kind].value === 'count' ? 'Count' : 'List' }}</span>
    </DropdownMenuSubTrigger>
    <DropdownMenuSubContent :side-offset="4" :class="`${MENU_CONTENT} max-w-52`">
      <DropdownMenuItem
        v-for="c in SUB_CHOICES"
        :key="c.value"
        role="menuitemradio"
        :aria-checked="subModes[k.kind].value === c.value"
        :class="MENU_ITEM"
        @select="subModes[k.kind].value = c.value"
      >
        <span class="flex-1">{{ c.label }}</span>
        <component :is="icons.check" v-if="subModes[k.kind].value === c.value" class="ms-3" />
      </DropdownMenuItem>
    </DropdownMenuSubContent>
  </DropdownMenuSub>

  <DropdownMenuSeparator :class="MENU_SEPARATOR" />
  <DropdownMenuLabel class="flex h-5.75 items-center px-2 py-0 text-[13px] font-medium text-text-muted">Cloud list</DropdownMenuLabel>
  <DropdownMenuItem :class="ITEM" title="Load the cloud list again from AgentHydra" @select.prevent="(cloud.on.value = true), cloud.refresh()">
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
    <component :is="icons.check" v-if="s.onlyThisView" class="ms-3" />
  </DropdownMenuItem>
  <DropdownMenuSeparator :class="MENU_SEPARATOR" />
  <DropdownMenuItem
    role="menuitemcheckbox"
    :aria-checked="cloud.selectMode.value"
    title="Tick several sessions in the cloud list to act on them at once"
    :class="ITEM"
    @select="(cloud.on.value = true), cloud.setSelectMode(!cloud.selectMode.value)"
  >
    <ListTodo />
    <span class="flex-1">Select multiple sessions</span>
    <component :is="icons.check" v-if="cloud.selectMode.value" class="ms-3" />
  </DropdownMenuItem>
  <DropdownMenuSeparator :class="MENU_SEPARATOR" />

  <template v-for="m in sub" :key="m.key">
    <DropdownMenuSub>
      <DropdownMenuSubTrigger :class="ITEM" :disabled="m.claudeOnly && !claude" :title="m.tip">
        <component :is="m.icon" />
        <span class="flex-1">{{ m.label }}</span>
        <span class="max-w-28 truncate ps-3 text-[12px] text-text-muted">{{ summarize(ticked(m.key), m.universe, (v) => m.labels[v] ?? v) }}</span>
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
          <component :is="icons.check" v-if="ticked(m.key).includes(v)" class="ms-3" />
        </DropdownMenuItem>
        <p v-if="m.note" class="px-2 py-1.5 text-[12px] leading-4 text-text-muted">{{ m.note }}</p>
      </DropdownMenuSubContent>
    </DropdownMenuSub>

    <!-- Instance sits first, as in AgentHydra: a fact about Claude sessions, so off without Claude. -->
    <DropdownMenuSub v-if="m.key === 'dispatched'">
      <DropdownMenuSubTrigger :class="ITEM" :disabled="!claude" title="Which Claude login (account instance) the sessions ran on">
        <Boxes />
        <span class="flex-1">Instance</span>
        <span class="max-w-28 truncate ps-3 text-[12px] text-text-muted">{{ summarize(instanceTicked, instanceUniverse, instanceLabel) }}</span>
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
          <component :is="icons.check" v-if="instanceTicked.includes(v)" class="ms-3" />
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  </template>

  <DropdownMenuSub>
    <DropdownMenuSubTrigger :class="ITEM" title="Which PC the sessions ran on, in both lists">
      <Monitor />
      <span class="flex-1">Computer</span>
      <span class="max-w-28 truncate ps-3 text-[12px] text-text-muted">{{ summarize(pcTicked, cloud.pcs.value, (v) => v) }}</span>
    </DropdownMenuSubTrigger>
    <DropdownMenuSubContent :side-offset="4" :class="`${MENU_CONTENT} max-w-64`">
      <DropdownMenuItem :class="MENU_ITEM" @select.prevent="setPcs(null)">Both</DropdownMenuItem>
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
        <component :is="icons.check" v-if="pcTicked.includes(pc)" class="ms-3" />
      </DropdownMenuItem>
      <p v-if="cloud.pcs.value.length < 2" class="px-2 py-1.5 text-[12px] leading-4 text-text-muted">
        No chat from another PC in this list yet: the other PC's Desktop chats arrive through AgentHydra's chat sync.
      </p>
    </DropdownMenuSubContent>
  </DropdownMenuSub>

  <DropdownMenuSub>
    <DropdownMenuSubTrigger :class="ITEM" title="How far back the cloud list reaches">
      <CalendarRange />
      <span class="flex-1">Time period</span>
      <span class="max-w-28 truncate ps-3 text-[12px] text-text-muted">{{ PERIOD_LABELS[s.period] }}</span>
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
        <component :is="icons.check" v-if="s.period === p" class="ms-3" />
      </DropdownMenuItem>
    </DropdownMenuSubContent>
  </DropdownMenuSub>

  <DropdownMenuSeparator :class="MENU_SEPARATOR" />
  <DropdownMenuItem v-if="scopesNarrowed(s)" :class="ITEM" title="Put every cloud filter back to its default" @select="cloud.reset()">
    <RotateCcw />
    <span class="flex-1">Reset cloud filters</span>
  </DropdownMenuItem>
  <DropdownMenuItem :class="ITEM" title="Opens AgentHydra beside the sidebar" @select="openHydra()">
    <Settings2 />
    <span class="flex-1">Session settings</span>
    <span class="ps-3 text-[12px] text-text-muted">AgentHydra</span>
  </DropdownMenuItem>
</template>

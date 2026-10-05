<script setup lang="ts">
import { computed, ref } from 'vue'
import { Cloud } from '@lucide/vue'
import type { CliMayteWorker, CloudSession } from '@shared/protocol'
import { shellGlyphs } from '@/lib/icons'
import { useClock } from '@/lib/clock'
import { Tip } from '@/components/ui/tooltip'
import { relativeTime } from '@/components/sidebar/search'
import TaskRows from '@/components/sidebar/TaskRows.vue'
import RunningBadge from '@/components/sidebar/RunningBadge.vue'
import { runningIn, type TaskNode } from '@/components/sidebar/tasks'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import RowMenuList from '@/components/sidebar/RowMenuList.vue'
import { MENU_CONTENT, focusFirstItem, runShortcut } from '@/components/sidebar/menuClasses'
import { useRowDrag } from '@/components/sidebar/rowDrag'
import { glyphDotClass, type RowMenuEntry, type RowMenuItem, type StatusGlyph } from '@/components/sidebar/logic'
import { leaveUnlessFiltered } from '@/lib/row-leave'
import { cloudOnlyLabel, fromPcLabel, modelName, originLabel, scopesNarrowed, sessionShape, SHAPE_LABELS } from './logic'
import { useCloud } from './store'

// Hydra Desk 2's cloud list, in the sidebar in place of the desk list: every session AgentHydra knows,
// both PCs' (a chat from the other PC carries its name), plus every one the desk list shows, in the desk
// list's groups and order (one saved order for both, sidebar/order.ts; logic.ts groupCloud), so the cloud
// button moves nothing. The rows only this list has follow the desk's in their group, each leading with a
// cloud (owner, 2026-10-04: "they change order and none display a cloud icon"). A row opens the session
// (Sidebar decides where: the outside-session view, or AgentHydra while it is open); in select mode it
// ticks instead. No title or counts over it: the chrome bar's blue cloud says which list this is (Michael,
// 2026-10-04). The search and filter buttons (the `tools` slot) sit at the right end of the first folder's
// header, as on the desk list, or alone in a header while there is no folder to show.
const props = defineProps<{
  selectedId: string | null
  /** With the chrome bar's CliMayte button on: the tasks a row handed out, listed under it (sidebar/tasks.ts). */
  tasksOf?: (id: string) => TaskNode[] | null
  /** Whether a row's session runs now, for a folded group's heading. */
  running?: (id: string) => boolean
  /** The desk row's dot (running, needs you, idle): the row here draws the same one. */
  glyph?: (id: string) => StatusGlyph | undefined
  /** A row's right-click menu: its desk row's, or the cloud-only one (Sidebar.vue cloudMenu). */
  menuFor?: (row: CloudSession) => RowMenuEntry[]
}>()
const emit = defineEmits<{ open: [row: CloudSession]; 'open-task': [worker: CliMayteWorker]; action: [row: CloudSession, item: RowMenuItem] }>()

const cloud = useCloud()
const rowLeave = leaveUnlessFiltered([() => cloud.answeredQuery.value, () => JSON.stringify(cloud.scopes.value)])
// Rows drag to another place in their group (sidebar/rowDrag.ts), into the order the desk list shares;
// not in select mode, nor while a search or a filter narrows the list.
const rowDrag = useRowDrag()
const canDrag = computed(() => !cloud.selectMode.value && !cloud.search.value.trim() && !scopesNarrowed(cloud.scopes.value))
const collapsed = ref(new Set<string>())
function toggleGroup(key: string) {
  const next = new Set(collapsed.value)
  if (!next.delete(key)) next.add(key)
  collapsed.value = next
}

/** The running tasks under a group's rows, and its rows that run, for its heading while it is folded. */
const runningInGroup = (rows: readonly CloudSession[]) => (props.tasksOf ? runningIn(rows.map((r) => props.tasksOf!(r.id))) : 0)
const chatsRunningIn = (rows: readonly CloudSession[]) => (props.running ? rows.filter((r) => props.running!(r.id)).length : 0)
const foldedRunning = computed(() => {
  const out = new Map<string, { tasks: number; chats: number }>()
  for (const g of cloud.groups.value) {
    if (!collapsed.value.has(g.key)) continue
    const tasks = runningInGroup(g.rows)
    const chats = chatsRunningIn(g.rows)
    if (tasks || chats) out.set(g.key, { tasks, chats })
  }
  return out
})

const now = useClock(30_000)

const thisPc = computed(() => cloud.thisPc.value)
/** The other PC's name on a chat the chat sync brought from it; null for this PC's rows. */
const otherPc = (r: CloudSession) => (r.fromPc && r.fromPc !== thisPc.value ? r.fromPc : null)
function tooltip(r: CloudSession): string {
  const pc = otherPc(r)
  // A row made of the desk's facts (AgentHydra's answer left it out) has no count or shape to tell.
  const size = cloud.fromDesk(r.id) ? 'Listed because the desk list shows it' : `${SHAPE_LABELS[sessionShape(r)]} · ${r.messageCount} messages`
  return [
    r.title,
    cloud.onDesk(r.id) ? originLabel(r, thisPc.value) : cloudOnlyLabel(r, thisPc.value),
    pc && fromPcLabel(pc),
    [modelName(r.model), r.effort].filter(Boolean).join(' · '),
    `${size}${r.archived ? ' · archived' : ''}`,
    r.cwd,
    r.lastCwd && `Now in ${r.lastCwd}`
  ]
    .filter(Boolean)
    .join('\n')
}
/** A row the desk list shows keeps its dot, moving while the desk's does (owner, 2026-10-05: the gray dots pulse while working). */
function dotClass(r: CloudSession): string {
  if (r.archived) return 'border border-text-muted'
  const g = props.glyph?.(r.id)
  return g ? glyphDotClass(g) : 'bg-text-muted'
}
// Each row's tooltip, built when the rows change and not on every redraw (the 30 s clock redraws them).
const tips = computed(() => {
  const out = new Map<string, string>()
  for (const g of cloud.groups.value) for (const r of g.rows) out.set(r.id, tooltip(r))
  return out
})
function onRow(r: CloudSession) {
  if (cloud.selectMode.value) cloud.toggleSelected(r.id)
  else emit('open', r)
}

const copied = ref(false)
async function copyIds() {
  await navigator.clipboard.writeText([...cloud.selected.value].join('\n'))
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}

const ROW =
  'group/row relative flex h-[26px] w-full cursor-default items-center gap-1 rounded-[var(--radius-6)] px-0.5 text-[13px] leading-[19.5px] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-snap)] select-none'
</script>

<template>
  <div class="flex flex-col" role="region" aria-label="Cloud list">
    <header v-if="cloud.groups.value.length === 0" class="flex h-[34px] items-center gap-1 pb-1 pl-1.5 pr-px pt-3 text-[12px] leading-4 text-text-muted">
      <span v-if="!cloud.loaded.value && !cloud.error.value" role="status">Loading sessions…</span>
      <span class="flex-1" />
      <slot name="tools" />
    </header>

    <p v-if="cloud.error.value" role="alert" class="px-1.5 pt-2 text-[12px] leading-4 text-danger-text">
      {{ cloud.error.value }}
      <button type="button" class="ml-1 rounded-[4px] px-1 text-text-2 hover:bg-fill-hover" @click="cloud.refresh()">Retry</button>
    </p>
    <p v-else-if="cloud.loaded.value && cloud.groups.value.length === 0" class="px-1.5 pt-3 text-[12px] leading-4 text-text-muted">
      No sessions match.
      <button type="button" class="ml-1 rounded-[4px] px-1 text-text-2 hover:bg-fill-hover" @click="cloud.reset()">Reset filters</button>
    </p>

    <TransitionGroup :css="false" @leave="rowLeave">
    <section v-for="(g, gi) in cloud.groups.value" :key="g.key" :aria-label="g.label">
      <header class="group/head flex h-[34px] items-center gap-1 pb-1 pl-1.5 pr-1 pt-3 text-[12px] leading-4 text-text-muted">
        <Tip :label="g.cwd ?? ''" align="start">
          <button type="button" class="flex min-w-0 items-center gap-0.5 rounded-[4px] hover:text-text-2" :aria-expanded="!collapsed.has(g.key)" @click="toggleGroup(g.key)">
            <span class="truncate">{{ g.label }}</span>
            <component
              :is="shellGlyphs.groupChevron"
              class="size-3 shrink-0 transition-transform duration-[var(--dur-fast)] group-hover/head:opacity-100"
              :class="collapsed.has(g.key) ? 'opacity-100' : 'rotate-90 opacity-0'"
            />
            <RunningBadge v-if="foldedRunning.get(g.key)" class="ml-1" :tasks="foldedRunning.get(g.key)!.tasks" :chats="foldedRunning.get(g.key)!.chats" />
          </button>
        </Tip>
        <span class="flex-1" />
        <span class="tnum">{{ g.rows.length }}</span>
        <slot v-if="gi === 0" name="tools" />
      </header>
      <TransitionGroup v-if="!collapsed.has(g.key)" tag="div" class="flex flex-col gap-[1.5px] pt-[1.5px]" :css="false" @leave="rowLeave">
        <div
          v-for="r in g.rows"
          :key="r.id"
          class="flex flex-col gap-[1.5px]"
          :class="rowDrag.line(cloud.orderKey(r.id))"
          :draggable="canDrag"
          @dragstart="canDrag && rowDrag.start($event, g.key, cloud.orderKey(r.id))"
          @dragover="canDrag && rowDrag.onOver($event, g.key, cloud.orderKey(r.id))"
          @drop="canDrag && rowDrag.drop($event, g.key, g.rows.map((x) => cloud.orderKey(x.id)), cloud.orderKey(r.id))"
          @dragend="rowDrag.end"
        >
        <Tip :label="tips.get(r.id) ?? ''" side="right" align="start">
          <span class="block">
          <ContextMenu>
          <ContextMenuTrigger as-child>
          <div
            role="button"
            tabindex="0"
            :aria-current="props.selectedId === r.id ? 'page' : undefined"
            :aria-pressed="cloud.selectMode.value ? cloud.selected.value.has(r.id) : undefined"
            :class="[ROW, props.selectedId === r.id ? 'bg-fill-selected text-text' : 'text-text-2 hover:bg-fill-hover', r.archived ? 'text-text-muted' : '']"
            @click="onRow(r)"
            @keydown.enter.self="onRow(r)"
          >
            <!-- A row only this list has leads with a cloud (owner, 2026-10-04: "none display a cloud icon"), and so does another PC's chat, as AgentHydra's Sessions tab draws it (owner, 2026-10-04: "the cloud chats don't have a cloud icon"); a row the desk list shows keeps its dot. -->
            <span class="flex size-6 shrink-0 items-center justify-center">
              <span
                v-if="cloud.selectMode.value"
                class="flex size-3.5 items-center justify-center rounded-[3px] border"
                :class="cloud.selected.value.has(r.id) ? 'border-accent bg-accent text-white' : 'border-text-muted'"
              >
                <svg v-if="cloud.selected.value.has(r.id)" viewBox="0 0 12 12" class="size-2.5" fill="none" stroke="currentColor" stroke-width="2"><path d="M2.5 6.2 5 8.5 9.5 3.5" /></svg>
              </span>
              <Cloud v-else-if="!cloud.onDesk(r.id)" role="img" :aria-label="cloudOnlyLabel(r, thisPc)" class="size-3.5 text-text-muted" />
              <Cloud v-else-if="otherPc(r)" role="img" :aria-label="fromPcLabel(otherPc(r)!)" class="size-3.5 text-text-muted" />
              <span v-else class="size-1.5 rounded-full" :class="dotClass(r)" />
            </span>
            <span class="min-w-0 flex-1 truncate">{{ r.title }}</span>
            <span v-if="otherPc(r)" class="max-w-24 shrink-0 truncate rounded-[4px] bg-fill-5 px-1 text-[11px] leading-4 text-accent-text">{{ r.fromPc }}</span>
            <span v-if="r.instanceNum !== null" class="shrink-0 rounded-[4px] bg-fill-5 px-1 text-[11px] leading-4 text-text-muted tnum">#{{ r.instanceNum }}</span>
            <span class="shrink-0 pr-1 text-[12px] leading-4 text-text-muted tnum">{{ relativeTime(r.lastActivityAt, now) }}</span>
          </div>
          </ContextMenuTrigger>
          <ContextMenuContent v-if="props.menuFor" :class="MENU_CONTENT" @open-auto-focus="focusFirstItem" @keydown.capture="(e: KeyboardEvent) => runShortcut(e, props.menuFor!(r))">
            <RowMenuList :entries="props.menuFor(r)" kind="context" @run="(item: RowMenuItem) => emit('action', r, item)" />
          </ContextMenuContent>
          </ContextMenu>
          </span>
        </Tip>
        <TaskRows v-if="props.tasksOf?.(r.id)" :nodes="props.tasksOf(r.id)!" :selected-id="props.selectedId" @open="(w: CliMayteWorker) => emit('open-task', w)" />
        </div>
      </TransitionGroup>
    </section>
    </TransitionGroup>

    <div v-if="cloud.selectMode.value" class="sticky bottom-0 mt-2 flex items-center gap-1 rounded-[var(--radius-6)] bg-bg-popover px-1.5 py-1 text-[12px] text-text-2 shadow-(--shadow-popover)">
      <span class="flex-1">{{ cloud.selected.value.size }} selected</span>
      <button type="button" class="rounded-[4px] px-1.5 py-0.5 hover:bg-fill-hover disabled:opacity-50" :disabled="cloud.selected.value.size === 0" @click="copyIds">
        {{ copied ? 'Copied' : `Copy ${cloud.selected.value.size} id${cloud.selected.value.size === 1 ? '' : 's'}` }}
      </button>
      <button type="button" class="rounded-[4px] px-1.5 py-0.5 hover:bg-fill-hover" @click="cloud.setSelectMode(false)">Done</button>
    </div>
  </div>
</template>

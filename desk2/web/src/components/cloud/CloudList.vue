<script setup lang="ts">
import { computed, ref, type Component } from 'vue'
import { Cloud, EyeOff } from '@lucide/vue'
import type { CliMayteWorker, CloudSession, SwarmJob } from '@shared/protocol'
import { shellGlyphs, shellIcons } from '@/lib/icons'
import { Tip } from '@/components/ui/tooltip'
import { createReusableTemplate } from '@vueuse/core'
import { useFirstInterestSet } from '@/lib/first-interest'
import RowAge from '@/lib/RowAge.vue'
import TaskRows from '@/components/sidebar/TaskRows.vue'
import RunningBadge from '@/components/sidebar/RunningBadge.vue'
import { isAddedRow, isTaskRow, runningJobsIn, runningTasksIn, type TaskNode } from '@/components/sidebar/tasks'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import RowMenuList from '@/components/sidebar/RowMenuList.vue'
import { MENU_CONTENT, MENU_ITEM, focusFirstItem, runShortcut } from '@/components/sidebar/menuClasses'
import { useHiddenGroups } from '@/components/sidebar/hidden'
import { cleanSidebar } from '@/components/sidebar/clean'
import { HEADER_BTN, LIST_ROW } from '@/components/sidebar/rowClasses'
import { useRowDrag } from '@/components/sidebar/rowDrag'
import { glyphDotClass, HIDE_TITLE, runPulse, type RowMenuEntry, type RowMenuItem, type StatusGlyph } from '@/components/sidebar/logic'
import { leaveUnlessFiltered } from '@/lib/row-leave'
import { fromPcLabel, modelName, originLabel, RESULTS_KEY, rowLead, scopesNarrowed, sessionShape, SHAPE_LABELS, type CloudGroup } from './logic'
import { appMark } from './appMarks'
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
  /** The groups to draw: the store's with the rows Sidebar adds for running work no row lists (sidebar/tasks.ts addToCloudGroups); else the store's. */
  groups?: CloudGroup[]
  selectedId: string | null
  /** With the chrome bar's CliMayte button on: the tasks a row handed out, listed under it (sidebar/tasks.ts). */
  tasksOf?: (id: string) => TaskNode[] | null
  /** The tasks of a row whose lines are drawn (Count mode leaves them out until its badge is opened); `tasksOf` still counts every one. */
  shownOf?: (id: string) => TaskNode[] | null
  /** The HSwarm jobs a folded group's heading counts under a row (its chat's, and the job an added row is itself); `shownJobsOf` has those whose lines are drawn. */
  jobsOf?: (id: string) => SwarmJob[] | null
  shownJobsOf?: (id: string) => SwarmJob[] | null
  /** Whether a row's session runs now, for a folded group's heading. */
  running?: (id: string) => boolean
  /** The desk row's dot (running, needs you, idle): the row here draws the same one. */
  glyph?: (id: string) => StatusGlyph | undefined
  /** How an added row's cloud pulses (tasks.ts addedPulse, from the row's own work and tasks); null for a row with nothing running, undefined for any other row. */
  pulse?: (id: string) => 'gray' | 'blue' | null | undefined
  /** A row's right-click menu: its desk row's, or the cloud-only one (Sidebar.vue cloudMenu). */
  menuFor?: (row: CloudSession) => RowMenuEntry[]
}>()
const emit = defineEmits<{ 'new-session': [cwd: string]; open: [row: CloudSession]; 'open-task': [worker: CliMayteWorker]; 'open-job': [job: SwarmJob]; action: [row: CloudSession, item: RowMenuItem] }>()

const cloud = useCloud()
// A row nobody touched draws its content only; its context menu mounts on the first hover or focus and stays (lib/first-interest.ts).
const rowMenus = useFirstInterestSet()
const [DefineRowBody, ReuseRowBody] = createReusableTemplate<{ r: CloudGroup['rows'][number] }>()
const shownGroups = computed(() => props.groups ?? cloud.groups.value)
// A group's right-click hides it here and on the desk list alike (sidebar/hidden.ts); the store leaves it out.
const hiddenGroups = useHiddenGroups()
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

/** The running CliMayte tasks and HSwarm jobs under a group's rows, and its rows that run, for its heading while it is folded. */
const tasksRunningIn = (rows: readonly CloudSession[]) => (props.tasksOf ? runningTasksIn(rows.map((r) => props.tasksOf!(r.id))) : 0)
const jobsRunningIn = (rows: readonly CloudSession[]) => (props.jobsOf ? runningJobsIn(rows.map((r) => props.jobsOf!(r.id))) : 0)
const chatsRunningIn = (rows: readonly CloudSession[]) => (props.running ? rows.filter((r) => props.running!(r.id)).length : 0)
const foldedRunning = computed(() => {
  const out = new Map<string, { tasks: number; jobs: number; chats: number }>()
  for (const g of shownGroups.value) {
    if (!collapsed.value.has(g.key)) continue
    const tasks = tasksRunningIn(g.rows)
    const jobs = jobsRunningIn(g.rows)
    const chats = chatsRunningIn(g.rows)
    if (tasks || jobs || chats) out.set(g.key, { tasks, jobs, chats })
  }
  return out
})

const thisPc = computed(() => cloud.thisPc.value)
/** The other PC's name on a chat the chat sync brought from it; null for this PC's rows. */
const otherPc = (r: CloudSession) => (r.fromPc && r.fromPc !== thisPc.value ? r.fromPc : null)
function tooltip(r: CloudSession): string {
  const pc = otherPc(r)
  // A row added for running work no row lists (sidebar/tasks.ts addedCloudRow): where it runs, the PC named.
  if (isAddedRow(r.id)) {
    return [r.title, originLabel(r, thisPc.value), [modelName(r.model), r.effort].filter(Boolean).join(' · '), r.cwd].filter(Boolean).join('\n')
  }
  // A row made of the desk's facts (AgentHydra's answer left it out) has no count or shape to tell.
  const size = cloud.fromDesk(r.id) ? 'Listed because the desk list shows it' : `${SHAPE_LABELS[sessionShape(r)]} · ${r.messageCount} messages`
  return [
    r.title,
    originLabel(r, thisPc.value),
    pc && fromPcLabel(pc, r.source),
    [modelName(r.model), r.effort].filter(Boolean).join(' · '),
    `${size}${r.archived ? ' · archived' : ''}`,
    r.cwd,
    r.lastCwd && `Now in ${r.lastCwd}`
  ]
    .filter(Boolean)
    .join('\n')
}
/** What a row's lead slot holds (logic.ts rowLead): another PC's cloud, else its dot; this PC's other app's mark sits beside the dot. */
const cloudMark = (r: CloudSession) => rowLead(r, thisPc.value, { added: isAddedRow(r.id) })
/** The mark of a row from this PC's other app, null for any other row. */
function appIcon(r: CloudSession): Component | null {
  const m = cloudMark(r)
  return m?.kind === 'app' ? appMark(m.app) : null
}
/**
 * A row keeps its dot, moving while the desk's does (owner, 2026-10-05: the gray dots pulse while working). A row
 * only this list has (a past session nothing runs now) draws the idle ring: a solid gray dot read as running
 * (owner, 2026-10-07, of an old chat on another account: "I don't have that running on any of my accounts").
 */
function dotClass(r: CloudSession): string {
  if (r.archived) return 'border border-text-muted'
  const g = props.glyph?.(r.id)
  return glyphDotClass(g ?? { shape: 'ring', tone: 'muted', motion: 'none' })
}
/**
 * Another PC's cloud pulses while its row runs, as the row's dot would (owner, 2026-10-05: "for chats that are
 * remote ... gray pulsing"): gray, or blue for a row that is a running HSwarm job; still and muted otherwise.
 */
function cloudTone(r: CloudSession): string {
  // A row added for running work has no dot of its own: its work and its tasks say whether it runs.
  if (isAddedRow(r.id)) {
    const tone = props.pulse?.(r.id)
    return tone ? runPulse(tone) : 'text-text-muted'
  }
  const g = props.glyph?.(r.id)
  return g?.motion === 'blink' ? runPulse(g.tone === 'swarm' ? 'blue' : 'gray') : 'text-text-muted'
}
// Each row's tooltip, built when the rows change and not on every redraw (the 30 s clock redraws them).
const tips = computed(() => {
  const out = new Map<string, string>()
  for (const g of shownGroups.value) for (const r of g.rows) out.set(r.id, tooltip(r))
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

const ROW = LIST_ROW
</script>

<template>
  <div class="flex flex-col" role="region" aria-label="Cloud list">
    <DefineRowBody v-slot="{ r }">
            <!-- A row only this list has leads with a cloud (owner, 2026-10-04: "none display a cloud icon"), and so does another PC's chat, as AgentHydra's Sessions tab draws it (owner, 2026-10-04: "the cloud chats don't have a cloud icon"); a row the desk list shows keeps its dot. -->
            <span class="flex size-6 shrink-0 items-center justify-center">
              <span
                v-if="cloud.selectMode.value"
                class="flex size-3.5 items-center justify-center rounded-[3px] border"
                :class="cloud.selected.value.has(r.id) ? 'border-accent bg-accent text-white' : 'border-text-muted'"
              >
                <svg v-if="cloud.selected.value.has(r.id)" viewBox="0 0 12 12" class="size-2.5" fill="none" stroke="currentColor" stroke-width="2"><path d="M2.5 6.2 5 8.5 9.5 3.5" /></svg>
              </span>
              <Cloud v-else-if="cloudMark(r)?.kind === 'cloud'" role="img" :aria-label="cloudMark(r)!.label" class="size-3.5" :class="cloudTone(r)" />
              <span v-else class="size-1.5 rounded-full" :class="dotClass(r)" />
            </span>
            <!-- This PC's chat of another app: its muted mark beside the dot, which keeps its running and needs-you look. -->
            <component :is="appIcon(r)!" v-if="appIcon(r)" role="img" :aria-label="cloudMark(r)!.label" :title="cloudMark(r)!.label" class="size-3.5 shrink-0 text-text-muted" />
            <!-- A CliMayte task drawn as a row of its own: the CliMayte toggle's mark, as the desk list draws it (owner, 2026-10-07). -->
            <component :is="shellIcons.climayte" v-if="isTaskRow(r.id)" role="img" aria-label="CliMayte task" title="CliMayte task" class="size-3.5 shrink-0 text-text-muted" />
            <span class="min-w-0 flex-1 truncate">{{ r.title }}</span>
            <!-- Clean sidebar (sidebar/clean.ts) leaves the account number and the age out. -->
            <span v-if="r.instanceNum !== null && !cleanSidebar" class="shrink-0 rounded-[4px] bg-fill-5 px-1 text-[11px] leading-4 text-text-muted tnum">#{{ r.instanceNum }}</span>
            <slot name="sub-badges" :id="r.id" />
            <RowAge v-if="!cleanSidebar" class="pr-1" :at="r.lastActivityAt" />
    </DefineRowBody>
    <header v-if="shownGroups.length === 0" class="flex h-[34px] items-center gap-1 pb-1 pl-1.5 pr-px pt-3 text-[12px] leading-4 text-text-muted">
      <span v-if="!cloud.loaded.value && !cloud.error.value" role="status">Loading sessions…</span>
      <span class="flex-1" />
      <slot name="tools" />
    </header>

    <p v-if="cloud.error.value" role="alert" class="px-1.5 pt-2 text-[12px] leading-4 text-danger-text">
      {{ cloud.error.value }}
      <button type="button" class="ml-1 rounded-[4px] px-1 text-text-2 hover:bg-fill-hover" @click="cloud.refresh()">Retry</button>
    </p>
    <p v-else-if="cloud.loaded.value && shownGroups.length === 0 && cloud.hiddenOut.value" class="px-1.5 pt-3 text-[12px] leading-4 text-text-muted">
      Every group here is hidden.
      <button type="button" class="ml-1 rounded-[4px] px-1 text-text-2 hover:bg-fill-hover" @click="hiddenGroups.setShowHidden(true)">Show hidden</button>
    </p>
    <p v-else-if="cloud.loaded.value && shownGroups.length === 0" class="px-1.5 pt-3 text-[12px] leading-4 text-text-muted">
      No sessions match.
      <button type="button" class="ml-1 rounded-[4px] px-1 text-text-2 hover:bg-fill-hover" @click="cloud.reset()">Reset filters</button>
    </p>

    <TransitionGroup :css="false" @leave="rowLeave">
    <section v-for="(g, gi) in shownGroups" :key="g.key" :aria-label="g.label">
      <ContextMenu>
      <ContextMenuTrigger as-child :disabled="g.key === RESULTS_KEY">
      <header class="group/head flex h-[34px] items-center gap-1 pb-1 pl-1.5 pr-1 pt-3 text-[12px] leading-4 text-text-muted" :class="g.hidden && 'opacity-60'">
        <Tip :label="g.cwd ?? ''" align="start">
          <button type="button" class="flex min-w-0 items-center gap-0.5 rounded-[4px] hover:text-text-2" :aria-expanded="!collapsed.has(g.key)" @click="toggleGroup(g.key)">
            <span class="truncate">{{ g.label }}</span>
            <EyeOff v-if="g.hidden" role="img" aria-label="Hidden group" class="ml-0.5 size-3 shrink-0" />
            <component
              :is="shellGlyphs.groupChevron"
              class="size-3 shrink-0 transition-transform duration-[var(--dur-fast)] group-hover/head:opacity-100"
              :class="collapsed.has(g.key) ? 'opacity-100' : 'rotate-90 opacity-0'"
            />
            <RunningBadge v-if="foldedRunning.get(g.key)" class="ml-1" :tasks="foldedRunning.get(g.key)!.tasks" :jobs="foldedRunning.get(g.key)!.jobs" :chats="foldedRunning.get(g.key)!.chats" />
          </button>
        </Tip>
        <span class="flex-1" />
        <Tip v-if="g.cwd && g.key !== RESULTS_KEY" :label="`New session in ${g.label}`">
          <button type="button" :class="HEADER_BTN" :aria-label="`New session in ${g.label}`" @click="emit('new-session', g.cwd)">
            <component :is="shellGlyphs.groupNew" class="size-4" />
          </button>
        </Tip>
        <slot v-if="gi === 0" name="tools" />
      </header>
      </ContextMenuTrigger>
      <ContextMenuContent :class="MENU_CONTENT" @open-auto-focus="focusFirstItem">
        <ContextMenuItem :class="MENU_ITEM" :title="g.hidden ? undefined : HIDE_TITLE" @select="hiddenGroups.hide(g.orderKey, !g.hidden)">
          <span class="flex-1">{{ g.hidden ? 'Unhide' : 'Hide' }}</span>
        </ContextMenuItem>
      </ContextMenuContent>
      </ContextMenu>
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
          <span class="block" v-on="rowMenus.listeners(r.id)">
          <ContextMenu v-if="rowMenus.seen(r.id)">
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
            <ReuseRowBody :r="r" />
          </div>
          </ContextMenuTrigger>
          <ContextMenuContent v-if="props.menuFor" :class="MENU_CONTENT" @open-auto-focus="focusFirstItem" @keydown.capture="(e: KeyboardEvent) => runShortcut(e, props.menuFor!(r))">
            <RowMenuList :entries="props.menuFor(r)" kind="context" @run="(item: RowMenuItem) => emit('action', r, item)" />
          </ContextMenuContent>
          </ContextMenu>
          <div
            v-else
            data-slot="context-menu-trigger"
            data-state="closed"
            role="button"
            tabindex="0"
            :aria-current="props.selectedId === r.id ? 'page' : undefined"
            :aria-pressed="cloud.selectMode.value ? cloud.selected.value.has(r.id) : undefined"
            :class="[ROW, props.selectedId === r.id ? 'bg-fill-selected text-text' : 'text-text-2 hover:bg-fill-hover', r.archived ? 'text-text-muted' : '']"
            @click="onRow(r)"
            @keydown.enter.self="onRow(r)"
          >
            <ReuseRowBody :r="r" />
          </div>
          </span>
        </Tip>
        <TaskRows v-if="(props.shownOf ?? props.tasksOf)?.(r.id)?.length || (props.shownJobsOf ?? props.jobsOf)?.(r.id)?.length" :nodes="(props.shownOf ?? props.tasksOf)?.(r.id) ?? []" :jobs="(props.shownJobsOf ?? props.jobsOf)?.(r.id) ?? []" :selected-id="props.selectedId" @open="(w: CliMayteWorker) => emit('open-task', w)" @open-job="(j: SwarmJob) => emit('open-job', j)" />
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

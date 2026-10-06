<script setup lang="ts">
import { computed, nextTick, ref, watch, type Component } from 'vue'
import {
  Ban,
  Check,
  ChevronRight,
  CircleCheck,
  CircleX,
  Clock,
  Cloud,
  CloudOff,
  Cpu,
  Hourglass,
  Info,
  Layers,
  LayoutGrid,
  ListChecks,
  LoaderCircle,
  Network,
  PictureInPicture2,
  PiggyBank,
  Plug,
  Plus,
  RefreshCw,
  RotateCcw,
  Route,
  Search,
  Server,
  TriangleAlert,
  X
} from '@lucide/vue'
import type { EmbedIcon, EmbedTone, SidebarModel, SidebarRow } from '@shared/hydra-embed'
import { icons } from '@/lib/icons'
import { Tip } from '@/components/ui/tooltip'
import { tellHydra } from './api'

// Hydra Desk 2: the sidebar of AgentHydra's current tab (HSwarm's tree), drawn here in
// Desk's sidebar and Desk's look while AgentHydra is open (Michael, 2026-10-04: one sidebar for
// everything, beside the content). The copy describes it (shared/hydra-embed.ts) and keeps every rule of
// what a row says; a click goes back to it. Rows are 26px like the desk list; hovers are the native
// title, so a 300-row tree costs no tooltip per row.
const props = defineProps<{ model: SidebarModel }>()

const ICONS: Record<EmbedIcon, Component> = {
  network: Network,
  refresh: RefreshCw,
  pip: PictureInPicture2,
  info: Info,
  plus: Plus,
  grid: LayoutGrid,
  'piggy-bank': PiggyBank,
  server: Server,
  cpu: Cpu,
  route: Route,
  plug: Plug,
  layers: Layers,
  cloud: Cloud,
  'cloud-off': CloudOff,
  check: Check,
  retry: RotateCcw,
  x: X,
  alert: TriangleAlert,
  clock: Clock,
  loader: LoaderCircle,
  hourglass: Hourglass,
  'list-checks': ListChecks,
  'circle-check': CircleCheck,
  'circle-x': CircleX,
  ban: Ban
}
const icon = (name: EmbedIcon | undefined): Component | null => (name ? (ICONS[name] ?? null) : null)
const TONE: Record<EmbedTone, string> = {
  muted: 'text-text-muted',
  info: 'text-accent-text',
  accent: 'text-accent-text',
  success: 'text-success-text',
  warning: 'text-warning-text',
  danger: 'text-danger-text'
}
const DOT: Record<EmbedTone | 'hollow', string> = {
  muted: 'bg-text-muted',
  info: 'bg-accent',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  hollow: 'border border-text-muted'
}
const tone = (t: EmbedTone | undefined) => TONE[t ?? 'muted']

const view = computed(() => props.model.view)
const send = {
  select: (key: string) => tellHydra({ type: 'desk:sidebar', view: view.value, action: 'select', key }),
  toggle: (key: string) => tellHydra({ type: 'desk:sidebar', view: view.value, action: 'toggle', key }),
  star: (key: string) => tellHydra({ type: 'desk:sidebar', view: view.value, action: 'star', key }),
  button: (id: string) => tellHydra({ type: 'desk:sidebar', view: view.value, action: 'button', id }),
  switch: (id: string, on: boolean) => tellHydra({ type: 'desk:sidebar', view: view.value, action: 'switch', id, on }),
  search: (value: string) => tellHydra({ type: 'desk:sidebar', view: view.value, action: 'search', value })
}

// The search box keeps its own text (the copy's echo would move the caret); a new tab starts from the copy's.
const query = ref(props.model.search?.value ?? '')
watch(view, () => (query.value = props.model.search?.value ?? ''))
function onSearchInput() {
  send.search(query.value)
}
const rows = computed(() => props.model.sections.flatMap((s) => s.rows))
function onSearchKey(e: KeyboardEvent) {
  if (e.isComposing) return
  if (e.key === 'Enter') {
    const hit = rows.value.find((r) => r.hit && !r.branch) ?? rows.value.find((r) => r.hit) ?? rows.value[0]
    if (hit) send.select(hit.key)
  } else if (e.key === 'Escape' && query.value) {
    e.stopPropagation()
    query.value = ''
    send.search('')
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    focusRow(0)
  }
}

// Arrow keys move through the rows; Right and Left open and close a branch; Enter or Space selects.
const list = ref<HTMLElement | null>(null)
function rowEls(): HTMLElement[] {
  return [...(list.value?.querySelectorAll<HTMLElement>('[data-row]') ?? [])]
}
function focusRow(i: number) {
  const els = rowEls()
  els[Math.max(0, Math.min(els.length - 1, i))]?.focus()
}
function onRowKey(e: KeyboardEvent, row: SidebarRow) {
  const els = rowEls()
  const i = els.indexOf(e.currentTarget as HTMLElement)
  if (e.key === 'ArrowDown') focusRow(i + 1)
  else if (e.key === 'ArrowUp') focusRow(i - 1)
  else if (e.key === 'Home') focusRow(0)
  else if (e.key === 'End') focusRow(els.length - 1)
  else if (e.key === 'ArrowRight' && row.branch === 'closed') send.toggle(row.key)
  else if (e.key === 'ArrowLeft' && row.branch === 'open') send.toggle(row.key)
  else if (e.key === 'Enter' || e.key === ' ') send.select(row.key)
  else return
  e.preventDefault()
}
// The selected row is shown when it changes (a task opened from elsewhere, a tree path picked).
watch(
  () => props.model.selected,
  () => nextTick(() => list.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }))
)

/** The label around its search match. */
function parts(r: SidebarRow): [string, string, string] {
  if (!r.hit) return [r.label, '', '']
  const [a, b] = r.hit
  return [r.label.slice(0, a), r.label.slice(a, b), r.label.slice(b)]
}
/** The sections that have a branch row, so their other rows leave room for the chevron; once per model. */
const branching = computed(() => new Set(props.model.sections.filter((s) => s.rows.some((r) => r.branch)).map((s) => s.key)))
// A logo that does not load gives way to the initials.
const brokenAvatars = ref(new Set<string>())
const empty = computed(() => !rows.value.length)

const ROW =
  'group/row flex h-[26px] w-full cursor-default items-center gap-1 rounded-[var(--radius-6)] pr-1 text-left text-[13px] leading-[19.5px] outline-none transition-colors duration-[var(--dur-fast)] ease-[var(--ease-snap)] select-none focus-visible:ring-1 focus-visible:ring-accent'
const HEAD_BTN =
  'flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-6)] transition-colors hover:bg-fill-hover hover:text-text disabled:opacity-40 disabled:hover:bg-transparent'
const FOOT_BTN =
  'flex h-7 min-w-0 flex-1 items-center justify-center gap-1 rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-2 text-[12px] text-text-2 hover:bg-[var(--fill-secondary-hover)] hover:text-text disabled:opacity-50'
</script>

<template>
  <div class="flex flex-col" role="region" :aria-label="model.title" data-testid="hydra-sidebar">
    <header class="flex h-[34px] items-center gap-1 pb-1 pl-1.5 pr-px pt-3 text-[12px] leading-4 text-text-muted">
      <component :is="icon(model.icon)" v-if="model.icon" class="size-3.5 shrink-0" />
      <span class="min-w-0 truncate font-medium text-text-2">{{ model.title }}</span>
      <span v-if="model.count != null" class="shrink-0 tnum">{{ model.count }}</span>
      <Tip v-if="model.info" :label="model.info">
        <span class="inline-flex shrink-0 text-text-muted" tabindex="0" :aria-label="model.info"><Info class="size-3.5" /></span>
      </Tip>
      <Tip v-if="model.warn" :label="model.warn">
        <span class="inline-flex shrink-0 text-warning-text" tabindex="0" :aria-label="model.warn"><TriangleAlert class="size-3.5" /></span>
      </Tip>
      <span class="flex-1" />
      <Tip v-for="b in model.buttons ?? []" :key="b.id" :label="b.label">
        <!-- The colour is apart: on is the blue icon alone, as the chrome bar's buttons. -->
        <button
          type="button"
          :class="[HEAD_BTN, b.on ? 'text-accent-text' : 'text-text-2']"
          :aria-label="b.label"
          :aria-pressed="b.on === undefined ? undefined : b.on"
          :disabled="b.disabled"
          @click="send.button(b.id)"
        >
          <component :is="icon(b.icon)" class="size-3.5" :class="b.spin ? 'animate-spin' : ''" />
        </button>
      </Tip>
    </header>

    <p v-if="model.banner" role="status" class="mx-1 mb-1 flex items-start gap-1.5 rounded-[var(--radius-6)] bg-fill-5 px-2 py-1.5 text-[12px] leading-4" :class="tone(model.banner.tone)">
      <component :is="icon(model.banner.icon)" v-if="model.banner.icon" class="mt-px size-3.5 shrink-0" />
      <span class="min-w-0">{{ model.banner.text }}</span>
    </p>

    <button
      v-for="s in model.switches ?? []"
      :key="s.id"
      type="button"
      role="switch"
      :aria-checked="s.on"
      class="flex h-[26px] w-full items-center gap-2 rounded-[var(--radius-6)] px-1.5 text-left text-[12px] leading-4 text-text-muted hover:bg-fill-hover hover:text-text-2"
      @click="send.switch(s.id, !s.on)"
    >
      <span class="min-w-0 flex-1 truncate">{{ s.label }}<span v-if="s.note" class="tnum"> · {{ s.note }}</span></span>
      <span class="relative h-3.5 w-6 shrink-0 rounded-full transition-colors" :class="s.on ? 'bg-accent' : 'bg-[var(--fill-secondary)]'">
        <span class="absolute top-0.5 size-2.5 rounded-full bg-white transition-[left]" :class="s.on ? 'left-3' : 'left-0.5'" />
      </span>
    </button>

    <div v-if="model.search" class="mb-1 flex h-[26px] items-center gap-1 rounded-[var(--radius-6)] bg-fill-5 px-0.5">
      <span class="flex size-6 shrink-0 items-center justify-center text-text-muted"><Search class="size-3.5" /></span>
      <input
        v-model="query"
        type="text"
        :aria-label="model.search.label"
        :placeholder="model.search.placeholder"
        class="h-full min-w-0 flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-text-muted"
        @input="onSearchInput"
        @keydown="onSearchKey"
      />
      <button
        v-if="query"
        type="button"
        aria-label="Clear search"
        class="flex size-5 items-center justify-center rounded-[var(--radius-5)] text-text-muted hover:bg-fill-hover hover:text-text"
        @click="(query = ''), send.search('')"
      >
        <component :is="icons.dismiss" class="size-3.5" />
      </button>
    </div>

    <div v-if="model.legend?.length" class="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-1.5 pb-1 text-[11px] leading-4 text-text-muted">
      <span v-for="l in model.legend" :key="l.label" class="flex items-center gap-1"><span class="size-1.5 rounded-full" :class="DOT[l.dot]" />{{ l.label }}</span>
      <span v-if="model.legendNote" class="ml-auto font-mono">{{ model.legendNote }}</span>
    </div>

    <div ref="list" role="tree" :aria-label="model.title" class="flex flex-col">
      <section v-for="sec in model.sections" :key="sec.key" :aria-label="sec.label || undefined">
        <header v-if="sec.label" class="flex h-[30px] items-center gap-1 pb-1 pl-1.5 pr-1 pt-2.5 text-[12px] leading-4 text-text-muted" :title="sec.hint">
          <span class="truncate">{{ sec.label }}</span>
          <span class="flex-1" />
          <span class="tnum">{{ sec.rows.length }}</span>
        </header>
        <div class="flex flex-col gap-[1.5px] pt-[1.5px]">
          <div
            v-for="r in sec.rows"
            :key="r.key"
            data-row
            role="treeitem"
            tabindex="0"
            :aria-level="(r.depth ?? 0) + 1"
            :aria-expanded="r.branch ? r.branch === 'open' : undefined"
            :aria-selected="model.selected === r.key"
            :title="r.hint"
            :class="[
              ROW,
              model.selected === r.key ? 'bg-fill-selected text-text' : 'text-text-2 hover:bg-fill-hover',
              r.dim ? 'opacity-60' : '',
              r.italic ? 'italic text-text-muted' : ''
            ]"
            :style="{ paddingLeft: `${2 + (r.depth ?? 0) * 14}px` }"
            @click="send.select(r.key)"
            @keydown="onRowKey($event, r)"
          >
            <span v-if="r.branch" class="flex size-4 shrink-0 items-center justify-center text-text-muted" aria-hidden="true" @click.stop="send.toggle(r.key)">
              <ChevronRight class="size-3 transition-transform duration-[var(--dur-fast)]" :class="r.branch === 'open' ? 'rotate-90' : ''" />
            </span>
            <span v-else-if="branching.has(sec.key)" class="size-4 shrink-0" aria-hidden="true" />
            <span v-if="r.status" class="flex size-5 shrink-0 items-center justify-center" :class="tone(r.status.tone)" :title="r.status.label">
              <component :is="icon(r.status.icon)" v-if="r.status.icon" class="size-3.5" :class="r.status.spin ? 'animate-spin' : ''" aria-hidden="true" />
              <span v-else-if="r.status.dot" class="size-1.5 rounded-full" :class="[DOT[r.status.dot], r.status.pulse ? 'animate-pulse' : '']" aria-hidden="true" />
              <span v-if="r.status.label" class="sr-only">{{ r.status.label }}</span>
            </span>
            <template v-if="r.avatar">
              <img
                v-if="r.avatar.src && !brokenAvatars.has(r.avatar.src)"
                :src="r.avatar.src"
                alt=""
                aria-hidden="true"
                decoding="async"
                class="size-4 shrink-0 rounded-[3px]"
                @error="brokenAvatars.add(r.avatar.src ?? '')"
              />
              <span v-else class="flex size-4 shrink-0 items-center justify-center rounded-[3px] bg-fill-5 text-[9px] font-semibold text-text-muted" aria-hidden="true">{{ r.avatar.text }}</span>
            </template>
            <component :is="icon(r.icon)" v-else-if="r.icon" class="size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate"><template v-for="[before, match, after] in [parts(r)]" :key="r.key">{{ before }}<mark v-if="match" class="rounded-[2px] bg-[rgb(250_204_21/0.3)] text-inherit">{{ match }}</mark>{{ after }}</template></span>
            <component :is="icon(r.badge.icon)" v-if="r.badge" class="size-3.5 shrink-0 text-text-muted" :aria-label="r.badge.label" />
            <span v-if="r.chip" class="shrink-0 rounded-[4px] bg-fill-5 px-1 text-[11px] leading-4 text-warning-text" :title="r.chip.hint">{{ r.chip.text }}</span>
            <span v-if="r.count != null" class="shrink-0 text-[12px] leading-4 text-text-muted tnum">({{ r.count }})</span>
            <span v-if="r.tag" class="max-w-[45%] shrink-0 truncate text-[11px] leading-4" :class="r.tag.tone === 'warning' ? 'text-warning-text' : 'text-text-muted'">{{ r.tag.text }}</span>
            <span v-if="r.mark" class="inline-flex shrink-0" :class="tone(r.mark.tone)" :title="r.mark.hint ?? r.mark.label">
              <component :is="icon(r.mark.icon)" class="size-3.5" :aria-label="r.mark.label" />
            </span>
            <span v-if="r.meta" class="shrink-0 font-mono text-[11px] leading-4 text-text-muted">{{ r.meta }}</span>
            <span v-if="r.time" class="shrink-0 text-[12px] leading-4 text-text-muted tnum">{{ r.time }}</span>
            <button
              v-if="r.star"
              type="button"
              class="shrink-0 rounded-[4px] px-0.5 text-[11px] leading-4 hover:bg-fill-hover"
              :class="[r.star.on ? 'text-accent-text' : 'text-text-muted', r.star.busy ? 'opacity-50' : '']"
              :aria-label="r.star.label"
              :title="r.star.label"
              @click.stop="send.star(r.key)"
            >
              {{ r.star.text }}
            </button>
          </div>
        </div>
      </section>
    </div>

    <div v-if="empty && model.loading" class="flex flex-col gap-1.5 px-1.5 pt-2" aria-busy="true">
      <span v-for="i in 3" :key="i" class="h-[22px] animate-pulse rounded-[var(--radius-6)] bg-fill-5" />
    </div>
    <p v-else-if="empty && model.empty" class="px-1.5 pt-3 text-[12px] leading-4 text-text-muted">{{ model.empty }}</p>

    <div v-if="model.footer?.length" class="mt-2 flex gap-1.5 px-0.5">
      <button v-for="b in model.footer" :key="b.id" type="button" :class="FOOT_BTN" :disabled="b.disabled" @click="send.button(b.id)">
        <component :is="icon(b.icon)" class="size-3.5 shrink-0" />
        <span class="truncate">{{ b.label }}</span>
      </button>
    </div>
  </div>
</template>

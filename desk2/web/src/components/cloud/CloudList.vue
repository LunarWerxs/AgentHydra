<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Cloud } from '@lucide/vue'
import type { CloudSession } from '@shared/protocol'
import { shellGlyphs } from '@/lib/icons'
import { Tip } from '@/components/ui/tooltip'
import { relativeTime } from '@/components/sidebar/search'
import { pcOf, PERIOD_LABELS, SOURCE_LABELS, sessionShape, SHAPE_LABELS, type CloudSource } from './logic'
import { useCloud } from './store'

// Hydra Desk 2's cloud list, in the sidebar in place of the desk list: every session AgentHydra knows,
// both PCs' (a chat from the other PC carries its name), grouped by folder like the desk list. A row
// opens the session (Sidebar decides where: the outside-session view, or AgentHydra while it is open); in
// select mode it ticks instead. The header's
// right end holds the search and filter buttons (the `tools` slot).
const props = defineProps<{ selectedId: string | null }>()
const emit = defineEmits<{ open: [row: CloudSession] }>()

const cloud = useCloud()
const collapsed = ref(new Set<string>())
function toggleGroup(key: string) {
  const next = new Set(collapsed.value)
  if (!next.delete(key)) next.add(key)
  collapsed.value = next
}

const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => (timer = setInterval(() => (now.value = Date.now()), 30_000)))
onBeforeUnmount(() => timer && clearInterval(timer))

const thisPc = computed(() => cloud.thisPc.value)
const otherPcRows = computed(() => cloud.sessions.value.filter((r) => r.fromPc && r.fromPc !== thisPc.value).length)
const summary = computed(() => {
  const n = cloud.shownCount.value
  if (cloud.searching.value) return `${n} match${n === 1 ? '' : 'es'} · ${cloud.scopes.value.onlyThisView ? 'this view' : 'everywhere, all time'}`
  return `${n} session${n === 1 ? '' : 's'} · ${PERIOD_LABELS[cloud.scopes.value.period].replace('Last ', '')}`
})
const sourceName = (s: string) => SOURCE_LABELS[s as CloudSource] ?? s
/** claude-opus-5-5 -> Opus 5.5, the way AgentHydra's rows name it; any other model as it is. */
const modelName = (m: string | null) => {
  const hit = m?.match(/^claude-([a-z]+)-(\d+)-(\d+)/)
  return hit ? `${hit[1]!.charAt(0).toUpperCase()}${hit[1]!.slice(1)} ${hit[2]}.${hit[3]}` : m
}
function tooltip(r: CloudSession): string {
  return [
    r.title,
    [sourceName(r.source), r.instanceNum !== null ? `#${r.instanceNum}` : r.instance, `on ${pcOf(r, thisPc.value)}`].filter(Boolean).join(' · '),
    [modelName(r.model), r.effort].filter(Boolean).join(' · '),
    `${SHAPE_LABELS[sessionShape(r)]} · ${r.messageCount} messages${r.archived ? ' · archived' : ''}`,
    r.cwd
  ]
    .filter(Boolean)
    .join('\n')
}
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
    <header class="flex h-[34px] items-center gap-1 pb-1 pl-1.5 pr-px pt-3 text-[12px] leading-4 text-text-muted">
      <Cloud class="size-3.5 shrink-0 text-accent-text" />
      <Tip :label="`This PC is ${thisPc}. ${otherPcRows} of these came from another PC through AgentHydra's chat sync.`" align="start">
        <span class="min-w-0 truncate">All sessions · both PCs</span>
      </Tip>
      <span
        v-if="cloud.loading.value"
        role="status"
        aria-label="Loading the cloud list"
        class="size-2.5 shrink-0 animate-spin rounded-full border border-current border-t-transparent"
      />
      <span class="flex-1" />
      <slot name="tools" />
    </header>
    <p class="px-1.5 pb-1 text-[12px] leading-4 text-text-muted">{{ summary }}</p>

    <p v-if="cloud.error.value" role="alert" class="px-1.5 pt-2 text-[12px] leading-4 text-danger-text">
      {{ cloud.error.value }}
      <button type="button" class="ml-1 rounded-[4px] px-1 text-text-2 hover:bg-fill-hover" @click="cloud.refresh()">Retry</button>
    </p>
    <p v-else-if="cloud.loaded.value && cloud.groups.value.length === 0" class="px-1.5 pt-3 text-[12px] leading-4 text-text-muted">
      No sessions match.
      <button type="button" class="ml-1 rounded-[4px] px-1 text-text-2 hover:bg-fill-hover" @click="cloud.reset()">Reset filters</button>
    </p>

    <section v-for="g in cloud.groups.value" :key="g.key" :aria-label="g.label">
      <header class="group/head flex h-[34px] items-center gap-1 pb-1 pl-1.5 pr-1 pt-3 text-[12px] leading-4 text-text-muted">
        <Tip :label="g.cwd ?? ''" align="start">
          <button type="button" class="flex min-w-0 items-center gap-0.5 rounded-[4px] hover:text-text-2" :aria-expanded="!collapsed.has(g.key)" @click="toggleGroup(g.key)">
            <span class="truncate">{{ g.label }}</span>
            <component
              :is="shellGlyphs.groupChevron"
              class="size-3 shrink-0 transition-transform duration-[var(--dur-fast)] group-hover/head:opacity-100"
              :class="collapsed.has(g.key) ? 'opacity-100' : 'rotate-90 opacity-0'"
            />
          </button>
        </Tip>
        <span class="flex-1" />
        <span class="tnum">{{ g.rows.length }}</span>
      </header>
      <div v-if="!collapsed.has(g.key)" class="flex flex-col gap-[1.5px] pt-[1.5px]">
        <Tip v-for="r in g.rows" :key="r.id" :label="tooltip(r)" side="right" align="start">
          <div
            role="button"
            tabindex="0"
            :aria-current="props.selectedId === r.id ? 'page' : undefined"
            :aria-pressed="cloud.selectMode.value ? cloud.selected.value.has(r.id) : undefined"
            :class="[ROW, props.selectedId === r.id ? 'bg-fill-selected text-text' : 'text-text-2 hover:bg-fill-hover', r.archived ? 'text-text-muted' : '']"
            @click="onRow(r)"
            @keydown.enter.self="onRow(r)"
          >
            <span class="flex size-6 shrink-0 items-center justify-center">
              <span
                v-if="cloud.selectMode.value"
                class="flex size-3.5 items-center justify-center rounded-[3px] border"
                :class="cloud.selected.value.has(r.id) ? 'border-accent bg-accent text-white' : 'border-text-muted'"
              >
                <svg v-if="cloud.selected.value.has(r.id)" viewBox="0 0 12 12" class="size-2.5" fill="none" stroke="currentColor" stroke-width="2"><path d="M2.5 6.2 5 8.5 9.5 3.5" /></svg>
              </span>
              <span
                v-else
                class="size-1.5 rounded-full"
                :class="r.fromPc && r.fromPc !== thisPc ? 'bg-accent' : r.archived ? 'border border-text-muted' : 'bg-text-muted'"
              />
            </span>
            <span class="min-w-0 flex-1 truncate">{{ r.title }}</span>
            <span v-if="r.fromPc && r.fromPc !== thisPc" class="max-w-24 shrink-0 truncate rounded-[4px] bg-fill-5 px-1 text-[11px] leading-4 text-accent-text">{{ r.fromPc }}</span>
            <span v-if="r.instanceNum !== null" class="shrink-0 rounded-[4px] bg-fill-5 px-1 text-[11px] leading-4 text-text-muted tnum">#{{ r.instanceNum }}</span>
            <span class="shrink-0 pr-1 text-[12px] leading-4 text-text-muted tnum">{{ relativeTime(r.lastActivityAt, now) }}</span>
          </div>
        </Tip>
      </div>
    </section>

    <div v-if="cloud.selectMode.value" class="sticky bottom-0 mt-2 flex items-center gap-1 rounded-[var(--radius-6)] bg-bg-popover px-1.5 py-1 text-[12px] text-text-2 shadow-(--shadow-popover)">
      <span class="flex-1">{{ cloud.selected.value.size }} selected</span>
      <button type="button" class="rounded-[4px] px-1.5 py-0.5 hover:bg-fill-hover disabled:opacity-50" :disabled="cloud.selected.value.size === 0" @click="copyIds">
        {{ copied ? 'Copied' : `Copy ${cloud.selected.value.size} id${cloud.selected.value.size === 1 ? '' : 's'}` }}
      </button>
      <button type="button" class="rounded-[4px] px-1.5 py-0.5 hover:bg-fill-hover" @click="cloud.setSelectMode(false)">Done</button>
    </div>
  </div>
</template>

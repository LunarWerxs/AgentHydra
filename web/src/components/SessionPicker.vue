<script setup lang="ts">
// Searchable session picker for the run builder — replaces the raw "paste a UUID" box.
// Receives Claude sessions from the run builder (already sorted most-recent-first server-side),
// filters them like SessionsView's search, and shows the friendly title with
// the opaque id tucked behind an info affordance you can click to copy.
//
// Single or multi select via the `multiple` prop. v-model is a string[] either way (one
// element in single mode) so the caller has one shape to handle.
import { Check, ChevronsUpDown, Copy, Info, Search, X } from '@lucide/vue'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import StatusBadge from '@/components/StatusBadge.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { SessionSummary } from '@/lib/api'
import { baseName, shortId, timeAgo } from '@/lib/format'
import { rankByQuery, sessionSearchFields } from '@/lib/fuzzy'

const props = withDefaults(defineProps<{ multiple?: boolean; sessions?: SessionSummary[] }>(), {
  multiple: false,
  sessions: () => [],
})
const selected = defineModel<string[]>({ default: () => [] })

const { t } = useI18n()

const open = ref(false)
const search = ref('')
const copiedId = ref<string | null>(null)
let copiedTimer: number | undefined

// Same fuzzy match as the sessions sidebar search (lib/fuzzy.ts: title / cwd / id). With no query
// the list keeps its server order (most-recently-active first); with one, the best match sorts
// first and equal scores keep that order.
const filtered = computed(() => {
  const q = search.value.trim()
  if (!q) return props.sessions
  return rankByQuery(props.sessions, q, sessionSearchFields).map((r) => r.row)
})

const byId = computed(() => new Map(props.sessions.map((s) => [s.session_id, s])))
const selectedSessions = computed(() =>
  selected.value.map((id) => byId.value.get(id)).filter((s): s is SessionSummary => !!s),
)

function isSelected(id: string): boolean {
  return selected.value.includes(id)
}

function toggle(id: string) {
  if (props.multiple) {
    selected.value = isSelected(id)
      ? selected.value.filter((x) => x !== id)
      : [...selected.value, id]
  } else {
    selected.value = [id]
    open.value = false
  }
}

function removeChip(id: string) {
  selected.value = selected.value.filter((x) => x !== id)
}

function copyId(id: string, e: Event) {
  e.stopPropagation()
  navigator.clipboard?.writeText(id).catch(() => {})
  copiedId.value = id
  window.clearTimeout(copiedTimer)
  copiedTimer = window.setTimeout(() => {
    copiedId.value = null
  }, 1200)
}

const triggerLabel = computed(() => {
  if (selected.value.length === 0) return t('builder.sessionPickerPlaceholder')
  if (selected.value.length === 1)
    return selectedSessions.value[0]?.title ?? shortId(selected.value[0]!)
  return t('builder.sessionPickerNSelected', { n: selected.value.length })
})
</script>

<template>
  <div class="space-y-1.5">
    <Popover v-model:open="open">
      <PopoverTrigger as-child>
        <Button variant="outline" class="w-full justify-between font-normal" role="combobox">
          <span class="truncate" :class="selected.length ? '' : 'text-muted-foreground'">
            {{ triggerLabel }}
          </span>
          <ChevronsUpDown class="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" class="w-[min(90vw,30rem)] p-0">
        <div class="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search class="size-3.5 shrink-0 text-muted-foreground" />
          <input
            v-model="search"
            :placeholder="$t('builder.sessionPickerSearch')"
            class="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div class="max-h-72 overflow-y-auto p-1">
          <p v-if="filtered.length === 0" class="px-3 py-6 text-center text-xs text-muted-foreground">
            {{ $t('builder.sessionPickerEmpty') }}
          </p>
          <button
            v-for="s in filtered"
            :key="s.session_id"
            type="button"
            class="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-start hover:bg-accent"
            @click="toggle(s.session_id)"
          >
            <Check
              class="mt-0.5 size-3.5 shrink-0"
              :class="isSelected(s.session_id) ? 'opacity-100 text-primary' : 'opacity-0'"
            />
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-1.5">
                <span class="truncate text-xs font-medium">{{ s.title }}</span>
                <StatusBadge v-if="s.queue_status" :status="s.queue_status" />
              </span>
              <span class="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span class="truncate">{{ baseName(s.cwd) }}</span>
                <span v-if="s.git_branch" class="shrink-0">· {{ s.git_branch }}</span>
                <span class="shrink-0">· {{ timeAgo(s.last_activity_at) }}</span>
              </span>
            </span>
            <!-- the opaque id, on demand: hover shows it, click copies it -->
            <span
              class="mt-0.5 flex shrink-0 items-center gap-1 rounded px-1 text-[10px] text-muted-foreground hover:bg-background hover:text-foreground"
              :title="s.session_id"
              @click="copyId(s.session_id, $event)"
            >
              <Copy v-if="copiedId !== s.session_id" class="size-3" />
              <Check v-else class="size-3 text-success" />
              {{ copiedId === s.session_id ? $t('builder.sessionPickerCopied') : shortId(s.session_id) }}
            </span>
          </button>
        </div>
      </PopoverContent>
    </Popover>

    <!-- selected chips (multi): name + info tooltip carrying the id, and a remove X -->
    <div v-if="multiple && selectedSessions.length" class="flex flex-wrap gap-1.5">
      <Badge v-for="s in selectedSessions" :key="s.session_id" variant="secondary" class="gap-1">
        {{ s.title }}
        <button
          type="button"
          class="text-muted-foreground hover:text-foreground"
          :title="s.session_id"
          @click="copyId(s.session_id, $event)"
        >
          <Info class="size-3" />
        </button>
        <button type="button" class="text-muted-foreground hover:text-destructive" @click="removeChip(s.session_id)">
          <X class="size-3" />
        </button>
      </Badge>
    </div>
  </div>
</template>

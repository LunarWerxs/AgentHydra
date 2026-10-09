<script setup lang="ts">
import { computed, getCurrentInstance, onMounted, ref, shallowRef, watch } from 'vue'
import { RefreshCw, CircleCheck, FolderX } from '@lucide/vue'
import { icons } from '@/lib/icons'
import type { GitStatus } from '@shared/protocol'
import { useDesk } from '@/stores/desk'
import { Tip } from '@/components/ui/tooltip'
import { usePaneApi } from './api'
import { finishedTurns, parseUnifiedDiff, sameFolder, statusLetter, type ParsedDiff } from './diff'

// initialPath: a file to open once the status arrives (e.g. the composer's +/- strip).
const props = defineProps<{ cwd: string; initialPath?: string }>()
const emit = defineEmits<{ close: [] }>()
// The close button only shows when the host listens for it.
const closable = !!getCurrentInstance()?.vnode.props?.onClose

const api = usePaneApi()
const desk = useDesk()

// Both are replaced whole, never edited in place: shallow refs keep a big diff's rows out of deep proxies.
const status = shallowRef<GitStatus | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const selectedPath = ref<string | null>(props.initialPath ?? null)
const diff = shallowRef<ParsedDiff | null>(null)
const diffLoading = ref(false)
const diffError = ref<string | null>(null)

const files = computed(() => status.value?.files ?? [])
// Each file's letter, word, name and folder, worked out once per status read.
const fileRows = computed(() =>
  files.value.map((f) => {
    const { letter, word } = statusLetter(f.status)
    return { f, letter, word, name: fileName(f.path), dir: fileDir(f.path) }
  })
)
const selectedFile = computed(() => files.value.find((f) => f.path === selectedPath.value) ?? null)

async function refresh() {
  if (!props.cwd) return
  loading.value = true
  error.value = null
  try {
    status.value = await api.gitStatus(props.cwd)
    const still = selectedPath.value && status.value.files.some((f) => f.path === selectedPath.value)
    if (still) await loadDiff(selectedPath.value!)
    else {
      selectedPath.value = null
      diff.value = null
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

let diffSeq = 0
async function loadDiff(path: string) {
  const mine = ++diffSeq
  diffLoading.value = true
  diffError.value = null
  try {
    const parsed = parseUnifiedDiff(await api.gitDiff(props.cwd, path))
    if (mine === diffSeq) diff.value = parsed
  } catch (e) {
    if (mine !== diffSeq) return
    diff.value = null
    diffError.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (mine === diffSeq) diffLoading.value = false
  }
}

function open(path: string) {
  if (selectedPath.value === path) {
    selectedPath.value = null
    diff.value = null
    diffSeq++
    diffLoading.value = false
    return
  }
  selectedPath.value = path
  diff.value = null
  loadDiff(path)
}

function fileName(path: string) {
  const i = path.replace(/\\/g, '/').lastIndexOf('/')
  return i >= 0 ? path.slice(i + 1) : path
}
function fileDir(path: string) {
  const p = path.replace(/\\/g, '/')
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(0, i) : ''
}

const letterColor: Record<string, string> = {
  M: 'var(--git-mod)',
  A: 'var(--git-add)',
  U: 'var(--git-add)',
  D: 'var(--git-del)',
  R: 'var(--git-merged)',
  C: 'var(--git-merged)',
  '!': 'var(--danger-text)'
}

// Auto-refresh: a chat in this folder whose turn just ended (working/needs_you -> anything else).
let lastStatuses = new Map<string, string>()
// The getter returns a string, so the callback only runs when an id, status or folder really changed.
watch(
  () => desk.chats.value.map((c) => `${c.id}\t${c.status}\t${c.cwd}`).join('\n'),
  () => {
    const now = desk.chats.value
    const next = new Map(now.map((c) => [c.id, c.status] as [string, string]))
    const ended = finishedTurns(lastStatuses, next)
    lastStatuses = next
    if (ended.some((id) => sameFolder(now.find((c) => c.id === id)?.cwd, props.cwd))) refresh()
  },
  { immediate: true }
)

watch(
  () => props.cwd,
  () => {
    status.value = null
    selectedPath.value = null
    diff.value = null
    refresh()
  }
)

onMounted(refresh)
</script>

<template>
  <div class="flex size-full min-w-0 flex-col bg-(--bg-page) text-[13px] leading-[19.5px] text-(--text)">
    <div class="flex h-8 shrink-0 items-center gap-1 ps-3 pe-2">
      <span class="font-medium">Changes</span>
      <Tip v-if="status?.isRepo && status.branch" :label="status.branch">
        <span class="ms-1 flex h-5 min-w-0 items-center gap-1 rounded-(--radius-6) bg-(--fill-secondary) px-1.25 text-[12px] leading-4 text-(--text-2)">
          <component :is="icons.branch" class="size-3 shrink-0" />
          <span class="truncate">{{ status.branch }}</span>
          <span v-if="status.ahead" class="tnum shrink-0 text-(--text-muted)">↑{{ status.ahead }}</span>
          <span v-if="status.behind" class="tnum shrink-0 text-(--text-muted)">↓{{ status.behind }}</span>
        </span>
      </Tip>
      <span class="flex-1" />
      <span v-if="status?.isRepo && files.length" class="tnum me-1 flex shrink-0 gap-1 text-[12px] leading-4">
        <span class="text-(--git-add)">+{{ status.added }}</span>
        <span class="text-(--git-del)">-{{ status.removed }}</span>
      </span>
      <Tip label="Refresh">
        <button
          type="button"
          class="flex size-6 shrink-0 items-center justify-center rounded-(--radius-6) text-(--text-2) transition-colors duration-60 hover:bg-(--fill-hover) hover:text-(--text) focus-visible:shadow-(--focus-ring) focus-visible:outline-none"
          aria-label="Refresh"
          @click="refresh"
        >
          <RefreshCw class="size-4" :class="{ 'animate-spin': loading }" />
        </button>
      </Tip>
      <Tip v-if="closable" label="Close">
        <button
          type="button"
          class="flex size-6 shrink-0 items-center justify-center rounded-(--radius-6) text-(--text-2) transition-colors duration-60 hover:bg-(--fill-hover) hover:text-(--text) focus-visible:shadow-(--focus-ring) focus-visible:outline-none"
          aria-label="Close changes"
          @click="emit('close')"
        >
          <component :is="icons.dismiss" class="size-4" />
        </button>
      </Tip>
    </div>

    <div v-if="error" class="mx-2 mt-1 rounded-(--radius-10) bg-(--danger-bg) px-3 py-2 text-[13px] text-(--danger-text)">
      {{ error }}
    </div>

    <div v-else-if="!status" class="flex flex-1 items-center justify-center text-(--text-muted)">Loading…</div>

    <div v-else-if="!status.isRepo" class="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
      <FolderX class="mb-1 size-6 text-(--text-muted)" />
      <div class="font-medium">Not a git repository</div>
      <div class="break-all text-(--text-muted)">{{ cwd }}</div>
    </div>

    <div v-else-if="files.length === 0" class="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
      <CircleCheck class="mb-1 size-6 text-(--text-muted)" />
      <div class="font-medium">No changes</div>
      <div class="text-(--text-muted)">The working tree matches HEAD.</div>
    </div>

    <template v-else>
      <div class="shrink-0 overflow-y-auto px-2 pb-1" :class="selectedPath ? 'max-h-[40%]' : 'min-h-0 flex-1'">
        <div class="flex h-8.5 items-end pb-1 ps-1.5 text-[12px] leading-4 text-(--text-muted)">
          {{ files.length === 1 ? '1 file changed' : `${files.length} files changed` }}
        </div>
        <Tip v-for="{ f, letter, word, name, dir } in fileRows" :key="f.path" :label="`${word}: ${f.path}`">
          <button
            type="button"
            class="flex h-6.5 w-full items-center gap-1 rounded-(--radius-6) px-0.5 text-start transition-colors duration-60 hover:bg-(--fill-hover) focus-visible:shadow-(--focus-ring) focus-visible:outline-none"
            :class="{ 'bg-(--fill-selected) hover:bg-(--fill-selected)': f.path === selectedPath }"
            :aria-pressed="f.path === selectedPath"
            @click="open(f.path)"
          >
            <span
              class="flex size-6 shrink-0 items-center justify-center text-[12px] font-semibold leading-4"
              :style="{ color: letterColor[letter] ?? 'var(--text-muted)' }"
            >{{ letter }}</span>
            <span class="min-w-0 flex-1 truncate">
              <span>{{ name }}</span>
              <span v-if="dir" class="ms-1.5 text-[12px] text-(--text-muted)">{{ dir }}</span>
            </span>
            <span class="tnum flex shrink-0 gap-1 pe-1.5 text-[12px] leading-4">
              <span v-if="f.added" class="text-(--git-add)">+{{ f.added }}</span>
              <span v-if="f.removed" class="text-(--git-del)">-{{ f.removed }}</span>
            </span>
          </button>
        </Tip>
      </div>

      <div v-if="selectedPath" class="min-h-0 flex-1 overflow-auto border-t border-(--border)">
        <div class="sticky top-0 z-10 flex h-8 items-center gap-1.5 bg-(--bg-page) ps-3 pe-2 shadow-[inset_0_-1px_0_var(--border)]">
          <Tip :label="selectedPath"><span class="min-w-0 flex-1 truncate text-(--text-2)">{{ selectedPath }}</span></Tip>
          <span v-if="selectedFile" class="tnum flex shrink-0 gap-1 text-[12px] leading-4">
            <span v-if="selectedFile.added" class="text-(--git-add)">+{{ selectedFile.added }}</span>
            <span v-if="selectedFile.removed" class="text-(--git-del)">-{{ selectedFile.removed }}</span>
          </span>
          <Tip label="Close diff">
          <button
            type="button"
            class="flex size-6 shrink-0 items-center justify-center rounded-(--radius-6) text-(--text-2) transition-colors duration-60 hover:bg-(--fill-hover) hover:text-(--text)"
            aria-label="Close diff"
            @click="open(selectedPath)"
          >
            <component :is="icons.dismiss" class="size-4" />
          </button>
          </Tip>
        </div>
        <div v-if="diffLoading && !diff" class="px-3 py-1.5 text-(--text-muted)">Loading diff…</div>
        <div v-else-if="diffError" class="px-3 py-1.5 text-(--danger-text)">{{ diffError }}</div>
        <div v-else-if="diff && diff.rows.length === 0" class="px-3 py-1.5 text-(--text-muted)">No textual changes.</div>
        <table v-else-if="diff" class="w-full border-collapse font-mono text-[13px] leading-4.75 [font-feature-settings:'calt'_0,'liga'_0]">
          <tbody>
            <tr
              v-for="(row, i) in diff.rows"
              :key="i"
              :class="{
                'bg-[color-mix(in_srgb,var(--git-add)_20%,transparent)]': row.kind === 'add',
                'bg-[color-mix(in_srgb,var(--git-del)_20%,transparent)]': row.kind === 'del',
                'bg-(--fill-5)': row.kind === 'hunk'
              }"
            >
              <template v-if="row.kind === 'hunk' || row.kind === 'note'">
                <td colspan="3" class="whitespace-pre px-3 py-1.5 text-(--text-muted)" :class="{ italic: row.kind === 'note' }">{{ row.text }}</td>
              </template>
              <template v-else>
                <td class="w-[1%] min-w-9 select-none whitespace-nowrap ps-3 pe-1.5 text-end align-top text-(--text-muted)">{{ row.oldNo ?? '' }}</td>
                <td class="w-[1%] min-w-9 select-none whitespace-nowrap ps-1.5 pe-3 text-end align-top text-(--text-muted)">{{ row.newNo ?? '' }}</td>
                <td class="whitespace-pre pe-3"><span class="inline-block w-4 select-none" :class="row.kind === 'add' ? 'text-(--git-add)' : row.kind === 'del' ? 'text-(--git-del)' : 'text-(--text-muted)'">{{ row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' ' }}</span>{{ row.text }}</td>
              </template>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

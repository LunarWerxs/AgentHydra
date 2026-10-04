<script setup lang="ts">
import { computed, getCurrentInstance, onMounted, ref, watch } from 'vue'
import { RefreshCw, CircleCheck, FolderX } from '@lucide/vue'
import { icons } from '@/lib/icons'
import type { GitStatus } from '@shared/protocol'
import { useDesk } from '@/stores/desk'
import { usePaneApi } from './api'
import { finishedTurns, parseUnifiedDiff, sameFolder, statusLetter, type ParsedDiff } from './diff'

// initialPath: a file to open once the status arrives (e.g. the composer's +/- strip).
const props = defineProps<{ cwd: string; initialPath?: string }>()
const emit = defineEmits<{ close: [] }>()
// The close button only shows when the host listens for it.
const closable = !!getCurrentInstance()?.vnode.props?.onClose

const api = usePaneApi()
const desk = useDesk()

const status = ref<GitStatus | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const selectedPath = ref<string | null>(props.initialPath ?? null)
const diff = ref<ParsedDiff | null>(null)
const diffLoading = ref(false)
const diffError = ref<string | null>(null)

const files = computed(() => status.value?.files ?? [])
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

async function loadDiff(path: string) {
  diffLoading.value = true
  diffError.value = null
  try {
    diff.value = parseUnifiedDiff(await api.gitDiff(props.cwd, path))
  } catch (e) {
    diff.value = null
    diffError.value = e instanceof Error ? e.message : String(e)
  } finally {
    diffLoading.value = false
  }
}

function open(path: string) {
  if (selectedPath.value === path) {
    selectedPath.value = null
    diff.value = null
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
watch(
  () => desk.chats.value.map((c) => [c.id, c.status, c.cwd] as const),
  (now) => {
    const next = new Map(now.map(([id, s]) => [id, s] as [string, string]))
    const ended = finishedTurns(lastStatuses, next)
    lastStatuses = next
    if (ended.some((id) => sameFolder(now.find(([cid]) => cid === id)?.[2], props.cwd))) refresh()
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
  <div class="flex h-full w-full min-w-0 flex-col bg-[var(--bg-page)] text-[13px] leading-[19.5px] text-[var(--text)]">
    <div class="flex h-8 shrink-0 items-center gap-1 pl-3 pr-2">
      <span class="font-medium">Changes</span>
      <span
        v-if="status?.isRepo && status.branch"
        class="ml-1 flex h-5 min-w-0 items-center gap-1 rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-[5px] text-[12px] leading-4 text-[var(--text-2)]"
        :title="status.branch"
      >
        <component :is="icons.branch" class="size-3 shrink-0" />
        <span class="truncate">{{ status.branch }}</span>
        <span v-if="status.ahead" class="tnum shrink-0 text-[var(--text-muted)]">↑{{ status.ahead }}</span>
        <span v-if="status.behind" class="tnum shrink-0 text-[var(--text-muted)]">↓{{ status.behind }}</span>
      </span>
      <span class="flex-1" />
      <span v-if="status?.isRepo && files.length" class="tnum mr-1 flex shrink-0 gap-1 text-[12px] leading-4">
        <span class="text-[var(--git-add)]">+{{ status.added }}</span>
        <span class="text-[var(--git-del)]">-{{ status.removed }}</span>
      </span>
      <button
        type="button"
        class="flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-6)] text-[var(--text-2)] transition-colors duration-[60ms] hover:bg-[var(--fill-hover)] hover:text-[var(--text)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
        title="Refresh"
        aria-label="Refresh"
        @click="refresh"
      >
        <RefreshCw class="size-4" :class="{ 'animate-spin': loading }" />
      </button>
      <button
        v-if="closable"
        type="button"
        class="flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-6)] text-[var(--text-2)] transition-colors duration-[60ms] hover:bg-[var(--fill-hover)] hover:text-[var(--text)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
        title="Close"
        aria-label="Close changes"
        @click="emit('close')"
      >
        <component :is="icons.dismiss" class="size-4" />
      </button>
    </div>

    <div v-if="error" class="mx-2 mt-1 rounded-[var(--radius-10)] bg-[var(--danger-bg)] px-3 py-2 text-[13px] text-[var(--danger-text)]">
      {{ error }}
    </div>

    <div v-else-if="!status" class="flex flex-1 items-center justify-center text-[var(--text-muted)]">Loading…</div>

    <div v-else-if="!status.isRepo" class="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
      <FolderX class="mb-1 size-6 text-[var(--text-muted)]" />
      <div class="font-medium">Not a git repository</div>
      <div class="break-all text-[var(--text-muted)]">{{ cwd }}</div>
    </div>

    <div v-else-if="files.length === 0" class="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
      <CircleCheck class="mb-1 size-6 text-[var(--text-muted)]" />
      <div class="font-medium">No changes</div>
      <div class="text-[var(--text-muted)]">The working tree matches HEAD.</div>
    </div>

    <template v-else>
      <div class="shrink-0 overflow-y-auto px-2 pb-1" :class="selectedPath ? 'max-h-[40%]' : 'min-h-0 flex-1'">
        <div class="flex h-[34px] items-end pb-1 pl-1.5 text-[12px] leading-4 text-[var(--text-muted)]">
          {{ files.length === 1 ? '1 file changed' : `${files.length} files changed` }}
        </div>
        <button
          v-for="f in files"
          :key="f.path"
          type="button"
          class="flex h-[26px] w-full items-center gap-1 rounded-[var(--radius-6)] px-0.5 text-left transition-colors duration-[60ms] hover:bg-[var(--fill-hover)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
          :class="{ 'bg-[var(--fill-selected)] hover:bg-[var(--fill-selected)]': f.path === selectedPath }"
          :aria-pressed="f.path === selectedPath"
          :title="`${statusLetter(f.status).word}: ${f.path}`"
          @click="open(f.path)"
        >
          <span
            class="flex size-6 shrink-0 items-center justify-center text-[12px] font-semibold leading-4"
            :style="{ color: letterColor[statusLetter(f.status).letter] ?? 'var(--text-muted)' }"
          >{{ statusLetter(f.status).letter }}</span>
          <span class="min-w-0 flex-1 truncate">
            <span>{{ fileName(f.path) }}</span>
            <span v-if="fileDir(f.path)" class="ml-1.5 text-[12px] text-[var(--text-muted)]">{{ fileDir(f.path) }}</span>
          </span>
          <span class="tnum flex shrink-0 gap-1 pr-1.5 text-[12px] leading-4">
            <span v-if="f.added" class="text-[var(--git-add)]">+{{ f.added }}</span>
            <span v-if="f.removed" class="text-[var(--git-del)]">-{{ f.removed }}</span>
          </span>
        </button>
      </div>

      <div v-if="selectedPath" class="min-h-0 flex-1 overflow-auto border-t border-[var(--border)]">
        <div class="sticky top-0 z-10 flex h-8 items-center gap-1.5 bg-[var(--bg-page)] pl-3 pr-2 shadow-[inset_0_-1px_0_var(--border)]">
          <span class="min-w-0 flex-1 truncate text-[var(--text-2)]" :title="selectedPath">{{ selectedPath }}</span>
          <span v-if="selectedFile" class="tnum flex shrink-0 gap-1 text-[12px] leading-4">
            <span v-if="selectedFile.added" class="text-[var(--git-add)]">+{{ selectedFile.added }}</span>
            <span v-if="selectedFile.removed" class="text-[var(--git-del)]">-{{ selectedFile.removed }}</span>
          </span>
          <button
            type="button"
            class="flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-6)] text-[var(--text-2)] transition-colors duration-[60ms] hover:bg-[var(--fill-hover)] hover:text-[var(--text)]"
            title="Close diff"
            aria-label="Close diff"
            @click="open(selectedPath)"
          >
            <component :is="icons.dismiss" class="size-4" />
          </button>
        </div>
        <div v-if="diffLoading && !diff" class="px-3 py-1.5 text-[var(--text-muted)]">Loading diff…</div>
        <div v-else-if="diffError" class="px-3 py-1.5 text-[var(--danger-text)]">{{ diffError }}</div>
        <div v-else-if="diff && diff.rows.length === 0" class="px-3 py-1.5 text-[var(--text-muted)]">No textual changes.</div>
        <table v-else-if="diff" class="w-full border-collapse font-mono text-[13px] leading-[19px] [font-feature-settings:'calt'_0,'liga'_0]">
          <tbody>
            <tr
              v-for="(row, i) in diff.rows"
              :key="i"
              :class="{
                'bg-[color-mix(in_srgb,var(--git-add)_20%,transparent)]': row.kind === 'add',
                'bg-[color-mix(in_srgb,var(--git-del)_20%,transparent)]': row.kind === 'del',
                'bg-[var(--fill-5)]': row.kind === 'hunk'
              }"
            >
              <template v-if="row.kind === 'hunk' || row.kind === 'note'">
                <td colspan="3" class="whitespace-pre px-3 py-1.5 text-[var(--text-muted)]" :class="{ italic: row.kind === 'note' }">{{ row.text }}</td>
              </template>
              <template v-else>
                <td class="w-[1%] min-w-9 select-none whitespace-nowrap pl-3 pr-1.5 text-right align-top text-[var(--text-muted)]">{{ row.oldNo ?? '' }}</td>
                <td class="w-[1%] min-w-9 select-none whitespace-nowrap pl-1.5 pr-3 text-right align-top text-[var(--text-muted)]">{{ row.newNo ?? '' }}</td>
                <td class="whitespace-pre pr-3"><span class="inline-block w-4 select-none" :class="row.kind === 'add' ? 'text-[var(--git-add)]' : row.kind === 'del' ? 'text-[var(--git-del)]' : 'text-[var(--text-muted)]'">{{ row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' ' }}</span>{{ row.text }}</td>
              </template>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { tab } from '@/components/servers/styles'
import { changesTabFor, showChangesSwitch } from '@/components/connectors/logic'
import { changesTab, repoYeti, setChangesTab, watchRepoYeti } from '@/components/connectors/repoyeti-state'
import type { MergeConflictPreview } from '@shared/protocol'
import DiffPane from './DiffPane.vue'
import RepoYetiPane from '@/components/connectors/RepoYetiPane.vue'
import { loadMergePreview, mergePreviewLine } from './merge-preview'

// The one Changes tab: the diff, or RepoYeti (the git app), chosen by a small switch at its top. The choice is the
// Desk's, remembered in this browser. With the RepoYeti connector off in Settings the switch is gone and this is plain Changes.
const props = defineProps<{ cwd: string }>()
const emit = defineEmits<{ close: [] }>()

const switchShown = computed(() => showChangesSwitch(repoYeti.value))
const side = computed(() => changesTabFor(changesTab.value, repoYeti.value))

// Asked on a timer, not per status poll: the answer moves only when HEAD or the base does, and the server caches it.
const PREVIEW_MS = 15_000
const preview = ref<MergeConflictPreview | null>(null)
const previewLine = computed(() => (preview.value ? mergePreviewLine(preview.value) : null))
let previewTimer: ReturnType<typeof setInterval> | null = null
async function refreshPreview() {
  const cwd = props.cwd
  const next = await loadMergePreview(cwd)
  // A folder's answer that lands after the pane moved on to another folder is dropped.
  if (cwd === props.cwd) preview.value = next
}
watch(
  () => props.cwd,
  () => {
    preview.value = null
    refreshPreview()
  },
)

let stop: (() => void) | null = null
onMounted(() => {
  stop = watchRepoYeti()
  refreshPreview()
  previewTimer = setInterval(refreshPreview, PREVIEW_MS)
})
onBeforeUnmount(() => {
  stop?.()
  if (previewTimer) clearInterval(previewTimer)
})
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1 flex-col">
    <div v-if="switchShown" class="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2" role="tablist" aria-label="Changes or RepoYeti">
      <button type="button" role="tab" :class="tab(side === 'changes')" :aria-selected="side === 'changes'" @click="setChangesTab('changes')">Changes</button>
      <button type="button" role="tab" :class="tab(side === 'repoyeti')" :aria-selected="side === 'repoyeti'" @click="setChangesTab('repoyeti')">RepoYeti</button>
    </div>
    <RepoYetiPane v-if="side === 'repoyeti'" :cwd="cwd" @close="emit('close')" />
    <template v-else>
      <div v-if="previewLine" class="shrink-0 truncate border-b border-border px-3 py-1.5 text-[12px] text-(--text-muted)" :title="previewLine">{{ previewLine }}</div>
      <DiffPane :cwd="cwd" />
    </template>
  </div>
</template>

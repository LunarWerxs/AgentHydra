<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { tab } from '@/components/servers/styles'
import { changesTabFor, showChangesSwitch } from '@/components/connectors/logic'
import { changesTab, repoYeti, setChangesTab, watchRepoYeti } from '@/components/connectors/repoyeti-state'
import DiffPane from './DiffPane.vue'
import RepoYetiPane from '@/components/connectors/RepoYetiPane.vue'

// The one Changes tab: the diff, or RepoYeti (the git app), chosen by a small switch at its top. The choice is the
// Desk's, remembered in this browser. With the RepoYeti connector off in Settings the switch is gone and this is plain Changes.
defineProps<{ cwd: string }>()
const emit = defineEmits<{ close: [] }>()

const switchShown = computed(() => showChangesSwitch(repoYeti.value))
const side = computed(() => changesTabFor(changesTab.value, repoYeti.value))

let stop: (() => void) | null = null
onMounted(() => (stop = watchRepoYeti()))
onBeforeUnmount(() => stop?.())
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1 flex-col">
    <div v-if="switchShown" class="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2" role="tablist" aria-label="Changes or RepoYeti">
      <button type="button" role="tab" :class="tab(side === 'changes')" :aria-selected="side === 'changes'" @click="setChangesTab('changes')">Changes</button>
      <button type="button" role="tab" :class="tab(side === 'repoyeti')" :aria-selected="side === 'repoyeti'" @click="setChangesTab('repoyeti')">RepoYeti</button>
    </div>
    <RepoYetiPane v-if="side === 'repoyeti'" :cwd="cwd" @close="emit('close')" />
    <DiffPane v-else :cwd="cwd" />
  </div>
</template>

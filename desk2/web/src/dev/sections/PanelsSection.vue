<script setup lang="ts">
import { ref } from 'vue'
import {
  chatFixtures,
  accountFixtures,
  cliMayteWorkerFixtures,
  externalSessionFixtures,
  settingsFixtures
} from '../fixtures'
import CliMaytePanel from '@/components/climayte/CliMaytePanel.vue'
import ExternalSessionList from '@/components/external/ExternalSessionList.vue'
import ExternalSessionView from '@/components/external/ExternalSessionView.vue'

const mockChats = ref(chatFixtures)
const mockExternal = ref(externalSessionFixtures)
const mockWorkers = ref(cliMayteWorkerFixtures)
const mockAccounts = ref(accountFixtures)
const mockSettings = ref(settingsFixtures)
const mockSelected = ref({ kind: 'chat', id: chatFixtures[0]?.id || '' })
</script>

<template>
  <div class="space-y-8">
    <!-- CliMayte Panel -->
    <div class="space-y-2">
      <h3 class="text-sm font-semibold text-[var(--text)]">CliMayte Panel</h3>
      <div class="h-96 border border-[var(--border)] rounded overflow-hidden">
        <CliMaytePanel :origin-session-id="mockChats[0]?.id" />
      </div>
    </div>

    <!-- External Session List -->
    <div class="space-y-2">
      <h3 class="text-sm font-semibold text-[var(--text)]">External Session List</h3>
      <div class="h-96 border border-[var(--border)] rounded overflow-hidden">
        <ExternalSessionList />
      </div>
    </div>

    <!-- External Session View -->
    <div class="space-y-2">
      <h3 class="text-sm font-semibold text-[var(--text)]">External Session View</h3>
      <div v-if="mockExternal.length > 0" class="h-96 border border-[var(--border)] rounded overflow-hidden">
        <ExternalSessionView :session-id="mockExternal[0].id" />
      </div>
      <div v-else class="h-96 border border-[var(--border)] rounded flex items-center justify-center text-[var(--text-muted)]">
        No sessions available
      </div>
    </div>
  </div>
</template>

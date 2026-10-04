<script setup lang="ts">
import { ref } from 'vue'
import { chatFixtures, accountFixtures } from '../fixtures'
import App from '@/App.vue'

// Mock the store
const mockStore = {
  chats: ref(chatFixtures),
  itemsByChat: ref(new Map()),
  external: ref([]),
  workers: ref([]),
  accounts: ref(accountFixtures),
  settings: ref({
    defaultModel: null,
    defaultEffort: 'medium',
    defaultPermissionMode: 'acceptEdits',
    defaultAccountId: 'auto',
    delegateToCliMayte: true,
    idleCloseMinutes: 30,
    notifications: true
  }),
  connected: ref(true),
  selected: ref({ kind: 'chat', id: chatFixtures[0].id })
}
</script>

<template>
  <div class="h-96 border border-[var(--border)] rounded overflow-hidden">
    <div class="flex h-full bg-[var(--bg-page)]">
      <!-- Shell preview would go here -->
      <div class="flex-1 flex items-center justify-center text-[var(--text-muted)]">
        <p>App.vue shell layout preview</p>
      </div>
    </div>
  </div>
</template>

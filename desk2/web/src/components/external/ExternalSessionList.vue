<script setup lang="ts">
import { computed, ref } from 'vue'
import { icons } from '@/lib/icons'

const Search = icons.search
import type { ExternalSession } from '@shared/protocol'
import { useDesk } from '@/stores/desk'

const desk = useDesk()
const searchQuery = ref('')

const sortedSessions = computed(() => {
  const sessions = desk.external.value
  const sorted = [...sessions].sort((a, b) => {
    if (a.status === 'working' && b.status !== 'working') return -1
    if (a.status !== 'working' && b.status === 'working') return 1
    if (a.status === 'needs_you' && b.status !== 'needs_you') return -1
    if (a.status !== 'needs_you' && b.status === 'needs_you') return 1
    const aTime = a.lastActivityAt ?? 0
    const bTime = b.lastActivityAt ?? 0
    return bTime - aTime
  })
  // Each row's relative time is worked out here, once per update of the list, not once per render.
  return sorted.map((session) => ({ session, time: session.lastActivityAt ? formatTime(session.lastActivityAt) : '' }))
})

const filteredSessions = computed(() => {
  if (!searchQuery.value) return sortedSessions.value
  const query = searchQuery.value.toLowerCase()
  return sortedSessions.value.filter(({ session: s }) =>
    s.title.toLowerCase().includes(query) ||
    (s.cwd && s.cwd.toLowerCase().includes(query))
  )
})

const workingCount = computed(() => {
  return desk.external.value.filter((s) => s.status === 'working').length
})

const sourceIcon = (source: string): string => {
  switch (source) {
    case 'desktop':
      return '🖥️'
    case 'cli':
      return '⌨️'
    case 'climayte':
      return '⚙️'
    case 'codex':
      return '🔮'
    default:
      return '•'
  }
}

const statusColor = (status: string): string => {
  switch (status) {
    case 'working':
      return 'text-[var(--brand)]'
    case 'needs_you':
      return 'text-[var(--warning-text)]'
    case 'idle':
      return 'text-[var(--text-muted)]'
    case 'stale':
      return 'text-[var(--danger-text)]'
    default:
      return 'text-[var(--text-muted)]'
  }
}

const formatTime = (time: number | null): string => {
  if (!time) return 'Never'
  const elapsed = Date.now() - time
  const minutes = Math.floor(elapsed / 60000)
  const hours = Math.floor(elapsed / 3600000)
  const days = Math.floor(elapsed / 86400000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  return `${days}d ago`
}

const selectSession = (session: ExternalSession) => {
  desk.select({ kind: 'external', id: session.id })
}
</script>

<template>
  <div class="flex flex-col h-full bg-[var(--bg-page)]">
    <!-- Header -->
    <div class="px-4 py-3 border-b border-[var(--border)]">
      <div class="flex items-center gap-2 mb-2">
        <h2 class="text-[13px] font-medium">Elsewhere</h2>
        <span v-if="workingCount > 0" class="rounded-[var(--radius-4)] bg-[var(--fill-secondary)] px-1 text-[11px] leading-4 text-[var(--text-2)]">
          {{ workingCount }} working
        </span>
      </div>
      <div class="relative">
        <Search class="absolute left-2.5 top-2.5 w-4 h-4 text-[var(--text-muted)]" />
        <input
          v-model="searchQuery"
          type="text"
          placeholder="Search sessions..."
          class="w-full pl-8 pr-3 py-1.5 bg-[var(--fill-5)] rounded-[var(--radius-6)] text-[13px] text-[var(--text)] shadow-[inset_0_0_0_1px_var(--border)] placeholder:text-[var(--text-muted)] focus:outline-none focus:shadow-[var(--shadow-composer-focus)]"
        />
      </div>
    </div>

    <!-- Sessions list -->
    <div class="flex-1 overflow-y-auto">
      <div v-if="filteredSessions.length > 0">
        <div
          v-for="{ session, time } in filteredSessions"
          :key="session.id"
          class="px-4 py-3 border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--fill-hover)] cursor-pointer"
          @click="selectSession(session)"
        >
          <!-- Title with status -->
          <div class="flex items-center gap-2 mb-1">
            <span class="text-[13px] font-medium truncate">{{ session.title }}</span>
            <span :class="statusColor(session.status)" class="text-[12px] font-medium whitespace-nowrap">
              {{ session.status }}
            </span>
          </div>

          <!-- Metadata row -->
          <div class="flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
            <span v-if="session.source" class="shrink-0">{{ sourceIcon(session.source) }}</span>
            <span v-if="session.instance" class="shrink-0">{{ session.instance }}</span>
            <span v-if="session.cwd" class="truncate text-[var(--text-muted)]">{{ session.cwd }}</span>
          </div>

          <!-- Activity and time -->
          <div class="flex items-center gap-2 text-[12px] text-[var(--text-muted)] mt-1">
            <span v-if="session.activity" class="truncate">{{ session.activity }}</span>
            <span v-if="session.lastActivityAt" class="shrink-0">{{ time }}</span>
          </div>
        </div>
      </div>

      <!-- Empty state -->
      <div v-else class="flex items-center justify-center h-full text-[var(--text-muted)]">
        <div class="text-center">
          <p class="text-[13px] font-medium">{{ searchQuery ? 'No sessions found' : 'No sessions' }}</p>
          <p class="text-[12px]">{{ searchQuery ? 'Try a different search' : 'No Claude Desktop, CLI, or other sessions running elsewhere' }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

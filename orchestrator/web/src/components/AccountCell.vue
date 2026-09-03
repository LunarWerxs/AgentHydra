<script setup lang="ts">
import type { ChatAccount } from '@/lib/api'

defineProps<{ account: ChatAccount | null; instance: string | null }>()
</script>

<template>
  <div v-if="!account">
    <div>{{ instance ?? '—' }}</div>
    <div class="text-[11px] text-muted-foreground">account unknown</div>
  </div>
  <div v-else>
    <div>{{ instance }} <span v-if="account.appRunning">🟢</span></div>
    <div class="text-[11px] text-muted-foreground">{{ account.email ?? '?' }} · {{ account.plan ?? 'plan?' }}</div>
  </div>
</template>

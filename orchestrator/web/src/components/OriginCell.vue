<script setup lang="ts">
defineProps<{ chat: { origin: 'desktop' | 'console'; sourceTool: string | null } }>()
</script>

<template>
  <div v-if="chat.origin === 'desktop'">
    <span class="inline-flex items-center gap-1 text-xs font-medium">🖥 desktop</span>
    <div class="text-[11px] text-muted-foreground">stays in the desktop</div>
  </div>
  <div v-else>
    <span class="inline-flex items-center gap-1 text-xs font-medium">⌨ console</span>
    <div class="text-[11px] text-muted-foreground">{{ chat.sourceTool ?? '' }} — never landed in the app</div>
  </div>
</template>

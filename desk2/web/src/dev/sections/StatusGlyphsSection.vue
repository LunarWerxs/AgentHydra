<script setup lang="ts">
import { glyphDotClass, statusGlyph } from '@/components/sidebar/logic'
import { chatFixtures } from '../fixtures'
</script>

<template>
  <div class="space-y-4">
    <div class="grid grid-cols-2 gap-4">
      <div
        v-for="chat in chatFixtures.slice(0, 8)"
        :key="chat.id"
        class="flex items-center gap-3 p-3 rounded border border-[var(--border)] bg-[var(--bg-popover)]"
      >
        <span class="flex size-[14px] shrink-0 items-center justify-center">
          <span class="size-1.5 rounded-full" :class="glyphDotClass(statusGlyph(chat))" />
        </span>

        <!-- Title -->
        <div class="flex-1 min-w-0">
          <p class="text-sm truncate">{{ chat.title }}</p>
          <p class="text-xs text-[var(--text-muted)]">{{ chat.status }}{{ chat.unread ? ' · unread' : '' }} · {{ statusGlyph(chat).label }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

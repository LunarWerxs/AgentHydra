<script setup lang="ts">
// The `?` sheet. Generated from the live registry (composables/useShortcuts.ts), never from a
// hand-written list, so it always describes what is actually bound on the view you are looking at.
import { computed } from 'vue'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { displayKeys, useShortcutSheet } from '@/composables/useShortcuts'

const { shortcuts, open } = useShortcutSheet()

/** Grouped in registration order, so the shell's global bindings lead and a view's own follow. */
const groups = computed(() => {
  const out = new Map<string, typeof shortcuts.value>()
  for (const s of shortcuts.value) {
    const list = out.get(s.groupKey) ?? []
    list.push(s)
    out.set(s.groupKey, list)
  }
  return [...out.entries()]
})
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-w-md">
      <DialogHeader>
        <DialogTitle>{{ $t('app.shortcutsTitle') }}</DialogTitle>
        <DialogDescription>{{ $t('app.shortcutsHint') }}</DialogDescription>
      </DialogHeader>
      <div v-if="!shortcuts.length" class="text-xs text-muted-foreground">
        {{ $t('app.shortcutsNone') }}
      </div>
      <div v-for="[groupKey, list] in groups" :key="groupKey" class="space-y-1">
        <p class="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {{ $t(groupKey) }}
        </p>
        <div
          v-for="s in list"
          :key="s.keys"
          class="flex items-center justify-between gap-4 text-sm"
        >
          <span class="min-w-0 flex-1">{{ $t(s.labelKey) }}</span>
          <kbd
            class="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px]"
          >{{ displayKeys(s.keys) }}</kbd>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

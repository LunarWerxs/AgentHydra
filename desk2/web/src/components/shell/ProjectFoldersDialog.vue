<script setup lang="ts">
import { computed } from 'vue'
import type { ProjectChoiceKind, ProjectChoices } from '@shared/protocol'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useShellSource } from './source'

// The folders the New screen's grid is built from, each with the one action that takes it off again: Remove for a
// folder or a folder of projects, Unhide for a hidden project.
const props = defineProps<{ open: boolean; choices: ProjectChoices }>()
const emit = defineEmits<{ 'update:open': [open: boolean]; changed: []; failed: [message: string] }>()
const src = useShellSource()

const sections = computed(() => [
  { kind: 'folders' as const, title: 'Folders', hint: 'Each one is a tile on the New screen.', paths: props.choices.folders, action: 'Remove' },
  { kind: 'roots' as const, title: 'Folders of projects', hint: 'Each folder directly inside one is a tile.', paths: props.choices.roots, action: 'Remove' },
  { kind: 'hidden' as const, title: 'Hidden', hint: 'Taken off the New screen; Unhide puts it back.', paths: props.choices.hidden, action: 'Unhide' },
])

async function release(kind: ProjectChoiceKind, path: string): Promise<void> {
  try {
    await src.changeProjectChoice?.(kind, path, false)
    emit('changed')
  } catch (err) {
    emit('failed', err instanceof Error ? err.message : String(err))
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="(o: boolean) => emit('update:open', o)">
    <DialogContent :show-close-button="false" class="max-h-[80vh] gap-3 overflow-y-auto rounded-(--radius-12) p-4 shadow-(--shadow-popover) ring-0 sm:max-w-120">
      <DialogTitle class="text-[14px] font-semibold leading-5 text-text">Manage folders</DialogTitle>
      <DialogDescription class="sr-only">The folders and hidden projects the New screen shows, each with its action.</DialogDescription>
      <section v-for="section in sections" :key="section.kind" class="flex flex-col gap-1.5">
        <h2 class="text-[12px] font-semibold leading-4 text-text-2">{{ section.title }}</h2>
        <p class="text-[11px] leading-4 text-text-muted">{{ section.hint }}</p>
        <p v-if="!section.paths.length" class="text-[12px] leading-4 text-text-muted">None.</p>
        <ul v-else class="flex flex-col gap-1">
          <li v-for="path in section.paths" :key="path" class="flex min-w-0 items-center gap-2 rounded-(--radius-6) bg-fill-5 px-2 py-1">
            <span class="min-w-0 flex-1 truncate text-[12px] leading-4 text-text" :title="path">{{ path }}</span>
            <button type="button" class="h-6 shrink-0 rounded-(--radius-6) bg-(--fill-secondary) px-2 text-[12px] text-text hover:bg-(--fill-secondary-hover)" @click="release(section.kind, path)">{{ section.action }}</button>
          </li>
        </ul>
      </section>
    </DialogContent>
  </Dialog>
</template>

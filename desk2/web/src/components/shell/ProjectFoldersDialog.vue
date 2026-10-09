<script setup lang="ts">
import { computed } from 'vue'
import type { ProjectChoiceKind, ProjectChoices, ProjectEntry } from '@shared/protocol'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Tip } from '@/components/ui/tooltip'
import { projectSourceGroups } from './projects'
import { useShellSource } from './source'

// The folders the New screen's grid is built from, each with the one action that takes it off again: Remove for a
// folder or a folder of projects, Unhide for a hidden project. The automatic sources list what the grid found on its
// own, each with Hide.
const props = defineProps<{ open: boolean; choices: ProjectChoices; projects: ProjectEntry[] }>()
const emit = defineEmits<{ 'update:open': [open: boolean]; changed: []; failed: [message: string] }>()
const src = useShellSource()

const sections = computed(() => [
  { kind: 'folders' as const, title: 'Folders', hint: 'Each one is a tile on the New screen.', paths: props.choices.folders, action: 'Remove' },
  { kind: 'roots' as const, title: 'Folders of projects', hint: 'Each folder directly inside one is a tile.', paths: props.choices.roots, action: 'Remove' },
  { kind: 'hidden' as const, title: 'Hidden', hint: 'Taken off the New screen; Unhide puts it back.', paths: props.choices.hidden, action: 'Unhide' },
])

const groups = computed(() => projectSourceGroups(props.projects))
const sourceSections = computed(() => [
  { title: 'From Project Hydra', hint: "Projects in Project Hydra's registry. Hide one to take it off the New screen.", items: groups.value.hydra },
  { title: 'From your chats', hint: 'Folders you have chatted in.', items: groups.value.chats },
])

async function setChoice(kind: ProjectChoiceKind, path: string, on: boolean): Promise<void> {
  try {
    await src.changeProjectChoice?.(kind, path, on)
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
      <DialogDescription class="sr-only">The folders the New screen shows, its hidden projects, and the projects it found on its own, each with its action.</DialogDescription>
      <section v-for="section in sourceSections" :key="section.title" class="flex flex-col gap-1.5">
        <h2 class="text-[12px] font-semibold leading-4 text-text-2">{{ section.title }} <span class="font-normal text-text-muted">{{ section.items.length }}</span></h2>
        <p class="text-[11px] leading-4 text-text-muted">{{ section.hint }}</p>
        <p v-if="!section.items.length" class="text-[12px] leading-4 text-text-muted">None yet.</p>
        <details v-else :open="section.items.length <= 5">
          <summary class="cursor-pointer text-[12px] leading-4 text-text-2">Show list</summary>
          <ul class="mt-1 flex flex-col gap-1">
            <li v-for="p in section.items" :key="p.path" class="flex min-w-0 items-center gap-2 rounded-(--radius-6) bg-fill-5 px-2 py-1">
              <span class="min-w-0 flex-1">
                <span class="block truncate text-[12px] leading-4 text-text">{{ p.name }}</span>
                <Tip :label="p.path">
                  <span class="block truncate text-[11px] leading-4 text-text-muted">{{ p.path }}</span>
                </Tip>
              </span>
              <button type="button" class="h-6 shrink-0 rounded-(--radius-6) bg-(--fill-secondary) px-2 text-[12px] text-text hover:bg-(--fill-secondary-hover)" @click="setChoice('hidden', p.path, true)">Hide</button>
            </li>
          </ul>
        </details>
      </section>
      <section v-for="section in sections" :key="section.kind" class="flex flex-col gap-1.5">
        <h2 class="text-[12px] font-semibold leading-4 text-text-2">{{ section.title }}</h2>
        <p class="text-[11px] leading-4 text-text-muted">{{ section.hint }}</p>
        <p v-if="!section.paths.length" class="text-[12px] leading-4 text-text-muted">None yet.</p>
        <ul v-else class="flex flex-col gap-1">
          <li v-for="path in section.paths" :key="path" class="flex min-w-0 items-center gap-2 rounded-(--radius-6) bg-fill-5 px-2 py-1">
            <Tip :label="path">
              <span class="min-w-0 flex-1 truncate text-[12px] leading-4 text-text">{{ path }}</span>
            </Tip>
            <button type="button" class="h-6 shrink-0 rounded-(--radius-6) bg-(--fill-secondary) px-2 text-[12px] text-text hover:bg-(--fill-secondary-hover)" @click="setChoice(section.kind, path, false)">{{ section.action }}</button>
          </li>
        </ul>
      </section>
    </DialogContent>
  </Dialog>
</template>

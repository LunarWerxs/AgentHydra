<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronDown, ExternalLink, Sparkles } from '@lucide/vue'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { dismissWhatsNew, whatsNew } from '@/lib/whats-new'

const CHANGELOG_URL = 'https://github.com/LunarWerxs/AgentHydra/blob/main/CHANGELOG.md'

const open = computed({
  get: () => whatsNew.value !== null,
  set: (o: boolean) => {
    if (!o) dismissWhatsNew()
  },
})
const expanded = ref<Set<string>>(new Set())
const gotIt = ref<HTMLButtonElement | null>(null)

const heading = computed(() => (whatsNew.value?.updated ? `Updated to v${whatsNew.value.version}` : "What's new"))
const status = computed(() => {
  const n = whatsNew.value?.count ?? 0
  const changes = `${n} ${n === 1 ? 'change' : 'changes'}`
  return whatsNew.value?.updated ? `Restart complete · ${changes}` : `${changes} since you last looked`
})

function keyOf(group: number, entry: number): string {
  return `${group}:${entry}`
}

function toggle(key: string) {
  const next = new Set(expanded.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expanded.value = next
}

function focusGotIt(event: Event) {
  event.preventDefault()
  gotIt.value?.focus()
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      v-if="whatsNew"
      :show-close-button="false"
      class="max-h-[80vh] gap-0 overflow-y-auto rounded-(--radius-12) p-0 shadow-(--shadow-popover) ring-0 sm:max-w-120"
      @open-auto-focus="focusGotIt"
    >
      <header class="flex items-start gap-3 px-5 pt-5 pb-4">
        <span class="flex size-8 shrink-0 items-center justify-center rounded-(--radius-8) bg-accent text-white" aria-hidden="true">
          <Sparkles class="size-4" />
        </span>
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <DialogTitle class="text-[15px] font-semibold leading-5 text-text">{{ heading }}</DialogTitle>
          <DialogDescription class="flex items-center gap-1.5 text-[12px] leading-4 text-text-muted">
            <span v-if="whatsNew.updated" class="size-1.5 shrink-0 rounded-full bg-success" aria-hidden="true" />
            <span>{{ status }}</span>
          </DialogDescription>
        </div>
      </header>

      <div class="flex flex-col gap-4 px-5 pb-4">
        <section v-for="(group, gi) in whatsNew.groups" :key="gi" class="flex flex-col gap-1.5">
          <h2 class="text-[12px] font-semibold leading-4 text-text-2">
            {{ group.version ? `v${group.version}` : 'Unreleased' }}<span v-if="group.date" class="font-normal text-text-muted"> · {{ group.date }}</span>
          </h2>
          <ul class="flex flex-col gap-1">
            <li v-for="(entry, ei) in group.entries" :key="ei" class="rounded-(--radius-6) bg-fill-5">
              <button
                type="button"
                class="flex w-full min-w-0 items-start gap-2 px-2.5 py-2 text-start"
                :aria-expanded="entry.detail ? expanded.has(keyOf(gi, ei)) : undefined"
                :disabled="!entry.detail"
                @click="toggle(keyOf(gi, ei))"
              >
                <span class="min-w-0 flex-1 text-[13px] leading-5 text-text">{{ entry.headline }}</span>
                <ChevronDown
                  v-if="entry.detail"
                  class="mt-0.5 size-3.5 shrink-0 text-text-muted transition-transform duration-60"
                  :class="expanded.has(keyOf(gi, ei)) ? 'rotate-180' : ''"
                  aria-hidden="true"
                />
              </button>
              <p v-if="entry.detail && expanded.has(keyOf(gi, ei))" class="px-2.5 pb-2 text-[12px] leading-5 text-text-2">{{ entry.detail }}</p>
            </li>
          </ul>
        </section>
      </div>

      <footer class="flex items-center gap-3 border-t border-border px-5 py-3">
        <a :href="CHANGELOG_URL" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-[12px] text-text-2 hover:text-text">
          Full changelog <ExternalLink class="size-3" aria-hidden="true" />
        </a>
        <span class="flex-1" />
        <span class="text-[11px] text-text-muted">Esc to dismiss</span>
        <button ref="gotIt" type="button" class="h-7 rounded-(--radius-6) bg-brand px-3 text-[12px] font-medium text-white hover:bg-brand-hover" @click="dismissWhatsNew">
          Got it
        </button>
      </footer>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { SearchHit } from '@shared/protocol'
import { Tip } from '@/components/ui/tooltip'
import { folderLabel, sourceLabel } from './logic'
import { highlightParts, relativeTime } from './search'

// One "Everywhere" row of the sidebar search: AgentHydra found the query inside this session's
// transcript. The title and the matching line with the query's words emphasised, folder and age beside.
const props = withDefaults(defineProps<{ hit: SearchHit; query: string; now: number; active?: boolean; selected?: boolean }>(), {
  active: false,
  selected: false
})
const emit = defineEmits<{ select: [] }>()

const title = computed(() => highlightParts(props.hit.title, props.query))
const snippet = computed(() => highlightParts(props.hit.snippet, props.query))
const meta = computed(() =>
  [props.hit.cwd ? folderLabel(props.hit.cwd) : null, relativeTime(props.hit.lastActivityAt, props.now)].filter(Boolean).join(' · ')
)
const tooltip = computed(() => [sourceLabel(props.hit.source), props.hit.cwd].filter(Boolean).join('\n'))
</script>

<template>
  <Tip :label="tooltip" side="right" align="start">
    <button
      type="button"
      :aria-current="selected ? 'page' : undefined"
      :data-search-cursor="active || undefined"
      class="flex w-full cursor-default flex-col gap-0.5 rounded-[var(--radius-6)] px-1.5 py-1 text-left transition-colors duration-[var(--dur-fast)] ease-[var(--ease-snap)] select-none"
      :class="selected ? 'bg-fill-selected' : active ? 'bg-fill-hover' : 'hover:bg-fill-hover'"
      @click="emit('select')"
    >
      <span class="flex w-full min-w-0 items-baseline gap-2">
        <span class="min-w-0 flex-1 truncate text-[13px] leading-[19.5px] text-text">
          <template v-for="(p, i) in title" :key="i"><mark v-if="p.mark" class="bg-transparent font-semibold text-text">{{ p.text }}</mark><template v-else>{{ p.text }}</template></template>
        </span>
        <span class="shrink-0 text-[12px] leading-4 text-text-muted">{{ meta }}</span>
      </span>
      <span v-if="hit.snippet" class="line-clamp-2 w-full text-[12px] leading-4 text-text-muted">
        <template v-for="(p, i) in snippet" :key="i"><mark v-if="p.mark" class="bg-transparent font-medium text-text-2">{{ p.text }}</mark><template v-else>{{ p.text }}</template></template>
      </span>
    </button>
  </Tip>
</template>

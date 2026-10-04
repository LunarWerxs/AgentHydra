<script setup lang="ts">
// The open transcript's turns, laid out the way the Claude desktop app lays out a chat: what you
// typed in a bubble on the right, the model's replies as plain prose across the column, and every
// run of tool calls and reasoning between two messages folded into one quiet work row
// (TranscriptWorkGroup) instead of a log block per call. A message neither side wrote (the summary a
// compaction leaves, the API's usage-limit notice) is a divider, not a turn. Split out of SessionsView.vue, which keeps
// the scroll container, the loading and empty states and the history paging around it; renders as
// a fragment, so the turns land in that container exactly as they did inline and `data-turn` stays
// where the scroller and find look (a folded row carries every index it holds in `data-turns`).

import { Check, ChevronRight, CircleAlert, Copy, FoldVertical, GitBranch } from '@lucide/vue'
import { useNow } from '@vueuse/core'
import { computed } from 'vue'
import TranscriptWorkGroup from '@/components/TranscriptWorkGroup.vue'
import { Button } from '@/components/ui/button'
import type { TranscriptTurn } from '@/composables/useTranscriptDisplay'
import type { DisplayItem, TurnItem, WorkStep } from '@/lib/transcript-groups'
import ExpandTransition from '@/shell/ExpandTransition.vue'

const props = defineProps<{
  items: DisplayItem<TranscriptTurn>[]
  copiedIdx: number | null
  isExpanded: (key: string) => boolean
  /** A find is running: rows and steps holding a match open on their own, so the match is on
   *  screen for the find bar to scroll to. */
  findActive: boolean
  /** A subagent's run drawn inside its Agent step: no data-turn marks, which name the open
   *  session's own turns. */
  nested?: boolean
}>()

const emit = defineEmits<{
  copy: [i: number, text: string]
  toggleExpand: [key: string]
  /** "Copy up to here into a new chat", from the reply on this transcript line. */
  branch: [uuid: string]
}>()

/** How recent a session's newest work must be for its row to read as still in progress. A tool
 *  that runs for minutes writes nothing until it returns, so this is generous. */
const LIVE_MS = 90_000
// Coarse on purpose: it only decides when a row stops being live. The template reads liveKey, not
// the clock, and a computed whose value did not change re-renders nothing, so the list re-renders
// when a row goes quiet rather than on every tick; the live row runs its own second-hand.
const now = useNow({ interval: 5000 })

const liveKey = computed(() => {
  const last = props.items.at(-1)
  if (last?.type !== 'work' || last.endedAt === null) return null
  return now.value.getTime() - last.endedAt < LIVE_MS ? last.key : null
})

const groupOpen = (key: string, hits: number) =>
  props.isExpanded(key) || (props.findActive && hits > 0)
const stepOpen = (step: WorkStep<TranscriptTurn>) =>
  props.isExpanded(step.key) || (props.findActive && step.hits > 0)
const noticeOpen = (item: TurnItem<TranscriptTurn>) =>
  props.isExpanded(item.key) || (props.findActive && item.ev.hits > 0)

/** Space above an item: a new exchange (your message) gets room; the work and the reply it led to
 *  stay close, so a question and its answer read as one block. */
function gap(i: number): string {
  if (i === 0) return ''
  const it = props.items[i]
  return it.type === 'turn' && it.ev.role === 'user' ? 'mt-6' : 'mt-2'
}
</script>

<template>
  <template v-for="(item, i) in items" :key="item.key">
    <!-- a run of tool calls and reasoning, folded -->
    <TranscriptWorkGroup
      v-if="item.type === 'work'"
      :class="gap(i)"
      :group="item"
      :open="groupOpen(item.key, item.hits)"
      :live="item.key === liveKey"
      :nested="nested"
      :is-step-open="stepOpen"
      :copied-idx="copiedIdx"
      @toggle="emit('toggleExpand', item.key)"
      @toggle-step="(key) => emit('toggleExpand', key)"
      @copy="(idx, text) => emit('copy', idx, text)"
    />

    <!-- a message neither side wrote: a divider, not a turn -->
    <div
      v-else-if="item.ev.notice"
      :data-turn="nested ? undefined : item.index"
      class="flex flex-col items-center"
      :class="i ? 'mt-4' : ''"
    >
      <div class="flex w-full items-center gap-3 text-2xs text-muted-foreground">
        <span class="h-px flex-1 bg-border" />
        <!-- the compaction summary: everything above it is what the session no longer holds -->
        <button
          v-if="item.ev.notice === 'compact'"
          type="button"
          class="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border/70 px-2.5 py-0.5 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          :aria-expanded="noticeOpen(item)"
          :title="noticeOpen(item) ? $t('sessions.notice.hideSummary') : $t('sessions.notice.showSummary')"
          @click="emit('toggleExpand', item.key)"
        >
          <FoldVertical class="size-3" />
          {{ $t('sessions.notice.compacted') }}
          <ChevronRight class="size-3 transition-transform duration-200" :class="noticeOpen(item) && 'rotate-90'" />
        </button>
        <!-- the API's own notice, e.g. a usage limit and when it resets -->
        <!-- eslint-disable-next-line vue/no-v-html -- escaped, see the note on the bubble below -->
        <div
          v-else
          class="flex min-w-0 max-w-[85%] items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/5 px-2.5 py-0.5 text-destructive [&_p]:inline"
        >
          <CircleAlert class="size-3 shrink-0" />
          <span class="min-w-0 wrap-break-word" v-html="item.ev.html" />
        </div>
        <span class="h-px flex-1 bg-border" />
      </div>
      <div v-if="item.ev.notice === 'compact'" class="w-full">
        <ExpandTransition :open="noticeOpen(item)">
          <!-- eslint-disable-next-line vue/no-v-html -- escaped, see the note on the bubble below -->
          <div
            class="scroll-slim mt-2 max-h-96 overflow-y-auto rounded-md bg-muted/30 px-3 py-2 text-xs text-muted-foreground wrap-break-word"
            :class="item.ev.pre ? 'whitespace-pre-wrap' : 'md'"
            v-html="item.ev.html"
          ></div>
        </ExpandTransition>
      </div>
    </div>

    <!-- what you typed: a raised bubble on the right, copy on its left -->
    <div
      v-else-if="item.ev.role === 'user'"
      :data-turn="nested ? undefined : item.index"
      class="group flex items-end justify-end gap-1.5"
      :class="gap(i)"
    >
      <span
        class="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100 has-focus-visible:opacity-100 pointer-coarse:opacity-60"
      >
        <Button
          variant="ghost"
          size="icon-sm"
          :title="$t('sessions.copyMessage')"
          @click="emit('copy', item.index, item.ev.text)"
        >
          <Check v-if="copiedIdx === item.index" class="text-success" />
          <Copy v-else />
        </Button>
      </span>
      <!-- The bubble was bg-primary/15 once, which composited to #352626: a maroon block behind
           every message you sent, rather than a neutral raised surface. -->
      <div class="min-w-0 max-w-[85%] rounded-2xl rounded-ee-md bg-accent px-3.5 py-2 text-sm">
        <!-- the text is HTML-escaped before anything reads it (lib/markdown.ts), and lib/find.ts
             only ever adds <mark> around already-escaped slices, so no tag here came from the
             transcript -->
        <!-- eslint-disable-next-line vue/no-v-html -- see the note above -->
        <div
          class="wrap-break-word"
          :class="[
            item.ev.pre ? 'whitespace-pre-wrap' : 'md',
            item.ev.long && !isExpanded(item.key) && !(findActive && item.ev.hits)
              ? 'transcript-fade max-h-56 overflow-hidden'
              : '',
          ]"
          v-html="item.ev.html"
        ></div>
        <button
          v-if="item.ev.long"
          class="mt-1 text-2xs font-medium text-primary hover:underline"
          @click="emit('toggleExpand', item.key)"
        >
          {{ isExpanded(item.key) ? $t('sessions.showLess') : $t('sessions.showMore') }}
        </button>
      </div>
    </div>

    <!-- the model's reply: prose across the column, no bubble; copy underneath on hover -->
    <div v-else :data-turn="nested ? undefined : item.index" class="group min-w-0" :class="gap(i)">
      <!-- eslint-disable-next-line vue/no-v-html -- escaped, see the note above -->
      <div
        class="wrap-break-word text-sm leading-relaxed"
        :class="item.ev.pre ? 'whitespace-pre-wrap' : 'md'"
        v-html="item.ev.html"
      ></div>
      <div
        class="-ms-1.5 flex h-6 items-center opacity-0 transition-opacity group-hover:opacity-100 has-focus-visible:opacity-100 pointer-coarse:opacity-60"
      >
        <Button
          variant="ghost"
          size="icon-xs"
          :title="$t('sessions.copyMessage')"
          @click="emit('copy', item.index, item.ev.text)"
        >
          <Check v-if="copiedIdx === item.index" class="text-success" />
          <Copy v-else />
        </Button>
        <Button
          v-if="item.ev.uuid && !nested"
          variant="ghost"
          size="icon-xs"
          :title="$t('sessions.branchHere')"
          :aria-label="$t('sessions.branchHere')"
          @click="emit('branch', item.ev.uuid)"
        >
          <GitBranch />
        </Button>
      </div>
    </div>
  </template>
</template>

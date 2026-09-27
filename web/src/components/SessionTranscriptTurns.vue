<script setup lang="ts">
// The open transcript's turns: chat bubbles, tool and reasoning log lines, and each turn's copy and
// expand controls. Split out of SessionsView.vue, which keeps the scroll container, the loading and
// empty states and the history paging around it; renders as a fragment, so the turns land in that
// container exactly as they did inline and `data-turn` stays where the scroller and find look.
import { Brain, Check, Copy, Wrench } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import type { TranscriptTurn } from '@/composables/useTranscriptDisplay'

defineProps<{
  events: TranscriptTurn[]
  copiedIdx: number | null
  isExpanded: (i: number) => boolean
}>()

const emit = defineEmits<{
  copy: [i: number, text: string]
  toggleExpand: [i: number]
}>()
</script>

<template>
  <div
    v-for="(ev, i) in events"
    :key="i"
    :data-turn="i"
    class="group flex items-end gap-1.5"
    :class="[
      i > 0 && events[i - 1].role === ev.role ? 'mt-1.5' : 'mt-4',
      ev.kind === 'text' && ev.role === 'user' ? 'justify-end' : 'justify-start',
    ]"
  >
    <!-- user bubbles get their copy button on the left, assistant on the right;
         hover-revealed, but always faintly visible on touch screens -->
    <span
      v-if="ev.kind === 'text' && ev.role === 'user'"
      class="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100 has-focus-visible:opacity-100 pointer-coarse:opacity-60"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        :title="$t('sessions.copyMessage')"
        @click="emit('copy', i, ev.text)"
      >
        <Check v-if="copiedIdx === i" class="text-success" />
        <Copy v-else />
      </Button>
    </span>

    <!-- tool activity and reasoning: a compact log line, not a bubble -->
    <div
      v-if="ev.kind !== 'text'"
      class="w-full min-w-0 rounded-md border-s-2 border-border bg-muted/20 px-2.5 py-1.5 text-2xs text-muted-foreground"
      :class="ev.kind === 'thinking' ? 'italic' : 'font-mono'"
    >
      <div class="mb-0.5 flex items-center gap-1 font-semibold not-italic">
        <Brain v-if="ev.kind === 'thinking'" class="size-3" />
        <Wrench v-else class="size-3" />
        {{ ev.kind === 'thinking' ? $t('sessions.thinkingLabel') : ev.tool_name ?? ev.kind }}
        <span
          class="ms-auto flex opacity-0 transition-opacity group-hover:opacity-100 has-focus-visible:opacity-100 pointer-coarse:opacity-60"
        >
          <Button
            variant="ghost"
            size="icon-xs"
            :title="$t('sessions.copyMessage')"
            @click="emit('copy', i, ev.text)"
          >
            <Check v-if="copiedIdx === i" class="text-success" />
            <Copy v-else />
          </Button>
        </span>
      </div>
      <!-- the text is HTML-escaped before anything reads it (lib/markdown.ts), and
           lib/find.ts only ever adds <mark> around already-escaped slices, so no tag
           here came from the transcript -->
      <!-- eslint-disable-next-line vue/no-v-html -- see the note above -->
      <div
        class="wrap-break-word"
        :class="[
          ev.pre ? 'whitespace-pre-wrap' : 'md',
          ev.long && !isExpanded(i) ? 'max-h-48 overflow-hidden' : '',
        ]"
        v-html="ev.html"
      ></div>
      <button
        v-if="ev.long"
        class="mt-1 text-2xs font-medium text-primary hover:underline"
        @click="emit('toggleExpand', i)"
      >
        {{ isExpanded(i) ? $t('sessions.showLess') : $t('sessions.showMore') }}
      </button>
    </div>

    <!-- chat bubbles: user = raised grey, assistant = flatter muted. The user bubble was
         bg-primary/15, which composited to #352626 — a maroon block behind every message
         you sent, rather than a neutral raised surface. -->
    <div
      v-else
      class="min-w-0 max-w-[85%] rounded-2xl px-3.5 py-2 text-sm"
      :class="ev.role === 'user' ? 'rounded-ee-md bg-accent' : 'rounded-es-md bg-muted/50'"
    >
      <!-- eslint-disable-next-line vue/no-v-html -- see the note above -->
      <div
        class="wrap-break-word"
        :class="[
          ev.pre ? 'whitespace-pre-wrap' : 'md',
          ev.long && !isExpanded(i) ? 'max-h-56 overflow-hidden' : '',
        ]"
        v-html="ev.html"
      ></div>
      <button
        v-if="ev.long"
        class="mt-1 text-2xs font-medium text-primary hover:underline"
        @click="emit('toggleExpand', i)"
      >
        {{ isExpanded(i) ? $t('sessions.showLess') : $t('sessions.showMore') }}
      </button>
    </div>

    <span
      v-if="ev.kind === 'text' && ev.role !== 'user'"
      class="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100 has-focus-visible:opacity-100 pointer-coarse:opacity-60"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        :title="$t('sessions.copyMessage')"
        @click="emit('copy', i, ev.text)"
      >
        <Check v-if="copiedIdx === i" class="text-success" />
        <Copy v-else />
      </Button>
    </span>
  </div>
</template>

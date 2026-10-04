<script setup lang="ts">
/**
 * One row of a `SideList`, one line (about 33px): status icon, leading badge, title, trailing
 * marks, a number chip (`P3`, `#71`), a small "model · effort" tag, and when it last moved. It is a `<button>`, so Enter and
 * Space select it; the `click` listener falls through to the button and receives the MouseEvent
 * (modifier keys included). Other attributes (`data-*`, `class`) land on the button too.
 */
import { Loader2 } from '@lucide/vue'

withDefaults(
  defineProps<{
    /** The row's title, truncated to one line. */
    label: string
    /** Selected row: raised grey with the leading bar, and aria-current. */
    selected?: boolean
    /** Working now: the default status icon is a spinner. */
    active?: boolean
    /** Accessible name of the spinner, e.g. "Working". */
    activeLabel?: string
    /** The row's native hover hint. */
    hint?: string
    /** Fade a row that is finished or stale, so it stops competing for the eye. */
    dim?: boolean
    /** Strike the title through (a row marked done). */
    struck?: boolean
    /** The number chip after the title: a CliMayte priority (`P3`) or a session's instance (`#71`). */
    chip?: string
    /** The chip's native hover hint. */
    chipHint?: string
    /** The small tag text: "model · effort" (see modelEffortTag). */
    tag?: string
    /** `warning` colours the tag amber (the run differs from what was asked for). */
    tagTone?: 'muted' | 'warning'
    /** The time text: how long ago it moved, or how long it ran. */
    time?: string
  }>(),
  {
    selected: false,
    active: false,
    activeLabel: undefined,
    hint: undefined,
    dim: false,
    struck: false,
    chip: undefined,
    chipHint: undefined,
    tag: undefined,
    tagTone: 'muted',
    time: undefined,
  },
)

defineSlots<{
  /** Leading status icon. Default: a spinner while `active`, else nothing. */
  status?: () => unknown
  /** Between the status icon and the title (a checkbox, a cloud for another PC's task). */
  badge?: () => unknown
  /** Replaces the title text (highlighted search hits). */
  title?: () => unknown
  /** After the title, inside its line (a verdict mark, small icons). */
  mark?: () => unknown
  /** Inside the time text, before it (an activity dot). */
  'time-prefix'?: () => unknown
}>()
</script>

<template>
  <button
    type="button"
    class="flex w-full min-w-0 items-center gap-2 border-b border-border px-3 py-1.5 text-start text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    :class="[selected ? 'bg-accent shadow-row-selected' : 'hover:bg-accent/50', dim ? 'opacity-55' : '']"
    :aria-current="selected ? 'true' : undefined"
    :title="hint"
  >
    <slot name="status">
      <Loader2
        v-if="active"
        class="size-3.5 shrink-0 animate-spin text-primary"
        :aria-label="activeLabel"
        :aria-hidden="activeLabel ? undefined : 'true'"
      />
    </slot>
    <slot name="badge" />
    <span class="flex min-w-0 flex-1 items-center gap-1">
      <span
        class="min-w-0 truncate font-medium"
        :class="struck ? 'line-through decoration-muted-foreground/40' : ''"
      >
        <slot name="title">{{ label }}</slot>
      </span>
      <slot name="mark" />
    </span>
    <span
      v-if="chip"
      class="shrink-0 rounded bg-muted px-1 text-2xs font-medium tabular-nums text-muted-foreground"
      :title="chipHint"
    >{{ chip }}</span>
    <span
      v-if="tag"
      class="max-w-28 shrink-0 truncate text-2xs"
      :class="tagTone === 'warning' ? 'text-warning' : 'text-muted-foreground'"
    >{{ tag }}</span>
    <span
      v-if="time"
      class="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums"
    >
      <slot name="time-prefix" />
      {{ time }}
    </span>
  </button>
</template>

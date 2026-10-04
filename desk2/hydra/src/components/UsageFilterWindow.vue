<script setup lang="ts">
// One quota window inside the usage flyout: a switch that says whether the window is measured at
// all, and — only once it is — the line it is measured against.
//
// A component rather than two copies in InstanceFilterMenu.vue because the weekly cap and the 5-hour
// session are the SAME control twice over. They are also the two halves of one comparison, so any
// drift between them (a preset row on one, a differently-sized readout on the other) reads as the
// two windows working differently rather than as a styling slip.
//
// Three ways to set one number, deliberately, because they answer different questions: the presets
// are the one-click common case, the slider is "somewhere around here" without typing, and the box
// is the exact figure. All three write through the same clamped setter, so none of them can persist
// a value the others could not reach.
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { USAGE_THRESHOLD_PRESETS } from '@/lib/usage-filter'
import ExpandTransition from '@/shell/ExpandTransition.vue'
import InfoHint from '@/shell/InfoHint.vue'

// Every string arrives as a PROP — there is not a t() or $t() left in here. The quick-instances
// window (QuickInstanceFilter.vue) renders these same two windows and deliberately runs without
// vue-i18n installed, so a translate call anywhere in this subtree would throw there. Taking the
// last two literals ("Set aside at" / the preset captions) as props is what lets both surfaces
// share one slider, one preset row and one clamped setter instead of growing a second copy of the
// control that the filter's whole correctness story is written around.
const props = defineProps<{
  /** Row label, e.g. "Weekly usage". */
  label: string
  /** The InfoHint body: what this window is and why you would measure it. */
  hint: string
  /** Spoken name for the number box, which has no visible label of its own. */
  thresholdLabel: string
  /** Caption above the number box, e.g. "Set aside at". */
  thresholdCaption: string
  /** Renders one preset button's caption, e.g. (80) => "80%". A function rather than a formatted
   *  list so a translated surface can keep its own number formatting. */
  presetLabel: (pct: number) => string
  threshold: number
}>()

const emit = defineEmits<{ 'update:threshold': [value: unknown] }>()

/** The window's on/off. `defineModel` so the parent keeps owning the persisted ref. */
const enabled = defineModel<boolean>({ required: true })

/** The slider's filled portion, painted with a gradient rather than a second element: a range input
 *  has no "track before the thumb" pseudo-element to colour, and the fill is what makes the control
 *  read as a level rather than as a dot on a line. */
const fill = computed(() => `${props.threshold}%`)
</script>

<template>
  <section
    class="overflow-hidden rounded-md border transition-colors"
    :class="enabled ? 'border-border bg-background/60' : 'border-border/60 bg-transparent'"
  >
    <div class="flex items-center gap-3 px-2.5 py-1.5">
      <span class="flex min-w-0 flex-1 items-center gap-1.5 text-ui text-foreground">
        {{ label }}
        <InfoHint :text="hint" />
      </span>
      <Switch v-model="enabled" />
    </div>

    <ExpandTransition :open="enabled">
      <div class="space-y-2 border-t border-border/60 px-2.5 py-2">
        <div class="flex items-center justify-between gap-3">
          <span class="text-xs text-muted-foreground">{{ thresholdCaption }}</span>
          <div class="flex items-baseline gap-1">
            <!-- `md:text-ui` as well as the unprefixed size: the Input's own base class list
                 carries a `md:text-xs/relaxed`, and twMerge treats a responsive variant as its own
                 group — so the unprefixed size alone loses above the md breakpoint. Spinners off
                 because this reads as a value, and they cost a third of the box's width. -->
            <Input
              variant="numeric"
              text-size="ui"
              class="h-6 w-11"
              type="number"
              min="0"
              max="100"
              :aria-label="thresholdLabel"
              :model-value="threshold"
              @change="(e: Event) => emit('update:threshold', (e.target as HTMLInputElement).value)"
            />
            <span class="text-xs text-muted-foreground">%</span>
          </div>
        </div>

        <input
          class="usage-range"
          type="range"
          min="0"
          max="100"
          step="1"
          :aria-label="thresholdLabel"
          :value="threshold"
          :style="{ '--usage-fill': fill }"
          @input="(e: Event) => emit('update:threshold', (e.target as HTMLInputElement).value)"
        />

        <div class="grid grid-cols-4 gap-1">
          <Button
            v-for="preset in USAGE_THRESHOLD_PRESETS"
            :key="preset"
            :variant="threshold === preset ? 'default' : 'outline'"
            size="xs"
            :aria-pressed="threshold === preset"
            @click="emit('update:threshold', preset)"
          >
            {{ presetLabel(preset) }}
          </Button>
        </div>
      </div>
    </ExpandTransition>
  </section>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { INSTANCE_LABEL_MAX, type InstanceColorKey, type InstanceIconKey } from '@/lib/api'
import {
  colorValue,
  INSTANCE_COLOR_KEYS,
  INSTANCE_ICON_KEYS,
  iconComponent,
  resolveColorKey,
  resolveIconKey,
} from '@/lib/instance-appearance'

const open = defineModel<boolean>('open', { default: false })

const props = defineProps<{
  /** The instance's on-disk folder name — shown as the placeholder + used to resolve the
   *  deterministic default icon/color when none has been chosen. */
  instanceName?: string | null
  /** The instance's normalized dir (seeds the deterministic default icon/color). */
  dir?: string | null
  /** Current display-label override (null = no override; the field starts empty). */
  currentLabel?: string | null
  currentIcon?: InstanceIconKey | null
  currentColor?: InstanceColorKey | null
  submitting?: boolean
  errorMessage?: string | null
}>()

const emit = defineEmits<{
  /** Fired as the user edits (debounced). The parent persists it; the dialog stays open. `label`
   *  is null when the field is empty (falls back to the folder name). */
  apply: [payload: { label: string | null; icon: InstanceIconKey; color: InstanceColorKey }]
}>()

const name = ref('')
const icon = ref<InstanceIconKey>('box')
const color = ref<InstanceColorKey>('slate')

// Set while the watcher below is seeding, so re-opening the dialog doesn't immediately write back
// the values it just read.
let seeding = false

// (Re)seed the fields each time the dialog opens: the name from the current label (empty when
// unset, so the folder name shows as placeholder), the icon/color from the current choice or the
// deterministic default so the pickers open on the glyph/hue already visible in the table.
watch(open, (isOpen) => {
  if (!isOpen) return
  seeding = true
  name.value = props.currentLabel ?? ''
  icon.value = resolveIconKey({ dir: props.dir ?? '', icon: props.currentIcon ?? null })
  color.value = resolveColorKey({ dir: props.dir ?? '', color: props.currentColor ?? null })
  // Cleared after the watcher below has seen this tick's changes.
  void nextTick(() => {
    seeding = false
  })
})

/**
 * There is no in-dialog preview any more, because the real thing is right there behind the flyout.
 * A miniature copy of a row that is already on screen is a worse answer to "what will this look
 * like" than simply making the row itself change, and it quietly encouraged the fiction that
 * nothing had happened until you pressed Save.
 *
 * So every edit persists as you make it. Debounced, because the name is typed a character at a
 * time and each write touches instance-meta.json on disk; icon and colour are single clicks and
 * would be fine immediately, but they share the path for one rule instead of two.
 */
let applyTimer: ReturnType<typeof setTimeout> | undefined
watch([name, icon, color], () => {
  if (seeding) return
  clearTimeout(applyTimer)
  applyTimer = setTimeout(() => {
    const trimmed = name.value.trim()
    emit('apply', {
      label: trimmed.length > 0 ? trimmed : null,
      icon: icon.value,
      color: color.value,
    })
  }, 350)
})
onBeforeUnmount(() => clearTimeout(applyTimer))
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent>
      <form @submit.prevent="open = false">
        <DialogHeader>
          <!-- No description. It read "Rename this instance and pick its icon and color. Changes
               apply live, even while it's running." — three facts the dialog itself already makes
               obvious: the field is labelled, the swatches are visible, and the row behind now
               changes as you edit. -->
          <DialogTitle>{{ $t('instances.editDialogTitle') }}</DialogTitle>
        </DialogHeader>

        <div class="mt-3 flex flex-col gap-1.5">
          <label for="instance-edit-name" class="text-xs font-medium text-muted-foreground">
            {{ $t('instances.editDialogNameLabel') }}
          </label>
          <Input
            id="instance-edit-name"
            v-model="name"
            :placeholder="instanceName ?? $t('instances.createDialogPlaceholder')"
            :maxlength="INSTANCE_LABEL_MAX"
            :disabled="submitting"
            autofocus
          />
        </div>

        <div class="mt-4 flex flex-col gap-1.5">
          <span class="text-xs font-medium text-muted-foreground">{{ $t('instances.editDialogIconLabel') }}</span>
          <div class="grid grid-cols-8 gap-1">
            <button
              v-for="k in INSTANCE_ICON_KEYS"
              :key="k"
              type="button"
              class="inline-flex size-8 items-center justify-center rounded-md border transition-colors"
              :class="k === icon ? 'border-primary bg-accent' : 'border-transparent hover:bg-accent'"
              :aria-label="k"
              :aria-pressed="k === icon"
              @click="icon = k"
            >
              <component
                :is="iconComponent(k)"
                class="size-4 text-(--instance-color)"
                :style="{ '--instance-color': colorValue(color) }"
              />
            </button>
          </div>
        </div>

        <div class="mt-4 flex flex-col gap-1.5">
          <span class="text-xs font-medium text-muted-foreground">{{ $t('instances.editDialogColorLabel') }}</span>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="c in INSTANCE_COLOR_KEYS"
              :key="c"
              type="button"
              class="size-6 rounded-full bg-(--instance-color) ring-offset-2 ring-offset-background transition-transform hover:scale-110"
              :class="c === color ? 'ring-2 ring-foreground' : ''"
              :style="{ '--instance-color': colorValue(c) }"
              :aria-label="c"
              :aria-pressed="c === color"
              @click="color = c"
            />
          </div>
        </div>

        <p v-if="errorMessage" class="mt-3 text-xs text-destructive">{{ errorMessage }}</p>

        <!-- "Done", not "Save": everything above is already saved. The button is the way OUT of the
             dialog, and saying Save would imply the edits were being held back until you pressed
             it. It still reports an in-flight write so closing mid-save isn't a silent race. -->
        <DialogFooter class="mt-4">
          <Button type="submit">
            {{ submitting ? $t('instances.editDialogSaving') : $t('instances.editDialogDone') }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

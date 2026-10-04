<script setup lang="ts">
// A single small text-input dialog reused for both "New instance" (create) and "Rename",
// the same shape as CreateInstanceDialog.vue, just parameterized on `mode` so both actions
// don't need near-duplicate components. The Codex and DeepSeek tables use both modes; the Claude
// CLI table only renames (its plus opens Quick add), so its namespace has no create wording.
import { computed, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { CLI_INSTANCE_DIALOG_KEYS, type CliDialogNamespace } from '@/lib/instance-dialog-i18n'

const open = defineModel<boolean>('open', { default: false })

const props = defineProps<{
  mode: 'create' | 'rename'
  namespace?: CliDialogNamespace
  currentName?: string | null
  submitting?: boolean
  errorMessage?: string | null
}>()

const emit = defineEmits<{
  submit: [name: string]
}>()

const name = ref('')

watch(open, (isOpen) => {
  if (isOpen) name.value = props.mode === 'rename' ? (props.currentName ?? '') : ''
})

const keys = computed(() => CLI_INSTANCE_DIALOG_KEYS[props.namespace ?? 'cliInstances'])
/** The create wording, in create mode under a namespace that has one. */
const createKeys = computed(() => {
  const k = keys.value
  return props.mode === 'create' && 'createDialogTitle' in k ? k : null
})
const titleKey = computed(() => createKeys.value?.createDialogTitle ?? keys.value.renameDialogTitle)
const descriptionKey = computed(
  () => createKeys.value?.createDialogDescription ?? keys.value.renameDialogDescription,
)
const submitKey = computed(
  () => createKeys.value?.createDialogSubmit ?? keys.value.renameDialogSubmit,
)
const submittingKey = computed(
  () => createKeys.value?.createDialogCreating ?? keys.value.renameDialogRenaming,
)

function handleSubmit() {
  const trimmed = name.value.trim()
  if (!trimmed) return
  emit('submit', trimmed)
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent>
      <form @submit.prevent="handleSubmit">
        <DialogHeader>
          <DialogTitle>{{ $t(titleKey) }}</DialogTitle>
          <DialogDescription>{{ $t(descriptionKey) }}</DialogDescription>
        </DialogHeader>

        <div class="mt-3 flex flex-col gap-1.5">
          <label for="cli-instance-name" class="text-xs font-medium text-muted-foreground">
            {{ $t(keys.nameLabel) }}
          </label>
          <Input
            id="cli-instance-name"
            v-model="name"
            :placeholder="$t(keys.namePlaceholder)"
            :disabled="submitting"
            autofocus
          />
          <p v-if="errorMessage" class="text-xs text-destructive">{{ errorMessage }}</p>
        </div>

        <DialogFooter class="mt-4">
          <Button type="submit" :disabled="submitting || !name.trim()">
            {{ submitting ? $t(submittingKey) : $t(submitKey) }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

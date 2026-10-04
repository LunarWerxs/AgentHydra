<script setup lang="ts">
// The one type-the-name delete confirmation, for every instance table (Claude desktop, Claude CLI,
// Codex, DeepSeek); `namespace` picks the table's own title and wording. It replaced two copies of
// the same dialog.
//
// The name to type is a chip that copies itself on click (owner, 2026-09-30): the gate is there to
// make a delete deliberate, not to make anyone retype a long or odd name by hand.
import { Copy } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
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
import { DELETE_DIALOG_KEYS, type DeleteDialogNamespace } from '@/lib/instance-dialog-i18n'

const open = defineModel<boolean>('open', { default: false })

const props = defineProps<{
  instanceName: string | null
  namespace?: DeleteDialogNamespace
  submitting?: boolean
  errorMessage?: string | null
}>()

const emit = defineEmits<{
  /** Emitted once the typed name matches `instanceName` exactly. */
  confirm: [name: string]
}>()

const { t } = useI18n()
const keys = computed(() => DELETE_DIALOG_KEYS[props.namespace ?? 'instances'])
const typed = ref('')

watch(open, (isOpen) => {
  if (isOpen) typed.value = ''
})

const matches = computed(
  () => typed.value.trim() === (props.instanceName ?? '').trim() && !!props.instanceName,
)

function copyName() {
  const name = props.instanceName
  if (!name) return
  navigator.clipboard
    ?.writeText(name)
    .then(() => toast.success(t('instances.toastNameCopied', { name })))
    .catch(() => {})
}

function handleSubmit() {
  if (!matches.value || !props.instanceName) return
  emit('confirm', props.instanceName)
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent>
      <form @submit.prevent="handleSubmit">
        <DialogHeader>
          <DialogTitle>{{ $t(keys.title) }}</DialogTitle>
          <DialogDescription>{{ $t(keys.description) }}</DialogDescription>
        </DialogHeader>

        <div class="mt-3 flex flex-col gap-1.5">
          <label for="instance-delete-confirm" class="text-xs font-medium text-muted-foreground">
            {{ $t('instances.deleteDialogTypeName') }}
          </label>
          <button
            v-if="instanceName"
            type="button"
            class="inline-flex max-w-full cursor-pointer items-center gap-1.5 self-start rounded-md border bg-muted px-2 py-1 font-mono text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            :title="$t('instances.copyName')"
            :aria-label="`${$t('instances.copyName')}: ${instanceName}`"
            @click="copyName"
          >
            <span class="truncate">{{ instanceName }}</span>
            <Copy class="size-3 shrink-0 text-muted-foreground" />
          </button>
          <Input
            id="instance-delete-confirm"
            v-model="typed"
            :placeholder="instanceName ?? $t(keys.placeholder)"
            :disabled="submitting"
            autofocus
          />
          <p v-if="errorMessage" class="text-xs text-destructive">{{ errorMessage }}</p>
          <p v-else-if="typed && !matches" class="text-xs text-destructive">
            {{ $t(keys.mismatch) }}
          </p>
        </div>

        <DialogFooter class="mt-4">
          <Button type="submit" variant="destructive" :disabled="submitting || !matches">
            {{ submitting ? $t(keys.deleting) : $t(keys.submit) }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

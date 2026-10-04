<script setup lang="ts">
import { ref, watch } from 'vue'
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

const open = defineModel<boolean>('open', { default: false })

defineProps<{
  submitting?: boolean
  errorMessage?: string | null
}>()

const emit = defineEmits<{
  /** Emitted on submit; the parent performs the API call and closes the dialog itself
   *  once it knows the outcome (so the field only resets on success). */
  submit: [name: string]
}>()

const name = ref('')

// Reset the field whenever the dialog is (re)opened.
watch(open, (isOpen) => {
  if (isOpen) name.value = ''
})

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
          <DialogTitle>{{ $t('instances.createDialogTitle') }}</DialogTitle>
          <DialogDescription>{{ $t('instances.createDialogDescription') }}</DialogDescription>
        </DialogHeader>

        <div class="mt-3 flex flex-col gap-1.5">
          <label for="instance-create-name" class="text-xs font-medium text-muted-foreground">
            {{ $t('instances.createDialogLabel') }}
          </label>
          <Input
            id="instance-create-name"
            v-model="name"
            :placeholder="$t('instances.createDialogPlaceholder')"
            :disabled="submitting"
            autofocus
          />
          <p v-if="errorMessage" class="text-xs text-destructive">{{ errorMessage }}</p>
        </div>

        <div class="mt-3 rounded-md border border-border bg-muted/40 p-2.5 text-xs text-muted-foreground">
          <p class="mb-0.5 font-medium text-foreground">{{ $t('instances.browserDanceTitle') }}</p>
          <p>{{ $t('instances.browserDanceBody') }}</p>
        </div>

        <DialogFooter class="mt-4">
          <Button type="submit" :disabled="submitting || !name.trim()">
            {{ submitting ? $t('instances.createDialogCreating') : $t('instances.createDialogSubmit') }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

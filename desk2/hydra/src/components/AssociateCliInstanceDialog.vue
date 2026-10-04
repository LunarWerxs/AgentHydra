<script setup lang="ts">
// Small dialog to pick which dispatch account a CLI instance checks usage against (and,
// later, auto-resumes under). "" selects the none/default option, mirroring the value=''
// convention format.ts's MODELS/EFFORTS/PERMISSION_MODES option lists already use.
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { Account } from '@/lib/api'
import InfoHint from '@/shell/InfoHint.vue'

const open = defineModel<boolean>('open', { default: false })

const props = defineProps<{
  instanceName: string | null
  accounts: Account[]
  currentAccountId: string | null
  submitting?: boolean
  errorMessage?: string | null
}>()

const emit = defineEmits<{
  submit: [accountId: string | null]
}>()

const selected = ref('')

watch(open, (isOpen) => {
  if (isOpen) selected.value = props.currentAccountId ?? ''
})

const options = computed(() => [
  { value: '', label: null as string | null },
  ...props.accounts.map((a) => ({ value: a.id, label: a.label as string | null })),
])

function handleSubmit() {
  emit('submit', selected.value || null)
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent>
      <form @submit.prevent="handleSubmit">
        <DialogHeader>
          <DialogTitle>
            <span class="flex items-center gap-1.5">
              {{ $t('cliInstances.associateDialogTitle') }}
              <InfoHint :text="$t('cliInstances.associateDialogDescription')" />
            </span>
          </DialogTitle>
          <DialogDescription class="sr-only">{{ $t('cliInstances.associateDialogDescription') }}</DialogDescription>
        </DialogHeader>

        <div class="mt-3 flex flex-col gap-1.5">
          <label class="text-xs font-medium text-muted-foreground">
            {{ $t('cliInstances.associateAccountLabel') }}
          </label>
          <Select v-model="selected">
            <SelectTrigger class="w-full">
              <SelectValue :placeholder="$t('cliInstances.associateNone')" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="o in options" :key="o.value" :value="o.value">
                {{ o.label ?? $t('cliInstances.associateNone') }}
              </SelectItem>
            </SelectContent>
          </Select>
          <p v-if="errorMessage" class="text-xs text-destructive">{{ errorMessage }}</p>
        </div>

        <DialogFooter class="mt-4">
          <Button type="submit" :disabled="submitting">
            {{ submitting ? $t('cliInstances.associateDialogSaving') : $t('cliInstances.associateDialogSubmit') }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

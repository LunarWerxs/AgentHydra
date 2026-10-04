<script setup lang="ts">
// Link a CLI instance to a DESKTOP instance. They are two independent logins (Electron safeStorage
// vs a CLAUDE_CONFIG_DIR), but in practice the same Anthropic account used two ways. Linking them
// tells the app so, which does two things: it groups them for the user, and it lets each side's
// credential answer for the other when one's token is expired (see the fallback chains in
// server/src/usage-service.ts).
//
// Mirrors AssociateCliInstanceDialog: "" is the none/unlink option, same value='' convention.
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
import { piiDisplayName } from '@/composables/usePrivacy'
import type { CMInstance } from '@/lib/api'
import InfoHint from '@/shell/InfoHint.vue'

const open = defineModel<boolean>('open', { default: false })

const props = defineProps<{
  instanceName: string | null
  desktopInstances: CMInstance[]
  currentDesktopDir: string | null
  submitting?: boolean
  errorMessage?: string | null
}>()

const emit = defineEmits<{
  submit: [desktopDir: string | null]
}>()

const selected = ref('')

watch(open, (isOpen) => {
  if (isOpen) selected.value = props.currentDesktopDir ?? ''
})

const options = computed(() => [
  { value: '', label: null as string | null },
  ...props.desktopInstances.map((i) => ({
    value: i.dir,
    label: piiDisplayName(i) as string | null,
  })),
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
              {{ $t('cliInstances.linkDialogTitle') }}
              <InfoHint :text="$t('cliInstances.linkDialogDescription')" />
            </span>
          </DialogTitle>
          <DialogDescription class="sr-only">{{ $t('cliInstances.linkDialogDescription') }}</DialogDescription>
        </DialogHeader>

        <div class="mt-3 flex flex-col gap-1.5">
          <label class="text-xs font-medium text-muted-foreground">
            {{ $t('cliInstances.linkDesktopLabel') }}
          </label>
          <Select v-model="selected">
            <SelectTrigger class="w-full">
              <SelectValue :placeholder="$t('cliInstances.linkNone')" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="o in options" :key="o.value" :value="o.value">
                {{ o.label ?? $t('cliInstances.linkNone') }}
              </SelectItem>
            </SelectContent>
          </Select>
          <p v-if="errorMessage" class="text-xs text-destructive">{{ errorMessage }}</p>
        </div>

        <DialogFooter class="mt-4">
          <Button type="submit" :disabled="submitting">
            {{ submitting ? $t('cliInstances.linkDialogSaving') : $t('cliInstances.linkDialogSubmit') }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

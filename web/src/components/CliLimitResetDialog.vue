<script setup lang="ts">
// Confirm, then use a CLI account's limit reset through the CLI's own `/limit-reset`
// (server/src/core/cli-limit-reset.ts). A confirm and not a one-click menu item because it spends
// something and there is no way to look first: only running the command tells whether a reset was
// there. The toast is the CLI's own answer.
import { RotateCcw } from '@lucide/vue'
import { ref } from 'vue'
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
import { type CliInstance, cliLimitReset } from '@/lib/api'

const open = defineModel<boolean>('open', { default: false })
const props = defineProps<{ instance: CliInstance | null }>()
const emit = defineEmits<{ done: [] }>()

const { t } = useI18n()
const running = ref(false)

async function onConfirm() {
  const inst = props.instance
  if (!inst || running.value) return
  running.value = true
  try {
    const r = await cliLimitReset(inst.id)
    if (r.outcome === 'reset') toast.success(r.message)
    else if (r.outcome === 'error') toast.error(r.message || t('cliInstances.limitResetFailed'))
    else toast.info(r.message)
    open.value = false
    emit('done')
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('cliInstances.limitResetFailed'))
  } finally {
    running.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-w-md">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <RotateCcw class="size-4" />
          {{ $t('cliInstances.limitResetTitle', { name: instance?.name ?? '' }) }}
        </DialogTitle>
        <DialogDescription>{{ $t('cliInstances.limitResetBody') }}</DialogDescription>
      </DialogHeader>
      <DialogFooter class="mt-2">
        <Button variant="ghost" :disabled="running" @click="open = false">
          {{ $t('cliInstances.limitResetCancel') }}
        </Button>
        <Button :disabled="running || !instance" @click="onConfirm">
          <RotateCcw :class="running ? 'animate-spin' : ''" />
          {{ running ? $t('cliInstances.limitResetWorking') : $t('cliInstances.limitResetConfirm') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

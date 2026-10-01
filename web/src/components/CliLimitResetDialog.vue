<script setup lang="ts">
// Confirm, then check for or use a CLI account's limit reset through the CLI's own `/limit-reset`
// (server/src/core/cli-limit-reset.ts). A dialog and not a one-click menu item because both can
// spend something: "Check only" backs out of a banked reset's question, but the weekly session
// reset asks nothing. The toast is the CLI's own answer.
import { RotateCcw, Search } from '@lucide/vue'
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
const running = ref<'check' | 'use' | null>(null)

async function onConfirm(check: boolean) {
  const inst = props.instance
  if (!inst || running.value) return
  running.value = check ? 'check' : 'use'
  try {
    const r = await cliLimitReset(inst.id, { check })
    if (r.outcome === 'reset' || r.outcome === 'available') toast.success(r.message)
    else if (r.outcome === 'error') toast.error(r.message || t('cliInstances.limitResetFailed'))
    else toast.info(r.message)
    open.value = false
    emit('done')
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('cliInstances.limitResetFailed'))
  } finally {
    running.value = null
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>
          <span class="flex items-center gap-2">
            <RotateCcw class="size-4" />
            {{ $t('cliInstances.limitResetTitle', { name: instance?.name ?? '' }) }}
          </span>
        </DialogTitle>
        <DialogDescription>{{ $t('cliInstances.limitResetBody') }}</DialogDescription>
      </DialogHeader>
      <DialogFooter class="mt-2">
        <Button variant="ghost" :disabled="!!running" @click="open = false">
          {{ $t('cliInstances.limitResetCancel') }}
        </Button>
        <Button variant="outline" :disabled="!!running || !instance" @click="onConfirm(true)">
          <Search :class="running === 'check' ? 'animate-pulse' : ''" />
          {{ running === 'check' ? $t('cliInstances.limitResetWorking') : $t('cliInstances.limitResetCheck') }}
        </Button>
        <Button :disabled="!!running || !instance" @click="onConfirm(false)">
          <RotateCcw :class="running === 'use' ? 'animate-spin' : ''" />
          {{ running === 'use' ? $t('cliInstances.limitResetWorking') : $t('cliInstances.limitResetConfirm') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

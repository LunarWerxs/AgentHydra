<script setup lang="ts">
// Confirmation gate for quitting the External (default, non-isolated) Claude Desktop — the user's
// REAL app, which may have a conversation in progress. One click must never reach it: this dialog
// is the UI half of the server-side confirmExternal guard (core/instances.ts quitInstance).
// Deliberately a plain confirm (no type-to-confirm like Delete): quitting is recoverable — the
// friction just has to make it deliberate, not painful.
import { TriangleAlert } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const open = defineModel<boolean>('open', { default: false })

defineProps<{
  instanceName: string | null
  submitting?: boolean
}>()

const emit = defineEmits<{
  confirm: []
}>()
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent>
      <DialogHeader>
        <DialogTitle class="flex items-center">
          <TriangleAlert class="me-2 size-4 text-warning" />
          {{ $t('instances.quitExternalDialogTitle') }}
        </DialogTitle>
        <DialogDescription>
          {{ $t('instances.quitExternalDialogDescription') }}
        </DialogDescription>
      </DialogHeader>

      <p v-if="instanceName" class="mono mt-2 truncate text-xs text-muted-foreground">
        {{ instanceName }}
      </p>

      <DialogFooter class="mt-4">
        <Button type="button" variant="destructive" :disabled="submitting" @click="emit('confirm')">
          {{
            submitting
              ? $t('instances.quitExternalDialogQuitting')
              : $t('instances.quitExternalDialogSubmit')
          }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

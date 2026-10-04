<script setup lang="ts">
// One page's settings in a dialog, opened from that page (owner, 2026-10-01: a setting lives on
// the page where he would look for it, not only in the Settings panel). The rows inside are the
// same SettingsGroup / SettingsRow the Settings panel uses. `trigger` draws the gear that opens
// it; without it the caller opens it (a menu item, another button).
import { Settings2 } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import IconTooltip from '@/shell/IconTooltip.vue'

const open = defineModel<boolean>('open', { default: false })
defineProps<{ title: string; trigger?: boolean }>()
</script>

<template>
  <IconTooltip v-if="trigger" :label="title">
    <Button variant="outline" size="icon" :aria-label="title" @click="open = true">
      <Settings2 />
    </Button>
  </IconTooltip>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>
          <span class="flex items-center gap-2">
            <Settings2 class="size-4" />
            {{ title }}
          </span>
        </DialogTitle>
        <DialogDescription class="sr-only">{{ title }}</DialogDescription>
      </DialogHeader>
      <div class="flex min-w-0 flex-col gap-5">
        <slot />
      </div>
    </DialogContent>
  </Dialog>
</template>

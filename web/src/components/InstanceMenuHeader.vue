<script setup lang="ts">
// The top of every instance row's ⋯ menu, on every table: WHICH instance it is (#N), then the row's
// quick actions as icons, with Copy number last (owner spec 2026-09-07 for the Claude desktop rows;
// 2026-09-30 for every table, with Log out always an icon here and never a menu item).
//
// Each icon is a real menu item, so arrow keys reach it. An action that opens a dialog closes the
// menu (`closes`), so no menu is left floating over its own dialog; the others (Refresh, Copy)
// keep it open, because they are the ones you want twice in a row.
import { Copy } from '@lucide/vue'
import type { Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'

export interface MenuIconAction {
  key: string
  icon: Component
  label: string
  run: () => void
  disabled?: boolean
  /** Spin the icon (an action in flight). */
  spin?: boolean
  /** Close the menu on click (the action opens a dialog). */
  closes?: boolean
}

defineProps<{ num: number; actions?: MenuIconAction[] }>()

const { t } = useI18n()

function select(event: Event, action: { run: () => void; closes?: boolean }) {
  if (!action.closes) event.preventDefault()
  action.run()
}

function copyNumber(num: number) {
  navigator.clipboard?.writeText(String(num)).catch(() => {})
  toast.success(t('instances.toastNumberCopied', { num }))
}
</script>

<template>
  <div class="flex items-center justify-between gap-2 pe-1">
    <DropdownMenuLabel class="font-mono text-xs">
      {{ $t('instances.numberMenuLabel', { num }) }}
    </DropdownMenuLabel>
    <div class="flex items-center gap-0.5">
      <DropdownMenuItem
        v-for="action in actions ?? []"
        :key="action.key"
        class="size-6 min-h-6 justify-center p-0 text-muted-foreground"
        :disabled="action.disabled"
        :aria-label="action.label"
        :title="action.label"
        @select="select($event, action)"
      >
        <component :is="action.icon" class="size-3.5" :class="action.spin ? 'animate-spin' : ''" />
      </DropdownMenuItem>
      <DropdownMenuItem
        class="size-6 min-h-6 justify-center p-0 text-muted-foreground"
        :aria-label="$t('instances.copyNumber')"
        :title="$t('instances.copyNumber')"
        @select="select($event, { run: () => copyNumber(num) })"
      >
        <Copy class="size-3.5" />
      </DropdownMenuItem>
    </div>
  </div>
  <DropdownMenuSeparator />
</template>

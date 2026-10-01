<script setup lang="ts">
// The top of every instance row's ⋯ menu, on every table: WHICH instance it is (#N), then the row's
// quick actions as icons, with Copy number last (owner spec 2026-09-07 for the Claude desktop rows;
// 2026-09-30 for every table, with Log out always an icon here and never a menu item).
//
// Each icon is a real menu item, so arrow keys reach it. An action that opens a dialog closes the
// menu (`closes`), so no menu is left floating over its own dialog; the others (Refresh, Copy)
// keep it open, because they are the ones you want twice in a row.
//
// The icons are the bare reka-ui menu item with this file's own square look, not the kit's
// DropdownMenuItem: that one is a text row and owns its padding and colour.
import { Copy } from '@lucide/vue'
import { DropdownMenuItem as MenuIconItem } from 'reka-ui'
import type { Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'

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

/** One icon in the row: a 24px square that takes the menu's highlight like any other item. */
const ICON_ITEM =
  'flex size-6 cursor-default items-center justify-center rounded-md text-muted-foreground outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none'
</script>

<template>
  <div class="flex items-center justify-between gap-2 pe-1">
    <DropdownMenuLabel>
      <span class="font-mono text-xs">{{ $t('instances.numberMenuLabel', { num }) }}</span>
    </DropdownMenuLabel>
    <div class="flex items-center gap-0.5">
      <MenuIconItem
        v-for="action in actions ?? []"
        :key="action.key"
        :class="ICON_ITEM"
        :disabled="action.disabled"
        :aria-label="action.label"
        :title="action.label"
        @select="select($event, action)"
      >
        <component :is="action.icon" class="size-3.5" :class="action.spin ? 'animate-spin' : ''" />
      </MenuIconItem>
      <MenuIconItem
        :class="ICON_ITEM"
        :aria-label="$t('instances.copyNumber')"
        :title="$t('instances.copyNumber')"
        @select="select($event, { run: () => copyNumber(num) })"
      >
        <Copy class="size-3.5" />
      </MenuIconItem>
    </div>
  </div>
  <DropdownMenuSeparator />
</template>

<script setup lang="ts">
// MultiSelectSubmenu — one submenu of a dropdown whose entries are ticked independently, with All and
// None on top and the current choice summarised on the trigger. Written once for the Sessions list
// menu and the Analytics source filter, so "select several, all or none" behaves the same wherever
// it appears. The selection model lives with the caller (lib/session-scopes.ts); this only draws it.
import type { Component } from 'vue'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'

defineProps<{
  icon?: Component
  label: string
  /** The trigger's right-hand text (All, None, a name, or a name and a count). */
  summary: string
  items: readonly { value: string; label: string }[]
  selected: readonly string[]
  disabled?: boolean
  contentClass?: string
}>()

defineEmits<{
  toggle: [value: string]
  all: []
  none: []
}>()
</script>

<template>
  <DropdownMenuSub :disabled="disabled">
    <DropdownMenuSubTrigger>
      <component :is="icon" v-if="icon" />
      {{ label }}
      <span class="ms-auto max-w-24 truncate ps-2 text-2xs text-muted-foreground">{{ summary }}</span>
    </DropdownMenuSubTrigger>
    <DropdownMenuSubContent :class="contentClass ?? 'max-w-52'">
      <!-- @select.prevent keeps the menu open so several boxes can be flipped in one visit. -->
      <DropdownMenuItem @select.prevent="$emit('all')">{{ $t('sessions.selectionAll') }}</DropdownMenuItem>
      <DropdownMenuItem @select.prevent="$emit('none')">{{ $t('sessions.selectionNone') }}</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuCheckboxItem
        v-for="item in items"
        :key="item.value"
        :model-value="selected.includes(item.value)"
        @select.prevent
        @update:model-value="$emit('toggle', item.value)"
      >
        {{ item.label }}
      </DropdownMenuCheckboxItem>
      <slot />
    </DropdownMenuSubContent>
  </DropdownMenuSub>
</template>

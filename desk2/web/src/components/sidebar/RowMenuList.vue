<script setup lang="ts">
import { icons } from '@/lib/icons'
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger
} from '@/components/ui/context-menu'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import type { RowMenuEntry, RowMenuItem } from './logic'
import { MENU_CONTENT, MENU_ITEM, MENU_SEPARATOR, MENU_SHORTCUT } from './menuClasses'

// The row menu's entries inside a right-click menu or a "..." menu: one list, either primitive set.
const props = defineProps<{ entries: RowMenuEntry[]; kind: 'context' | 'dropdown' }>()
const emit = defineEmits<{ run: [item: RowMenuItem] }>()

const ui =
  props.kind === 'context'
    ? { Item: ContextMenuItem, Separator: ContextMenuSeparator, Shortcut: ContextMenuShortcut, Sub: ContextMenuSub, SubTrigger: ContextMenuSubTrigger, SubContent: ContextMenuSubContent }
    : { Item: DropdownMenuItem, Separator: DropdownMenuSeparator, Shortcut: DropdownMenuShortcut, Sub: DropdownMenuSub, SubTrigger: DropdownMenuSubTrigger, SubContent: DropdownMenuSubContent }
</script>

<template>
  <template v-for="(entry, i) in entries" :key="i">
    <component :is="ui.Separator" v-if="entry === 'separator'" :class="MENU_SEPARATOR" />
    <component :is="ui.Sub" v-else-if="'items' in entry">
      <component :is="ui.SubTrigger" :class="MENU_ITEM">{{ entry.label }}</component>
      <component :is="ui.SubContent" :side-offset="4" :class="MENU_CONTENT">
        <template v-for="(sub, j) in entry.items" :key="j">
          <component :is="ui.Separator" v-if="sub === 'separator'" :class="MENU_SEPARATOR" />
          <component
            :is="ui.Item"
            v-else
            :disabled="sub.disabled"
            :title="sub.title"
            :role="sub.checked !== undefined ? 'menuitemradio' : undefined"
            :aria-checked="sub.checked"
            :class="MENU_ITEM"
            @select="emit('run', sub)"
          >
            <span class="min-w-0 flex-1 truncate">{{ sub.label }}</span>
            <component :is="icons.check" v-if="sub.checked" class="ms-3" />
          </component>
        </template>
      </component>
    </component>
    <component
      :is="ui.Item"
      v-else
      :variant="entry.danger ? 'destructive' : 'default'"
      :disabled="entry.disabled"
      :title="entry.title"
      :data-shortcut="entry.shortcut"
      :class="MENU_ITEM"
      @select="emit('run', entry)"
    >
      <span class="flex-1">{{ entry.label }}</span>
      <component :is="ui.Shortcut" v-if="entry.shortcut" :class="MENU_SHORTCUT">{{ entry.shortcut }}</component>
    </component>
  </template>
</template>

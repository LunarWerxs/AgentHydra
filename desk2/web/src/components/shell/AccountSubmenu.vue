<script setup lang="ts">
import type { AccountInfo } from '@shared/protocol'
import { icons } from '@/lib/icons'
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from '@/components/ui/dropdown-menu'
import { accountTitle } from '@/components/accounts/format'
import { MENU_CONTENT, MENU_ITEM } from '@/components/sidebar/menuClasses'

// The title bar menu's "Account" submenu: a chat's account at its next start, or where an outside
// session's stand-in continues. Picking the current one does nothing.
const props = defineProps<{ accounts: AccountInfo[]; current: string; note: string }>()
const emit = defineEmits<{ pick: [id: string] }>()
</script>

<template>
  <DropdownMenuSub>
    <DropdownMenuSubTrigger :class="MENU_ITEM">Account</DropdownMenuSubTrigger>
    <DropdownMenuSubContent :class="MENU_CONTENT">
      <DropdownMenuLabel class="max-w-64 px-2 py-1 text-[12px] font-normal leading-4 text-text-muted">{{ note }}</DropdownMenuLabel>
      <DropdownMenuItem
        v-for="a in accounts"
        :key="a.id"
        role="menuitemradio"
        :aria-checked="current === a.id"
        :disabled="!a.signedIn"
        :class="MENU_ITEM"
        @select="props.current !== a.id && emit('pick', a.id)"
      >
        <span class="flex-1 truncate">{{ accountTitle(a) }}</span>
        <span v-if="a.plan" class="text-text-muted">{{ a.plan }}</span>
        <span class="flex size-4 items-center justify-center"><component :is="icons.check" v-if="current === a.id" /></span>
      </DropdownMenuItem>
    </DropdownMenuSubContent>
  </DropdownMenuSub>
</template>

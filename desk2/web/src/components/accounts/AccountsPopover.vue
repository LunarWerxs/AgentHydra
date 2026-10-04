<script setup lang="ts">
import { ref } from 'vue'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import AccountsList from './AccountsList.vue'

// Usage (sidebar footer): <AccountsPopover><button>profile</button></AccountsPopover>.
// The default slot is the trigger (rendered as-child); the popover opens above it with the real
// app's popover look (#20201f, r10, ringed menu shadow).
withDefaults(defineProps<{ side?: 'top' | 'bottom' | 'left' | 'right'; align?: 'start' | 'center' | 'end' }>(), {
  side: 'top',
  align: 'start'
})
const emit = defineEmits<{ settings: [] }>()

const open = defineModel<boolean>('open', { default: false })
const list = ref<InstanceType<typeof AccountsList> | null>(null)
</script>

<template>
  <Popover v-model:open="open" @update:open="(o: boolean) => o && list?.load()">
    <PopoverTrigger as-child>
      <slot />
    </PopoverTrigger>
    <PopoverContent
      :side="side"
      :align="align"
      :side-offset="6"
      flush
      class="w-auto rounded-[var(--radius-10)] border-0 bg-[var(--bg-popover)] shadow-(--shadow-menu-ringed) ring-0"
    >
      <AccountsList
        ref="list"
        @chosen="open = false"
        @settings="
          () => {
            open = false
            emit('settings')
          }
        "
      />
    </PopoverContent>
  </Popover>
</template>

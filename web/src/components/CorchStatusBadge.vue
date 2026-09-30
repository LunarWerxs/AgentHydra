<script setup lang="ts">
// One Corch task status as a chip: icon + sentence-case label, with what it means on hover. Shared by
// the task list and the detail pane so the two always read the same (lib/corch-status.ts).
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import type { CorchStatus } from '@/lib/api'
import { CORCH_STATUS } from '@/lib/corch-status'

const props = defineProps<{ status: CorchStatus }>()
const meta = computed(() => CORCH_STATUS[props.status])
</script>

<template>
  <Badge :variant="meta.variant" class="h-5 text-2xs" :title="$t(meta.hint)">
    <component :is="meta.icon" :class="meta.spin ? 'animate-spin' : ''" aria-hidden="true" />
    {{ $t(meta.label) }}
  </Badge>
</template>

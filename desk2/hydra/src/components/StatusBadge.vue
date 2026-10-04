<script setup lang="ts">
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import type { QueueStatus } from '@/lib/api'
import { queueStatusMeta } from '@/lib/format'

const props = defineProps<{ status: QueueStatus }>()
const meta = computed(() => queueStatusMeta(props.status))
</script>

<template>
  <Badge :variant="meta.variant">
    <component :is="meta.icon" :class="meta.spin ? 'animate-spin' : ''" />
    {{ meta.label }}
  </Badge>
</template>

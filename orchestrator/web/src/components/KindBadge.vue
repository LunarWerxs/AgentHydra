<script setup lang="ts">
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import { type DecisionKind, KINDS } from '@/lib/api'

const props = defineProps<{ kind: DecisionKind }>()

const k = computed(
  () => KINDS[props.kind] ?? { icon: '•', label: props.kind, badge: 'secondary' as const },
)
</script>

<template>
  <Badge :variant="k.badge">{{ k.icon }} {{ k.label }}</Badge>
</template>

<script setup lang="ts">
// The session-source chip. Each reader wears its own product's colour (session-labels.ts), which
// is this app's vocabulary and not a kit variant, so the chip owns that look here: the kit's
// outline badge underneath, the source tint merged over it, and call sites only place it.
import { computed } from 'vue'
import { badgeVariants } from '@/components/ui/badge'
import type { SessionSource } from '@/lib/api'
import { SOURCE_BADGE_CLASS } from '@/lib/session-labels'
import { cn } from '@/lib/utils'

const props = defineProps<{ source: SessionSource }>()
const chipClass = computed(() =>
  cn(badgeVariants({ variant: 'outline' }), SOURCE_BADGE_CLASS[props.source]),
)
</script>

<template>
  <span data-slot="badge" data-variant="outline" :class="chipClass">
    <slot />
  </span>
</template>

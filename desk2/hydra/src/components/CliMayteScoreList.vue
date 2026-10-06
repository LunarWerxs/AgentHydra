<script setup lang="ts">
// "What works" in full: the scorecard rows per kind of task, each model and thinking level with its
// passes, fails and cost per task (opened from the stats card's bar chart).
import { Star, ThumbsDown, ThumbsUp } from '@lucide/vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Badge } from '@/components/ui/badge'
import type { CliMayteScorecard } from '@/lib/api'
import { modelName } from '@/lib/climayte-status'

const props = defineProps<{ scorecard: CliMayteScorecard }>()
const { t } = useI18n()

/** The rows by kind, in the server's order (kind, then cheapest first). */
const scoreKinds = computed(() => {
  const map = new Map<string, CliMayteScorecard['rows']>()
  for (const r of props.scorecard.rows) {
    const list = map.get(r.kind)
    if (list) list.push(r)
    else map.set(r.kind, [r])
  }
  return [...map.entries()].map(([kind, rows]) => ({ kind, rows }))
})
const scoreModel = (m: string | null) => (m ? modelName(m) : t('climayte.runDefault'))
</script>

<template>
  <p
    v-if="!scorecard.rows.length"
    class="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground"
  >
    {{ $t('climayte.scoreEmpty') }}
  </p>
  <div v-else class="scroll-slim max-h-64 overflow-y-auto rounded-lg border bg-card text-xs">
    <section v-for="k in scoreKinds" :key="k.kind" :aria-label="k.kind">
      <h3 class="border-b bg-muted/40 px-3 py-1 text-2xs font-medium text-muted-foreground">
        {{ k.kind }}
      </h3>
      <ul class="divide-y">
        <li
          v-for="(r, i) in k.rows"
          :key="i"
          class="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1"
        >
          <span class="min-w-24 font-medium">
            {{ scoreModel(r.model) }}
            <span class="font-normal text-muted-foreground">· {{ r.effort ?? $t('climayte.runDefault') }}</span>
          </span>
          <span
            class="flex items-center gap-1 tabular-nums text-success"
            :title="$t('climayte.scorePasses', { n: r.pass })"
          >
            <ThumbsUp class="size-3" aria-hidden="true" />{{ r.pass }}
          </span>
          <span
            class="flex items-center gap-1 tabular-nums text-destructive"
            :title="$t('climayte.scoreFailsSplit', { n: r.fail, slip: r.slip ?? 0, rework: r.rework ?? 0, failed: r.failed ?? r.fail })"
          >
            <ThumbsDown class="size-3" aria-hidden="true" />{{ r.fail }}
          </span>
          <span v-if="r.score != null" class="tabular-nums font-medium">{{ Math.round(r.score * 100) }}%</span>
          <span
            v-if="r.excluded > 0"
            class="tabular-nums text-muted-foreground"
            :title="$t('climayte.scoreNotCounted', { n: r.excluded })"
          >
            +{{ r.excluded }}
          </span>
          <span class="tabular-nums text-muted-foreground">
            {{ r.pctPerTask === null ? '—' : $t('climayte.scorePerTask', { pct: r.pctPerTask.toFixed(1) }) }}
          </span>
          <Badge v-if="r.pick" variant="success" class="ms-auto" :title="$t('climayte.scoreNextPickHint')">
            <Star aria-hidden="true" />
            <span class="text-2xs">{{ $t('climayte.scoreNextPick') }}</span>
          </Badge>
        </li>
      </ul>
    </section>
  </div>
</template>

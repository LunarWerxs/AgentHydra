<script setup lang="ts">
// Port of dashboard.html's renderScripts(): three groups (observe / act / lib), grouped by
// ScriptRow.kind, each rendered as its own table.
import { computed } from 'vue'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { ScriptRow, ScriptsData } from '@/lib/api'

const props = defineProps<{ data: ScriptsData }>()

const SCRIPT_KIND: Record<ScriptRow['kind'], { icon: string; label: string; dot: string }> = {
  observe: { icon: '👁', label: 'observe — reads only, touches nothing', dot: 'bg-primary' },
  act: { icon: '✋', label: 'act — changes something, behind the rails', dot: 'bg-warning' },
  lib: { icon: '🧩', label: 'shared library — imported, not run', dot: 'bg-muted-foreground' },
}

const groups = computed(() =>
  (['observe', 'act', 'lib'] as const)
    .map((kind) => ({
      kind,
      meta: SCRIPT_KIND[kind],
      rows: props.data.scripts.filter((s) => s.kind === kind),
    }))
    .filter((g) => g.rows.length),
)

function usage(u: string): string {
  return u.replace(/^Usage:\s*/, '')
}
</script>

<template>
  <div class="space-y-5">
    <div v-for="g in groups" :key="g.kind">
      <h3 class="mb-2 flex items-center gap-1.5 text-sm font-semibold">
        <span class="size-2 rounded-full" :class="g.meta.dot" />
        {{ g.meta.icon }} {{ g.meta.label }}
      </h3>
      <div class="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead class="w-[16%]">Script</TableHead>
              <TableHead class="w-[34%]">What it does</TableHead>
              <TableHead>Detail · how to run it</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="s in g.rows" :key="s.name">
              <TableCell class="whitespace-normal font-mono font-semibold">{{ s.name }}</TableCell>
              <TableCell class="whitespace-normal text-xs">{{ s.summary }}</TableCell>
              <TableCell class="whitespace-normal text-xs">
                <div v-if="s.detail" class="whitespace-pre-wrap">{{ s.detail }}</div>
                <div v-if="s.usage" class="mt-1"><span class="cmd">{{ usage(s.usage) }}</span></div>
                <div v-if="s.exits" class="mt-1 text-muted-foreground">{{ s.exits }}</div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </div>
  </div>
</template>

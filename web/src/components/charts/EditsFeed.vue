<script setup lang="ts">
// The recently-edited files, as something you can actually read.
//
// It was a flat list of absolute paths in a monospace column: the useful part of a path (the file
// name and the folder above it) sat at the far RIGHT of a long identical prefix, so every row began
// with the same thirty characters. This leads with the filename, puts the folder under it in a
// quieter tone, and drops the repository prefix that is already the group heading.
//
// The extension carries a colour chip, which is doing real work: it is the fastest way to see that
// a burst of activity was all tests, or all styles, without reading a single path.
import { computed } from 'vue'
import type { EditEntry } from '@/lib/api'
import { timeAgo } from '@/lib/format'

const props = defineProps<{ project: string; edits: EditEntry[] }>()

/** File extensions worth colouring. Anything else takes the neutral chip rather than a generated
 *  hue nobody validated. */
const EXT_COLOR: Record<string, string> = {
  ts: 'var(--viz-3)',
  tsx: 'var(--viz-3)',
  js: 'var(--viz-6)',
  mjs: 'var(--viz-6)',
  vue: 'var(--viz-2)',
  css: 'var(--viz-5)',
  py: 'var(--viz-3)',
  go: 'var(--viz-2)',
  rs: 'var(--viz-1)',
  md: 'var(--viz-4)',
  json: 'var(--viz-6)',
  sql: 'var(--viz-5)',
}

interface Row {
  key: string
  name: string
  /** The path with the project prefix removed: the group heading already says which repo. */
  where: string
  ext: string
  color: string
  ts: number | null
  /** How many times this same file was touched in the window. */
  count: number
}

const rows = computed<Row[]>(() => {
  const prefix = props.project.replace(/[\\/]+$/, '')
  const seen = new Map<string, Row>()
  for (const e of props.edits) {
    const parts = e.path.split(/[\\/]/)
    const name = parts[parts.length - 1] || e.path
    const ext = (name.includes('.') ? (name.split('.').pop() ?? '') : '').toLowerCase()
    // Collapse repeats: editing one file eleven times is one row that says eleven, not eleven rows
    // that push everything else off the list.
    const existing = seen.get(e.path)
    if (existing) {
      existing.count++
      if ((e.ts ?? 0) > (existing.ts ?? 0)) existing.ts = e.ts
      continue
    }
    let where = e.path.startsWith(prefix) ? e.path.slice(prefix.length) : e.path
    where = where
      .replace(/^[\\/]+/, '')
      .slice(0, -name.length)
      .replace(/[\\/]+$/, '')
    seen.set(e.path, {
      key: e.path,
      name,
      where,
      ext,
      color: EXT_COLOR[ext] ?? 'var(--color-muted-foreground)',
      ts: e.ts,
      count: 1,
    })
  }
  return [...seen.values()].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
})
</script>

<template>
  <ul class="space-y-0.5">
    <li
      v-for="r in rows"
      :key="r.key"
      class="flex items-baseline gap-2 rounded px-1 py-0.5 hover:bg-muted/50"
      :title="r.key"
    >
      <span
        class="w-9 shrink-0 truncate rounded-[3px] px-1 py-px text-center font-mono text-[9px] uppercase leading-4"
        :style="{ background: `color-mix(in oklab, ${r.color} 22%, transparent)`, color: r.color }"
      >{{ r.ext || '·' }}</span>
      <span class="min-w-0 flex-1 truncate">
        <span class="text-xs font-medium">{{ r.name }}</span>
        <span v-if="r.where" class="ml-1.5 text-[11px] text-muted-foreground">{{ r.where }}</span>
      </span>
      <span
        v-if="r.count > 1"
        class="shrink-0 rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground"
      >&times;{{ r.count }}</span>
      <span class="shrink-0 text-[10px] tabular-nums text-muted-foreground">
        {{ r.ts ? timeAgo(r.ts) : '' }}
      </span>
    </li>
  </ul>
</template>

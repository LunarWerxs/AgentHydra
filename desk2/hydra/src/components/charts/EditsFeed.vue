<script setup lang="ts">
// The recently-edited files, as something you can actually read.
//
// It was a flat list of absolute paths in a monospace column: the useful part of a path (the file
// name and the folder above it) sat at the far RIGHT of a long identical prefix, so every row began
// with the same thirty characters. This leads with the filename, puts the folder under it in a
// quieter tone, and drops the repository prefix that is already the group heading.
//
// The extension leads each row in a small chip, so a burst of activity that was all tests, or all
// styles, shows without reading a path. The chips are gray: they were six hues, one per file type,
// on a page where colour is kept for what matters (owner, 2026-10-05: "adding, like, a thousand
// colors to it isn't gonna help"). The newest few files show; the rest fold behind "+N more".
import { computed, ref } from 'vue'
import type { EditEntry } from '@/lib/api'
import { timeAgo } from '@/lib/format'

const props = defineProps<{ project: string; edits: EditEntry[] }>()

/** Files shown before the fold. */
const TOP = 5
const expanded = ref(false)

interface Row {
  key: string
  name: string
  /** The path with the project prefix removed: the group heading already says which repo. */
  where: string
  ext: string
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
      ts: e.ts,
      count: 1,
    })
  }
  return [...seen.values()].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
})
const shown = computed(() => (expanded.value ? rows.value : rows.value.slice(0, TOP)))
</script>

<template>
  <ul class="space-y-0.5">
    <li
      v-for="r in shown"
      :key="r.key"
      class="flex items-baseline gap-2 rounded px-1 py-0.5 hover:bg-muted/50"
      :title="r.key"
    >
      <span
        class="w-9 shrink-0 truncate rounded-xs bg-muted px-1 py-px text-center font-mono text-3xs uppercase leading-4 text-muted-foreground"
      >{{ r.ext || '·' }}</span>
      <span class="min-w-0 flex-1 truncate">
        <span class="text-xs font-medium">{{ r.name }}</span>
        <span v-if="r.where" class="ms-1.5 text-2xs text-muted-foreground">{{ r.where }}</span>
      </span>
      <span
        v-if="r.count > 1"
        class="shrink-0 rounded-full bg-muted px-1.5 text-3xs tabular-nums text-muted-foreground"
      >&times;{{ r.count }}</span>
      <span class="shrink-0 text-3xs tabular-nums text-muted-foreground">
        {{ r.ts ? timeAgo(r.ts) : '' }}
      </span>
    </li>
    <li v-if="rows.length > TOP" class="px-1">
      <button
        type="button"
        class="text-2xs font-medium text-muted-foreground hover:text-foreground hover:underline"
        @click="expanded = !expanded"
      >
        {{ expanded ? $t('analytics.showLess') : $t('analytics.showMore', { n: rows.length - TOP }) }}
      </button>
    </li>
  </ul>
</template>

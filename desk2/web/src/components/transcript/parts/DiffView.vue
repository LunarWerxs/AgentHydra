<script setup lang="ts">
import { computed } from 'vue'
import { collapseContext, type Diff } from '../lib/diff'
import { useTranscript } from '../context'

const props = defineProps<{ id: string; diff: Diff; maxLines?: number }>()
const ctx = useTranscript()
const key = computed(() => `${props.id}:all`)
const rows = computed(() => collapseContext(props.diff.lines, 3))
const limit = computed(() => props.maxLines ?? 80)
const shown = computed(() => (ctx.isOpen(key.value) ? rows.value : rows.value.slice(0, limit.value)))
</script>

<template>
  <div class="code-scroll overflow-x-auto font-mono text-[12px] leading-4.75">
    <table class="w-full border-collapse">
      <tbody>
        <template v-for="(l, i) in shown" :key="i">
          <tr v-if="l === null" class="text-text-muted">
            <td class="w-10 select-none px-2 text-end">⋯</td>
            <td />
            <td />
          </tr>
          <tr
            v-else
            :class="
              l.type === 'add' ? 'bg-git-add/[0.12] text-text' : l.type === 'del' ? 'bg-git-del/[0.12] text-text' : 'text-text-2'
            "
          >
            <td class="w-10 select-none whitespace-nowrap px-2 text-end align-top text-text-muted">
              {{ l.type === 'del' ? l.oldNo : l.newNo }}
            </td>
            <td
              class="w-4 select-none align-top"
              :class="l.type === 'add' ? 'text-git-add' : l.type === 'del' ? 'text-git-del' : ''"
            >{{ l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ' }}</td>
            <td class="whitespace-pre-wrap break-all pe-3">{{ l.text || ' ' }}</td>
          </tr>
        </template>
      </tbody>
    </table>
    <div v-if="rows.length > limit" class="border-t border-border px-3 py-1 text-[12px] text-text-muted">
      <button type="button" class="text-text-muted hover:text-text" @click="ctx.toggle(key)">
        {{ ctx.isOpen(key) ? 'Show less' : `Show all (${rows.length} lines)` }}
      </button>
    </div>
  </div>
</template>

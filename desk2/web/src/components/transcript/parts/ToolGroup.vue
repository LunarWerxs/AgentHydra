<script setup lang="ts">
// A run of tool calls folded into one status row, as the real app draws it: "Ran 3 commands, read
// screen-half.png" in muted 14px, targets in primary text, a 12px chevron. Open, it lists each call
// (a CliMayte call with its task and worker card) as the rows of one rounded box split by hairlines, as Claude
// Desktop draws a run's steps (owner, 2026-10-08: "contained in a rounded-edged table"); a step opens inside
// the box, under its row. A thinking block of the run is one of its steps: a run is every tool call and thinking
// block with nothing else between them (owner, 2026-10-08: seven status rows between two paragraphs became one).
import { computed } from 'vue'
import { useTranscript } from '../context'
import { toolSummary, type RunItem, type TaskItem } from '../lib/groups'
import { toolFamily } from '../lib/tools'
import CliMayteCard from './CliMayteCard.vue'
import StatusRow from './StatusRow.vue'
import ThinkingRow from './ThinkingRow.vue'
import ToolRow from './ToolRow.vue'
import TaskGroup from './TaskGroup.vue'
import Collapse from './Collapse.vue'

const props = defineProps<{ id: string; items: RunItem[]; tasks?: TaskItem[] }>()
const ctx = useTranscript()
const open = computed(() => ctx.isOpen(props.id))
const sum = computed(() => toolSummary(props.items, ctx.cwd.value, props.tasks))
</script>

<template>
  <div>
    <StatusRow :open="open" :running="sum.running" @toggle="ctx.toggle(id)">
      <!-- one line: template whitespace would show as stray spaces -->
      <span class="min-w-0 truncate" :class="sum.running && 'tx-shimmer'"><template v-for="(p, i) in sum.phrases" :key="i">{{ i ? ', ' : '' }}{{ p.text }}{{ p.target ? ' ' : '' }}<span v-if="p.target" class="tx-target ms-0.75">{{ p.target }}</span>{{ p.after ? ' ' + p.after : '' }}</template></span>
      <template #after>
        <span v-if="sum.added || sum.removed" class="shrink-0 font-mono text-[12px] tabular-nums">
          <span class="text-git-add">+{{ sum.added }}</span>
          <span v-if="sum.removed" class="ms-1 text-git-del">-{{ sum.removed }}</span>
        </span>
      </template>
    </StatusRow>
    <Collapse :open="open">
      <div class="tx-steps mb-1 mt-1.5">
        <template v-for="t in items" :key="t.id">
          <ThinkingRow v-if="t.kind === 'thinking'" :id="t.id" :text="t.text" :streaming="t.streaming" step />
          <CliMayteCard v-else-if="toolFamily(t.name) === 'climayte'" :item="t" step />
          <ToolRow v-else :item="t" step />
        </template>
        <TaskGroup v-if="tasks?.length" :id="`${id}:tasks`" :items="tasks" step />
      </div>
    </Collapse>
  </div>
</template>

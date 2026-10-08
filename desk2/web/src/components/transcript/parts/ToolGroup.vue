<script setup lang="ts">
// A run of tool calls folded into one status row, as the real app draws it: "Ran 3 commands, read
// screen-half.png" in muted 14px, targets in primary text, a 12px chevron. Open, it lists each call
// (a CliMayte call with its task and worker card).
import { computed } from 'vue'
import { useTranscript } from '../context'
import { toolSummary, type TaskItem, type ToolItem } from '../lib/groups'
import { toolFamily } from '../lib/tools'
import CliMayteCard from './CliMayteCard.vue'
import StatusRow from './StatusRow.vue'
import ToolRow from './ToolRow.vue'
import TaskGroup from './TaskGroup.vue'

const props = defineProps<{ id: string; items: ToolItem[]; tasks?: TaskItem[] }>()
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
    <div v-if="open" class="mb-1 mt-1.5 flex flex-col gap-0.5 border-s border-border ps-3 ms-1">
      <template v-for="t in items" :key="t.id">
        <CliMayteCard v-if="toolFamily(t.name) === 'climayte'" :item="t" />
        <ToolRow v-else :item="t" />
      </template>
      <TaskGroup v-if="tasks?.length" :id="`${id}:tasks`" :items="tasks" />
    </div>
  </div>
</template>

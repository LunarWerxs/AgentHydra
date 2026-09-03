<script setup lang="ts">
// Port of dashboard.html's planTable(): the incomplete warning, the active-filter line, the
// residence-rule doctrine, then the per-chat table. Clicking a row toggles an evidence row
// below it, same as the original tr.clickable + tr.evidence pair.
import { reactive } from 'vue'
import AccountCell from '@/components/AccountCell.vue'
import KindBadge from '@/components/KindBadge.vue'
import OriginCell from '@/components/OriginCell.vue'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { type DecisionKind, KINDS, type Plan, rel, STATE_ICON } from '@/lib/api'

const props = defineProps<{ plan: Plan; filter: DecisionKind | null }>()
const emit = defineEmits<{ clearFilter: [] }>()

const open = reactive(new Set<string>())
function toggle(id: string): void {
  if (open.has(id)) open.delete(id)
  else open.add(id)
}

function rows() {
  return props.plan.chats.filter((ch) => !props.filter || ch.decision.kind === props.filter)
}
</script>

<template>
  <div class="space-y-2">
    <p v-if="!plan.complete" class="text-xs text-destructive">
      ⚠ INCOMPLETE: {{ plan.incompleteWhy }} — the zeros above are lower bounds.
    </p>
    <p v-if="filter" class="text-xs">
      Filtered to <b>{{ KINDS[filter]?.label ?? filter }}</b> —
      <Button variant="link" size="xs" class="h-auto p-0 align-baseline" @click="emit('clearFilter')">show all {{ plan.chats.length }}</Button>
    </p>
    <p class="text-xs text-muted-foreground">
      Residence rule: a chat with a desktop home stays in the desktop; console-only sessions may stay console, but
      the ones waiting on you are listed as land-in-desktop suggestions under Accounts above.
    </p>

    <div class="overflow-x-auto rounded-lg border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Chat</TableHead>
            <TableHead>Origin</TableHead>
            <TableHead>Instance · account</TableHead>
            <TableHead>State</TableHead>
            <TableHead>What I'd do</TableHead>
            <TableHead>Why</TableHead>
            <TableHead>Do it (terminal)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <template v-if="rows().length">
            <template v-for="ch in rows()" :key="ch.sessionId">
              <TableRow class="cursor-pointer" @click="toggle(ch.sessionId)">
                <TableCell class="whitespace-normal">
                  <div class="font-semibold">{{ ch.title ?? '(untitled)' }}</div>
                  <div class="text-[11px] text-muted-foreground">
                    {{ rel(ch.lastActivityAt) }}<span v-if="ch.evidence && ch.evidence.trim()"> · click for its last words</span>
                  </div>
                </TableCell>
                <TableCell class="whitespace-normal"><OriginCell :chat="ch" /></TableCell>
                <TableCell class="whitespace-normal"><AccountCell :account="ch.account" :instance="ch.instance" /></TableCell>
                <TableCell>{{ STATE_ICON[ch.state] ?? '•' }} {{ ch.state }}</TableCell>
                <TableCell class="whitespace-normal">
                  <KindBadge :kind="ch.decision.kind" />
                  <div class="mt-1 text-xs">{{ ch.decision.action }}</div>
                </TableCell>
                <TableCell class="whitespace-normal text-xs">{{ ch.decision.detail || ch.cause || '' }}</TableCell>
                <TableCell class="whitespace-normal">
                  <span v-if="ch.decision.command" class="cmd">{{ ch.decision.command }}</span>
                  <span v-else class="text-muted-foreground">—</span>
                </TableCell>
              </TableRow>
              <TableRow v-if="open.has(ch.sessionId)" class="bg-muted/40 hover:bg-muted/40">
                <TableCell colspan="7" class="whitespace-normal">
                  <pre class="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-muted-foreground">{{ ch.evidence || '' }}</pre>
                </TableCell>
              </TableRow>
            </template>
          </template>
          <TableRow v-else>
            <TableCell colspan="7" class="text-muted-foreground">nothing in this lane</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  </div>
</template>

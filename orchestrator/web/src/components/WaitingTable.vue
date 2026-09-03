<script setup lang="ts">
// Port of dashboard.html's waitingTable(): chats whose decision is wait-on-person or judgment.
import { computed } from 'vue'
import AccountCell from '@/components/AccountCell.vue'
import KindBadge from '@/components/KindBadge.vue'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { type Plan, rel } from '@/lib/api'

const props = defineProps<{ plan: Plan }>()

const rows = computed(() =>
  props.plan.chats.filter(
    (ch) => ch.decision.kind === 'wait-on-person' || ch.decision.kind === 'judgment',
  ),
)

function tail(evidence: string): string {
  return (evidence || '').split('\n').slice(-6).join('\n')
}
</script>

<template>
  <p v-if="!rows.length" class="text-sm">
    No chat is waiting on you<template v-if="plan.complete"> — full transcript tails were read, so that is an
      answer, not a guess.</template><template v-else>, but the scan was incomplete.</template>
  </p>
  <div v-else class="overflow-x-auto rounded-lg border border-border bg-card">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Chat</TableHead>
          <TableHead>Instance · account</TableHead>
          <TableHead>Why it waits</TableHead>
          <TableHead>Its last words (tail)</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="ch in rows" :key="ch.sessionId">
          <TableCell class="whitespace-normal">
            <div class="font-semibold">{{ ch.title ?? '(untitled)' }}</div>
            <div class="text-[11px] text-muted-foreground">{{ rel(ch.lastActivityAt) }}</div>
          </TableCell>
          <TableCell class="whitespace-normal"><AccountCell :account="ch.account" :instance="ch.instance" /></TableCell>
          <TableCell class="whitespace-normal">
            <KindBadge :kind="ch.decision.kind" />
            <div class="mt-1 text-xs">{{ ch.decision.action }}</div>
          </TableCell>
          <TableCell class="whitespace-normal text-xs">
            <pre class="whitespace-pre-wrap font-mono text-[12px] leading-relaxed">{{ tail(ch.evidence) }}</pre>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>

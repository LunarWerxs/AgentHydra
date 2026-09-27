<script setup lang="ts">
// Port of dashboard.html's suppressedTable(): the holds block (owner's hands-off switch) and
// the breaker block (futile-repetition suppression).
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { SuppressedData } from '@/lib/api'

defineProps<{ data: SuppressedData }>()
</script>

<template>
  <div class="space-y-5">
    <div>
      <h3 class="mb-2 text-sm font-semibold">
        🔒 On hold — the owner's hands-off switch (outranks every verdict; --force still works)
      </h3>
      <div v-if="data.holds.length" class="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Chat</TableHead>
              <TableHead>Why</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="(h, i) in data.holds" :key="`${h.session}-${i}`">
              <TableCell class="whitespace-normal"><div class="font-mono">{{ h.session }}</div></TableCell>
              <TableCell class="whitespace-normal"><div class="text-xs">{{ h.why || h.reason }}</div></TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      <p v-else class="text-xs text-muted-foreground">
        No chat is on hold. Put one out of automation's reach with:
        <span class="cmd">python scripts/hold_chat.py &lt;chat&gt; --reason "why"</span>
      </p>
    </div>

    <div>
      <template v-if="!data.suppressed.length">
        <p class="text-sm">Nothing is suppressed — the breaker has no futile loop to stop right now.</p>
      </template>
      <template v-else>
        <h3 class="mb-2 text-sm font-semibold">⏸ Held back by the breaker (futile repetition)</h3>
        <div class="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Act</TableHead>
                <TableHead>Chat / target id</TableHead>
                <TableHead class="text-end">Attempts</TableHead>
                <TableHead>Why</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="(s, i) in data.suppressed" :key="`${s.session}-${i}`">
                <TableCell>{{ s.kind }}</TableCell>
                <TableCell class="whitespace-normal"><div class="font-mono">{{ s.session }}</div></TableCell>
                <TableCell class="text-end">{{ s.attempts ?? '?' }}</TableCell>
                <TableCell class="whitespace-normal"><div class="text-xs">{{ s.why }}</div></TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </template>
    </div>
  </div>
</template>

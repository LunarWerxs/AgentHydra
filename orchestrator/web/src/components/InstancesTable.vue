<script setup lang="ts">
// Port of dashboard.html's instancesTable().
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { InstancesData } from '@/lib/api'

defineProps<{ data: InstancesData }>()
</script>

<template>
  <div class="overflow-x-auto rounded-lg border border-border bg-card">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>#</TableHead>
          <TableHead>Instance</TableHead>
          <TableHead>Open</TableHead>
          <TableHead>Account</TableHead>
          <TableHead>Plan</TableHead>
          <TableHead class="text-right">Weekly %</TableHead>
          <TableHead class="text-right">Visible chats</TableHead>
          <TableHead>Signed in</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="i in data.instances" :key="`${i.num ?? '?'}-${i.name}`">
          <TableCell class="font-mono">{{ i.num ?? '?' }}</TableCell>
          <TableCell class="whitespace-normal">
            <div class="font-semibold">{{ i.name || '(unnamed)' }}</div>
            <div class="text-[11px] text-muted-foreground">{{ i.dir ?? '' }}</div>
          </TableCell>
          <TableCell>{{ i.isRunning ? '🟢 open' : '◦ closed' }}</TableCell>
          <TableCell class="text-xs">{{ i.email ?? '?' }}</TableCell>
          <TableCell class="text-xs">{{ i.plan ?? '?' }}</TableCell>
          <TableCell class="text-right">{{ i.weeklyPct ?? '—' }}</TableCell>
          <TableCell class="text-right">{{ i.visibleChats }}</TableCell>
          <TableCell>{{ i.signedIn ? 'yes' : '⚠ SIGNED OUT' }}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>

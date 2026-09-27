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
          <TableHead class="text-end">Weekly %</TableHead>
          <TableHead class="text-end">Visible chats</TableHead>
          <TableHead>Signed in</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="i in data.instances" :key="`${i.num ?? '?'}-${i.name}`">
          <TableCell><div class="font-mono">{{ i.num ?? '?' }}</div></TableCell>
          <TableCell class="whitespace-normal">
            <div class="font-semibold">{{ i.name || '(unnamed)' }}</div>
            <div class="text-2xs text-muted-foreground">{{ i.dir ?? '' }}</div>
          </TableCell>
          <TableCell>{{ i.isRunning ? '🟢 open' : '◦ closed' }}</TableCell>
          <TableCell><div class="text-xs">{{ i.email ?? '?' }}</div></TableCell>
          <TableCell><div class="text-xs">{{ i.plan ?? '?' }}</div></TableCell>
          <TableCell class="text-end">{{ i.weeklyPct ?? '—' }}</TableCell>
          <TableCell class="text-end">{{ i.visibleChats }}</TableCell>
          <TableCell>{{ i.signedIn ? 'yes' : '⚠ SIGNED OUT' }}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>

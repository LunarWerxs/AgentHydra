<script setup lang="ts">
// Port of dashboard.html's chatsTable().
import AccountCell from '@/components/AccountCell.vue'
import OriginCell from '@/components/OriginCell.vue'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { type ChatsData, rel } from '@/lib/api'

defineProps<{ data: ChatsData }>()
</script>

<template>
  <div class="space-y-2">
    <p class="text-xs">
      {{ data.total }} chats total. The preview column is the daemon's ~140-char cut — the Plan and Waiting views
      read the REAL transcript tails instead.
    </p>
    <div class="overflow-x-auto rounded-lg border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Chat</TableHead>
            <TableHead>Origin</TableHead>
            <TableHead>Instance · account</TableHead>
            <TableHead>Archived</TableHead>
            <TableHead>Last activity</TableHead>
            <TableHead>Preview (truncated by the daemon)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="ch in data.chats" :key="ch.sessionId">
            <TableCell class="whitespace-normal font-semibold">{{ ch.title ?? '(untitled)' }}</TableCell>
            <TableCell class="whitespace-normal"><OriginCell :chat="ch" /></TableCell>
            <TableCell class="whitespace-normal"><AccountCell :account="ch.account" :instance="ch.instance" /></TableCell>
            <TableCell>{{ ch.archived ? '🗄 yes' : '👁 visible' }}</TableCell>
            <TableCell class="text-xs">{{ rel(ch.lastActivityAt) }}</TableCell>
            <TableCell class="whitespace-normal text-xs text-muted-foreground">{{ ch.preview }}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  </div>
</template>

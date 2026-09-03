<script setup lang="ts">
// Port of dashboard.html's renderRules(): one heading + table per section.
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { RulesData } from '@/lib/api'

defineProps<{ data: RulesData }>()
</script>

<template>
  <div class="space-y-5">
    <div v-for="s in data.sections" :key="s.title">
      <h3 class="mb-2 text-sm font-semibold">{{ s.title }}</h3>
      <div class="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead class="w-[32%]">If</TableHead>
              <TableHead class="w-[36%]">Then</TableHead>
              <TableHead>Configured value (live, from the code)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="(r, i) in s.rules" :key="i">
              <TableCell class="whitespace-normal text-xs">{{ r.if }}</TableCell>
              <TableCell class="whitespace-normal text-xs">{{ r.then }}</TableCell>
              <TableCell class="whitespace-normal font-mono text-xs">{{ r.value }}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </div>
  </div>
</template>

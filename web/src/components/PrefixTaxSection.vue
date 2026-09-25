<script setup lang="ts">
// Prefix tax: what every spawn on each Claude/Codex home re-ships before it says a word - tool
// count, MCP tool count, schema kB and the MCP servers that weigh the most.
//
// WHY: a worker pays its home's whole MCP loadout on its first request, and a fan-out pays it once
// per worker. This makes a bloated loadout visible BEFORE fanning out. Measuring runs the home's
// harness against a loopback sink (server/src/prefix-tax.ts): no model, no quota, but it does boot
// that home's MCP servers, so it only ever runs on a click and the section starts collapsed.
import { ChevronDown, Gauge, RefreshCw } from '@lucide/vue'
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import ExpandArea from '@/components/ExpandArea.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { getPrefixTax, measurePrefixTax, type PrefixTaxHome } from '@/lib/api'

const { t } = useI18n()

const rows = ref<PrefixTaxHome[]>([])
const running = ref<string | null>(null)
const open = ref(false)
const busy = ref(false)

const kb = (bytes: number) => t('prefixTax.kb', { kb: (bytes / 1024).toFixed(1) })

async function refresh(): Promise<void> {
  try {
    const r = await getPrefixTax()
    rows.value = r.rows
    running.value = r.running
  } catch {
    // Keep the last readings on screen; a dropped poll is not "no homes".
  }
}

async function measure(ref?: string): Promise<void> {
  busy.value = true
  running.value = ref ?? rows.value[0]?.ref ?? null
  try {
    const r = await measurePrefixTax(ref)
    const failed = r.rows.filter((row) => !row.tax).length
    if (failed) toast.error(t('prefixTax.someFailed', { count: failed }))
    else toast.success(t('prefixTax.measured', { count: r.rows.length }))
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err))
  } finally {
    busy.value = false
    await refresh()
  }
}

onMounted(() => void refresh())
</script>

<template>
  <div class="mt-6">
    <div class="mb-2 flex items-center gap-2">
      <button
        type="button"
        class="flex cursor-pointer items-center gap-1.5 font-medium text-sm"
        @click="open = !open"
      >
        <ChevronDown class="size-4 transition-transform" :class="open ? '' : '-rotate-90'" />
        {{ $t('prefixTax.title') }}
        <span class="text-muted-foreground text-xs">({{ rows.length }})</span>
      </button>
      <div class="ms-auto flex items-center gap-1">
        <Button variant="ghost" size="sm" :aria-label="$t('prefixTax.refresh')" @click="refresh">
          <RefreshCw class="size-3.5" />
        </Button>
        <Button size="sm" :disabled="busy" :title="$t('prefixTax.measureAllHint')" @click="measure()">
          <Gauge class="size-3.5" />{{ busy ? $t('prefixTax.measuring') : $t('prefixTax.measureAll') }}
        </Button>
      </div>
    </div>

    <ExpandArea :open="open">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead class="w-44">{{ $t('prefixTax.colName') }}</TableHead>
            <TableHead class="w-24">{{ $t('prefixTax.colTools') }}</TableHead>
            <TableHead class="w-24">{{ $t('prefixTax.colSchemas') }}</TableHead>
            <TableHead class="w-24">{{ $t('prefixTax.colPrefix') }}</TableHead>
            <TableHead>{{ $t('prefixTax.colHeaviest') }}</TableHead>
            <TableHead class="text-end">{{ $t('prefixTax.colActions') }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody v-if="rows.length === 0">
          <TableEmpty :colspan="6">
            <p class="text-xs text-muted-foreground">{{ $t('prefixTax.empty') }}</p>
          </TableEmpty>
        </TableBody>
        <TableBody v-else>
          <TableRow v-for="row in rows" :key="row.ref">
            <TableCell class="font-medium">
              <div class="flex items-center gap-1.5" :title="row.home">
                <span>{{ row.name }}</span>
                <Badge variant="outline">
                  {{ row.kind === 'codex' ? $t('prefixTax.kindCodex') : $t('prefixTax.kindClaude') }}
                </Badge>
              </div>
            </TableCell>
            <template v-if="row.reading?.tax">
              <TableCell class="text-xs">
                {{ $t('prefixTax.tools', { tools: row.reading.tax.tools, mcp: row.reading.tax.mcpTools }) }}
              </TableCell>
              <TableCell class="text-xs" :title="$t('prefixTax.mcpShare', { kb: kb(row.reading.tax.mcpToolBytes) })">
                {{ kb(row.reading.tax.toolBytes) }}
              </TableCell>
              <TableCell class="text-xs" :title="$t('prefixTax.prefixHint')">
                {{ $t('prefixTax.tokens', { tokens: row.reading.tax.approxTokens.toLocaleString() }) }}
              </TableCell>
              <TableCell class="text-xs text-muted-foreground">
                <span v-if="row.reading.tax.byServer.length === 0">{{ $t('prefixTax.noMcp') }}</span>
                <span
                  v-for="s in row.reading.tax.byServer.slice(0, 3)"
                  v-else
                  :key="s.server"
                  class="me-2 whitespace-nowrap"
                >
                  {{ $t('prefixTax.server', { server: s.server, kb: kb(s.bytes), tools: s.tools }) }}
                </span>
              </TableCell>
            </template>
            <TableCell v-else colspan="4" class="text-xs text-muted-foreground">
              {{ row.reading?.error ?? $t('prefixTax.notMeasured') }}
            </TableCell>
            <TableCell>
              <div class="flex justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  :disabled="busy"
                  :title="$t('prefixTax.measureHint')"
                  @click="measure(row.ref)"
                >
                  {{ running === row.ref && busy ? $t('prefixTax.measuring') : $t('prefixTax.measure') }}
                </Button>
              </div>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </ExpandArea>
  </div>
</template>

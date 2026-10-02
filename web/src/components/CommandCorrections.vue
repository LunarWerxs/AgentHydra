<script setup lang="ts">
// Recurring mistakes: shell commands agents got wrong and then fixed, grouped by error kind and
// command with how often it happened (server/src/command-corrections.ts).
//
// Asked for on a click, not on every visit to the tab: unlike the totals above it, it opens
// transcripts, and a tab that reads a few hundred of them each time it is shown would be slow for a
// list that changes over days. "Copy as rules" is the point of it: a mistake that keeps coming back
// becomes a rules file the agents read, with the counts that justify it.
import { ClipboardCopy, RefreshCw, TriangleAlert } from '@lucide/vue'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { CommandErrorKind, CorrectionReport } from '@/lib/api'
import * as api from '@/lib/api'
import InfoHint from '@/shell/InfoHint.vue'

const { t } = useI18n()
const report = ref<CorrectionReport | null>(null)
const loading = ref(false)

const KIND_KEYS: Record<CommandErrorKind, string> = {
  'unknown-flag': 'analytics.mistakeUnknownFlag',
  'missing-arg': 'analytics.mistakeMissingArg',
  'wrong-path': 'analytics.mistakeWrongPath',
  'command-not-found': 'analytics.mistakeNotFound',
  'permission-denied': 'analytics.mistakePermission',
}

async function scan() {
  loading.value = true
  try {
    report.value = await api.getCommandCorrections()
  } catch {
    toast.error(t('analytics.mistakesFailed'))
  } finally {
    loading.value = false
  }
}

// The toast waits for the write: see CopyResetDate.vue for why a fire-and-forget copy lies.
async function copyRules() {
  const markdown = report.value?.markdown
  if (!markdown) return
  try {
    if (!navigator.clipboard) throw new Error('no clipboard in this context')
    await navigator.clipboard.writeText(markdown)
    toast.success(t('analytics.mistakesCopied'))
  } catch {
    toast.error(t('analytics.mistakesCopyFailed'))
  }
}
</script>

<template>
  <section class="rounded-lg border border-border p-3">
    <h3 class="mb-1 flex items-center gap-1.5 text-xs font-medium">
      <TriangleAlert class="size-3.5" />{{ $t('analytics.mistakes') }}
      <InfoHint :text="$t('analytics.mistakesNote')" />
      <span class="ms-auto flex gap-1">
        <Button
          v-if="report?.groups.length"
          size="sm"
          variant="outline"
          @click="copyRules"
        >
          <ClipboardCopy class="size-3" /><span class="text-2xs">{{ $t('analytics.mistakesCopy') }}</span>
        </Button>
        <Button
          size="sm"
          variant="outline"
          :disabled="loading"
          @click="scan"
        >
          <RefreshCw class="size-3" :class="{ 'animate-spin': loading }" />
          <span class="text-2xs">{{ report ? $t('analytics.mistakesRescan') : $t('analytics.mistakesScan') }}</span>
        </Button>
      </span>
    </h3>
    <template v-if="report">
      <p class="mb-2 text-2xs text-muted-foreground">
        {{
          report.budgetExhausted
            ? $t('analytics.mistakesCoveragePartial', { n: report.scanned, total: report.total })
            : $t('analytics.mistakesCoverage', { n: report.scanned, total: report.total })
        }}
      </p>
      <p v-if="!report.groups.length" class="text-2xs text-muted-foreground">
        {{ $t('analytics.mistakesNone') }}
      </p>
      <ul v-else class="scroll-slim max-h-96 space-y-2 overflow-y-auto">
        <li v-for="g in report.groups" :key="`${g.kind}:${g.base}`" class="text-2xs">
          <p class="flex items-center gap-2">
            <code class="font-mono font-medium">{{ g.base }}</code>
            <Badge variant="outline" class="shrink-0">
              <span class="font-normal">{{ $t(KIND_KEYS[g.kind]) }}</span>
            </Badge>
            <span class="ms-auto shrink-0 tabular-nums text-muted-foreground">
              {{ $t('analytics.mistakesCount', { n: g.count, sessions: g.sessions }) }}
            </span>
          </p>
          <ul class="mt-0.5 space-y-0.5 ps-3">
            <li
              v-for="ex in g.examples"
              :key="`${ex.wrong} -> ${ex.right}`"
              class="min-w-0 font-mono text-3xs"
              :title="ex.error"
            >
              <span class="block truncate text-destructive">{{ ex.wrong }}</span>
              <span class="block truncate">{{ ex.right }}</span>
            </li>
          </ul>
        </li>
      </ul>
    </template>
  </section>
</template>

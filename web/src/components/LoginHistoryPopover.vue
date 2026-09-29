<script setup lang="ts">
// The account cell's history button: every account this desktop profile has been signed into, the
// signed-in one first, then newest first (server: core/login-history.ts). It answers the question a
// row reading "(not logged in)" or "(unknown account)" raises, which is where its account went,
// without opening the profile folder (owner ask, 2026-09-29, about #75).
//
// Fetched each time the flyout opens, never with the table: it walks one profile's chat store,
// which is cheap for the row you asked about and waste for the seventy you did not.
import { History } from '@lucide/vue'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Badge } from '@/components/ui/badge'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { type CMLoginHistory, type CMLoginHistoryEntry, getInstanceLoginHistory } from '@/lib/api'
import { timeAgo } from '@/lib/format'
import IconTooltip from '@/shell/IconTooltip.vue'

const props = defineProps<{ dir: string; num: number }>()
const { t } = useI18n()

const history = ref<CMLoginHistory | null>(null)
const failed = ref(false)

async function load(open: boolean) {
  if (!open) return
  failed.value = false
  try {
    history.value = await getInstanceLoginHistory(props.dir)
  } catch {
    failed.value = true
  }
}

/** The address when this machine ever identified the account; its short id when it never did. */
function who(e: CMLoginHistoryEntry): string {
  return e.email ?? e.name ?? t('instances.loginHistoryUnknown', { id: e.accountUuid.slice(0, 8) })
}

function detail(e: CMLoginHistoryEntry): string {
  // No chats under an account that is not signed in means they were moved out of this profile.
  const used = e.lastSeenAt
    ? t('instances.loginHistoryLastUsed', { when: timeAgo(e.lastSeenAt), count: e.chats }, e.chats)
    : t(e.current ? 'instances.loginHistoryNoChats' : 'instances.loginHistoryChatsMoved')
  return e.planLabel ? `${e.planLabel} · ${used}` : used
}

const numbers = (nums: number[]) => nums.map((n) => `#${n}`).join(', ')

/** Instances it passed through and has since left: where to look for an account with no name. */
const usedBefore = (e: CMLoginHistoryEntry) => e.usedOn.filter((n) => !e.signedInOn.includes(n))

/** With nobody signed in, the top entry is the account the profile was on last: the one to name. */
function isLastSignedIn(index: number): boolean {
  return index === 0 && !history.value?.entries.some((e) => e.current)
}
</script>

<template>
  <!-- Popover root INSIDE the tooltip's slot, wrapped in a plain element: see the note in
       InstanceFilterMenu.vue (reka anchors the popper to the nearest root). -->
  <IconTooltip
    :label="$t('instances.loginHistoryTitle', { num })"
    :description="$t('instances.loginHistoryHint')"
  >
    <span class="inline-flex">
      <Popover @update:open="load">
        <PopoverTrigger as-child>
          <button
            type="button"
            class="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :aria-label="$t('instances.loginHistoryTitle', { num })"
          >
            <History class="size-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" flush class="w-80">
          <div class="space-y-2 p-3">
            <h2 class="text-sm font-semibold text-foreground">
              {{ $t('instances.loginHistoryTitle', { num }) }}
            </h2>
            <p v-if="failed" class="text-xs text-destructive">
              {{ $t('instances.loginHistoryFailed') }}
            </p>
            <p v-else-if="!history" class="text-xs text-muted-foreground">
              {{ $t('instances.resolving') }}
            </p>
            <template v-else>
              <p v-if="history.loginState !== 'signed-in'" class="text-xs text-warning">
                {{ $t('instances.loginHistorySignedOut') }}
              </p>
              <!-- The list is capped with its own scroller: a profile that has hosted a dozen
                   accounts would otherwise run the flyout off the bottom of the window. -->
              <p v-if="history.entries.length === 0" class="text-xs text-muted-foreground">
                {{ $t('instances.loginHistoryEmpty') }}
              </p>
              <ol v-else class="max-h-80 space-y-1.5 overflow-y-auto">
                <li
                  v-for="(e, i) in history.entries"
                  :key="e.accountUuid"
                  class="rounded-md border border-border bg-background/60 px-2.5 py-1.5"
                >
                  <div class="flex items-center gap-2">
                    <span
                      class="min-w-0 flex-1 truncate text-sm text-foreground"
                      :title="e.name && e.email ? `${e.name} <${e.email}>` : e.accountUuid"
                    >
                      {{ who(e) }}
                    </span>
                    <Badge v-if="e.current" variant="success">
                      {{ $t('instances.loginHistoryNow') }}
                    </Badge>
                    <Badge v-else-if="isLastSignedIn(i)" variant="warning">
                      {{ $t('instances.loginHistoryLast') }}
                    </Badge>
                  </div>
                  <div class="text-xs text-muted-foreground">{{ detail(e) }}</div>
                  <div v-if="e.signedInOn.length" class="text-xs font-medium text-primary">
                    {{ $t('instances.loginHistorySignedInOn', { nums: numbers(e.signedInOn) }) }}
                  </div>
                  <div v-if="usedBefore(e).length" class="text-xs text-muted-foreground">
                    {{ $t('instances.loginHistoryUsedOn', { nums: numbers(usedBefore(e)) }) }}
                  </div>
                </li>
              </ol>
              <p class="text-xs text-muted-foreground">{{ $t('instances.loginHistoryFootnote') }}</p>
            </template>
          </div>
        </PopoverContent>
      </Popover>
    </span>
  </IconTooltip>
</template>

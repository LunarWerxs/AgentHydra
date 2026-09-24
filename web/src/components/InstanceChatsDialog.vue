<script setup lang="ts">
import { ArrowRightLeft } from '@lucide/vue'
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import type { ChatListResult, ChatListRow, CMInstance } from '@/lib/api'
import { getInstanceChats } from '@/lib/api'
import { baseName, timeAgo } from '@/lib/format'
import { displayName } from '@/lib/instance-appearance'

// --- what chats are ON this account --------------------------------------------------------------
// The read that used to require opening the account (owner, 2026-09-07). The move submenu answers
// "send them somewhere"; this answers the question you have to settle FIRST on a fleet of near
// -identically named rows - which account is holding the chat you are looking for.
//
// Deliberately reads /api/chats, the account's own store, and NOT the session list: a session
// listing is scoped by period and by the instance NAME a transcript happens to record, so a chat
// nobody has touched this week simply is not in it. That would make an account with twenty chats
// look empty, which is the one wrong answer this panel must never give.
const open = defineModel<boolean>('open', { default: false })
const props = defineProps<{
  /** The row whose chats are being read; null while the dialog is closed. */
  instance: CMInstance | null
}>()

const emit = defineEmits<{
  /** A chat with a CLI transcript was clicked: the parent lands on it in Sessions. */
  openChat: [row: ChatListRow]
}>()

const { t } = useI18n()
const busy = ref(false)
const error = ref<string | null>(null)
const rows = ref<ChatListRow[]>([])
const total = ref(0)
const counts = ref<ChatListResult['counts'] | null>(null)
// Archived is the resting state of a Claude Desktop chat and therefore the majority of any
// account, so the list opens on the active ones and says how many it is not showing.
const showArchived = ref(false)
const CHATS_PAGE = 200

// Which load is the current one. Guarding by instance dir alone is not enough: toggling "Include
// archived" twice quickly issues two loads for the SAME row, and the store scan is slow enough
// (~1300 files) that they can land in either order - so the list could settle on the reply that
// disagrees with the checkbox. A monotonic id means only the newest load may write.
let request = 0

const instLabel = (i: CMInstance) => displayName(i)

async function loadChats(inst: CMInstance) {
  const seq = ++request
  const mine = () => request === seq && props.instance?.dir === inst.dir
  busy.value = true
  error.value = null
  try {
    // `desktop:<dir>` is the one spelling that cannot be ambiguous: a label and an account name
    // are both user-editable and two rows may share either. The server maps it to the chat-store
    // label, including the default install's literal `default` (see chatStoreLabel in
    // server/src/routes/sessions.ts).
    const got = await getInstanceChats(
      `desktop:${inst.dir}`,
      showArchived.value ? 'include' : 'hide',
      CHATS_PAGE,
    )
    // A slower reply for a row the user has since closed or swapped, or for a filter they have
    // since changed, must not overwrite the one they are looking at now.
    if (!mine()) return
    rows.value = got.rows
    total.value = got.total
    counts.value = got.counts
  } catch (e) {
    if (!mine()) return
    rows.value = []
    total.value = 0
    counts.value = null
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (mine()) busy.value = false
  }
}

function close() {
  open.value = false
}

// Opening resets the filter and clears what the previous row was holding; closing bumps the guard
// so nothing in flight may write into the next dialog that opens.
watch(
  () => (open.value ? props.instance : null),
  (inst) => {
    if (!inst) {
      request++
      busy.value = false
      return
    }
    rows.value = []
    total.value = 0
    counts.value = null
    // Reset the filter BEFORE the load, and let the watcher below own the fetch when this actually
    // changes the value: setting it and then loading here as well means an open with the toggle
    // left on pays for two identical full store scans.
    if (showArchived.value) showArchived.value = false
    else void loadChats(inst)
  },
  { immediate: true },
)

// Re-reads on the toggle rather than filtering what is already loaded: the archived chats were
// never fetched, and a client-side filter over a 200-row page would silently under-report an
// account holding two hundred of them.
watch(showArchived, () => {
  const inst = props.instance
  if (inst) void loadChats(inst)
})

/** A chat in the list, clicked: land on it in Sessions. Only reachable for a chat that HAS a CLI
 *  transcript - a Desktop-only row has no session for Sessions to show. */
function openChatFromList(row: ChatListRow) {
  if (!row.sessionId) return
  close()
  emit('openChat', row)
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-w-lg">
      <DialogHeader>
        <DialogTitle>
          {{ $t('instances.chatsTitle', { name: instance ? instLabel(instance) : '' }) }}
        </DialogTitle>
        <DialogDescription>
          <template v-if="counts">
            {{ $t('instances.chatsCounts', counts) }}
            <template v-if="counts.live > 0">
              · {{ $t('instances.chatsLiveCount', { n: counts.live }) }}
            </template>
            <!-- On disk, not in the app: filed under an account this profile is no longer
                 signed into (2026-09-18, #12). Loud, because nothing else on screen says so. -->
            <span v-if="counts.staleLogin > 0" class="font-medium text-destructive">
              · {{ $t('instances.chatsStaleLoginCount', { n: counts.staleLogin }) }}
            </span>
          </template>
          <template v-else-if="busy">{{ $t('instances.chatsLoading') }}</template>
        </DialogDescription>
      </DialogHeader>

      <label class="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
        <input v-model="showArchived" type="checkbox" class="size-3.5 accent-current" />
        {{ $t('instances.chatsShowArchived') }}
      </label>

      <p v-if="error" class="text-xs text-destructive">
        {{ $t('instances.chatsFailed', { name: instance ? instLabel(instance) : '' }) }}
        {{ error }}
      </p>
      <div v-else-if="busy" class="space-y-2">
        <Skeleton v-for="n in 4" :key="n" class="h-9 w-full" />
      </div>
      <p v-else-if="rows.length === 0" class="text-xs text-muted-foreground">
        {{ showArchived ? $t('instances.chatsEmptyArchived') : $t('instances.chatsEmpty') }}
      </p>
      <ul v-else class="scroll-slim max-h-80 space-y-1 overflow-y-auto text-xs">
        <li
          v-for="row in rows"
          :key="row.chatId ?? row.sessionId ?? row.title ?? ''"
          class="rounded border border-border px-2 py-1.5"
        >
          <div class="flex items-center gap-2">
            <span class="min-w-0 flex-1 truncate" :title="row.title ?? undefined">
              {{ row.title || $t('instances.chatsNoTitle') }}
            </span>
            <Badge v-if="row.live" variant="outline" class="shrink-0">
              {{ $t('instances.chatsLive') }}
            </Badge>
            <Badge v-if="row.isArchived" variant="secondary" class="shrink-0">
              {{ $t('instances.chatsArchivedBadge') }}
            </Badge>
            <Badge
              v-if="row.staleLogin"
              variant="destructive"
              class="shrink-0"
              :title="$t('instances.chatsStaleLoginHint')"
            >
              {{ $t('instances.chatsStaleLoginBadge') }}
            </Badge>
            <!-- Absent, not disabled, for a Desktop-only chat: there is no session to open. -->
            <button
              v-if="row.sessionId"
              type="button"
              class="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              :aria-label="$t('instances.chatsOpen')"
              :title="$t('instances.chatsOpen')"
              @click="openChatFromList(row)"
            >
              <ArrowRightLeft class="size-3.5" />
            </button>
          </div>
          <div class="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span v-if="row.cwd" class="truncate" :title="row.cwd">{{ baseName(row.cwd) }}</span>
            <span class="ms-auto shrink-0">
              {{ row.lastActivityAt ? timeAgo(row.lastActivityAt) : $t('instances.chatsNeverActive') }}
            </span>
          </div>
        </li>
      </ul>
      <p v-if="rows.length && total > rows.length" class="text-[11px] text-muted-foreground">
        {{ $t('instances.chatsTruncated', { shown: rows.length, total: total }) }}
      </p>

      <DialogFooter>
        <Button variant="ghost" @click="close">{{ $t('instances.chatsClose') }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

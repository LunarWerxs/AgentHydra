<script setup lang="ts">
import {
  CalendarClock,
  Cpu,
  ExternalLink,
  FolderGit2,
  Gauge,
  ListPlus,
  Minus,
  Plus,
  SendHorizonal,
  ShieldCheck,
  UserCircle2,
  UsersRound,
} from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { useAppSettings } from '@/composables/useAppSettings'
import { useData } from '@/composables/useData'
import { usePanels } from '@/composables/usePanels'
import * as api from '@/lib/api'
import { baseName, EFFORTS, MODELS, PERMISSION_MODES } from '@/lib/format'

export interface ComposerTarget {
  session_id: string
  title: string
  cwd: string
}

const props = defineProps<{ targets: ComposerTarget[] }>()
const emit = defineEmits<{ sent: [mode: 'now' | 'queued'] }>()

const { t } = useI18n()
const { queue, accounts, scheduler, refreshQueue } = useData()
const { queueOpen } = usePanels()
const { chatGptHandoffEnabled, load: loadAppSettings } = useAppSettings()
onMounted(loadAppSettings)

const text = ref('')
const model = ref('')
const effort = ref('')
const permission = ref('')
const accountId = ref('')
const cwdOverride = ref('')
const sending = ref(false)

const single = computed(() => (props.targets.length === 1 ? props.targets[0] : null))

// the cwd override is a per-session choice — never let it silently follow a selection change
watch(
  () => single.value?.session_id,
  () => {
    cwdOverride.value = ''
  },
)

// A session with a RUNNING queue run can't take a second concurrent `claude --resume`
// against the same transcript — "send now" to it degrades to a plain queue add.
const runningIds = computed(
  () => new Set(queue.value.filter((q) => q.status === 'running').map((q) => q.session_id)),
)
const anyBusy = computed(() => props.targets.some((tg) => runningIds.value.has(tg.session_id)))

/**
 * The busy hint is a warning about the message you are TYPING — so it only shows while there is
 * one. Without the text gate it fired on your own message the instant you sent it: submit() awaits
 * refreshQueue(), and the server doesn't answer until dispatchItem has already written
 * status='running', so `anyBusy` flips true inside the very same click that sent it. The banner
 * then announced "your message will queue and start on its own" about a message that had just
 * started running immediately — reading as a flat lie when nothing had been running at all.
 *
 * Gating on `text` fixes it because submit() clears the text in the same synchronous stretch as the
 * refresh, so Vue renders both facts at once and the hint never appears for the message just sent.
 * (That ordering is load-bearing: clearing `text` earlier — say, optimistically before the awaits —
 * would let the flash back in.) It still shows in the case that is actually useful: typing a NEW
 * message while a run really is in flight.
 */
const showBusyHint = computed(() => anyBusy.value && !!text.value.trim())

const accountOptions = computed(() => [
  { value: '', label: t('builder.accountAmbient') },
  ...accounts.value.map((a) => ({ value: a.id, label: a.label })),
])

const canSend = computed(() => !!text.value.trim() && props.targets.length > 0 && !sending.value)
const handingOff = ref(false)
const canHandoff = computed(() => !!text.value.trim() && !!single.value && !handingOff.value)

// chips: label falls back to the dimension name while the value is "default"
const chipLabel = (value: string, options: { value: string; label: string }[], fallback: string) =>
  value ? (options.find((o) => o.value === value)?.label ?? value) : fallback

function titleFor(target: ComposerTarget): string {
  return target.title || text.value.trim().slice(0, 60)
}

function createFor(target: ComposerTarget, notBefore: string | null) {
  return api.createQueueItem({
    session_id: target.session_id,
    title: titleFor(target),
    cwd: (single.value ? cwdOverride.value.trim() : '') || target.cwd,
    prompt: text.value,
    model: model.value || null,
    effort: (effort.value || null) as api.EffortLevel | null,
    permission_mode: (permission.value || null) as api.PermissionMode | null,
    account_id: accountId.value || null,
    new_chat: false,
    fork: false,
    not_before: notBefore,
  })
}

async function submit(mode: 'now' | 'queue', notBefore: string | null = null) {
  if (!canSend.value) return
  sending.value = true
  let started = 0
  let queued = 0
  let failed = 0
  try {
    for (const target of props.targets) {
      let item: api.QueueItem
      try {
        item = await createFor(target, notBefore)
      } catch {
        failed++
        continue
      }
      if (mode === 'now' && !runningIds.value.has(target.session_id)) {
        try {
          await api.runQueueItem(item.id)
          started++
        } catch {
          // the server holds a per-session run lock (409 when a run raced us in) —
          // the item was still created, so it's queued, not failed
          queued++
        }
      } else {
        queued++
      }
    }
  } finally {
    sending.value = false
  }
  await refreshQueue()
  if (failed) toast.error(t('composer.toastFailed', { n: failed }))
  if (!started && !queued) return

  text.value = ''
  scheduleOpen.value = false
  const message =
    started && queued
      ? t('composer.toastMixed', { ran: started, queued })
      : started
        ? t('composer.toastStarted', { n: started })
        : t('composer.toastQueued', { n: queued })
  const idleQueued = queued > 0 && !scheduler.value?.enabled
  toast.success(message, {
    description: idleQueued ? t('composer.schedulerOffHint') : undefined,
    action: { label: t('composer.viewQueue'), onClick: () => (queueOpen.value = true) },
  })
  emit('sent', started ? 'now' : 'queued')
}

// --- queue-for-later popover --------------------------------------------------
// The controls live in SchedulePanel.vue (shared with the queue builder); all this surface owns is
// whether the popover is open. submit() clears it on a successful send.
const scheduleOpen = ref(false)

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter' || e.shiftKey) return
  e.preventDefault()
  // Ctrl/Cmd+Enter always queues; plain Enter sends (busy targets self-queue in submit)
  submit(e.ctrlKey || e.metaKey ? 'queue' : 'now')
}

function downloadContextPack(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function handoffToChatGpt() {
  const target = single.value
  if (!target || !canHandoff.value) return

  // Open synchronously from the user's click so popup blockers do not mistake the new tab for an
  // unsolicited async popup. The pack generation remains local; nothing is submitted for them.
  window.open('https://chatgpt.com/', '_blank', 'noopener,noreferrer')
  handingOff.value = true
  try {
    const cwd = cwdOverride.value.trim() || target.cwd
    const pack = await api.createChatGptContextPack(cwd, text.value)
    downloadContextPack(pack.filename, pack.content)

    let copied = false
    try {
      await navigator.clipboard.writeText(pack.prompt)
      copied = true
    } catch {
      // The attachment carries the task too, so a denied clipboard does not lose the handoff.
    }
    toast.success(
      copied ? t('composer.chatGptReady') : t('composer.chatGptReadyWithoutClipboard'),
      {
        description:
          pack.warnings.length > 0
            ? pack.warnings.join(' ')
            : t('composer.chatGptAttachHint', { files: pack.includedFiles.length }),
      },
    )
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t('composer.chatGptHandoffFailed'))
  } finally {
    handingOff.value = false
  }
}
</script>

<template>
  <div class="bg-background">
    <div class="mx-auto w-full max-w-3xl px-4 py-3">
      <!-- multi-target banner -->
      <!-- count only: the joined titles always overflowed and truncated into noise -->
      <div
        v-if="targets.length > 1"
        class="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground"
      >
        <UsersRound class="size-3.5 text-primary" />
        <span class="font-medium text-foreground">{{ $t('composer.sendingToN', { n: targets.length }) }}</span>
      </div>
      <p v-if="showBusyHint" class="mb-2 text-xs text-warning">
        {{ scheduler?.enabled ? $t('composer.busyHintAuto') : $t('composer.busyHintManual') }}
      </p>

      <!-- bg-input (solid), not bg-input/10: this wrapper IS the composer box, so it carries the
           same raised surface + outline as every other text field. The Textarea inside stays
           transparent. -->
      <div class="rounded-xl border border-border bg-input focus-within:border-ring">
        <Textarea
          v-model="text"
          class="max-h-48 min-h-12 border-0 bg-transparent px-3 pt-2.5 focus-visible:ring-0 dark:bg-transparent"
          :placeholder="
            targets.length > 1
              ? $t('composer.placeholderMulti', { n: targets.length })
              : $t('composer.placeholder')
          "
          @keydown="onKeydown"
        />

        <!-- option chips (left) + actions (right), Claude-composer style -->
        <div class="flex flex-wrap items-center gap-1 px-2 pb-2">
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="xs" :class="model ? 'text-foreground' : 'text-muted-foreground'">
                <Cpu /> {{ chipLabel(model, MODELS, $t('composer.chipModel')) }}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuRadioGroup v-model="model">
                <DropdownMenuRadioItem value="">{{ $t('composer.clearOption') }}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem v-for="o in MODELS" :key="o.value" :value="o.value">
                  {{ o.label }}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="xs" :class="effort ? 'text-foreground' : 'text-muted-foreground'">
                <Gauge /> {{ chipLabel(effort, EFFORTS, $t('composer.chipEffort')) }}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuRadioGroup v-model="effort">
                <DropdownMenuRadioItem value="">{{ $t('composer.clearOption') }}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem v-for="o in EFFORTS" :key="o.value" :value="o.value">
                  {{ o.label }}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="xs" :class="permission ? 'text-foreground' : 'text-muted-foreground'">
                <ShieldCheck /> {{ chipLabel(permission, PERMISSION_MODES, $t('composer.chipPermission')) }}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuRadioGroup v-model="permission">
                <DropdownMenuRadioItem value="">{{ $t('composer.clearOption') }}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem v-for="o in PERMISSION_MODES" :key="o.value" :value="o.value">
                  {{ o.label }}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu v-if="accounts.length">
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="xs" :class="accountId ? 'text-foreground' : 'text-muted-foreground'">
                <UserCircle2 /> {{ chipLabel(accountId, accountOptions, $t('composer.chipAccount')) }}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuRadioGroup v-model="accountId">
                <DropdownMenuRadioItem v-for="o in accountOptions" :key="o.value" :value="o.value">
                  {{ o.label }}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <!-- cwd override: single target only (multi always uses each session's own dir) -->
          <Popover v-if="single">
            <PopoverTrigger as-child>
              <Button variant="ghost" size="xs" :class="cwdOverride.trim() ? 'text-foreground' : 'text-muted-foreground'">
                <FolderGit2 /> {{ baseName(cwdOverride.trim() || single.cwd) }}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" class="w-96 space-y-1.5 p-3">
              <label class="text-xs font-medium text-muted-foreground">{{ $t('composer.cwdPopoverLabel') }}</label>
              <Input v-model="cwdOverride" :placeholder="single.cwd" class="font-mono text-xs" />
              <p class="text-[11px] text-muted-foreground">{{ $t('composer.cwdPopoverHint') }}</p>
            </PopoverContent>
          </Popover>

          <div class="ml-auto flex items-center gap-1">
            <Button
              v-if="chatGptHandoffEnabled && single"
              variant="outline"
              size="sm"
              :disabled="!canHandoff"
              :title="$t('composer.chatGptHandoffHint')"
              @click="handoffToChatGpt"
            >
              <ExternalLink /> {{ $t('composer.chatGptHandoff') }}
            </Button>

            <Button
              variant="outline"
              size="sm"
              :disabled="!canSend"
              :title="$t('composer.queue')"
              @click="submit('queue')"
            >
              <ListPlus /> {{ $t('composer.queue') }}
            </Button>

            <Popover v-model:open="scheduleOpen">
              <PopoverTrigger as-child>
                <Button variant="outline" size="icon-sm" :disabled="!canSend" :title="$t('composer.queueForLater')">
                  <CalendarClock />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" class="w-64 p-3">
                <!-- The panel itself is shared with the queue builder (SchedulePanel.vue); this
                     surface's job is only to say what a picked time MEANS here: queue the message
                     currently in the box for then. -->
                <SchedulePanel @pick="submit('queue', $event)" @close="scheduleOpen = false" />
              </PopoverContent>
            </Popover>

            <Button size="sm" :disabled="!canSend" :title="$t('composer.send')" @click="submit('now')">
              <SendHorizonal /> {{ $t('composer.send') }}
            </Button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

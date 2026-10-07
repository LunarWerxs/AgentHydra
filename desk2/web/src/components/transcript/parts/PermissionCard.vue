<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { Ban, Check, CheckCheck, Clock, ShieldQuestion } from '@lucide/vue'
import type { PermissionDecision, TranscriptItem } from '@shared/protocol'
import { useDesk } from '@/stores/desk'
import { keyArgument, toolLabel } from '../lib/tools'
import { toolDiff } from '../lib/diff'
import { keyBefore } from '../lib/key-clock'
import { keyIsForCard, permissionKeyAction } from '../lib/requests'
import { useTranscript } from '../context'
import DiffView from './DiffView.vue'
import OutputBlock from './OutputBlock.vue'

// Pending, the card lives in the composer dock (docked); the transcript keeps a quiet row.
const props = defineProps<{ item: Extract<TranscriptItem, { kind: 'permission' }>; docked?: boolean }>()

const ctx = useTranscript()
const desk = useDesk()
const busy = ref(false)
const err = ref<string | null>(null)
const denying = ref(false)
const reason = ref('')

const label = computed(() => toolLabel(props.item.toolName))
const arg = computed(() => keyArgument(props.item.toolName, props.item.input, ctx.cwd.value))
const diff = computed(() => toolDiff(props.item.toolName, props.item.input))
const inputJson = computed(() => JSON.stringify(props.item.input, null, 2))
const command = computed(() => (typeof props.item.input.command === 'string' ? props.item.input.command : null))
const answered = computed(() => {
  switch (props.item.state) {
    case 'allowed':
      return { icon: Check, cls: 'text-success-text', text: 'Allowed' }
    case 'session':
      return { icon: Check, cls: 'text-success-text', text: 'Allowed for this session' }
    case 'always':
      return { icon: CheckCheck, cls: 'text-success-text', text: 'Always allowed' }
    case 'denied':
      return { icon: Ban, cls: 'text-danger-text', text: 'Denied' }
    case 'expired':
      return { icon: Clock, cls: 'text-text-muted', text: 'Expired' }
    default:
      return null
  }
})

async function decide(decision: PermissionDecision['decision']) {
  busy.value = true
  err.value = null
  try {
    const body: PermissionDecision = { decision }
    if (decision === 'deny' && reason.value.trim()) body.message = reason.value.trim()
    await desk.respondPermission(ctx.chatId.value, props.item.id, body)
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

// Docked, the card answers its keys (lib/requests.ts): Enter or 1, 2, 3, Esc. A bare Esc is a No that stops the turn.
const dockEl = ref<HTMLElement | null>(null)
let mountedAt = 0
function onKey(e: KeyboardEvent) {
  if (ctx.readOnly.value || busy.value || denying.value || props.item.state !== 'pending') return
  // Not while the card is out of sight (the Background tasks panel covers the composer column, or AgentHydra or the
  // Dev servers page has the chat's place, whose side is then inert: Esc there closes the page), nor while a menu or
  // dialog (Settings, the image lightbox) is open: Esc and the digits are theirs then.
  const el = dockEl.value
  if (!el?.getClientRects().length || el.closest('[inert]') || document.querySelector('[role="menu"], [role="dialog"]')) return
  // Never the rest of what the owner was typing for the composer when the card docked and hid the box.
  const moment = { now: performance.now(), mountedAt, prevKeyAt: keyBefore(), repeat: e.repeat, inCard: el.contains(e.target as Node | null), target: e.target }
  if (!keyIsForCard(moment)) return
  const action = permissionKeyAction(e, props.item)
  if (!action) return
  e.preventDefault()
  void decide(action)
}
onMounted(() => {
  mountedAt = performance.now()
  if (props.docked) window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

// The reason box takes the keys at once, every time (autofocus works once per page).
const reasonEl = ref<HTMLInputElement | null>(null)
function startDeny() {
  denying.value = true
  void nextTick(() => reasonEl.value?.focus())
}
</script>

<template>
  <!-- Answered: one line -->
  <div v-if="answered" class="flex h-6 min-w-0 items-center gap-1.5 px-1 text-[14px] text-text-muted">
    <component :is="answered.icon" class="size-4 shrink-0" :class="answered.cls" />
    <span class="shrink-0">{{ answered.text }}</span>
    <span class="shrink-0 font-medium text-text">{{ label }}</span>
    <span class="min-w-0 truncate font-mono text-[12px]">{{ arg }}</span>
  </div>

  <div v-else-if="!docked" class="flex h-6 min-w-0 items-center gap-1.5 px-1 text-[14px] text-text-muted">
    <ShieldQuestion class="size-4 shrink-0 text-warning-text" />
    <span class="shrink-0">Waiting for you</span>
    <span class="shrink-0 font-medium text-text">{{ label }}</span>
    <span class="min-w-0 truncate font-mono text-[12px]">{{ arg }}</span>
  </div>

  <div v-else ref="dockEl" class="tx-ask" role="group" :aria-label="item.title || `Allow ${label}?`">
    <div class="flex items-center gap-2 px-3 pt-2.5 text-[14px]">
      <ShieldQuestion class="size-4 shrink-0 text-warning-text" />
      <!-- The SDK's own sentence when it gives one ("Claude wants to run git push") -->
      <span v-if="item.title" class="min-w-0 text-text">{{ item.title }}</span>
      <template v-else>
        <span class="text-text">Allow <span class="font-medium">{{ label }}</span>?</span>
        <span class="min-w-0 truncate font-mono text-[12px] text-text-muted">{{ arg }}</span>
      </template>
    </div>
    <p v-if="item.description" class="px-3 pt-1 pl-9 text-[12px] text-text-muted">{{ item.description }}</p>
    <p v-if="item.reason" class="px-3 pt-1 pl-9 text-[12px] text-warning-text">{{ item.reason }}</p>
    <p v-if="item.blockedPath" class="px-3 pt-1 pl-9 text-[12px] text-text-muted">
      Outside the allowed folders: <span class="font-mono">{{ item.blockedPath }}</span>
    </p>
    <div class="mx-3 mt-2 overflow-hidden rounded-md border border-border bg-bg-page">
      <pre v-if="command" class="whitespace-pre-wrap break-words px-3 py-2 font-mono text-[12px] text-text"><span class="select-none text-text-muted">$ </span>{{ command }}</pre>
      <DiffView v-else-if="diff" :id="`${item.id}:diff`" :diff="diff" :max-lines="24" />
      <OutputBlock v-else :id="`${item.id}:in`" :text="inputJson" :max-lines="12" />
    </div>
    <div v-if="!ctx.readOnly.value" class="flex flex-wrap items-center gap-2 px-3 py-2.5">
      <template v-if="!denying">
        <!-- defaultToNo: the SDK wants no one-key approve, so Allow is neither the default nor on a key, and nor are 2 and 3 -->
        <button type="button" class="tx-btn" :class="!item.defaultToNo && 'tx-btn-primary'" :disabled="busy" @click="decide('allow')">
          Allow<span v-if="!item.defaultToNo" class="tx-kbd">1</span>
        </button>
        <template v-if="item.canAlwaysAllow">
          <button type="button" class="tx-btn" :disabled="busy" @click="decide('session')">
            Allow for this session<span v-if="!item.defaultToNo" class="tx-kbd">2</span>
          </button>
          <button type="button" class="tx-btn" :disabled="busy" @click="decide('always')">
            Always allow<span v-if="!item.defaultToNo" class="tx-kbd">3</span>
          </button>
        </template>
        <button type="button" class="tx-btn tx-btn-ghost" :disabled="busy" @click="startDeny">
          Deny<span class="tx-kbd">Esc</span>
        </button>
      </template>
      <template v-else>
        <input
          ref="reasonEl"
          v-model="reason"
          class="tx-input min-w-0 flex-1"
          placeholder="Tell Claude why (optional)"
          @keydown.enter="decide('deny')"
          @keydown.esc="denying = false"
        />
        <button type="button" class="tx-btn tx-btn-danger" :disabled="busy" @click="decide('deny')">Deny</button>
        <button type="button" class="tx-btn tx-btn-ghost" :disabled="busy" @click="denying = false">Cancel</button>
      </template>
      <span v-if="err" class="text-[12px] text-danger-text">{{ err }}</span>
    </div>
    <p v-if="!ctx.readOnly.value && !denying && item.canAlwaysAllow && item.alwaysRules?.length" class="-mt-1 px-3 pb-2.5 text-[12px] text-text-muted">
      Always allow saves <span class="font-mono">{{ item.alwaysRules.join('; ') }}</span>
    </p>
    <div v-if="ctx.readOnly.value" class="px-3 py-2 text-[12px] text-text-muted">Waiting for an answer</div>
  </div>
</template>

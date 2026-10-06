<script setup lang="ts">
// A design_options call: the ReDesign run's options as a grid of pictures. With ask_owner the person chooses here (one
// option, a note on any, "More options", or words) and Send posts ONE normal message into this chat; without it the
// card only shows the options and, once design_pick ran, which one the AI took.
import { computed, reactive, ref } from 'vue'
import { Check, KeyRound, LayoutGrid, LoaderCircle, Maximize2, Send } from '@lucide/vue'
import type { TranscriptItem } from '@shared/protocol'
import { useDesk } from '@/stores/desk'
import { useTranscript } from '../context'
import { canSendReply, composeRedesignReply, parseDesignOptions, redesignSetup, RETRY_MESSAGE } from '../lib/redesign'
import { listConnectors } from '@/components/connectors/api'
import { openLightbox } from '../lib/media'

type ToolItem = Extract<TranscriptItem, { kind: 'tool_use' }>
const props = defineProps<{ item: ToolItem }>()
const ctx = useTranscript()
const desk = useDesk()

const view = computed(() => parseDesignOptions(props.item))
const aiPick = computed(() => ctx.redesign?.value.picks.get(view.value.run) ?? null)

const setup = computed(() => (view.value.state === 'error' ? redesignSetup(view.value.error) : null))
const keyBusy = ref(false)
const keyNote = ref('')
const keyOk = ref(false)

// ReDesign itself (its keys live in a dialog, Settings → Models & keys, with no URL of their own), at wherever the connector says it runs.
async function openKeys() {
  keyNote.value = ''
  try {
    const url = (await listConnectors()).find((c) => c.id === 'redesign')?.url
    if (!url) throw new Error('ReDesign is not running')
    window.open(url, '_blank', 'noopener')
  } catch (e) {
    keyNote.value = e instanceof Error ? e.message : 'Could not open ReDesign'
  }
}
// Copies a few of HSwarm's working keys into ReDesign (the server moves them; none comes back here), then asks the AI to retry.
async function useHswarmKeys() {
  if (keyBusy.value) return
  keyBusy.value = true
  keyNote.value = ''
  try {
    const res = await fetch('/api/redesign/keys/hswarm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const body = (await res.json().catch(() => ({}))) as { error?: string; pools?: { added: number; before: number }[] }
    if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`)
    const have = (body.pools ?? []).reduce((n, p) => n + p.added + p.before, 0)
    if (!have) throw new Error("HSwarm has no working key to lend")
    keyOk.value = true
    keyNote.value = 'Keys added.'
    if (!ctx.readOnly.value) await desk.send(ctx.chatId.value, { text: RETRY_MESSAGE })
  } catch (e) {
    keyNote.value = e instanceof Error ? e.message : 'Could not add keys'
  } finally {
    keyBusy.value = false
  }
}

const pick = ref<number | null>(null)
const notes = reactive<Record<number, string>>({})
const more = ref(false)
const text = ref('')
const busy = ref(false)
const err = ref('')
const sentNow = ref('')

// What the person already sent for this call (this session, or read back from the transcript).
const sent = computed(() => sentNow.value || ctx.redesign?.value.replies.get(props.item.id) || '')
const editable = computed(() => view.value.askOwner && view.value.state === 'done' && !sent.value && !ctx.readOnly.value)
const reply = computed(() => ({ pick: more.value ? null : pick.value, notes: { ...notes }, more: more.value, text: text.value }))
const ready = computed(() => canSendReply(reply.value))

function choose(n: number) {
  more.value = false
  pick.value = pick.value === n ? null : n
}
function toggleMore() {
  more.value = !more.value
  if (more.value) pick.value = null
}
async function send() {
  if (!ready.value || busy.value) return
  const message = composeRedesignReply(reply.value)
  busy.value = true
  err.value = ''
  try {
    await desk.send(ctx.chatId.value, { text: message })
    sentNow.value = message
  } catch (e) {
    err.value = e instanceof Error ? e.message : 'Could not send'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="tx-card w-[560px] max-w-full overflow-hidden shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--brand)_35%,transparent)]">
    <div class="flex items-start gap-2 px-3 pb-2 pt-2.5">
      <span class="mt-px inline-flex shrink-0 items-center gap-1 rounded-6 bg-fill-hover px-1.5 py-0.5 text-[12px] font-medium text-text">
        <LayoutGrid class="size-3.5" aria-hidden="true" />ReDesign
      </span>
      <p class="min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] text-text">{{ view.brief }}</p>
    </div>

    <p v-if="view.state === 'running'" class="flex items-center gap-2 px-3 pb-3 text-[13px] text-text-muted" role="status">
      <LoaderCircle class="size-4 animate-spin" aria-hidden="true" />
      <span>{{ item.progress || 'ReDesign is making options…' }}</span>
    </p>
    <div v-else-if="setup" class="grid gap-2 px-3 pb-3" role="status">
      <p class="flex items-center gap-1.5 text-[13px] font-medium text-text"><KeyRound class="size-3.5 text-text-muted" aria-hidden="true" />{{ setup.title }}</p>
      <p class="text-[13px] text-text-muted">{{ setup.line }}</p>
      <div v-if="setup.kind === 'no-key'" class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="inline-flex h-7 items-center rounded-6 bg-fill-hover px-2.5 text-[13px] text-text outline-none hover:bg-fill-active focus-visible:ring-2 focus-visible:ring-brand"
          @click="openKeys"
        >
          Open ReDesign to add a key
        </button>
        <button
          type="button"
          class="inline-flex h-7 items-center gap-1 rounded-6 bg-brand px-2.5 text-[13px] font-medium text-white outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40"
          :disabled="keyBusy || keyOk"
          @click="useHswarmKeys"
        >
          <LoaderCircle v-if="keyBusy" class="size-3.5 animate-spin" aria-hidden="true" />Use HSwarm's keys
        </button>
        <span v-if="keyNote" class="min-w-0 truncate text-[12px]" :class="keyOk ? 'text-text-muted' : 'text-danger-text'">{{ keyNote }}</span>
      </div>
      <p v-if="view.error" class="whitespace-pre-wrap break-words text-[12px] text-text-muted opacity-80">{{ view.error }}</p>
    </div>
    <p v-else-if="view.state === 'error'" class="whitespace-pre-wrap break-words px-3 pb-3 text-[13px] text-danger-text">{{ view.error }}</p>

    <template v-else>
      <ul class="grid grid-cols-2 gap-2 px-3 pb-2.5">
        <li v-for="o in view.options" :key="o.n" class="min-w-0">
          <div
            class="group/opt relative overflow-hidden rounded-[8px] bg-bg-popover"
            :class="
              (editable ? pick === o.n : aiPick === o.n)
                ? 'shadow-[0_0_0_2px_var(--brand)]'
                : 'shadow-[inset_0_0_0_1px_var(--border)]'
            "
          >
            <button
              v-if="o.src"
              type="button"
              class="block aspect-[16/10] w-full outline-none focus-visible:ring-2 focus-visible:ring-brand"
              :title="`View option ${o.n} large`"
              @click="openLightbox(o.src!, `Option ${o.n}`)"
            >
              <img :src="o.src" :alt="`Option ${o.n}`" class="size-full object-cover object-left-top" draggable="false" />
            </button>
            <span v-else class="flex aspect-[16/10] w-full items-center justify-center bg-fill-hover text-[12px] text-text-muted">No picture</span>
            <Maximize2
              v-if="o.src"
              class="pointer-events-none absolute right-1.5 top-1.5 size-5 rounded-6 bg-black/55 p-1 text-white opacity-0 transition-opacity group-hover/opt:opacity-100"
              aria-hidden="true"
            />
          </div>
          <label
            class="mt-1 flex min-w-0 items-center gap-1.5 text-[12px] text-text"
            :class="editable ? 'cursor-pointer' : ''"
          >
            <input
              v-if="editable"
              type="radio"
              :name="`redesign-${item.id}`"
              class="size-3.5 shrink-0 accent-[var(--brand)]"
              :checked="pick === o.n"
              @click="choose(o.n)"
            />
            <span class="shrink-0 font-medium">Option {{ o.n }}</span>
            <span v-if="!editable && aiPick === o.n" class="inline-flex shrink-0 items-center gap-0.5 rounded-6 bg-fill-hover px-1 text-brand">
              <Check class="size-3" aria-hidden="true" />{{ view.askOwner ? 'Chosen' : 'AI picked' }}
            </span>
            <span class="min-w-0 truncate text-text-muted" :title="o.description">{{ o.description }}</span>
          </label>
          <input
            v-if="editable"
            v-model="notes[o.n]"
            type="text"
            class="tx-input mt-1 w-full"
            :placeholder="`Note on option ${o.n} (optional)`"
            :aria-label="`Note on option ${o.n}`"
            maxlength="300"
            @keydown.enter="send"
          />
        </li>
      </ul>

      <div v-if="editable" class="grid gap-2 border-t border-border px-3 pb-3 pt-2.5">
        <textarea
          v-model="text"
          rows="2"
          class="tx-input w-full resize-y"
          placeholder="Or reply in your own words…"
          aria-label="Reply to ReDesign"
          maxlength="2000"
        />
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="inline-flex h-7 items-center rounded-6 px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-brand"
            :class="more ? 'bg-brand text-white' : 'bg-fill-hover text-text hover:bg-fill-active'"
            :aria-pressed="more"
            @click="toggleMore"
          >
            More options
          </button>
          <span v-if="err" class="min-w-0 truncate text-[12px] text-danger-text">{{ err }}</span>
          <button
            type="button"
            class="ml-auto inline-flex h-7 items-center gap-1 rounded-6 bg-brand px-3 text-[13px] font-medium text-white outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40"
            :disabled="!ready || busy"
            @click="send"
          >
            <Send class="size-3.5" aria-hidden="true" />Send
          </button>
        </div>
      </div>
      <div v-else-if="sent" class="border-t border-border px-3 py-2 text-[12px] text-text-muted">
        <span class="font-medium text-text">Sent:</span> <span class="whitespace-pre-wrap break-words">{{ sent }}</span>
      </div>
      <p v-else-if="view.askOwner && ctx.readOnly.value" class="border-t border-border px-3 py-2 text-[12px] text-text-muted">Waiting for the person's choice.</p>
    </template>
  </div>
</template>

<script setup lang="ts">
// A design_options call: the ReDesign run's options as a grid of large pictures. With ask_owner the person chooses here
// (one option with an optional note, "Other" with words, or "More options") and Send posts ONE normal message into this
// chat; without it the card only shows the options and, once design_pick ran, which one the AI took.
import { computed, reactive, ref } from 'vue'
import { Check, KeyRound, LayoutGrid, LoaderCircle, Maximize2 } from '@lucide/vue'
import type { TranscriptItem } from '@shared/protocol'
import { useDesk } from '@/stores/desk'
import { useTranscript } from '../context'
import { canSendReply, composeRedesignReply, parseDesignOptions, redesignSetup, replyFor, RETRY_MESSAGE, type DesignOption, type RedesignChoice } from '../lib/redesign'
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

// Like a question with choices: the pictures are the choices and "Other" is the last one. Only Other has a text box.
const choice = ref<RedesignChoice>(null)
const notes = reactive<Record<number, string>>({})
const text = ref('')
const busy = ref(false)
const err = ref('')
const sentNow = ref('')

// What the person already sent for this call (this session, or read back from the transcript).
const sent = computed(() => sentNow.value || ctx.redesign?.value.replies.get(props.item.id) || '')
const editable = computed(() => view.value.askOwner && view.value.state === 'done' && !sent.value && !ctx.readOnly.value)
const reply = computed(() => replyFor(choice.value, notes, text.value))
const ready = computed(() => canSendReply(reply.value))
const shown = (n: number) => (editable.value ? choice.value === n : aiPick.value === n)
const title = computed(() => (view.value.askOwner ? 'Pick a design' : 'Design options'))
// Tiles while a run is still going: the count the call asked for, else four.
const expected = computed(() => {
  const n = Number(props.item.input.count ?? props.item.input.options)
  return Number.isInteger(n) && n >= 1 && n <= 8 ? n : 4
})
const countLabel = computed(() => {
  const n = view.value.state === 'running' ? expected.value : view.value.state === 'done' ? view.value.options.length : 0
  return n ? `${n} option${n === 1 ? '' : 's'}` : ''
})

function choose(n: number | 'other') {
  choice.value = choice.value === n ? null : n
}
function open(o: DesignOption) {
  if (o.src) openLightbox(o.src, `Option ${o.n}`, view.value.options.filter((x) => x.src).map((x) => ({ src: x.src!, alt: `Option ${x.n}` })))
}
async function post(message: string) {
  if (busy.value) return
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
const send = () => ready.value && post(composeRedesignReply(reply.value))
const sendMore = () => post(composeRedesignReply(replyFor(null, {}, '', true)))
</script>

<template>
  <div class="tx-card @container w-[620px] max-w-full overflow-hidden shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--brand)_35%,transparent)]">
    <div class="px-3 pb-2 pt-2.5">
      <div class="flex items-center gap-2">
        <span class="inline-flex shrink-0 items-center gap-1 rounded-6 bg-fill-hover px-1.5 py-0.5 text-[12px] font-medium text-text">
          <LayoutGrid class="size-3.5" aria-hidden="true" />ReDesign
        </span>
        <span class="min-w-0 truncate text-[14px] font-medium text-text">{{ title }}</span>
        <span v-if="countLabel" class="ml-auto shrink-0 text-[12px] text-text-muted">{{ countLabel }}</span>
      </div>
      <p v-if="view.brief" class="mt-1 truncate text-[12px] text-text-muted" :title="view.brief">{{ view.brief }}</p>
    </div>

    <template v-if="view.state === 'running'">
      <ul class="grid grid-cols-1 gap-2.5 px-3 pb-2 @[420px]:grid-cols-2" aria-hidden="true">
        <li v-for="n in expected" :key="n" class="min-w-0">
          <div class="flex aspect-[16/10] w-full animate-pulse items-center justify-center rounded-[8px] bg-fill-hover shadow-[inset_0_0_0_1px_var(--border)]">
            <LoaderCircle class="size-5 animate-spin text-text-muted" />
          </div>
          <p class="mt-1 text-[12px] font-medium text-text-muted">Option {{ n }}</p>
        </li>
      </ul>
      <p class="px-3 pb-3 text-[12px] text-text-muted" role="status">{{ item.progress || 'ReDesign is making options…' }}</p>
    </template>
    <div v-else-if="setup" class="grid gap-2 px-3 pb-3" role="status">
      <p class="flex items-center gap-1.5 text-[13px] font-medium text-text"><KeyRound class="size-3.5 text-text-muted" aria-hidden="true" />{{ setup.title }}</p>
      <p class="text-[13px] text-text-muted">{{ setup.line }}</p>
      <div v-if="setup.kind === 'no-key'" class="flex flex-wrap items-center gap-2">
        <button type="button" class="tx-btn" @click="openKeys">Open ReDesign to add a key</button>
        <button type="button" class="tx-btn tx-btn-primary" :disabled="keyBusy || keyOk" @click="useHswarmKeys">
          <LoaderCircle v-if="keyBusy" class="size-3.5 animate-spin" aria-hidden="true" />Use HSwarm's keys
        </button>
        <span v-if="keyNote" class="min-w-0 truncate text-[12px]" :class="keyOk ? 'text-text-muted' : 'text-danger-text'">{{ keyNote }}</span>
      </div>
      <p v-if="view.error" class="whitespace-pre-wrap break-words text-[12px] text-text-muted opacity-80">{{ view.error }}</p>
    </div>
    <p v-else-if="view.state === 'error'" class="whitespace-pre-wrap break-words px-3 pb-3 text-[13px] text-danger-text">{{ view.error }}</p>

    <template v-else>
      <ul class="grid grid-cols-1 gap-2.5 px-3 pb-2.5 @[420px]:grid-cols-2" :role="editable ? 'radiogroup' : undefined" aria-label="Design options">
        <li v-for="o in view.options" :key="o.n" class="min-w-0">
          <div
            class="group/opt relative overflow-hidden rounded-[8px] bg-(--bg-picture) transition-shadow"
            :class="shown(o.n) ? 'shadow-[0_0_0_2px_var(--accent)]' : 'shadow-(--shadow-picture)'"
          >
            <button
              v-if="o.src"
              type="button"
              class="block aspect-[16/10] w-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
              :role="editable ? 'radio' : undefined"
              :aria-checked="editable ? choice === o.n : undefined"
              :aria-label="`Option ${o.n}`"
              :title="editable ? `Choose option ${o.n}` : `View option ${o.n} large`"
              @click="editable ? choose(o.n) : open(o)"
            >
              <img :src="o.src" :alt="`Option ${o.n}`" class="size-full object-cover object-top" draggable="false" />
            </button>
            <span v-else class="flex aspect-[16/10] w-full items-center justify-center text-[12px] text-text-muted">No picture</span>
            <span
              v-if="shown(o.n)"
              class="pointer-events-none absolute left-2 top-2 flex size-6 items-center justify-center rounded-full bg-accent text-white shadow"
              aria-hidden="true"
            >
              <Check class="size-4" />
            </span>
            <button
              v-if="o.src"
              type="button"
              class="absolute right-2 top-2 flex size-7 items-center justify-center rounded-6 bg-black/60 text-white outline-none hover:bg-black/80 focus-visible:ring-2 focus-visible:ring-brand"
              :aria-label="`View option ${o.n} full size`"
              title="Full size"
              @click="open(o)"
            >
              <Maximize2 class="size-4" aria-hidden="true" />
            </button>
          </div>
          <div class="mt-1 flex min-w-0 items-baseline gap-1.5 text-[12px]">
            <span class="shrink-0 font-medium" :class="shown(o.n) ? 'text-text' : 'text-text-muted'">Option {{ o.n }}</span>
            <span v-if="!editable && aiPick === o.n" class="shrink-0 text-brand">{{ view.askOwner ? 'Chosen' : 'AI picked' }}</span>
            <span v-if="o.description" class="min-w-0 truncate text-[11px] text-text-muted opacity-70" :title="o.description">{{ o.description }}</span>
          </div>
        </li>
      </ul>

      <div v-if="editable" class="grid gap-2 border-t border-border px-3 pb-3 pt-2.5">
        <input
          v-if="typeof choice === 'number'"
          :key="choice"
          v-model="notes[choice]"
          type="text"
          class="tx-input w-full"
          placeholder="Add a note (optional)"
          :aria-label="`Note on option ${choice}`"
          maxlength="300"
          @keydown.enter.prevent="send"
        />
        <button
          type="button"
          role="radio"
          :aria-checked="choice === 'other'"
          class="flex h-9 w-full items-center gap-2 rounded-md border px-2.5 text-left text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand"
          :class="choice === 'other' ? 'border-accent bg-accent/10 text-text' : 'border-border text-text-muted hover:bg-fill-hover hover:text-text'"
          @click="choose('other')"
        >
          <span class="flex size-4 shrink-0 items-center justify-center rounded-full" :class="choice === 'other' ? 'bg-accent text-white' : 'shadow-[inset_0_0_0_1px_var(--border)]'">
            <Check v-if="choice === 'other'" class="size-3" aria-hidden="true" />
          </span>
          <span class="font-medium">Other</span>
        </button>
        <textarea
          v-if="choice === 'other'"
          v-model="text"
          rows="2"
          class="tx-input w-full resize-y"
          placeholder="Type what you want"
          aria-label="What you want instead"
          maxlength="2000"
          @keydown.enter.exact.prevent="send"
        />
        <div class="flex items-center gap-2">
          <button type="button" class="tx-btn" :disabled="busy" @click="sendMore">More options</button>
          <span v-if="err" class="min-w-0 truncate text-[12px] text-danger-text">{{ err }}</span>
          <button type="button" class="tx-btn tx-btn-primary ml-auto" :disabled="!ready || busy" @click="send">Send</button>
        </div>
      </div>
      <div v-else-if="sent" class="border-t border-border px-3 py-2 text-[12px] text-text-muted">
        <span class="font-medium text-text">Sent:</span> <span class="whitespace-pre-wrap break-words">{{ sent }}</span>
      </div>
      <p v-else-if="view.askOwner && ctx.readOnly.value" class="border-t border-border px-3 py-2 text-[12px] text-text-muted">Waiting for the person's choice.</p>
    </template>
  </div>
</template>

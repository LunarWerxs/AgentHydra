<script setup lang="ts">
// A design_options call: the ReDesign run's options as a grid of large pictures, each with its name on it. With ask_owner the
// person chooses here (an option by its name, "Other" with words, or "More options") and Send posts ONE normal message into
// this chat; without it the card only shows the options and, once design_pick ran, which one the AI took.
import { computed, ref, watch } from 'vue'
import { Check, ChevronDown, ChevronUp, KeyRound, LayoutGrid, LoaderCircle, Maximize2 } from '@lucide/vue'
import type { TranscriptItem } from '@shared/protocol'
import { useDesk } from '@/stores/desk'
import { useTranscript } from '../context'
import { canSendReply, composeRedesignReply, landedNames, optionLabel, parseDesignOptions, parseReplyChip, pickedOption, redesignSetup, replyFor, RETRY_MESSAGE, type DesignOption, type RedesignChoice } from '../lib/redesign'
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

// Like a question with choices: the names are the choices; Other (a button by More options) reveals the one text box.
const choice = ref<RedesignChoice>(null)
const text = ref('')
const busy = ref(false)
const err = ref('')
const sentNow = ref('')

// What the person already sent for this call (this session, or read back from the transcript).
const sent = computed(() => sentNow.value || ctx.redesign?.value.replies.get(props.item.id) || '')
const editable = computed(() => view.value.askOwner && view.value.state === 'done' && !sent.value && !ctx.readOnly.value)
const chosenName = computed(() => {
  const o = view.value.options.find((x) => x.n === choice.value)
  return o ? o.name : ''
})
const reply = computed(() => replyFor(choice.value, chosenName.value, text.value))
const sentChip = computed(() => (sent.value ? parseReplyChip(sent.value) : null))
const ready = computed(() => canSendReply(reply.value))
const picked = computed(() => pickedOption({ editable: editable.value, choice: choice.value, aiPick: aiPick.value, sentChip: sentChip.value }))
const shown = (n: number) => picked.value === n
// With an option picked the card folds to a row for it; a pick that changes folds it again, a click on the row unfolds it.
const expanded = ref(false)
watch(picked, (n) => { if (n !== null) expanded.value = false }, { immediate: true })
const pickedOpt = computed(() => view.value.options.find((o) => o.n === picked.value) ?? null)
const folded = computed(() => !!pickedOpt.value && !expanded.value)
const title = computed(() => (view.value.askOwner ? 'Pick a design' : 'Design options'))
// Tiles while a run is still going: the count the call asked for, else four.
const expected = computed(() => {
  const n = Number(props.item.input.count ?? props.item.input.options)
  return Number.isInteger(n) && n >= 1 && n <= 8 ? n : 4
})
// Names of the options already landed while the run is going: they appear as pills on the tiles.
const landed = computed(() => landedNames(props.item.progress))
const countLabel = computed(() => {
  const n = view.value.state === 'running' ? expected.value : view.value.state === 'done' ? view.value.options.length : 0
  return n ? `${n} option${n === 1 ? '' : 's'}` : ''
})

function choose(n: number | 'other') {
  choice.value = choice.value === n ? null : n
}
function open(o: DesignOption) {
  if (o.src) openLightbox(o.src, optionLabel(o), view.value.options.filter((x) => x.src).map((x) => ({ src: x.src!, alt: optionLabel(x) })))
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
const sendMore = () => post(composeRedesignReply(replyFor(null, '', '', true)))
const moreCount = computed(() => view.value.options.length || expected.value)
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
        <button
          v-if="view.state === 'done' && pickedOpt && expanded"
          type="button"
          class="tx-btn shrink-0"
          aria-expanded="true"
          @click="expanded = false"
        >
          <ChevronUp class="size-3.5" aria-hidden="true" />Collapse
        </button>
      </div>
      <p v-if="view.brief" class="mt-1 truncate text-[12px] text-text-muted" :title="view.brief">{{ view.brief }}</p>
    </div>

    <template v-if="view.state === 'running'">
      <ul class="grid grid-cols-1 gap-2.5 px-3 pb-2 @[420px]:grid-cols-2" aria-hidden="true">
        <li v-for="n in expected" :key="n" class="min-w-0">
          <div class="relative flex aspect-[16/10] w-full items-center justify-center rounded-[8px] bg-fill-hover shadow-[inset_0_0_0_1px_var(--border)]" :class="!landed[n - 1] && 'animate-pulse'">
            <LoaderCircle class="size-5 animate-spin text-text-muted" />
            <span v-if="landed[n - 1]" class="absolute bottom-2 left-2 max-w-[80%] truncate rounded-full bg-black/70 px-2.5 py-1 text-[12px] font-medium text-white">{{ landed[n - 1] }}</span>
          </div>
          <p class="mt-1 text-[12px] font-medium text-text-muted">Option {{ n }}</p>
        </li>
      </ul>
      <p class="px-3 pb-3 text-[12px] text-text-muted" role="status">{{ (!landed.length && item.progress) || 'ReDesign is making options…' }}</p>
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
      <button
        v-if="folded && pickedOpt"
        type="button"
        class="mx-3 mb-2.5 flex w-[calc(100%-1.5rem)] items-center gap-3 rounded-[8px] text-left outline-none focus-visible:ring-2 focus-visible:ring-brand"
        aria-expanded="false"
        @click="expanded = true"
      >
        <span class="block aspect-[16/10] w-28 shrink-0 overflow-hidden rounded-[8px] bg-(--bg-picture) shadow-[0_0_0_2px_var(--accent)]">
          <img v-if="pickedOpt.src" :src="pickedOpt.src" :alt="optionLabel(pickedOpt)" class="size-full object-cover object-top" draggable="false" />
          <span v-else class="flex size-full items-center justify-center text-[12px] text-text-muted">No picture</span>
        </span>
        <span class="flex min-w-0 items-center gap-1 text-[13px] font-medium text-text">
          <Check class="size-3.5 shrink-0" aria-hidden="true" /><span class="truncate">{{ optionLabel(pickedOpt) }}</span>
        </span>
        <span class="ml-auto flex shrink-0 items-center gap-1 text-[12px] text-text-muted">Show all {{ view.options.length }}<ChevronDown class="size-3.5" aria-hidden="true" /></span>
      </button>
      <ul v-else class="grid grid-cols-1 gap-2.5 px-3 pb-2.5 @[420px]:grid-cols-2" aria-label="Design options">
        <li v-for="o in view.options" :key="o.n" class="min-w-0">
          <div
            class="group/opt relative overflow-hidden rounded-[8px] bg-(--bg-picture) transition-shadow"
            :class="shown(o.n) ? 'shadow-[0_0_0_2px_var(--accent)]' : 'shadow-(--shadow-picture)'"
          >
            <button
              v-if="o.src"
              type="button"
              class="block aspect-[16/10] w-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
              :aria-label="`View ${optionLabel(o)} large`"
              @click="open(o)"
            >
              <img :src="o.src" :alt="optionLabel(o)" class="size-full object-cover object-top" draggable="false" />
            </button>
            <span v-else class="flex aspect-[16/10] w-full items-center justify-center text-[12px] text-text-muted">No picture</span>
            <component
              :is="editable ? 'button' : 'span'"
              :type="editable ? 'button' : undefined"
              :role="editable ? 'radio' : undefined"
              :aria-checked="editable ? choice === o.n : undefined"
              :title="editable ? `Choose ${optionLabel(o)}` : undefined"
              class="absolute bottom-2 left-2 flex max-w-[75%] items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium shadow outline-none focus-visible:ring-2 focus-visible:ring-brand"
              :class="[
                shown(o.n) ? 'bg-accent text-white' : 'bg-black/70 text-white backdrop-blur-sm',
                editable && !shown(o.n) && 'hover:bg-black/85'
              ]"
              @click="editable && choose(o.n)"
            >
              <Check v-if="shown(o.n)" class="size-3.5 shrink-0" aria-hidden="true" />
              <span class="truncate">{{ optionLabel(o) }}</span>
            </component>
            <button
              v-if="o.src"
              type="button"
              class="absolute right-2 top-2 flex size-7 items-center justify-center rounded-6 bg-black/60 text-white outline-none hover:bg-black/80 focus-visible:ring-2 focus-visible:ring-brand"
              :aria-label="`View ${optionLabel(o)} full size`"
              title="Full size"
              @click="open(o)"
            >
              <Maximize2 class="size-4" aria-hidden="true" />
            </button>
          </div>
        </li>
      </ul>

      <div v-if="editable" class="grid gap-2 border-t border-border px-3 pb-3 pt-2.5">
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
          <button type="button" class="tx-btn" :disabled="busy" :title="`${moreCount} new designs, different directions`" @click="sendMore">
            More options <span class="text-text-muted">· {{ moreCount }} new</span>
          </button>
          <button type="button" class="tx-btn" :class="choice === 'other' && 'border-accent text-text'" :aria-pressed="choice === 'other'" @click="choose('other')">Other</button>
          <span v-if="err" class="min-w-0 truncate text-[12px] text-danger-text">{{ err }}</span>
          <button type="button" class="tx-btn tx-btn-primary ml-auto" :disabled="!ready || busy" @click="send">Send</button>
        </div>
      </div>
      <p v-else-if="sent" class="flex items-center gap-1.5 border-t border-border px-3 py-2 text-[12px] text-text-muted">
        <Check class="size-3.5 shrink-0" aria-hidden="true" /><span class="min-w-0 truncate">{{ sentChip?.line(view.options.length) ?? sent }}</span>
      </p>
      <p v-else-if="view.askOwner && ctx.readOnly.value" class="border-t border-border px-3 py-2 text-[12px] text-text-muted">Waiting for the person's choice.</p>
    </template>
  </div>
</template>

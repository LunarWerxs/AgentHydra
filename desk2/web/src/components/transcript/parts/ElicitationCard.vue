<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { Ban, Check, Clock, ExternalLink, Plug } from '@lucide/vue'
import type { ElicitationAnswer, TranscriptItem } from '@shared/protocol'
import { Tip } from '@/components/ui/tooltip'
import { useDesk } from '@/stores/desk'
import { useTranscript } from '../context'
import { formAnswer, initialForm, limitHint, linkOf, LONG_CHOICE, togglePick } from '../lib/elicitation'

// An MCP server asks for a form or for a link to be opened. Pending, the card lives in the composer
// dock (docked); the transcript keeps a quiet row.
const props = defineProps<{ item: Extract<TranscriptItem, { kind: 'elicitation' }>; docked?: boolean }>()

const ctx = useTranscript()
const desk = useDesk()
const busy = ref(false)
const err = ref<string | null>(null)
const fields = computed(() => props.item.fields ?? [])
const form = reactive(initialForm(props.item.fields ?? []))
const answer = computed(() => formAnswer(fields.value, form))
// The server keeps http(s) links only; the window checks again before it links anything.
const link = computed(() => linkOf(props.item.url))
// A link request with no link it could open can only be cancelled.
const ready = computed(() => (props.item.mode === 'url' ? !!link.value : !answer.value.missing.length && !answer.value.invalid.length))

const textOf = (name: string) => {
  const v = form[name]
  return typeof v === 'string' ? v : ''
}
const picksOf = (name: string) => {
  const v = form[name]
  return Array.isArray(v) ? v : []
}
function setText(name: string, e: Event) {
  form[name] = (e.target as HTMLInputElement).value
}
function setChecked(name: string, e: Event) {
  form[name] = (e.target as HTMLInputElement).checked
}
function choose(name: string, value: string, required: boolean) {
  // An optional choice can be cleared by picking it again.
  form[name] = form[name] === value && !required ? '' : value
}
function setPicks(name: string, e: Event) {
  form[name] = [...(e.target as HTMLSelectElement).selectedOptions].map((o) => o.value)
}

async function respond(accept: boolean) {
  busy.value = true
  err.value = null
  try {
    const body: ElicitationAnswer = { action: accept ? 'accept' : 'decline' }
    if (accept && props.item.mode === 'form') body.values = answer.value.values
    await desk.answerElicitation(ctx.chatId.value, props.item.id, body)
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

const answered = computed(() => {
  switch (props.item.state) {
    case 'accepted':
      return { icon: Check, cls: 'text-success-text', text: props.item.mode === 'url' ? 'Done' : 'Answered' }
    case 'declined':
      return { icon: Ban, cls: 'text-text-muted', text: 'Declined' }
    case 'expired':
      return { icon: Clock, cls: 'text-text-muted', text: 'Expired' }
    default:
      return null
  }
})
</script>

<template>
  <div v-if="answered" class="flex h-6 min-w-0 items-center gap-1.5 px-1 text-[14px] text-text-muted">
    <component :is="answered.icon" class="size-4 shrink-0" :class="answered.cls" />
    <span class="shrink-0">{{ answered.text }}</span>
    <span class="shrink-0 font-medium text-text">{{ item.serverName }}</span>
    <span class="min-w-0 truncate">{{ item.message }}</span>
  </div>

  <div v-else-if="!docked" class="flex h-6 min-w-0 items-center gap-1.5 px-1 text-[14px] text-text-muted">
    <Plug class="size-4 shrink-0 text-warning-text" />
    <span class="shrink-0">Waiting for you</span>
    <span class="shrink-0 font-medium text-text">{{ item.serverName }}</span>
    <span class="min-w-0 truncate">{{ item.message }}</span>
  </div>

  <div v-else class="tx-ask" role="group" :aria-label="item.title || `${item.serverName} asks for your input`">
    <div class="flex items-start gap-2 px-3 pt-2.5 text-[14px]">
      <Plug class="mt-0.5 size-4 shrink-0 text-warning-text" />
      <div class="min-w-0">
        <span class="me-2 rounded bg-fill-hover px-1.5 py-0.5 text-[11px] text-text-muted">{{ item.serverName }}</span>
        <!-- The server's own header for a permission it asks through a form ("Allow ... to delete ...?") -->
        <span class="whitespace-pre-wrap wrap-break-word text-text">{{ item.title || item.message }}</span>
      </div>
    </div>
    <p v-if="item.description" class="px-3 pt-1 ps-9 text-[12px] text-text-muted">{{ item.description }}</p>
    <p v-if="item.title && item.message !== item.title" class="whitespace-pre-wrap wrap-break-word px-3 pt-1 ps-9 text-[13px] text-text">{{ item.message }}</p>

    <div v-if="item.mode === 'form' && fields.length" class="grid max-h-[50vh] gap-2.5 overflow-auto px-3 pt-2.5 ps-9">
      <div v-for="f in fields" :key="f.name" class="grid gap-1">
        <label v-if="f.type === 'boolean'" class="flex items-center gap-2 text-[13px] text-text">
          <input
            type="checkbox"
            class="size-4 accent-(--accent)"
            :checked="form[f.name] === true"
            :disabled="ctx.readOnly.value || busy"
            @change="setChecked(f.name, $event)"
          />
          <span>{{ f.label }}</span>
        </label>
        <label v-else :for="`${item.id}:${f.name}`" class="text-[13px] text-text">
          {{ f.label }}<span v-if="f.required" class="text-text-muted"> *</span>
        </label>
        <p v-if="f.description" class="text-[12px] text-text-muted">{{ f.description }}</p>
        <p v-if="limitHint(f)" class="text-[12px] text-text-muted">{{ limitHint(f) }}</p>
        <input
          v-if="f.type === 'text' || f.type === 'number'"
          :id="`${item.id}:${f.name}`"
          class="tx-input"
          :inputmode="f.type === 'number' ? (f.integer ? 'numeric' : 'decimal') : undefined"
          :value="textOf(f.name)"
          :disabled="ctx.readOnly.value || busy"
          @input="setText(f.name, $event)"
          @keydown.enter="ready && respond(true)"
        />
        <!-- A long list is a dropdown: hundreds of buttons would push Submit out of the window -->
        <select
          v-else-if="f.type === 'choice' && (f.options?.length ?? 0) > LONG_CHOICE"
          :id="`${item.id}:${f.name}`"
          class="tx-input"
          :value="textOf(f.name)"
          :disabled="ctx.readOnly.value || busy"
          @change="setText(f.name, $event)"
        >
          <option value="" :disabled="f.required">{{ f.required ? 'Choose one' : 'None' }}</option>
          <option v-for="o in f.options ?? []" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <select
          v-else-if="f.type === 'multichoice' && (f.options?.length ?? 0) > LONG_CHOICE"
          :id="`${item.id}:${f.name}`"
          class="tx-input"
          multiple
          size="6"
          :disabled="ctx.readOnly.value || busy"
          @change="setPicks(f.name, $event)"
        >
          <option v-for="o in f.options ?? []" :key="o.value" :value="o.value" :selected="picksOf(f.name).includes(o.value)">{{ o.label }}</option>
        </select>
        <div v-else-if="f.type === 'choice' || f.type === 'multichoice'" :id="`${item.id}:${f.name}`" class="grid gap-1">
          <button
            v-for="o in f.options ?? []"
            :key="o.value"
            type="button"
            class="rounded-md border px-2.5 py-1.5 text-start text-[13px] transition-colors"
            :class="
              (f.type === 'choice' ? form[f.name] === o.value : picksOf(f.name).includes(o.value))
                ? 'border-brand/60 bg-brand/10 text-text'
                : 'border-border text-text-muted hover:bg-fill-hover hover:text-text'
            "
            :disabled="ctx.readOnly.value || busy"
            @click="f.type === 'choice' ? choose(f.name, o.value, f.required) : (form[f.name] = togglePick(picksOf(f.name), o.value))"
          >
            {{ o.label }}
          </button>
        </div>
      </div>
    </div>

    <!-- Where the link goes, in plain sight: the message is the server's to word, the host is not -->
    <div v-if="item.mode === 'url' && link" class="grid gap-1 px-3 pt-2 ps-9">
      <div class="flex min-w-0 flex-wrap items-center gap-2">
        <Tip :label="link.href">
          <a :href="link.href" target="_blank" rel="noopener noreferrer" class="tx-btn">
            Open link
            <ExternalLink class="size-3.5" />
          </a>
        </Tip>
        <span class="min-w-0 truncate text-[13px] font-medium text-text">{{ link.host }}</span>
        <span v-if="link.insecure" class="text-[12px] text-warning-text">Not secure (http)</span>
      </div>
      <Tip :label="link.href">
        <p class="truncate font-mono text-[12px] text-text-muted">{{ link.href }}</p>
      </Tip>
    </div>
    <p v-else-if="item.mode === 'url'" class="px-3 pt-2 ps-9 text-[12px] text-warning-text">
      The link it sent was refused: only http and https links open here.
    </p>

    <div v-if="!ctx.readOnly.value" class="flex flex-wrap items-center gap-2 px-3 py-2.5 ps-9">
      <button v-if="item.mode === 'form' || link" type="button" class="tx-btn tx-btn-primary" :disabled="busy || !ready" @click="respond(true)">
        {{ item.mode === 'url' ? 'I have finished' : 'Submit' }}
      </button>
      <button type="button" class="tx-btn tx-btn-ghost" :disabled="busy" @click="respond(false)">Cancel</button>
      <span v-if="answer.invalid.length" class="text-[12px] text-danger-text">{{ answer.invalid.join('; ') }}</span>
      <span v-if="err" class="text-[12px] text-danger-text">{{ err }}</span>
    </div>
    <div v-else class="px-3 py-2 text-[12px] text-text-muted">Waiting for an answer</div>
  </div>
</template>

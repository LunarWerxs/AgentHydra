<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { Check, Clock, MessageCircleQuestion, SkipForward, X } from '@lucide/vue'
import type { ImageRef, TranscriptItem } from '@shared/protocol'
import { dataUrlToBase64, validateImage } from '@/components/composer/logic'
import { useDesk } from '@/stores/desk'
import { useTranscript } from '../context'

// Pending, the card lives in the composer dock (docked); the transcript keeps a quiet row.
const props = defineProps<{ item: Extract<TranscriptItem, { kind: 'question' }>; docked?: boolean }>()

const ctx = useTranscript()
const desk = useDesk()
const busy = ref(false)
const err = ref<string | null>(null)
// Per question text: the chosen labels, and the "Other" text.
const picked = reactive<Record<string, string[]>>({})
const other = reactive<Record<string, string>>({})
const otherOn = reactive<Record<string, boolean>>({})
// Pictures pasted or dropped into the "Other" box, by question text; the server saves them and names them in the answer.
interface Picture { id: string; name: string; mediaType: string; dataBase64: string; url: string }
const pictures = reactive<Record<string, Picture[]>>({})
const pictureErr = ref<string | null>(null)
const dragOver = ref(false)
// One question at a time when there are several; the answers stay as the owner moves between them.
const step = ref(0)
const many = computed(() => props.item.questions.length > 1)
const last = computed(() => step.value >= props.item.questions.length - 1)
const q = computed(() => props.item.questions[step.value])

function toggle(q: string, label: string, multi: boolean) {
  const cur = picked[q] ?? []
  if (multi) picked[q] = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]
  else {
    picked[q] = [label]
    otherOn[q] = false
  }
}
function toggleOther(q: string, multi: boolean) {
  otherOn[q] = !otherOn[q]
  if (!multi && otherOn[q]) picked[q] = []
}

function picturesOf(q: string): Picture[] {
  return otherOn[q] ? (pictures[q] ?? []) : []
}
function answerFor(q: string): string {
  const parts = [...(picked[q] ?? [])]
  if (otherOn[q] && other[q]?.trim()) parts.push(other[q].trim())
  return parts.join(', ')
}
const answered = (q: string) => answerFor(q) !== '' || picturesOf(q).length > 0
const complete = computed(() => props.item.questions.every((x) => answered(x.question)))
const stepDone = computed(() => !!q.value && answered(q.value.question))

function next() {
  if (busy.value || !stepDone.value) return
  if (!last.value) step.value++
  else if (complete.value) void submit()
}

function addFiles(question: string, files: File[]) {
  pictureErr.value = null
  for (const file of files) {
    const bad = validateImage(file)
    if (bad) {
      pictureErr.value = bad
      continue
    }
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      ;(pictures[question] ??= []).push({ id: crypto.randomUUID(), name: file.name || 'Pasted image', mediaType: file.type, dataBase64: dataUrlToBase64(url), url })
    }
    reader.onerror = () => (pictureErr.value = `Could not read ${file.name || 'the image'}.`)
    reader.readAsDataURL(file)
  }
}
function onPaste(e: ClipboardEvent, question: string) {
  const files = Array.from(e.clipboardData?.items ?? [])
    .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
    .map((it) => it.getAsFile())
    .filter((f): f is File => !!f)
  if (!files.length) return
  e.preventDefault()
  addFiles(question, files)
}
function onDrop(e: DragEvent, question: string) {
  dragOver.value = false
  addFiles(question, Array.from(e.dataTransfer?.files ?? []))
}
function removePicture(question: string, id: string) {
  pictures[question] = (pictures[question] ?? []).filter((p) => p.id !== id)
}

async function submit(skip = false) {
  busy.value = true
  err.value = null
  try {
    if (skip) await desk.answerQuestion(ctx.chatId.value, props.item.id, { skip: true })
    else {
      const answers: Record<string, string> = {}
      const images: Record<string, ImageRef[]> = {}
      for (const x of props.item.questions) {
        answers[x.question] = answerFor(x.question)
        const list = picturesOf(x.question)
        if (list.length) images[x.question] = list.map((p) => ({ mediaType: p.mediaType, dataBase64: p.dataBase64, name: p.name }))
      }
      await desk.answerQuestion(ctx.chatId.value, props.item.id, Object.keys(images).length ? { answers, images } : { answers })
    }
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

const summary = computed(() => {
  const a = props.item.answers ?? {}
  const text = (s: string | undefined) => (s ?? '—').replace(/\s*\[Image: source: [^\]]*\]/g, ' [picture]')
  return props.item.questions.map((x) => `${x.header || x.question} → ${text(a[x.question])}`).join(' · ')
})
</script>

<template>
  <div v-if="item.state !== 'pending'" class="flex h-6 min-w-0 items-center gap-1.5 px-1 text-[14px] text-text-muted">
    <Check v-if="item.state === 'answered'" class="size-4 shrink-0 text-success-text" />
    <SkipForward v-else-if="item.state === 'skipped'" class="size-4 shrink-0 text-text-muted" />
    <Clock v-else class="size-4 shrink-0 text-text-muted" />
    <span class="shrink-0">{{ item.state === 'answered' ? 'Answered' : item.state === 'skipped' ? 'Skipped' : 'Expired' }}</span>
    <span v-if="item.state === 'answered'" class="min-w-0 truncate text-text">{{ summary }}</span>
    <span v-else class="min-w-0 truncate">{{ item.questions[0]?.question }}</span>
  </div>

  <div v-else-if="!docked" class="flex h-6 min-w-0 items-center gap-1.5 px-1 text-[14px] text-text-muted">
    <MessageCircleQuestion class="size-4 shrink-0 text-warning-text" />
    <span class="shrink-0">Waiting for you</span>
    <span class="min-w-0 truncate text-text">{{ item.questions[0]?.question }}</span>
  </div>

  <div v-else class="tx-ask px-3 py-2.5" role="group" aria-label="Claude has a question" @keydown.enter.self.prevent="next()">
    <div v-if="many" class="mb-2 flex items-center gap-2 pl-6 text-[12px] text-text-muted">
      <span class="font-medium text-text">Question {{ step + 1 }} of {{ item.questions.length }}</span>
      <span class="flex items-center gap-1" aria-hidden="true">
        <span
          v-for="(c, i) in item.questions"
          :key="c.question"
          class="h-1.5 rounded-full transition-all"
          :class="i === step ? 'w-4 bg-brand' : answered(c.question) ? 'w-1.5 bg-brand/50' : 'w-1.5 bg-border'"
        />
      </span>
    </div>
    <div v-if="q" :key="q.question" class="mb-1">
      <div class="flex items-start gap-2 text-[14px]">
        <MessageCircleQuestion class="mt-0.5 size-4 shrink-0 text-warning-text" />
        <div class="min-w-0">
          <span v-if="q.header" class="mr-2 rounded bg-fill-hover px-1.5 py-0.5 text-[11px] text-text-muted">{{ q.header }}</span>
          <span class="text-text">{{ q.question }}</span>
          <span v-if="q.multiSelect" class="ml-1 text-[12px] text-text-muted">(pick any)</span>
        </div>
      </div>
      <div class="mt-2 grid gap-1 pl-6">
        <button
          v-for="o in q.options"
          :key="o.label"
          type="button"
          class="flex items-baseline gap-2 rounded-md border px-2.5 py-1.5 text-left text-[13px] transition-colors"
          :class="
            picked[q.question]?.includes(o.label)
              ? 'border-brand/60 bg-brand/10 text-text'
              : 'border-border text-text-muted hover:bg-fill-hover hover:text-text'
          "
          :disabled="ctx.readOnly.value || busy"
          @click="toggle(q.question, o.label, q.multiSelect)"
        >
          <span class="shrink-0 font-medium">{{ o.label }}</span>
          <span v-if="o.description" class="min-w-0 truncate text-[12px] text-text-muted">{{ o.description }}</span>
        </button>
        <template v-if="!ctx.readOnly.value">
          <button
            type="button"
            class="rounded-md border px-2.5 py-1.5 text-left text-[13px]"
            :class="otherOn[q.question] ? 'border-brand/60 bg-brand/10 text-text' : 'border-border text-text-muted hover:bg-fill-hover'"
            :disabled="busy"
            @click="toggleOther(q.question, q.multiSelect)"
          >
            Other…
          </button>
          <div
            v-if="otherOn[q.question]"
            class="grid gap-1.5"
            :class="dragOver ? 'rounded-md ring-1 ring-brand/60' : ''"
            @dragover.prevent="dragOver = true"
            @dragleave="dragOver = false"
            @drop.prevent="onDrop($event, q.question)"
          >
            <input
              v-model="other[q.question]"
              class="tx-input"
              placeholder="Your answer (paste or drop a picture)"
              @keydown.enter.prevent="next()"
              @paste="onPaste($event, q.question)"
            />
            <div v-if="pictures[q.question]?.length" class="flex flex-wrap gap-1.5">
              <span v-for="im in pictures[q.question]" :key="im.id" class="group relative size-12 overflow-hidden rounded-md border border-border">
                <img :src="im.url" :alt="im.name" class="size-full object-cover" />
                <button
                  type="button"
                  class="absolute right-0 top-0 flex size-4 items-center justify-center rounded-bl bg-black/70 text-white"
                  :aria-label="`Remove ${im.name}`"
                  @click="removePicture(q.question, im.id)"
                >
                  <X class="size-3" />
                </button>
              </span>
            </div>
            <span v-if="pictureErr" class="text-[12px] text-danger-text">{{ pictureErr }}</span>
          </div>
        </template>
      </div>
    </div>
    <div v-if="!ctx.readOnly.value" class="mt-2.5 flex items-center gap-2 pl-6">
      <button v-if="step > 0" type="button" class="tx-btn tx-btn-ghost" :disabled="busy" @click="step--">Back</button>
      <button v-if="!last" type="button" class="tx-btn tx-btn-primary" :disabled="busy || !stepDone" @click="next()">Next</button>
      <button v-else type="button" class="tx-btn tx-btn-primary" :disabled="busy || !complete" @click="submit()">Answer</button>
      <button type="button" class="tx-btn tx-btn-ghost" :disabled="busy" @click="submit(true)">Skip</button>
      <span v-if="err" class="text-[12px] text-danger-text">{{ err }}</span>
    </div>
  </div>
</template>

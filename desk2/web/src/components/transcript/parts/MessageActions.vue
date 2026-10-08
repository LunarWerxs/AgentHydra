<script setup lang="ts">
// The toolbar under a message (role=toolbar "Message actions"): 24px muted buttons, hidden until the
// message row is hovered. Hydra Desk has Copy, Undo, Fork, "..." and the time; the real app's Pin and Read aloud
// need server routes Hydra Desk does not have yet. Undo (a message of yours, or the reply ending its turn) is
// Claude Code's rewind: this chat loses that message and all after it (a running turn is stopped), and the
// message, pictures and all, goes back in the box to change and send again. Undo asks first when it would take
// out more than your last message, with Fork instead in the dialog. Fork (a message of yours) opens a
// new chat cut just before that message, the message waiting unsent in its box.
// "..." (a message of yours) has Change project: a new chat in the folder chosen sends the same text and
// pictures and opens; this chat is left as it is, the message and its reply still in it.
// "Copy up to here into a new chat" (a reply in an outside Claude Code session): AgentHydra writes a new session
// holding it up to this reply, which opens; the original is not touched (AgentHydra's old Sessions tab had it).
import { computed, ref } from 'vue'
import { RotateCcw } from '@lucide/vue'
import type { ImageRef } from '@shared/protocol'
import { icons, shellGlyphs } from '@/lib/icons'
import { buildCopyHtml } from '@/lib/clipboard-images'
import type { DraftImage } from '@/components/composer/draft-images'
import ChangeProjectMenu from '@/components/composer/ChangeProjectMenu.vue'
import { movedChat } from '@/components/composer/change-project'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useDesk } from '@/stores/desk'
import { useTranscript } from '../context'
import { undoCount } from '../lib/undo-count'

const props = defineProps<{
  text: string
  ts: number
  align?: 'start' | 'end'
  pinned?: boolean
  /** The owner's message this row belongs to (the reply's: the one it answers), with its item id: Copy's pictures, Undo, Change project. */
  resend?: { text: string; images?: ImageRef[]; id?: string } | null
  /** The message's transcript id: a message of yours with one has Fork. */
  itemId?: string
  /** An outside Claude Code session's reply line: it has "Copy up to here into a new chat". */
  branchFrom?: string
}>()
const copied = ref(false)
const time = computed(() => new Date(props.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))

const ctx = useTranscript()
const desk = useDesk()
const canResend = computed(() => !!props.resend && !ctx.readOnly.value && !!ctx.chatId.value)

/** The message Undo goes back to before: this one, or the one this reply answers. Only a Hydra Desk chat has it. */
const undoAt = computed(() => props.itemId ?? props.resend?.id)
const canUndo = computed(() => canResend.value && !!undoAt.value && desk.chats.value.some((c) => c.id === ctx.chatId.value))
const undoState = ref<'idle' | 'undoing' | 'failed'>('idle')
const undoError = ref('')
const undoLabel = computed(() =>
  undoState.value === 'undoing'
    ? 'Undoing…'
    : undoState.value === 'failed'
      ? `Undo failed${undoError.value ? `: ${undoError.value}` : ''}`
      : 'Undo: take your message and all after it out of this chat, and put it back in the box. Asks first when that is more than your last message'
)

/** What an undo here takes out, or null when the chat's items are not known (then Undo goes straight through). */
const undoTakes = computed(() => (undoAt.value && ctx.items ? undoCount(ctx.items.value, undoAt.value) : null))
const askUndo = ref(false)
const undoTime = computed(() => {
  const at = ctx.items?.value.find((it) => it.id === undoAt.value)?.ts
  return at === undefined ? '' : new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
})

const canFork = computed(() => !!props.itemId && !ctx.readOnly.value && !!ctx.chatId.value)
const forkState = ref<'idle' | 'forking' | 'failed'>('idle')
const forkError = ref('')
const forkLabel = computed(() =>
  forkState.value === 'forking'
    ? 'Forking…'
    : forkState.value === 'failed'
      ? `Fork failed${forkError.value ? `: ${forkError.value}` : ''}`
      : 'Fork: a new chat from just before this message'
)

const canBranch = computed(() => !!props.branchFrom && !!ctx.chatId.value)
const branchState = ref<'idle' | 'branching' | 'failed'>('idle')
const branchError = ref('')
const branchLabel = computed(() =>
  branchState.value === 'branching'
    ? 'Copying…'
    : branchState.value === 'failed'
      ? `Copy failed${branchError.value ? `: ${branchError.value}` : ''}`
      : 'Copy up to here into a new chat'
)

const moreOpen = ref(false)
const moveState = ref<'idle' | 'moving' | 'failed'>('idle')
const moveError = ref('')
const moreLabel = computed(() =>
  moveState.value === 'moving' ? 'Sending to the other project…' : moveState.value === 'failed' ? `Change project failed${moveError.value ? `: ${moveError.value}` : ''}` : 'More'
)

/** A message with pictures copies them too: text/plain stays the text, text/html adds the pictures. */
async function writeClipboard() {
  const images = props.resend?.images ?? []
  if (!images.length || typeof ClipboardItem === 'undefined') return navigator.clipboard.writeText(props.text)
  // Blobs as promises, so the write starts inside the click while the pictures are still loading
  const html = Promise.all(images.map(withBytes)).then(
    (refs) =>
      new Blob([buildCopyHtml(props.text, refs.filter((r) => r.dataBase64).map((r) => `data:${r.mediaType};base64,${r.dataBase64}`))], {
        type: 'text/html'
      })
  )
  try {
    await navigator.clipboard.write([
      new ClipboardItem({ 'text/plain': new Blob([props.text], { type: 'text/plain' }), 'text/html': html })
    ])
  } catch {
    await navigator.clipboard.writeText(props.text)
  }
}

async function copy() {
  try {
    await writeClipboard()
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch {
    // clipboard refused (no focus or permission): nothing to show, the button stays as it was
  }
}

/** History keeps a picture as a URL; a send needs its bytes. */
async function withBytes(img: ImageRef): Promise<ImageRef> {
  if (img.dataBase64 || !img.url) return { mediaType: img.mediaType, dataBase64: img.dataBase64, name: img.name }
  const res = await fetch(img.url)
  if (!res.ok) throw new Error(`a picture could not be loaded (${res.status})`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return { mediaType: img.mediaType, dataBase64: btoa(bin), name: img.name }
}

/** The message's pictures as a box holds them. */
async function boxImages(): Promise<DraftImage[]> {
  const refs = props.resend?.images?.length ? await Promise.all(props.resend.images.map(withBytes)) : []
  return refs.flatMap(({ name, mediaType, dataBase64 }) =>
    dataBase64 ? [{ id: crypto.randomUUID(), name: name ?? 'Image', mediaType, dataBase64, url: `data:${mediaType};base64,${dataBase64}` }] : []
  )
}

/** Undo asks first when it takes out more than your last message; otherwise it goes straight through. */
function askOrUndo() {
  if ((undoTakes.value?.yours ?? 0) > 1) askUndo.value = true
  else void undo()
}

function confirmUndo() {
  askUndo.value = false
  void undo()
}

/** Undo: the chat goes back to before the message, which waits in the box (its pictures read first, so a failed read changes nothing). */
async function undo() {
  const r = props.resend
  const at = undoAt.value
  if (!r || !at || undoState.value === 'undoing') return
  undoState.value = 'undoing'
  try {
    await desk.rewind(ctx.chatId.value, at, { text: r.text, images: await boxImages() })
    undoState.value = 'idle'
  } catch (err) {
    undoError.value = err instanceof Error ? err.message : String(err)
    undoState.value = 'failed'
    setTimeout(() => (undoState.value = 'idle'), 4000)
  }
}

/** Change project: the message, pictures and all, starts a new chat in that folder, which opens. */
async function moveTo(cwd: string) {
  const r = props.resend
  if (!r || moveState.value === 'moving') return
  moveState.value = 'moving'
  try {
    const images = r.images?.length ? await Promise.all(r.images.map(withBytes)) : []
    const from = desk.chats.value.find((c) => c.id === ctx.chatId.value) ?? null
    await desk.createChat(movedChat(from, cwd, { text: r.text, images }))
    moveState.value = 'idle'
  } catch (err) {
    moveError.value = err instanceof Error ? err.message : String(err)
    moveState.value = 'failed'
    setTimeout(() => (moveState.value = 'idle'), 4000)
  }
}

async function forkBefore(at: string, text: string) {
  if (forkState.value === 'forking') return
  forkState.value = 'forking'
  try {
    await desk.forkAt(ctx.chatId.value, at, { text, images: await boxImages() })
    forkState.value = 'idle'
  } catch (err) {
    forkError.value = err instanceof Error ? err.message : String(err)
    forkState.value = 'failed'
    setTimeout(() => (forkState.value = 'idle'), 4000)
  }
}

function fork() {
  if (props.itemId) void forkBefore(props.itemId, props.text)
}

function forkInstead() {
  const at = undoAt.value
  if (!at || !props.resend) return
  askUndo.value = false
  void forkBefore(at, props.resend.text)
}

async function branch() {
  if (!props.branchFrom || branchState.value === 'branching') return
  branchState.value = 'branching'
  try {
    await desk.branchExternal(ctx.chatId.value, props.branchFrom)
    branchState.value = 'idle'
  } catch (err) {
    branchError.value = err instanceof Error ? err.message : String(err)
    branchState.value = 'failed'
    setTimeout(() => (branchState.value = 'idle'), 4000)
  }
}
</script>

<template>
  <div
    role="toolbar"
    aria-label="Message actions"
    class="tx-actions"
    :class="[align === 'end' ? 'justify-end' : 'justify-start', (pinned || moreOpen || moveState !== 'idle' || undoState === 'failed' || forkState !== 'idle') && 'tx-actions-pinned']"
  >
    <time v-if="align === 'end'" class="tx-actions-time">{{ time }}</time>
    <button type="button" class="tx-action" :aria-label="copied ? 'Copied' : 'Copy'" :title="copied ? 'Copied' : 'Copy'" @click="copy">
      <component :is="copied ? icons.check : icons.copy" class="size-4" />
    </button>
    <button
      v-if="canUndo"
      type="button"
      class="tx-action"
      :aria-label="undoLabel"
      :title="undoLabel"
      :disabled="undoState === 'undoing'"
      @click="askOrUndo"
    >
      <component :is="RotateCcw" class="size-4" :class="undoState === 'failed' && 'text-danger-text'" />
    </button>
    <Dialog :open="askUndo" @update:open="(o: boolean) => !o && (askUndo = false)">
      <DialogContent :show-close-button="false" class="gap-3 rounded-[var(--radius-12)] p-4 shadow-(--shadow-popover) ring-0 sm:max-w-[360px]">
        <DialogTitle class="text-[14px] font-semibold leading-5 text-text">Undo {{ undoTakes?.total }} messages?</DialogTitle>
        <DialogDescription class="text-[13px] leading-[19px] text-text-2">
          This takes your message from {{ undoTime }} and everything after it out of this chat: {{ undoTakes?.yours }} of your messages and {{ undoTakes?.replies }} {{ undoTakes?.replies === 1 ? 'reply' : 'replies' }}. Fork instead keeps this chat as it is and opens a new chat from just before that message.
        </DialogDescription>
        <div class="flex justify-end gap-2 pt-1">
          <button type="button" class="h-7 rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-3 text-[13px] text-text hover:bg-[var(--fill-secondary-hover)]" @click="askUndo = false">Cancel</button>
          <button type="button" class="h-7 rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-3 text-[13px] text-text hover:bg-[var(--fill-secondary-hover)]" @click="forkInstead">Fork instead</button>
          <button type="button" class="h-7 rounded-[var(--radius-6)] bg-danger px-3 text-[13px] font-medium text-white hover:brightness-110" @click="confirmUndo">Undo {{ undoTakes?.total }} messages</button>
        </div>
      </DialogContent>
    </Dialog>
    <!-- A reply's row has no Fork button, but its dialog's Fork instead shows its progress or failure here -->
    <button
      v-if="canFork || forkState !== 'idle'"
      type="button"
      class="tx-action"
      :aria-label="forkLabel"
      :title="forkLabel"
      :disabled="forkState === 'forking'"
      @click="fork"
    >
      <component :is="icons.fork" class="size-4" :class="forkState === 'failed' && 'text-danger-text'" />
    </button>
    <button
      v-if="canBranch"
      type="button"
      class="tx-action"
      :aria-label="branchLabel"
      :title="branchLabel"
      :disabled="branchState === 'branching'"
      @click="branch"
    >
      <component :is="icons.fork" class="size-4" :class="branchState === 'failed' && 'text-danger-text'" />
    </button>
    <ChangeProjectMenu v-if="canResend" v-model:open="moreOpen" :current="ctx.cwd.value" header="Send it in a new chat in" @choose="moveTo">
      <button type="button" class="tx-action" :aria-label="moreLabel" :title="moreLabel" :disabled="moveState === 'moving'">
        <component :is="shellGlyphs.rowMore" class="size-4" :class="moveState === 'failed' && 'text-danger-text'" />
      </button>
    </ChangeProjectMenu>
    <slot />
    <time v-if="align !== 'end'" class="tx-actions-time">{{ time }}</time>
  </div>
</template>

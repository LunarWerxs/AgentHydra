<script setup lang="ts">
// The toolbar under a message (role=toolbar "Message actions"): 24px muted buttons, hidden until the
// message row is hovered. Hydra Desk has Copy, Resend, Fork, "..." and the time; the real app's Rewind, Pin and
// Read aloud need server routes Hydra Desk does not have yet. Resend sends a prompt again as a new message
// at the end of the chat (queued if a turn is running); it does not rewind what came after it. Fork (a
// message of yours) opens a new chat cut just before that message, the message waiting unsent in its box.
// "..." (a message of yours) has Change project: a new chat in the folder chosen sends the same text and
// pictures and opens; this chat is left as it is, the message and its reply still in it.
import { computed, ref } from 'vue'
import { RotateCcw } from '@lucide/vue'
import type { ImageRef, SendMessageRequest } from '@shared/protocol'
import { icons, shellGlyphs } from '@/lib/icons'
import { buildCopyHtml } from '@/lib/clipboard-images'
import type { DraftImage } from '@/components/composer/draft-images'
import ChangeProjectMenu from '@/components/composer/ChangeProjectMenu.vue'
import { movedChat } from '@/components/composer/change-project'
import { useDesk } from '@/stores/desk'
import { useTranscript } from '../context'

const props = defineProps<{
  text: string
  ts: number
  align?: 'start' | 'end'
  pinned?: boolean
  /** The prompt the Resend button sends again; no button without one. */
  resend?: { text: string; images?: ImageRef[] } | null
  /** The message's transcript id: a message of yours with one has Fork. */
  itemId?: string
}>()
const copied = ref(false)
const time = computed(() => new Date(props.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))

const ctx = useTranscript()
const desk = useDesk()
const canResend = computed(() => !!props.resend && !ctx.readOnly.value && !!ctx.chatId.value)
const resendState = ref<'idle' | 'sending' | 'sent' | 'failed'>('idle')
const resendLabel = computed(() =>
  resendState.value === 'sent' ? 'Sent again' : resendState.value === 'failed' ? 'Resend failed' : 'Resend this prompt'
)

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

async function resend() {
  const r = props.resend
  if (!r || resendState.value === 'sending') return
  resendState.value = 'sending'
  try {
    const images = r.images?.length ? await Promise.all(r.images.map(withBytes)) : []
    const message: SendMessageRequest = { text: r.text, ...(images.length ? { images } : {}) }
    await desk.send(ctx.chatId.value, message)
    resendState.value = 'sent'
  } catch {
    resendState.value = 'failed'
  }
  setTimeout(() => (resendState.value = 'idle'), 1500)
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

async function fork() {
  if (!props.itemId || forkState.value === 'forking') return
  forkState.value = 'forking'
  try {
    const refs = props.resend?.images?.length ? await Promise.all(props.resend.images.map(withBytes)) : []
    const images: DraftImage[] = refs.flatMap(({ name, mediaType, dataBase64 }) =>
      dataBase64 ? [{ id: crypto.randomUUID(), name: name ?? 'Image', mediaType, dataBase64, url: `data:${mediaType};base64,${dataBase64}` }] : []
    )
    await desk.forkAt(ctx.chatId.value, props.itemId, { text: props.text, images })
    forkState.value = 'idle'
  } catch (err) {
    forkError.value = err instanceof Error ? err.message : String(err)
    forkState.value = 'failed'
    setTimeout(() => (forkState.value = 'idle'), 4000)
  }
}
</script>

<template>
  <div
    role="toolbar"
    aria-label="Message actions"
    class="tx-actions"
    :class="[align === 'end' ? 'justify-end' : 'justify-start', (pinned || moreOpen || moveState !== 'idle') && 'tx-actions-pinned']"
  >
    <time v-if="align === 'end'" class="tx-actions-time">{{ time }}</time>
    <button type="button" class="tx-action" :aria-label="copied ? 'Copied' : 'Copy'" :title="copied ? 'Copied' : 'Copy'" @click="copy">
      <component :is="copied ? icons.check : icons.copy" class="size-4" />
    </button>
    <button
      v-if="canResend"
      type="button"
      class="tx-action"
      :aria-label="resendLabel"
      :title="resendLabel"
      :disabled="resendState === 'sending'"
      @click="resend"
    >
      <component :is="resendState === 'sent' ? icons.check : RotateCcw" class="size-4" :class="resendState === 'failed' && 'text-danger-text'" />
    </button>
    <button
      v-if="canFork"
      type="button"
      class="tx-action"
      :aria-label="forkLabel"
      :title="forkLabel"
      :disabled="forkState === 'forking'"
      @click="fork"
    >
      <component :is="icons.fork" class="size-4" :class="forkState === 'failed' && 'text-danger-text'" />
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

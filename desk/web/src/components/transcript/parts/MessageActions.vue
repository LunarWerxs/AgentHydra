<script setup lang="ts">
// The toolbar under a message (role=toolbar "Message actions"): 24px muted buttons, hidden until the
// message row is hovered. Hydra Desk has Copy, Resend and the time; the real app's Rewind, Fork, Pin and
// Read aloud need server routes Hydra Desk does not have yet. Resend sends a prompt again as a new message
// at the end of the chat (queued if a turn is running); it does not rewind what came after it.
import { computed, ref } from 'vue'
import { RotateCcw } from '@lucide/vue'
import type { ImageRef, SendMessageRequest } from '@shared/protocol'
import { icons } from '@/lib/icons'
import { buildCopyHtml } from '@/lib/clipboard-images'
import { useDesk } from '@/stores/desk'
import { useTranscript } from '../context'

const props = defineProps<{
  text: string
  ts: number
  align?: 'start' | 'end'
  pinned?: boolean
  /** The prompt the Resend button sends again; no button without one. */
  resend?: { text: string; images?: ImageRef[] } | null
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
</script>

<template>
  <div
    role="toolbar"
    aria-label="Message actions"
    class="tx-actions"
    :class="[align === 'end' ? 'justify-end' : 'justify-start', pinned && 'tx-actions-pinned']"
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
    <slot />
    <time v-if="align !== 'end'" class="tx-actions-time">{{ time }}</time>
  </div>
</template>

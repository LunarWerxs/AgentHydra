<script setup lang="ts">
// The AI used its browser: one compact preview card that opens that browser live in the side pane (DeskFrame listens
// for OPEN_BROWSER_EVENT); the default browser is never live, its click loads the address in the pane. The caption and
// click use the run's latest real address, never about:blank. A run of browser calls is one card showing the latest (`run`). The picture is, in order,
// the browser live (a stream, else a 3 s poll; newest card of an open profile, on screen, window visible), the run's latest screenshot, a quiet
// placeholder; the caption along the bottom is faint until the pointer is over it. A browser that is closed (its pane tab
// was closed, or a look finds it not open) shows a quiet Closed and is not fed any more; the full-screen button and the
// copy-the-calls button are the card's own, over the picture and the status. When the run ended on a blank address (the AI
// left the page) or a live look finds a blank page, its last screenshot stays, dimmed, badged Page closed. With no real
// address a click on the picture opens it full screen. The person's own Chrome (browser_live) never opens the pane and is never fed live:
// its card shows its last picture or a grey placeholder, and its click only shows a picture.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Check, Copy, Globe, Maximize2, Monitor } from '@lucide/vue'
import type { TranscriptItem } from '@shared/protocol'
import { BROWSER_CLOSED_EVENT, OPEN_BROWSER_EVENT } from '@shared/browser'
import { browserErrorSummary, browserOpenRequest, browserRunAddress, DEFAULT_BROWSER, isOwnChromeCall, ownChromeAction, ownChromeClosed, parseBrowserCall, YOUR_CHROME } from '../lib/tools'
import { imageSrc, openLightbox } from '../lib/media'
import { browserCallsText } from '../lib/browserCopy'
import { forgetProfiles, isBlankPicture, nextFrame, openPreviewStream, openProfiles, PreviewFeed, previewWanted, savedProfiles } from '../lib/browserPreview'
import { shortId, shortName } from '../../servers/names'
import { useTranscript } from '../context'
import StatusIcon from './StatusIcon.vue'

type ToolItem = Extract<TranscriptItem, { kind: 'tool_use' }>
const props = defineProps<{ item: ToolItem; run?: ToolItem[] }>()
const ctx = useTranscript()

const calls = computed(() => props.run ?? [props.item])
const count = computed(() => calls.value.length)
// The latest call's profile and the run's latest REAL address (never about:blank); `left` says the run ended on a blank one.
const address = computed(() => browserRunAddress(calls.value))
const info = computed(() => ({ ...parseBrowserCall(props.item.name, props.item.input, props.item.result?.text), url: address.value.url }))
const shownUrl = computed(() => {
  const u = info.value.url.replace(/^https?:\/\//, '').replace(/\/$/, '')
  return u.length > 60 ? u.slice(0, 59) + '…' : u
})
const host = computed(() => {
  try {
    return new URL(info.value.url).host
  } catch {
    return ''
  }
})
const error = computed(() => {
  if (props.item.status !== 'error' && !props.item.result?.isError) return null
  const text = (props.item.result?.text ?? '').trim()
  return text ? browserErrorSummary(text) : { headline: 'Failed', hint: '' }
})
const ownChrome = computed(() => isOwnChromeCall(props.item.name, props.item.input))
const ownAction = computed(() => ownChromeAction(props.item.input))
// The run's latest screenshot picture, if any call carried one.
const shot = computed(() => {
  for (let i = calls.value.length - 1; i >= 0; i--) {
    const imgs = calls.value[i].result?.images ?? []
    for (let j = imgs.length - 1; j >= 0; j--) {
      const src = imageSrc(imgs[j])
      if (src) return src
    }
  }
  return null
})

// ---- live preview ----
const root = ref<HTMLElement | null>(null)
const onScreen = ref(false)
const visible = ref(typeof document === 'undefined' || document.visibilityState === 'visible')
const live = ref<string | null>(null)
const named = computed(() => info.value.profile !== DEFAULT_BROWSER)
const newest = computed(() => named.value && ctx.newestBrowser?.value.get(info.value.profile) === props.item.id)
// The browser was found closed (not open any more): the card says so and stops feeding itself. A newer call resets it.
const closed = ref(false)
// A live look found a blank page: the page is gone, so the picture shown is only the run's old screenshot.
const sawBlank = ref(false)
watch(
  () => props.item.id,
  () => {
    closed.value = false
    sawBlank.value = false
  }
)
const watching = computed(() => !closed.value && previewWanted({ named: named.value, newest: newest.value, onScreen: onScreen.value, visible: visible.value, hasCwd: !!ctx.cwd.value }))

// The profile chip is the short label the Saved browsers list shows; the registry name is its hover.
const label = ref<string | null>(null)
const chip = computed(() => (ownChrome.value ? YOUR_CHROME : (label.value ?? shortId(info.value.profile))))
async function loadLabel() {
  const cwd = ctx.cwd.value
  if (!cwd || !named.value) return
  const name = info.value.profile
  const row = (await savedProfiles(cwd))?.find((p) => p.name === name)
  if (row && name === info.value.profile) label.value = shortName(row)
}
watch(
  () => info.value.profile,
  () => {
    label.value = null
    void loadLabel()
  }
)

// A picture is a stream frame (a data: address) or a polled still (an object URL that is revoked when replaced).
// A blank page (one flat colour: the browser is on about:blank, its page is gone) is not shown live: the card goes back
// to the run's screenshot or its placeholder, never an older frame of a page that is no longer there.
let shown = 0
function show(src: string | null) {
  const token = ++shown
  if (!src) return put(null)
  void isBlankPicture(src).then((blank) => {
    if (token !== shown) {
      if (src.startsWith('blob:')) URL.revokeObjectURL(src)
      return
    }
    sawBlank.value = blank
    if (!blank) return put(src)
    if (src.startsWith('blob:')) URL.revokeObjectURL(src)
    put(null)
  })
}
function put(src: string | null) {
  const old = live.value
  live.value = src
  if (old?.startsWith('blob:')) URL.revokeObjectURL(old)
}
let busy = false
async function tick() {
  const cwd = ctx.cwd.value
  if (busy || !cwd) return
  busy = true
  try {
    const open = await openProfiles(cwd)
    // Only a read that succeeded and does not list the profile means closed; a failed read or frame keeps the last good one.
    const gone = open !== null && !open.has(info.value.profile)
    const frame = gone ? null : await nextFrame(cwd, info.value.profile, ctx.chatId.value).catch(() => null)
    if (!watching.value) {
      if (frame) URL.revokeObjectURL(frame)
      return
    }
    if (gone) closed.value = true
    if (!frame && !gone) return
    show(frame)
  } finally {
    busy = false
  }
}
// The stream feeds the picture while it works; the 3 s poll takes over when it fails or the browser is closed.
const feed = new PreviewFeed(
  { openStream: (onFrame, onEnd) => openPreviewStream(ctx.cwd.value ?? '', info.value.profile, onFrame, onEnd, ctx.chatId.value), poll: tick },
  show,
)
watch(watching, (on) => feed.setWanted(on), { immediate: true })

let observer: IntersectionObserver | null = null
const onVisibility = () => (visible.value = document.visibilityState === 'visible')
// The pane closed this browser: Closed at once, without waiting for the next look.
const onClosed = (e: Event) => {
  const d = (e as CustomEvent<{ cwd?: string; profile?: string }>).detail
  if (d?.profile !== info.value.profile || d.cwd !== ctx.cwd.value) return
  forgetProfiles(d.cwd)
  if (newest.value) closed.value = true
}
onMounted(() => {
  void loadLabel()
  window.addEventListener(BROWSER_CLOSED_EVENT, onClosed)
  document.addEventListener('visibilitychange', onVisibility)
  if (root.value && typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver((e) => (onScreen.value = e[e.length - 1]?.isIntersecting ?? false))
    observer.observe(root.value)
  }
})
onBeforeUnmount(() => {
  feed.setWanted(false)
  window.removeEventListener(BROWSER_CLOSED_EVENT, onClosed)
  observer?.disconnect()
  document.removeEventListener('visibilitychange', onVisibility)
  show(null)
})

const picture = computed(() => live.value ?? shot.value)
const gone = computed(() => (ownChrome.value ? ownChromeClosed(calls.value) : closed.value))
// The picture is the AI's last screenshot of a page that is gone: the run ended on a blank address, or a live look found one.
const past = computed(() => !gone.value && !live.value && !!shot.value && (address.value.left || sawBlank.value))
const surface = computed(() => (ownChrome.value && !picture.value ? 'div' : 'button'))
const grey = computed(() => ownChrome.value || gone.value)
const tip = computed(() => {
  if (ownChrome.value)
    return picture.value ? (gone.value ? 'Show the last screenshot full screen' : 'Show the picture full screen') : 'The AI worked in your own Chrome window'
  if (gone.value) return 'This browser is closed: open it again'
  if (past.value)
    return `Page closed: this is the AI's last screenshot of it. ${info.value.url ? `Click to open ${info.value.url} again in the browser pane` : 'Click to see it full screen'}`
  if (named.value) return `Watch this browser live${info.value.url ? ': ' + info.value.url : ''}`
  return info.value.url ? `Open ${info.value.url} in the browser pane` : 'Open the browser pane'
})

// Copy the calls: plain text, brief feedback.
const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | null = null
async function copyCalls() {
  try {
    await navigator.clipboard.writeText(browserCallsText(calls.value))
  } catch {
    return
  }
  copied.value = true
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => (copied.value = false), 1500)
}
onBeforeUnmount(() => copiedTimer && clearTimeout(copiedTimer))
function open() {
  if (ownChrome.value) {
    if (picture.value) openLightbox(picture.value, 'Browser')
    return
  }
  // No real address to open and a picture to show: the picture, not an empty pane tab.
  if (!named.value && !info.value.url && picture.value) return openLightbox(picture.value, 'Browser')
  window.dispatchEvent(new CustomEvent(OPEN_BROWSER_EVENT, { detail: browserOpenRequest(info.value) }))
}
</script>

<template>
  <div ref="root" class="group/card relative w-90 max-w-full">
    <!-- The person's own Chrome and a closed browser are a flat neutral grey: no brand ring, nothing that looks like it is loading. -->
    <div class="tx-card relative overflow-hidden" :class="grey ? '' : 'shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--brand)_35%,transparent)]'">
      <component
        :is="surface"
        :type="surface === 'button' ? 'button' : undefined"
        class="group/open relative block aspect-16/10 w-full overflow-hidden rounded-[inherit] text-start outline-none focus-visible:ring-2 focus-visible:ring-brand"
        :class="grey ? 'bg-(--bg-picture)' : 'bg-fill-hover'"
        :title="tip || undefined"
        @click="open"
      >
        <img v-if="picture" :src="picture" alt="" class="size-full rounded-[inherit] object-cover object-left-top" :class="gone ? 'opacity-25 grayscale' : past ? 'opacity-60 grayscale' : ''" draggable="false" />
        <span
          v-if="gone"
          class="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-[color-mix(in_srgb,var(--bg-picture)_80%,transparent)] px-4 text-center text-text-muted"
        >
          <span class="text-[13px]">{{ ownChrome ? 'Tab closed' : 'Browser closed' }}</span>
          <span v-if="shownUrl" class="max-w-full truncate font-mono text-[12px]">{{ shownUrl }}</span>
        </span>
        <span v-else-if="!picture" class="flex size-full flex-col items-center justify-center gap-1 text-text-muted">
          <Monitor v-if="ownChrome" class="size-5" aria-hidden="true" />
          <Globe v-else class="size-5" aria-hidden="true" />
          <span v-if="ownChrome" class="text-[12px]">{{ YOUR_CHROME }}</span>
          <span v-if="host" class="max-w-[90%] truncate text-[12px]">{{ host }}</span>
          <span v-if="ownChrome" class="mt-0.5 max-w-[90%] truncate rounded-full bg-black/10 px-2 py-0.5 text-[12px] text-text">{{ ownAction }}</span>
        </span>
        <span v-if="gone" class="absolute left-1.5 top-1.5 rounded bg-black/55 px-1.5 text-[11px] text-white/85">× Closed</span>
        <span v-else-if="past" class="absolute left-1.5 top-1.5 rounded bg-black/55 px-1.5 text-[11px] text-white/85">Page closed</span>
        <span
          class="absolute inset-x-0 bottom-0 flex min-w-0 items-center gap-1.5 bg-[linear-gradient(to_top,rgb(0_0_0/0.78),transparent)] px-2.5 pb-1.5 pt-5 text-[12px] text-white opacity-35 transition-opacity duration-120 hover:opacity-100 group-focus-visible/open:opacity-100"
          :title="`${info.verb}${info.url ? ' ' + info.url : ''}`"
        >
          <span v-if="live" class="size-1.5 shrink-0 animate-pulse rounded-full bg-success" title="Live" />
          <Monitor v-if="ownChrome" class="size-3.5 shrink-0" aria-hidden="true" />
          <Globe v-else class="size-3.5 shrink-0" aria-hidden="true" />
          <span class="min-w-0 truncate">{{ shownUrl && !gone ? shownUrl : ownChrome ? ownAction : info.verb }}</span>
          <span class="shrink-0 rounded bg-white/20 px-1.5 text-[11px]" :title="ownChrome ? 'Your own Chrome window' : info.profile">{{ chip }}</span>
          <!-- Room for the count and status drawn over this end: the address truncates before the chip meets them. -->
          <span class="invisible flex shrink-0 items-center gap-1.5 tabular-nums" aria-hidden="true">
            <span class="w-5" />
            <template v-if="count > 1">{{ count }} calls</template>
            <span class="size-3.5" />
          </span>
        </span>
      </component>
      <!-- Over the caption's right end, not inside its button: the count and status, with Copy the calls on hover. -->
      <span class="pointer-events-none absolute bottom-0 right-0 flex items-center px-2.5 pb-1.5 text-[12px] text-white">
        <span class="group/calls pointer-events-auto flex items-center gap-1.5 tabular-nums opacity-35 transition-opacity duration-120 focus-within:opacity-100 hover:opacity-100">
          <button
            type="button"
            class="grid h-5 place-items-center rounded-6 bg-black/55 px-1 text-white opacity-0 outline-none transition-opacity duration-120 hover:bg-black/75 focus-visible:opacity-100 group-hover/calls:opacity-100"
            :class="copied ? 'opacity-100!' : ''"
            :aria-label="count > 1 ? `Copy the ${count} calls` : 'Copy the call'"
            :title="count > 1 ? `Copy the ${count} calls` : 'Copy the call'"
            @click="copyCalls"
          >
            <span v-if="copied" class="flex items-center gap-1 text-[11px]"><Check class="size-3" aria-hidden="true" />Copied</span>
            <Copy v-else class="size-3" aria-hidden="true" />
          </button>
          <template v-if="count > 1">{{ count }} calls</template>
          <StatusIcon :status="item.status" />
        </span>
      </span>
    </div>
    <button
      v-if="picture"
      type="button"
      class="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-6 bg-black/55 text-white opacity-0 outline-none transition-opacity duration-120 hover:bg-black/75 focus-visible:opacity-100 group-hover/card:opacity-100"
      aria-label="Open full screen"
      title="Open full screen"
      @click="openLightbox(picture!, 'Browser')"
    >
      <Maximize2 class="size-3.5" aria-hidden="true" />
    </button>
    <!-- A failure in words, at most two lines: the headline in the danger colour, its hint muted; the full text on hover. -->
    <p v-if="error" class="mt-1 line-clamp-2 min-w-0 wrap-break-word px-1 text-[12px]" :title="[error.headline, error.hint].filter(Boolean).join(' — ')">
      <span class="text-danger-text">{{ error.headline }}</span>
      <span v-if="error.hint" class="text-text-muted"> — {{ error.hint }}</span>
    </p>
  </div>
</template>

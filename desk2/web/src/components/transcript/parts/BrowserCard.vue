<script setup lang="ts">
// The AI used its browser: one compact preview card that opens that browser live in the side pane (DeskFrame listens
// for OPEN_BROWSER_EVENT). A run of browser calls is one card showing the latest (`run`). The picture is, in order,
// the browser live (newest card of an open profile, on screen, window visible), the run's latest screenshot, a quiet
// placeholder; the caption along the bottom is faint until the pointer is over it.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Globe, Maximize2 } from '@lucide/vue'
import type { TranscriptItem } from '@shared/protocol'
import { OPEN_BROWSER_EVENT } from '@shared/browser'
import { browserOpenRequest, DEFAULT_BROWSER, parseBrowserCall } from '../lib/tools'
import { imageSrc, openLightbox } from '../lib/media'
import { nextFrame, openProfiles, PREVIEW_EVERY_MS } from '../lib/browserPreview'
import { useTranscript } from '../context'
import StatusIcon from './StatusIcon.vue'

type ToolItem = Extract<TranscriptItem, { kind: 'tool_use' }>
const props = defineProps<{ item: ToolItem; run?: ToolItem[] }>()
const ctx = useTranscript()

const calls = computed(() => props.run ?? [props.item])
const count = computed(() => calls.value.length)
// The latest call's address and profile; a call with no address of its own shows the run's latest one.
const info = computed(() => {
  const own = parseBrowserCall(props.item.name, props.item.input, props.item.result?.text)
  if (own.url || !props.run) return own
  for (let i = props.run.length - 1; i >= 0; i--) {
    const u = parseBrowserCall(props.run[i].name, props.run[i].input, props.run[i].result?.text).url
    if (u) return { ...own, url: u }
  }
  return own
})
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
const error = computed(() => (props.item.status === 'error' || props.item.result?.isError ? (props.item.result?.text ?? 'Failed').trim().slice(0, 240) : ''))
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
const watching = computed(() => newest.value && onScreen.value && visible.value && !!ctx.cwd.value)

let timer: ReturnType<typeof setInterval> | null = null
let busy = false
async function tick() {
  const cwd = ctx.cwd.value
  if (busy || !cwd) return
  busy = true
  try {
    const open = (await openProfiles(cwd)).has(info.value.profile)
    const frame = open ? await nextFrame(cwd, info.value.profile).catch(() => null) : null
    if (!watching.value) {
      if (frame) URL.revokeObjectURL(frame)
      return
    }
    const old = live.value
    live.value = frame
    if (old) URL.revokeObjectURL(old)
  } finally {
    busy = false
  }
}
function stop() {
  if (timer) clearInterval(timer)
  timer = null
}
watch(
  watching,
  (on) => {
    stop()
    if (!on) return
    void tick()
    timer = setInterval(() => void tick(), PREVIEW_EVERY_MS)
  },
  { immediate: true },
)

let observer: IntersectionObserver | null = null
const onVisibility = () => (visible.value = document.visibilityState === 'visible')
onMounted(() => {
  document.addEventListener('visibilitychange', onVisibility)
  if (root.value && typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver((e) => (onScreen.value = e[e.length - 1]?.isIntersecting ?? false))
    observer.observe(root.value)
  }
})
onBeforeUnmount(() => {
  stop()
  observer?.disconnect()
  document.removeEventListener('visibilitychange', onVisibility)
  if (live.value) URL.revokeObjectURL(live.value)
})

const picture = computed(() => live.value ?? shot.value)
function open() {
  window.dispatchEvent(new CustomEvent(OPEN_BROWSER_EVENT, { detail: browserOpenRequest(info.value) }))
}
</script>

<template>
  <div ref="root" class="group/card relative w-[360px] max-w-full">
    <div class="tx-card overflow-hidden shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--brand)_35%,transparent)]">
      <button
        type="button"
        class="group/open relative block aspect-[16/10] w-full overflow-hidden rounded-[inherit] text-left outline-none focus-visible:ring-2 focus-visible:ring-brand"
        :title="`Watch this browser live${info.url ? ': ' + info.url : ''}`"
        @click="open"
      >
        <img v-if="picture" :src="picture" alt="" class="size-full rounded-[inherit] object-cover object-top" draggable="false" />
        <span v-else class="flex size-full flex-col items-center justify-center gap-1 bg-fill-hover text-text-muted">
          <Globe class="size-5" aria-hidden="true" />
          <span v-if="host" class="max-w-[90%] truncate text-[12px]">{{ host }}</span>
        </span>
        <span
          class="absolute inset-x-0 bottom-0 flex min-w-0 items-center gap-1.5 bg-[linear-gradient(to_top,rgb(0_0_0/0.78),transparent)] px-2.5 pb-1.5 pt-5 text-[12px] text-white opacity-35 transition-opacity duration-[120ms] hover:opacity-100 group-focus-visible/open:opacity-100"
          :title="`${info.verb}${info.url ? ' ' + info.url : ''}`"
        >
          <span v-if="live" class="size-1.5 shrink-0 animate-pulse rounded-full bg-success" title="Live" />
          <Globe class="size-3.5 shrink-0" aria-hidden="true" />
          <span class="min-w-0 truncate">{{ shownUrl || info.verb }}</span>
          <span class="shrink-0 rounded bg-white/20 px-1.5 text-[11px]">{{ info.profile }}</span>
          <span class="ml-auto flex shrink-0 items-center gap-1.5 pl-1 tabular-nums">
            <template v-if="count > 1">{{ count }} calls</template>
            <StatusIcon :status="item.status" />
          </span>
        </span>
      </button>
    </div>
    <button
      v-if="shot"
      type="button"
      class="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-6 bg-black/55 text-white opacity-0 outline-none transition-opacity duration-[120ms] hover:bg-black/75 focus-visible:opacity-100 group-hover/card:opacity-100"
      aria-label="Open the screenshot"
      title="Open the screenshot"
      @click="openLightbox(shot!, 'Browser screenshot')"
    >
      <Maximize2 class="size-3.5" aria-hidden="true" />
    </button>
    <p v-if="error" class="mt-1 whitespace-pre-wrap break-words px-1 text-[12px] text-danger-text">{{ error }}</p>
  </div>
</template>

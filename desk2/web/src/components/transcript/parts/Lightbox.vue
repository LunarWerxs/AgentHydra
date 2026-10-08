<script setup lang="ts">
// The picture viewer, a port of SageThumbs 2K's Quick-Look-style preview: it fades in over a dark backdrop with the
// picture fitted to the window; Space, Esc or Enter close it; Left/Right step through the message's pictures and stop
// at the ends; the wheel (or + and -) zooms at the pointer with a snap to fit and to true 100%; drag pans a zoomed
// picture; 0 or 1 or a double click toggles fit and 100%; W fits the width; F goes full screen. Keys: lib/viewer.ts.
// The pen (or A) annotates the picture (Annotator.vue); Save copy puts the annotated copy in the box beside the original.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChevronLeft, ChevronRight, Pencil, X } from '@lucide/vue'
import { canAnnotate } from '../lib/annotate'
import { ANNOTATED_EVENT, closeLightbox, lightbox, stepLightbox, type Annotated } from '../lib/media'
import {
  FIT_VIEW,
  clampPan,
  fitScale,
  fitWidthZoom,
  toggleZoom,
  true100Zoom,
  viewerKeyAction,
  zoomPercent,
  zoomStepAt,
  type Geometry,
  type ViewState,
} from '../lib/viewer'
import Annotator from './Annotator.vue'

const stage = ref<HTMLElement | null>(null)
const view = ref<ViewState>(FIT_VIEW)
const natural = ref({ w: 0, h: 0 })
const area = ref({ w: 0, h: 0 })
const dragging = ref(false)
const annotating = ref(false)
const annotator = ref<InstanceType<typeof Annotator> | null>(null)

const current = computed(() => (lightbox.value ? lightbox.value.items[lightbox.value.index] : null))
const count = computed(() => lightbox.value?.items.length ?? 0)
const index = computed(() => lightbox.value?.index ?? 0)
// The room the picture may fill: the window less the bar at the top and the one at the bottom.
const geometry = computed<Geometry>(() => ({ iw: natural.value.w, ih: natural.value.h, cw: Math.max(1, area.value.w - 48), ch: Math.max(1, area.value.h - 112) }))
const imgStyle = computed(() => {
  const g = geometry.value
  const scale = fitScale(g) * view.value.zoom
  if (!g.iw) return { maxWidth: '100%', maxHeight: '100%', opacity: 0 }
  return { width: `${g.iw * scale}px`, height: `${g.ih * scale}px`, transform: `translate(${view.value.panX}px, ${view.value.panY}px)` }
})
const percent = computed(() => (natural.value.w ? zoomPercent(view.value, geometry.value) : 0))
const annotatable = computed(() => !!current.value && canAnnotate(current.value.src))

function startAnnotating() {
  if (annotatable.value) annotating.value = true
}
// The annotated copy goes to the box: right after the original when it is an attachment there, else onto the box on screen.
function onAnnotated(copy: { dataUrl: string; mediaType: string; name: string }) {
  const detail: Annotated = { ...copy, ...(current.value?.attachId ? { afterId: current.value.attachId } : {}) }
  window.dispatchEvent(new CustomEvent<Annotated>(ANNOTATED_EVENT, { detail }))
  annotating.value = false
  closeLightbox()
}

function measure() {
  const el = stage.value
  if (el) area.value = { w: el.clientWidth, h: el.clientHeight }
}
function onLoad(e: Event) {
  const img = e.target as HTMLImageElement
  natural.value = { w: img.naturalWidth, h: img.naturalHeight }
  measure()
}
// A new picture starts fitted again, as stepping files does in SageThumbs.
watch(
  () => current.value?.src,
  () => {
    view.value = FIT_VIEW
    natural.value = { w: 0, h: 0 }
    annotating.value = false
  },
)

function setView(v: ViewState) {
  view.value = clampPan(v, geometry.value)
}
function zoomAt(delta: number, clientX?: number, clientY?: number) {
  const r = stage.value?.getBoundingClientRect()
  const pt = r && clientX !== undefined && clientY !== undefined ? { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 } : undefined
  view.value = zoomStepAt(view.value, delta, geometry.value, pt)
}
let wheelRemainder = 0
function onWheel(e: WheelEvent) {
  // A precision touchpad sends many small deltas: whole notches only, as the viewer's wheel_notches does.
  wheelRemainder += e.deltaMode === 0 ? e.deltaY : e.deltaY * 100
  const notches = Math.trunc(wheelRemainder / 100)
  if (!notches) return
  wheelRemainder -= notches * 100
  zoomAt(-notches, e.clientX, e.clientY)
}

let drag: { x: number; y: number; panX: number; panY: number; moved: boolean } | null = null
let swallowClick = false
function onPointerDown(e: PointerEvent) {
  if (e.button !== 0 || view.value.zoom <= 1) return
  drag = { x: e.clientX, y: e.clientY, panX: view.value.panX, panY: view.value.panY, moved: false }
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  dragging.value = true
}
function onPointerMove(e: PointerEvent) {
  if (!drag) return
  const dx = e.clientX - drag.x
  const dy = e.clientY - drag.y
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
  setView({ zoom: view.value.zoom, panX: drag.panX + dx, panY: drag.panY + dy })
}
function onPointerUp() {
  if (drag?.moved) swallowClick = true
  drag = null
  dragging.value = false
}
// A click on the empty backdrop closes; the end of a drag does not.
function onBackdropClick(e: MouseEvent) {
  if (swallowClick) return void (swallowClick = false)
  if (e.target === stage.value) closeLightbox()
}
function onDblClick() {
  view.value = toggleZoom(view.value, true100Zoom(fitScale(geometry.value)))
}

function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen?.()
  else void stage.value?.parentElement?.requestFullscreen?.()
}

function onKey(e: KeyboardEvent) {
  if (annotating.value) {
    // Annotating owns every key: none reaches the page behind, and the editor's own (Esc, Ctrl+Z, tools) do nothing else.
    e.stopImmediatePropagation()
    if (annotator.value?.handleKey(e)) e.preventDefault()
    return
  }
  const action = viewerKeyAction(e)
  if (!action) return
  // The viewer owns its keys while open: the page behind (composer, permission card digits) never sees them.
  e.preventDefault()
  e.stopImmediatePropagation()
  if (e.repeat && action.type === 'close') return
  const g = geometry.value
  switch (action.type) {
    case 'close':
      if (e.key === ' ') swallowSpaceRelease()
      return closeLightbox()
    case 'step':
      return stepLightbox(action.delta)
    case 'zoom':
      return zoomAt(action.delta)
    case 'toggle100':
      return void (view.value = toggleZoom(view.value, true100Zoom(fitScale(g))))
    case 'fitWidth':
      return void (view.value = toggleZoom(view.value, fitWidthZoom(g)))
    case 'fullscreen':
      return toggleFullscreen()
    case 'annotate':
      return startAnnotating()
  }
}
// Space closed the viewer on key down; its release must not "click" the button that had focus and reopen it.
function swallowSpaceRelease() {
  const off = (e: KeyboardEvent) => {
    if (e.key !== ' ') return
    e.preventDefault()
    window.removeEventListener('keyup', off, true)
  }
  window.addEventListener('keyup', off, true)
  setTimeout(() => window.removeEventListener('keyup', off, true), 1000)
}

let opener: HTMLElement | null = null
let observer: ResizeObserver | null = null
async function opened() {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  view.value = FIT_VIEW
  window.addEventListener('keydown', onKey, true)
  await nextTick()
  stage.value?.focus()
  measure()
  if (stage.value && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(measure)
    observer.observe(stage.value)
  }
}
function closed() {
  annotating.value = false
  window.removeEventListener('keydown', onKey, true)
  observer?.disconnect()
  observer = null
  if (document.fullscreenElement) void document.exitFullscreen?.()
  const back = opener
  opener = null
  void nextTick(() => back?.isConnected && back.focus())
}
watch(
  () => !!lightbox.value,
  (open) => {
    if (open) void opened()
    else closed()
  },
)
// App.vue loads this on first use: a picture opened before the chunk arrived is already open when it mounts.
onMounted(() => {
  if (lightbox.value) void opened()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey, true)
  observer?.disconnect()
  closeLightbox()
})
</script>

<template>
  <Teleport to="body">
    <Transition enter-from-class="opacity-0" leave-to-class="opacity-0" enter-active-class="transition duration-150" leave-active-class="transition duration-150">
      <div v-if="lightbox && current" class="tx-viewer fixed inset-0 z-40 bg-[rgba(14,14,13,0.92)]" role="dialog" aria-modal="true" :aria-label="current.alt || 'Picture'" @click="onBackdropClick">
        <Annotator v-if="annotating" ref="annotator" :src="current.src" :name="current.alt" @cancel="annotating = false" @save="onAnnotated" />
        <template v-else>
          <div
            ref="stage"
            tabindex="-1"
            class="absolute inset-0 flex items-center justify-center overflow-hidden outline-none"
            :class="dragging ? 'cursor-grabbing' : view.zoom > 1 ? 'cursor-grab' : 'cursor-zoom-out'"
            data-testid="viewer-stage"
            @wheel.prevent="onWheel"
            @pointerdown="onPointerDown"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
          >
            <img
              :key="current.src"
              :src="current.src"
              :alt="current.alt"
              class="tx-viewer-img max-w-none select-none rounded-6 shadow-(--shadow-picture-lifted)"
              draggable="false"
              :style="imgStyle"
              @load="onLoad"
              @dblclick="onDblClick"
            />
          </div>
          <div class="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between gap-3 px-4 py-3 text-[13px] text-text-muted">
            <span class="truncate" data-testid="viewer-title">{{ current.alt }}</span>
            <span class="flex shrink-0 items-center gap-1">
              <button
                v-if="annotatable"
                type="button"
                class="tx-viewer-pen pointer-events-auto"
                title="Annotate: draw, highlight, circle (A)"
                data-testid="viewer-annotate"
                @click.stop="startAnnotating"
              >
                <Pencil class="size-3.5" />Annotate
              </button>
              <button type="button" class="tx-action pointer-events-auto" aria-label="Close" @click.stop="closeLightbox"><X class="size-4" /></button>
            </span>
          </div>
          <template v-if="count > 1">
            <button type="button" class="tx-action absolute left-4 top-1/2 -translate-y-1/2" aria-label="Previous picture" :disabled="index === 0" @click.stop="stepLightbox(-1)">
              <ChevronLeft class="size-4" />
            </button>
            <button type="button" class="tx-action absolute right-4 top-1/2 -translate-y-1/2" aria-label="Next picture" :disabled="index === count - 1" @click.stop="stepLightbox(1)">
              <ChevronRight class="size-4" />
            </button>
          </template>
          <div class="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center gap-3 px-4 py-3 text-[12px] text-text-muted">
            <span v-if="count > 1" data-testid="viewer-count">{{ index + 1 }} / {{ count }}</span>
            <span v-if="percent" data-testid="viewer-zoom">{{ percent }}%</span>
            <span class="opacity-70">Space or Esc closes · ← → step · wheel or + − zoom · 1 toggles 100% · W fits the width<template v-if="annotatable"> · A annotates</template></span>
          </div>
        </template>
      </div>
    </Transition>
  </Teleport>
</template>

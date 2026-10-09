<script setup lang="ts">
import './freeze-clock'
import { nextTick, onMounted, provide } from 'vue'
import DeskFrame from '@/components/shell/DeskFrame.vue'
import { SHELL_SOURCE } from '@/components/shell/source'
import { COMPOSER_API, OPEN_DIFF_EVENT } from '@/components/composer/api'
import { openBackgroundTasks } from '@/components/tasks/api'
import { PANE_API } from '@/components/panes/api'
import { waitForNextPaint } from '@/lib/wait-for-next-paint'
import { PARITY_SCENES, sceneComposerApi, scenePaneApi, sceneSource, type MenuName } from './scenes'
import { actionError } from '@/lib/action-error'
import { applyHeadlessAudio } from '@/lib/chat-audio'

// '#/parity/<scene>?open=<plus|mode|model|effort>&hover=<css selector | text:Label>&draft=<text>'
// renders one scene of docs/reference/real/scenes.json with the real components on fixtures, then sets
// window.__parity = { ready, scene, hover: {x,y} | null, error? } for docs/reference/tools/parity.ts
// (which moves the real mouse to `hover`, since a page cannot fake :hover).
const [path, search = ''] = window.location.hash.slice(1).split('?')
const name = path!.replace(/^\/parity\/?/, '')
const query = new URLSearchParams(search)
const scene = PARITY_SCENES[name] ?? null

// Layout state the app remembers (sidebar width, open) would differ between machines.
for (const key of Object.keys(localStorage)) if (key.startsWith('hydra-desk.')) localStorage.removeItem(key)

if (scene) {
  provide(SHELL_SOURCE, sceneSource(scene))
  provide(COMPOSER_API, sceneComposerApi(scene))
  provide(PANE_API, scenePaneApi(scene))
  if (scene.audio) applyHeadlessAudio(scene.audio)
}
const draft = query.get('draft') ?? undefined

const TRIGGERS: Record<MenuName, () => HTMLElement | null | undefined> = {
  plus: () => document.querySelector<HTMLElement>('button[aria-label="Add"]'),
  mode: () => document.querySelector<HTMLElement>('button[aria-label^="Mode:"]'),
  model: () => document.querySelector<HTMLElement>('button[aria-label^="Model:"]'),
  effort: () => document.querySelector<HTMLElement>('button[aria-label^="Effort:"]')
}

function press(el: HTMLElement) {
  const o = { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true }
  el.dispatchEvent(new PointerEvent('pointerdown', o))
  el.dispatchEvent(new MouseEvent('mousedown', o))
  el.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }))
  el.dispatchEvent(new MouseEvent('mouseup', { ...o, buttons: 0 }))
  el.dispatchEvent(new MouseEvent('click', { ...o, buttons: 0 }))
}

function find(target: string): HTMLElement | null {
  if (!target.startsWith('text:')) return document.querySelector<HTMLElement>(target)
  const label = target.slice(5)
  const hits = [...document.querySelectorAll<HTMLElement>('body *')].filter((e) => e.textContent?.trim() === label)
  return hits.at(-1) ?? null
}

const frames = async (n: number) => {
  for (let i = 0; i < n; i++) await waitForNextPaint()
}
/** Waits (bounded, ~3 s) for an element a lazily loaded pane draws. */
async function waitFor(selector: string) {
  for (let i = 0; i < 180 && !document.querySelector(selector); i++) await frames(1)
}
const settle = async () => {
  await nextTick()
  await frames(2)
}

async function setUp(): Promise<{ hover: { x: number; y: number } | null }> {
  if (!scene) throw new Error(`unknown parity scene '${name}'; known: ${Object.keys(PARITY_SCENES).join(', ')}`)
  if (scene.alert) actionError.value = scene.alert
  await document.fonts.ready
  await settle()
  await new Promise((r) => setTimeout(r, 50))
  await settle()
  if (draft) {
    const box = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')
    if (!box) throw new Error('no composer textbox for the draft')
    box.value = draft
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
  }
  if (scene.openDiff) {
    window.dispatchEvent(new Event(OPEN_DIFF_EVENT))
    await waitFor('aside[aria-label="Changes"] > *')
    await settle()
  }
  if (scene.openTasks) {
    openBackgroundTasks()
    await waitFor('section[aria-label="Background tasks"]')
    await settle()
  }
  const open = query.get('open') as MenuName | null
  if (open) {
    const trigger = TRIGGERS[open]?.()
    if (!trigger) throw new Error(`no trigger for open=${open}`)
    press(trigger)
    await settle()
    if (trigger.getAttribute('aria-expanded') !== 'true') {
      trigger.focus()
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await settle()
    }
    if (trigger.getAttribute('aria-expanded') !== 'true') throw new Error(`open=${open} did not open its menu`)
    const focused = document.activeElement as HTMLElement | null
    focused?.blur?.()
  }
  const hoverTarget = query.get('hover')
  let hover = null
  if (hoverTarget) {
    const el = find(hoverTarget)
    if (!el) throw new Error(`hover target not found: ${hoverTarget}`)
    const r = el.getBoundingClientRect()
    hover = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  }
  await settle()
  return { hover }
}

declare global {
  interface Window {
    __parity?: { ready: boolean; scene: string; hover: { x: number; y: number } | null; error?: string }
  }
}

onMounted(() => {
  setUp()
    .then(({ hover }) => (window.__parity = { ready: true, scene: name, hover }))
    .catch((e: Error) => (window.__parity = { ready: true, scene: name, hover: null, error: e.message }))
})
</script>

<template>
  <div class="size-full overflow-hidden bg-bg-page text-text">
    <p v-if="!scene" class="p-6 text-sm">Unknown parity scene '{{ name }}'. Known: {{ Object.keys(PARITY_SCENES).join(', ') }}</p>
    <DeskFrame v-else demo :accounts-open="scene.accountsOpen" :history="scene.history" :sidebar-hidden="!!(scene.alert || scene.sidebarHidden)" />
  </div>
</template>

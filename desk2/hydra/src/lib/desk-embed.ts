// Hydra Desk 2: this copy of AgentHydra's window runs inside Desk 2, in a frame at /ah/?embed=desk. It has
// no Sessions tab (Michael, 2026-10-04): Desk's cloud list is the session list and Desk's own view shows a
// session, with AgentHydra's session header over it. So "open this chat" (the Instances move dialog, the
// landing page's session tiles) is asked of Desk, which slides back and opens it. Messages go only to the
// parent window on this same origin; their shapes are desk2/shared/hydra-embed.ts.
//
// Desk also owns the one sidebar (Michael, 2026-10-04: "we only have two things, the sidebar and the
// content"): a tab with a list of its own (HSwarm's tree) describes it with useDeskSidebar and hides its
// own, Desk draws it, and Desk's clicks on it come back here to that tab. Desk can also ask for an
// account's row in Instances (its session header's account chip), a CliMayte task or an HSwarm job (its
// sidebar's task and job rows).
import { onScopeDispose, ref, shallowReactive, watch } from 'vue'
import type { AhMessage, AhSettingsPage, DeskMessage, SidebarModel } from '@desk/shared/hydra-embed'
import { useAppSettings } from '@/composables/useAppSettings'
import type { InstanceTableKind } from '@/lib/instance-table'
import { sameData } from '@/lib/reconcile'
import type { SessionJump } from '@/lib/session-jump'

export const EMBEDDED =
  typeof window !== 'undefined' &&
  window.parent !== window &&
  new URLSearchParams(window.location.search).get('embed') === 'desk'

function tellDesk(message: AhMessage): void {
  if (EMBEDDED) window.parent.postMessage(message, window.location.origin)
}

/** Desk opens this session in its own view. */
export function openInDesk(s: SessionJump): void {
  tellDesk({ type: 'ah:open-session', session_id: s.session_id, source: s.source })
}

/** Desk opens its Settings, which hold this window's settings now (owner, 2026-10-06): on a table's
 *  page from that table's gear (Instances → CLI, Desktop or Free). */
export function openSettingsInDesk(section?: AhSettingsPage): void {
  tellDesk({ type: 'ah:open-settings', section })
}

/** Marks the top bar (App.vue's header): in Desk the page's top row is the window's title bar. */
export const TITLE_BAR_ATTR = 'data-title-bar'
// What a press on the title bar does not drag from: anything that takes a click of its own.
const CLICKABLE = 'button, a, input, textarea, select, [role="button"], [role="tab"], [role="link"], [contenteditable]'

/** A press on the top row's empty parts moves the window and a double press maximizes or restores it, as Windows'
 *  caption does (owner, 2026-10-08: "drag handles that exist in places that aren't covered by buttons"). Desk's own
 *  top row drags through WebView2's drag regions, which do not reach into this frame, so Desk is asked (it ignores the
 *  ask while Windows draws the caption). The row is the bar and, beside the centred column, the page around it; never
 *  a pop-up over it (its backdrop is neither), nor a button, tab or link in it. */
function onTitleBarDown(e: MouseEvent): void {
  const bar = document.querySelector(`[${TITLE_BAR_ATTR}]`)
  const t = e.target
  if (!bar || e.button !== 0 || !(t instanceof Element) || t.closest(CLICKABLE)) return
  if (!(bar.contains(t) || (t.contains(bar) && e.clientY < bar.getBoundingClientRect().bottom))) return
  e.preventDefault()
  tellDesk({ type: 'ah:window', action: e.detail === 2 ? 'maximize' : 'drag' })
}

/** Desk draws the "a newer AgentHydra is waiting" dot on its Settings gear; this window has no gear. */
export function showUpdateDotInDesk(on: boolean): void {
  tellDesk({ type: 'ah:update-dot', on })
}

/** Desk's pane (HydraPane.vue) fires this on this window each time AgentHydra is shown, so a page that
 *  stayed built behind the pane can read again right then. The frame's own visibility never changes. */
export const PANE_OPEN_EVENT = 'hydra:pane-open'

export type SidebarEvent = Extract<DeskMessage, { type: 'desk:sidebar' }>

const sidebarHandlers = new Map<string, (e: SidebarEvent) => void>()

// Which sidebar Desk shows is decided here, from one fact: the tab on screen (App.vue's view, set with
// setDeskView). Only that tab's build is read, so a tab that is fading out, or stays built behind the
// next one (App.vue's KeepAlive), never speaks for Desk's sidebar, and a tab without one sends null the
// moment it is picked. A tab counts as active until its fade-out ends, so a tab deciding for itself
// could send its tree after the next tab's null (owner, 2026-10-05: the sidebar "didn't change ... some
// kind of holdover").
const currentView = ref<string | null>(null)
const builds = shallowReactive(new Map<string, () => SidebarModel | null>())

// What Desk was last sent, so a rebuild that changed nothing it shows sends nothing. Compared by value
// (rows a tab keeps between builds are the same objects, so they cost one check each), not by a JSON
// string of the whole model.
let lastSent: SidebarModel | null | undefined

function publish(model: SidebarModel | null, force = false): void {
  if (!force && lastSent !== undefined && sameData(lastSent, model)) return
  lastSent = model
  tellDesk({ type: 'ah:sidebar', model })
}

function currentModel(): SidebarModel | null {
  const build = currentView.value === null ? undefined : builds.get(currentView.value)
  return build ? build() : null
}

/** App.vue: the tab on screen changed. Its sidebar (or null for a tab without one) goes to Desk now. */
export function setDeskView(view: string): void {
  if (EMBEDDED) currentView.value = view
}

/** Sends the tab on screen's sidebar again even when Desk was sent the same: Desk may have dropped it (a
 *  frame re-attached, the pane closed and opened). On every desk:visible true, and on a click on the tab
 *  already on screen (App.vue), which is what anyone does when the sidebar looks wrong. */
export function resendSidebar(): void {
  if (EMBEDDED) publish(currentModel(), true)
}

/** In Desk: describes this tab's sidebar (`build` re-runs when what it reads changes) and takes Desk's
 *  clicks on it. `view` is the tab's AppView: the model is sent while that tab is on screen, also while
 *  Desk's pane is out of view, so Desk always holds the current one. Outside Desk it does nothing and
 *  the tab draws its own sidebar. */
export function useDeskSidebar(
  view: string,
  build: () => SidebarModel | null,
  onEvent: (e: SidebarEvent) => void,
): void {
  if (!EMBEDDED) return
  sidebarHandlers.set(view, onEvent)
  builds.set(view, build)
  onScopeDispose(() => {
    if (sidebarHandlers.get(view) === onEvent) sidebarHandlers.delete(view)
    if (builds.get(view) === build) builds.delete(view)
  })
}

/** Desk asked for an instance's row in Instances (App.vue switches tab and marks it). */
export const deskInstanceAsk = ref<{ num: number; kind: InstanceTableKind } | null>(null)
/** Desk asked for an HSwarm job, or just the HSwarm tab (App.vue switches to it; HSwarmView opens the
 *  job on its Jobs node and clears the ask). */
export const deskSwarmAsk = ref<{ job?: string } | null>(null)
/** Desk asked for a CliMayte task (App.vue shows the CliMayte node of the HSwarm tab; CliMayteView opens
 *  it once its list is in and clears the ask); `pc` names another PC's. */
export const deskWorkerAsk = ref<{ id: string; pc?: string } | null>(null)

/** The row of instance #num of this kind once the tab shows it, or null after `ms`; never one in the tab
 *  fading out (App.vue's view Transition keeps it mounted while the next comes in). */
export function findInstanceRow(
  num: number,
  kind: InstanceTableKind,
  ms: number,
): Promise<HTMLElement | null> {
  const look = () =>
    [
      ...document.querySelectorAll<HTMLElement>(
        `[data-instance-num="${num}"][data-instance-kind="${kind}"]`,
      ),
    ].find(
      (x) => !x.closest('.view-fade-leave-active'),
    ) ?? null
  const now = look()
  if (now) return Promise.resolve(now)
  // Waits for the page to add the row (or the fading tab to finish leaving) instead of asking every 100 ms.
  return new Promise((resolve) => {
    const done = (el: HTMLElement | null) => {
      observer.disconnect()
      clearTimeout(timeout)
      resolve(el)
    }
    const observer = new MutationObserver(() => {
      const el = look()
      if (el) done(el)
    })
    const timeout = setTimeout(() => done(look()), ms)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    })
  })
}

/** Scrolls a row into the middle and rings it for two seconds (style.css .desk-flash). */
export function flashRow(el: HTMLElement): void {
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  el.classList.remove('desk-flash')
  void el.offsetWidth
  el.classList.add('desk-flash')
  setTimeout(() => el.classList.remove('desk-flash'), 2200)
}

// Desk keeps this frame loaded behind its chat once it has been opened. While the pane is out of view
// (desk:visible false) the page counts as hidden: document.hidden and visibilityState say so on top of
// the browser's own answer (a minimized window), a visibilitychange goes out when that flips, and the
// page's CSS animations stop (style.css html.desk-hidden). So every poll that rests on a hidden page
// (lib/visible-poll.ts and the ones that read document.hidden) rests here too, and catches up on return.
let deskHidden = false

function watchDeskVisibility(): void {
  const proto = Document.prototype
  const hidden = Object.getOwnPropertyDescriptor(proto, 'hidden')!.get!
  const state = Object.getOwnPropertyDescriptor(proto, 'visibilityState')!.get!
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => deskHidden || hidden.call(document) })
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (deskHidden ? 'hidden' : state.call(document)),
  })
}

function setDeskHidden(next: boolean): void {
  if (next === deskHidden) return
  const was = document.hidden
  deskHidden = next
  document.documentElement.classList.toggle('desk-hidden', next)
  if (document.hidden !== was) document.dispatchEvent(new Event('visibilitychange'))
}

if (EMBEDDED) {
  watchDeskVisibility()
  document.addEventListener('mousedown', onTitleBarDown)
  // The tab on screen's sidebar, sent whenever it changes (the tab, or what its build reads). It is not
  // held back while the pane is out of view: a tree that changes then (a Desk ask switched the tab) would
  // leave Desk drawing the old one for a moment when the pane slides back in.
  watch(currentModel, (model) => publish(model), { immediate: true })
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window.parent || e.origin !== window.location.origin) return
    const m = e.data as DeskMessage | null
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') return
    if (m.type === 'desk:sidebar') sidebarHandlers.get(m.view)?.(m)
    else if (m.type === 'desk:show-instance') deskInstanceAsk.value = { num: m.num, kind: m.kind }
    else if (m.type === 'desk:open-hswarm') deskSwarmAsk.value = { job: m.job }
    else if (m.type === 'desk:open-worker') deskWorkerAsk.value = { id: m.id, pc: m.pc }
    else if (m.type === 'desk:settings-changed') void useAppSettings().load()
    else if (m.type === 'desk:visible') {
      setDeskHidden(!m.visible)
      // Desk says so when the pane slides in and when a frame (re)attaches (hydraReady): whatever it
      // held is replaced by what is on screen here, so its sidebar is never a stale or missing one.
      if (m.visible) resendSidebar()
    }
  })
  tellDesk({ type: 'ah:ready' })
}

/**
 * ime-composition-guard - ONE document-level guard that keeps input-method (IME) keystrokes out
 * of application key handlers. Installed once per app from its web boot entry (`main.ts`), and
 * proven there by the Architect's `ime-composition-enter-guard` check. Kit-synced: edit it here,
 * never in an app's copy.
 *
 * THE DEFECT IT CLOSES. A Chinese, Japanese or Korean user types through an input method: the
 * keystrokes build a candidate and Enter COMMITS the candidate. Chrome on Windows reports that
 * keydown as key="Process" / keyCode=229 / isComposing=true, so Vue's `.enter` modifier never
 * fires - the behaviour every handler was written against. Safari (macOS and iOS) and Chrome on
 * macOS report the SAME keystroke as key="Enter" / keyCode=229 / isComposing=true, so every
 * `@keydown.enter` / `@keyup.enter` / `key === "Enter"` handler submitted with the text half-typed.
 *
 * WHY A GLOBAL CAPTURE LISTENER. A keystroke that belongs to the IME is not an application
 * keystroke; expressing that once at the document's capture phase makes every browser behave
 * like Chrome/Windows for every handler that exists today and every one written tomorrow.
 *
 * WHAT IT SWALLOWS. `keydown` events whose `isComposing` is true or whose legacy `keyCode` is 229
 * (Safari's composition-commit Enter can report 229 with isComposing FALSE), and the `keyup`
 * paired with a swallowed keydown (it arrives after `compositionend` with a plain key="Enter", so
 * the pairing is the only signal). Swallowing is `stopImmediatePropagation()` only, never
 * `preventDefault()`: the browser's own composition and text insertion proceed untouched, and
 * `v-model` keeps working because it listens to compositionstart/compositionend, not keydown.
 *
 * PASSTHROUGH. ProseMirror tracks composition itself; anything else that genuinely needs the raw
 * composition keystrokes opts out with `data-ime-passthrough` on itself or an ancestor.
 */

export const IME_PASSTHROUGH_SELECTOR = '.ProseMirror, [data-ime-passthrough]'

export interface ImeCompositionGuardOptions {
  /** Elements (or ancestors) whose composition keystrokes must keep flowing to their own handlers. */
  passthroughSelector?: string
  /** The document to guard; defaults to the global one. */
  target?: Document
}

const INSTALLED_KEY = '__lunarwerxImeCompositionGuard'

type GuardedDocument = Document & { [INSTALLED_KEY]?: () => void }

/** The legacy `keyCode`, read without naming the deprecated property on the typed event. */
function legacyKeyCode(event: KeyboardEvent): number | undefined {
  return (event as { keyCode?: number }).keyCode
}

/** True when this keydown belongs to an input-method composition rather than to the application. */
export function isImeCompositionKey(event: KeyboardEvent): boolean {
  return event.isComposing === true || legacyKeyCode(event) === 229
}

/** The physical key when the browser reports it, else the logical one - stable across a keydown/keyup pair. */
function keystrokeId(event: KeyboardEvent): string {
  return event.code || event.key
}

function isPassthroughTarget(target: EventTarget | null, selector: string): boolean {
  return target instanceof Element && target.closest(selector) !== null
}

/**
 * Install the guard once on a document. Idempotent: a second call returns the first install's
 * uninstaller instead of stacking listeners. A no-op (returning a no-op) outside a browser.
 */
export function installImeCompositionGuard(options: ImeCompositionGuardOptions = {}): () => void {
  if (!options.target && typeof document === 'undefined') return () => undefined
  const target = (options.target ?? document) as GuardedDocument
  const existing = target[INSTALLED_KEY]
  if (existing) return existing

  const passthrough = options.passthroughSelector ?? IME_PASSTHROUGH_SELECTOR
  const swallowedKeystrokes = new Set<string>()

  const onKeydown = (event: KeyboardEvent) => {
    const id = keystrokeId(event)
    if (!isImeCompositionKey(event)) {
      swallowedKeystrokes.delete(id)
      return
    }
    if (isPassthroughTarget(event.target, passthrough)) return
    swallowedKeystrokes.add(id)
    event.stopImmediatePropagation()
  }

  const onKeyup = (event: KeyboardEvent) => {
    if (!swallowedKeystrokes.delete(keystrokeId(event))) return
    if (isPassthroughTarget(event.target, passthrough)) return
    event.stopImmediatePropagation()
  }

  target.addEventListener('keydown', onKeydown, true)
  target.addEventListener('keyup', onKeyup, true)

  const uninstall = () => {
    target.removeEventListener('keydown', onKeydown, true)
    target.removeEventListener('keyup', onKeyup, true)
    swallowedKeystrokes.clear()
    delete target[INSTALLED_KEY]
  }
  target[INSTALLED_KEY] = uninstall
  return uninstall
}

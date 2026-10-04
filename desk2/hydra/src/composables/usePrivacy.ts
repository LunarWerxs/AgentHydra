import type { App } from 'vue'
import type { CMInstance } from '@/lib/api'
import { accountName, displayName } from '@/lib/instance-appearance'
import { maskEmails, maskName } from '@/lib/privacy'
import { privacyMode } from './useUiPrefs'

/** Display-only mask. It reads the ref, so a template or computed that calls it re-renders when
 *  the switch flips. Never use it on a value that feeds logic, keys, copies or API calls. */
export function pii(text: string | null | undefined): string {
  if (text == null) return ''
  return privacyMode.value ? maskEmails(text) : text
}

/** The same for an account handle (an address's local part, which has no '@' for maskEmails to
 *  find) or anything else that names the login: masked whole while the switch is on. Only for a
 *  value known to identify the account; a label the person typed is not PII. */
export function piiName(name: string | null | undefined): string {
  if (name == null) return ''
  if (!privacyMode.value) return name
  return name.includes('@') ? maskEmails(name) : maskName(name)
}

/** displayName() as the screen shows it. With no label typed, the name IS the account's (its
 *  profile name or handle), so it is masked like one; a label or folder name only loses an address.
 *  Mask before any cut: a cut leaves "jo@gmai…" with no domain for the mask to find. */
export function piiDisplayName(inst: Pick<CMInstance, 'name' | 'label' | 'account'>): string {
  const name = displayName(inst)
  return !inst.label?.trim() && accountName(inst.account) ? piiName(name) : pii(name)
}

declare module 'vue' {
  interface ComponentCustomProperties {
    $pii: typeof pii
  }
}

export function installPrivacy(app: App): void {
  app.config.globalProperties.$pii = pii
}

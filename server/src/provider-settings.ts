import { getSetting, setSetting } from './db'
import type { ProviderSettings } from './types'

const enabledByDefault = (key: string): boolean => getSetting(key) !== '0'

export function getProviderSettings(): ProviderSettings {
  return {
    codexDesktopEnabled: enabledByDefault('provider_codex_desktop'),
    codexCliEnabled: enabledByDefault('provider_codex_cli'),
    // This opens an external consumer surface and creates a repository context file, so it is an
    // explicit opt-in rather than appearing in the composer without the owner asking for it.
    chatGptHandoffEnabled: getSetting('provider_chatgpt_handoff') === '1',
  }
}

export function setProviderSettings(patch: Partial<ProviderSettings>): ProviderSettings {
  if (typeof patch.codexDesktopEnabled === 'boolean')
    setSetting('provider_codex_desktop', patch.codexDesktopEnabled ? '1' : '0')
  if (typeof patch.codexCliEnabled === 'boolean')
    setSetting('provider_codex_cli', patch.codexCliEnabled ? '1' : '0')
  if (typeof patch.chatGptHandoffEnabled === 'boolean')
    setSetting('provider_chatgpt_handoff', patch.chatGptHandoffEnabled ? '1' : '0')
  return getProviderSettings()
}

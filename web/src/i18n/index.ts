import { createAppI18n } from '@/lib/i18n-core'
import en from './locales/en'

// The vue-i18n bootstrap — locale persistence (under `agenthydra.locale`), the <html lang>
// sync, and the supported-locale set — lives in the shared kit factory (@/lib/i18n-core) so all
// LunarWerx apps share one implementation. English is the base; add more catalogs under ./locales.
export const { i18n, setLocale, t } = createAppI18n({ en }, 'agenthydra.locale')

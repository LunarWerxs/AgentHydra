/**
 * Locale registry — the single source of truth for which languages exist and how far
 * along each translation is. Adding a language: add its code to `LocaleCode`, add a row
 * to `LOCALES`, drop a `./<code>.ts` catalog next to `en.ts`, and register it in
 * `../index.ts`. English (`en`) is always the base every other locale is translated from.
 */

export type LocaleCode = 'en'

export interface LocaleMeta {
  code: LocaleCode
  endonym: string
  englishName: string
  status: 'source' | 'machine-draft' | 'reviewed'
}

export const LOCALES: LocaleMeta[] = [
  { code: 'en', endonym: 'English', englishName: 'English', status: 'source' },
]

export const DEFAULT_LOCALE: LocaleCode = 'en'

export function isSupportedLocale(code: string): code is LocaleCode {
  return LOCALES.some((l) => l.code === code)
}

export function localeMeta(code: LocaleCode): LocaleMeta {
  return LOCALES.find((l) => l.code === code) ?? LOCALES[0]
}

export function isMachineDraft(code: LocaleCode): boolean {
  return localeMeta(code).status === 'machine-draft'
}

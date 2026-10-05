/**
 * Locale registry — the single source of truth for which languages exist and how
 * far along each translation is. Adding a language is a three-step change:
 *
 *   1. Add its code to `LocaleCode` below.
 *   2. Add a row to `LOCALES` (set `status: "machine-draft"` for an un-reviewed
 *      auto-translation so the UI can flag it).
 *   3. Drop a `./<code>.ts` file next to `en.ts` and register it in `../index.ts`.
 *
 * English (`en`) is always the base every other locale is translated from.
 */

/** Every shipped locale code. Extend this union when you add a language. */
export type LocaleCode = "en";

export interface LocaleMeta {
  code: LocaleCode;
  /** Native name shown in a language picker, e.g. "English", "Español", "日本語". */
  endonym: string;
  /** English name, for admin tooling / sorting. */
  englishName: string;
  /**
   * Translation provenance:
   *  - "source":        English — the base everything else is translated from.
   *  - "machine-draft": auto-translated, NOT yet human-reviewed. Surface a
   *                     "needs review" hint so nobody mistakes it for final copy.
   *  - "reviewed":      a human has proofread and signed off.
   */
  status: "source" | "machine-draft" | "reviewed";
}

export const LOCALES: LocaleMeta[] = [
  { code: "en", endonym: "English", englishName: "English", status: "source" },
];

export const DEFAULT_LOCALE: LocaleCode = "en";

export function isSupportedLocale(code: string): code is LocaleCode {
  return LOCALES.some((l) => l.code === code);
}

export function localeMeta(code: LocaleCode): LocaleMeta {
  return LOCALES.find((l) => l.code === code) ?? LOCALES[0];
}

/** True when a locale is an un-reviewed machine draft (so the UI can warn). */
export function isMachineDraft(code: LocaleCode): boolean {
  return localeMeta(code).status === "machine-draft";
}

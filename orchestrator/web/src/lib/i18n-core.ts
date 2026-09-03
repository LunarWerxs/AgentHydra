import { createI18n } from "vue-i18n";

/**
 * A message catalog: nested strings/plurals keyed by name. Values line up with
 * vue-i18n's `LocaleMessageValue`, so `createI18n` resolves to its Composition-API
 * (non-legacy) overload, which is what makes `i18n.global.locale` a writable ref.
 * Key existence itself is enforced by each app's build-time i18n check, not by TS.
 */
export type MessageValue = string | MessageCatalog | MessageValue[];
export interface MessageCatalog {
  [key: string]: MessageValue;
}

/**
 * Shared vue-i18n bootstrap for all LunarWerx apps. Promotes DevWebUI's setup
 * (the superset) into one factory so RepoYeti / DevWebUI / Reimagine stop
 * re-deriving the same `createI18n` call, localStorage persistence, and
 * `<html lang>` sync.
 *
 * `createAppI18n(messages, storageKey)`:
 *   - builds the Composition-API i18n instance (`legacy: false`, `globalInjection`)
 *     with `messages` and English as the base/fallback,
 *   - remembers the chosen locale under `storageKey` (falling back to `en` when
 *     nothing valid is stored, private-mode `localStorage` throws are swallowed),
 *   - reflects the active locale onto `<html lang>` from first paint and on every
 *     `setLocale()`,
 *   - derives the set of supported locales from `Object.keys(messages)`, so an app
 *     just passes the catalogs it ships (`{ en }` today; add more keys later).
 *
 * Returns `{ i18n, setLocale, t }`. Pass `i18n` to `app.use(i18n)`; call
 * `setLocale(code)` from a language picker; import `t` for plain (non-component)
 * helpers that need the global translator.
 */
export function createAppI18n(
  messages: { en: MessageCatalog } & Record<string, MessageCatalog>,
  storageKey: string,
) {
  const DEFAULT_LOCALE = "en";
  // Own enumerable keys of the catalog are the shipped locale codes. `Object.keys`
  // (vs `Object.hasOwn`) keeps this portable across every app's TS lib target.
  const supported = Object.keys(messages);
  const isSupported = (code: string): boolean => supported.includes(code);

  // Prefer a saved choice, else fall back to the base locale. (No auto
  // browser-detect yet, apps ship one language. Add `navigator.language`
  // matching here once catalogs grow.)
  function initialLocale(): string {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved && isSupported(saved)) return saved;
    } catch {
      /* localStorage can throw in private mode, fall through to the default */
    }
    return DEFAULT_LOCALE;
  }

  const i18n = createI18n({
    // Composition API ("legacy: false") so components use `useI18n()` and `<i18n-t>`.
    legacy: false,
    // Expose `$t` / `$d` / `$n` in every template without importing.
    globalInjection: true,
    locale: initialLocale(),
    fallbackLocale: DEFAULT_LOCALE,
    messages,
    // While apps are mid-migration, un-translated keys should fall back quietly
    // rather than spam the console.
    missingWarn: false,
    fallbackWarn: false,
  });

  /** Switch the active language and remember it. Call from a language picker. */
  function setLocale(locale: string): void {
    i18n.global.locale.value = locale;
    try {
      localStorage.setItem(storageKey, locale);
    } catch {
      /* best-effort persistence */
    }
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("lang", locale);
    }
  }

  // Reflect the boot locale onto <html lang> for a11y / SEO from the first paint.
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("lang", i18n.global.locale.value);
  }

  return { i18n, setLocale, t: i18n.global.t };
}

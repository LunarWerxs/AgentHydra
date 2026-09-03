import { computed, getCurrentInstance, onBeforeUnmount, watch } from "vue";
import { useStorage, usePreferredDark } from "@vueuse/core";

/**
 * Shared theme composable for every LunarWerx app (RepoYeti · DevWebUI · Reimagine).
 *
 * ONE implementation, merged from what each app used to hand-roll separately:
 *  - light / dark / system modes, persisted to localStorage, DEFAULTING TO **dark**
 *    (RepoYeti + Reimagine identity; DevWebUI adopts it here, dropping its old OS-`auto`
 *    default, the lone outlier);
 *  - toggles `.dark` on <html>, mirrors the raw mode to `html[data-theme]`, and sets
 *    `html.style.colorScheme` so native form controls / scrollbars match;
 *  - a brief crossfade on change, via the View Transitions API where available (one
 *    GPU-composited snapshot fade — cheap even on huge DOMs); otherwise falls back to
 *    adding `html.theme-transitioning` (styled in base.css, 280 ms) around the swap,
 *    then stripping it (ex-RepoYeti). An `activeScopes` ref-count clears any pending
 *    fallback transition once the last consumer unmounts, so no timer/class leaks
 *    across a full teardown (reduced-motion skips the view transition in code and
 *    neutralises the fallback in base.css);
 *  - syncs the mobile browser-chrome `<meta name="theme-color">` when present (ex-Reimagine).
 *    Each app declares its OWN chrome colours via `data-theme-color-dark` / `-light` on that
 *    meta tag (defaults #0a0a0a / #ffffff); apps without the meta simply opt out for free.
 *
 * DEFAULT = dark. The no-flash boot script in each app's index.html <head> MUST use the same
 * storage key (`lunarwerx-theme`) and the same resolve logic (see the kit README "Theme boot
 * snippet"), otherwise the first paint flashes before this composable takes over.
 */
export type ThemeMode = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "lunarwerx-theme";

// Keep in lockstep with base.css `html.theme-transitioning { transition-duration }`.
const THEME_TRANSITION_MS = 280;

// Module-level singletons: one source of truth; install the watcher exactly once.
const mode = useStorage<ThemeMode>(THEME_STORAGE_KEY, "dark");
const prefersDark = usePreferredDark();
const isDark = computed(() => (mode.value === "system" ? prefersDark.value : mode.value === "dark"));

let installed = false;
let transitionTimer: ReturnType<typeof setTimeout> | undefined;
let activeScopes = 0;

function apply(dark: boolean, current: ThemeMode) {
  const html = document.documentElement;
  html.classList.toggle("dark", dark);
  html.dataset.theme = current;
  html.style.colorScheme = dark ? "dark" : "light";
  // Mobile browser-chrome tint. The capability is shared; the colours are per-app,
  // declared on the meta tag so app identity stays in the app. No meta → nothing to do.
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) {
    const darkColor = meta.dataset.themeColorDark ?? "#0a0a0a";
    const lightColor = meta.dataset.themeColorLight ?? "#ffffff";
    meta.setAttribute("content", dark ? darkColor : lightColor);
  }
}

function withCrossfade(fn: () => void) {
  const html = document.documentElement;
  // Prefer the View Transitions API: the browser crossfades ONE pair of GPU
  // snapshots instead of transitioning colors on every element (the class
  // fallback below repaints the whole tree each frame for 280 ms, which gets
  // visibly laggy on large DOMs). Reduced-motion users get an instant swap:
  // the fallback's transitions are already neutralised in base.css.
  const vt = (
    document as Document & { startViewTransition?: (cb: () => void) => unknown }
  ).startViewTransition;
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
  if (typeof vt === "function" && !reducedMotion) {
    vt.call(document, fn);
    return;
  }
  html.classList.add("theme-transitioning");
  fn();
  clearTimeout(transitionTimer);
  transitionTimer = setTimeout(() => {
    html.classList.remove("theme-transitioning");
    transitionTimer = undefined;
  }, THEME_TRANSITION_MS);
}

export function useTheme() {
  if (!installed) {
    installed = true;
    let first = true;
    watch(
      isDark,
      (dark) => {
        // First run (initial paint) applies instantly; later changes crossfade.
        if (first) {
          first = false;
          apply(dark, mode.value);
          return;
        }
        withCrossfade(() => apply(dark, mode.value));
      },
      { immediate: true },
    );
    // Keep data-theme honest when the mode changes but resolved dark-ness doesn't
    // (e.g. light → system while the OS is also light): same paint, different raw mode.
    watch(mode, (m) => {
      document.documentElement.dataset.theme = m;
    });
  }

  // Ref-count live consumers so a pending crossfade can't leak past the last unmount.
  // Guarded so the composable is still callable outside a component setup (no-op there).
  if (getCurrentInstance()) {
    activeScopes += 1;
    onBeforeUnmount(() => {
      activeScopes -= 1;
      if (activeScopes > 0 || typeof window === "undefined") return;
      clearTimeout(transitionTimer);
      transitionTimer = undefined;
      document.documentElement.classList.remove("theme-transitioning");
    });
  }

  function setTheme(next: ThemeMode) {
    mode.value = next;
  }
  function toggle() {
    mode.value = isDark.value ? "light" : "dark";
  }

  return { mode, isDark, setTheme, toggle };
}

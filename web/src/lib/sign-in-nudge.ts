/**
 * "You could be signing in" - the occasional, decaying prompt for a Connections account.
 *
 * Every kit app already ships Sign in with Connections, and almost nobody finds it: the toggle
 * lives in a settings pane, and a person has to go looking for a feature they do not know exists.
 * This is the mention. It is not a marketing banner and it is not a paywall - the account is free,
 * the app already supports it, and the entire ask is that it exists.
 *
 * The decision of WHEN to ask lives entirely in `@cnct/connect`'s engine: a week of ownership and
 * a few real sessions before the first ask, three asks in a lifetime spaced 30 then 90 days, two
 * refusals stops it permanently, and "Don't ask again" is offered on the very first one. None of
 * that is re-implemented here and none of it should be re-implemented per app - it is the promise
 * made to the user, and an app that quietly writes its own version is the one that gets called
 * nagware.
 *
 * ⛔ SHARED KIT FILE. Synced verbatim into every app, so it must contain nothing app-specific.
 * Identity arrives as arguments; theme is read from the app's own CSS tokens, which every kit app
 * has because `lib/theme.ts` is shared too.
 *
 * ## Wiring an app (three lines, in three places)
 *
 * ```ts
 * // main.ts, before mount - counts the session
 * startSignInNudgeSession({ appId: "repoyeti", appName: "RepoYeti" });
 *
 * // wherever the store learns whether sync is connected
 * bindSignInNudgeStatus(() => syncStatus.value?.connected ?? false);
 *
 * // in the watcher that would have PUSHED a changed setting, on its not-connected branch
 * if (!connected) nudgeOnSettingsChange();
 * ```
 *
 * ## Why the session count is separate from the status
 *
 * They become available at different times, and conflating them is a real bug rather than a tidy
 * simplification. Hung off the settings store, a session is only counted when the owner happens to
 * open the settings pane - so most people never accrue one, never pass the gate, and never see the
 * prompt at all. The engine would look like it was working correctly, because staying quiet is
 * what it does. Count sessions at boot; bind the status whenever the store exists.
 */
// `@cnct/connect/nudge`, NOT `@cnct/connect`. The main entry carries the OAuth client, which
// legitimately imports node:http / node:child_process / node:fs / node:path for its loopback and
// file-store paths - and a kit app's BROWSER half never signs in, its daemon does. Importing the
// root pulled an unusable OAuth client into every web bundle and printed four "externalized for
// browser compatibility" warnings on every build. This subpath is the prompt and nothing else.
import {
  considerAndShow,
  createSignInNudge,
  type NudgeBannerOptions,
  type SignInNudge,
} from "@cnct/connect/nudge";

export interface SignInNudgeIdentity {
  /** Slug shared with the app's Connections registration. Rides the attribution link. */
  appId: string;
  /** Display name, used in the prompt's own copy. */
  appName: string;
}

let nudge: SignInNudge | null = null;

/**
 * Whether the owner is connected. Replaced once the app's store exists.
 *
 * Defaults to "not signed in", which is the safe direction: the gate still has to open before
 * anything is asked, and `bindSignInNudgeStatus` lands long before that.
 */
let isSignedIn: () => boolean = () => false;

/** Count this session. Call once, at app boot, before anything else here. */
export function startSignInNudgeSession(identity: SignInNudgeIdentity): void {
  if (nudge) return;
  nudge = createSignInNudge({
    appId: identity.appId,
    appName: identity.appName,
    isSignedIn: () => isSignedIn(),
  });
  void nudge.startSession();
}

/** Point the engine at the live connection state. Call when the store that holds it is built. */
export function bindSignInNudgeStatus(connected: () => boolean): void {
  isSignedIn = connected;
}

/**
 * The app's own theme, read off its own CSS tokens at the moment the prompt mounts.
 *
 * The SDK can infer a theme by reading the page, and for an app with no theme system that is the
 * right default. A kit app HAS one, so inferring is strictly worse: the banner resolves colours
 * once, when it mounts, and a theme that settles asynchronously after first paint can be caught
 * mid-transition - producing light chrome on a dark app. `--background` / `--foreground` are the
 * app's own answer whenever they are asked, and they follow the light/dark switch for free.
 *
 * The ACCENT is deliberately left to the SDK. Each app's accent differs; the button stays
 * Connections blue, so the chrome belongs to the app while the action is unmistakably about
 * Connections.
 */
function appTheme(): NudgeBannerOptions["theme"] {
  if (typeof document === "undefined") return undefined;
  const tokens = getComputedStyle(document.documentElement);
  const read = (name: string): string | undefined =>
    tokens.getPropertyValue(name).trim() || undefined;
  return {
    surface: read("--background"),
    text: read("--foreground"),
    muted: read("--muted-foreground"),
    border: read("--border"),
  };
}

/**
 * A preference changed. Ask the engine whether this is a moment worth spending.
 *
 * Almost always it is not, and that is the design working rather than a bug. Call it on every
 * change: the engine is what says no, and it says no far more often than yes.
 *
 * This moment is chosen because it is the one instant where "these settings follow you to your
 * other machines" is a true sentence about something the owner just did - and it is the same
 * instant the app WOULD have pushed that setting to the locker had they been connected. App
 * start, a timer, or opening a project are all facts about the app rather than about them.
 */
export function nudgeOnSettingsChange(): void {
  const engine = nudge;
  if (!engine) return;
  // ⛔ Deferred by one task, and not for tidiness. In an app whose synced setting IS the theme
  // (DevWebUI's only portable preference is appearance), this fires from the same `watch` that
  // repaints the app - and watcher order is not guaranteed. Reading the tokens synchronously can
  // therefore capture the theme the user just left, mounting a light banner onto a newly dark app.
  // One task later the class flip has landed and `--background` is the answer the user can see.
  setTimeout(() => {
    void considerAndShow(engine, "settings-changed", { theme: appTheme() });
  }, 0);
}

/**
 * The owner connected, however they got there - through the sync toggle, a sign-in gate, or the
 * prompt itself. Retires the campaign so it can never fire at somebody who has already done the
 * thing it would ask for.
 */
export function markSignedInForNudge(): void {
  void nudge?.markSignedIn();
}

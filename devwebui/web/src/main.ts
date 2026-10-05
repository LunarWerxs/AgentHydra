import { createApp } from "vue";
import { createPinia } from "pinia";
import { autoAnimatePlugin } from "@formkit/auto-animate/vue";
import App from "./App.vue";
import PairingGate from "./components/PairingGate.vue";
import { getPairingStatus } from "./api";
import { i18n } from "./i18n";
import { startSignInNudgeSession } from "./lib/sign-in-nudge";
import { installChunkReloadRecovery } from "./lib/chunk-reload-recovery";
import { installImeCompositionGuard } from "./lib/ime-composition-guard";
import "./style.css";
import "vue-sonner/style.css";

// Keep input-method (IME) composition keystrokes away from every @keydown.enter handler: on
// Safari and Chrome-on-macOS the Enter that commits a CJK candidate otherwise submits half-typed
// text. One document-level guard (kit-synced) instead of a check at ~every Enter handler.
installImeCompositionGuard();

// Recover from stale-chunk errors (a tab on an old build lazy-importing a chunk the new build
// renamed). Reloads once, with a timestamp guard against a reload loop - see the module for the
// full reasoning and its pairing with the server's /assets/* 404.
installChunkReloadRecovery();

// Counts one session for the Connections sign-in prompt. Here, not in the store, because the
// store is built lazily: an owner who never opens the settings pane would never accrue a session
// and so could never pass the prompt's gate. Counting only - nothing is shown from this call.
startSignInNudgeSession({ appId: "devwebui", appName: "DevWebUI" });

// A daemon that enforces local auth answers an unpaired browser with 401 everywhere, so ask first
// and mount the pairing screen instead of an app that would only show errors. Any failure here
// (an older daemon without the route, a network blip) falls through to the normal app.
getPairingStatus()
  .then((s) => s.required && !s.authorized)
  .catch(() => false)
  .then((needsPairing) => {
    createApp(needsPairing ? PairingGate : App)
      .use(createPinia())
      .use(i18n)
      .use(autoAnimatePlugin)
      .mount("#app");
  });

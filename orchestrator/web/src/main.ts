import { createApp } from 'vue'
import App from './App.vue'
import { installImeCompositionGuard } from './lib/ime-composition-guard'
import './style.css'
// vue-sonner v2 ships its toast styling separately.
import 'vue-sonner/style.css'

// Keep input-method (IME) composition keystrokes away from every @keydown.enter handler: on
// Safari and Chrome-on-macOS the Enter that commits a CJK candidate otherwise submits half-typed
// text. One document-level guard (kit-synced) instead of a check at ~every Enter handler.
installImeCompositionGuard()

createApp(App).mount('#app')

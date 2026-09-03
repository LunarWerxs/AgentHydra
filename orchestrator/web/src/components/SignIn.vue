<script setup lang="ts">
// Shown over the tunnel with no owner session. The button navigates to the gateway's
// /oauth/login (the PKCE dance); on loopback this screen never appears, because a request that
// did not come through the tunnel is the owner at their own desk.
import type { AuthStatus } from '@/lib/api'

const props = defineProps<{ auth: AuthStatus }>()

const callbackNote = (): string | null => {
  switch (props.auth.oauthCallback) {
    case 'pending':
    case 'retrying':
      return 'The tunnel is still registering its return route; give it a few seconds.'
    case 'failed':
      return 'The return route could not be registered - sign-in cannot come back to this address until the gateway is restarted.'
    case 'incompatible':
      return 'The relay needs updating before sign-in can return through a Quick Tunnel.'
    default:
      return null
  }
}
</script>

<template>
  <div class="grid min-h-dvh place-items-center px-6">
    <div class="w-full max-w-sm text-center">
      <img src="/favicon.svg" alt="" class="mx-auto mb-3 h-14 w-14" />
      <h1 class="mb-1 text-xl font-semibold tracking-tight">Orchestrator</h1>
      <p class="mx-auto mb-7 max-w-xs text-sm leading-relaxed text-muted-foreground">
        The fleet's decision dashboard, and the switch that lets it act. Owner only.
      </p>

      <a
        class="inline-flex h-11 items-center gap-2.5 rounded-xl border border-border bg-secondary px-5 text-sm font-semibold text-foreground transition-colors hover:bg-accent active:translate-y-px"
        href="/oauth/login"
      >
        <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
          <rect x="11" y="9.5" width="26" height="7" rx="3.5" fill="#4285F4" />
          <circle cx="11" cy="13" r="7" fill="#4285F4" />
          <circle cx="37" cy="13" r="7" fill="#EA4335" />
          <circle cx="10" cy="24" r="4.5" fill="#9AA0A6" />
          <rect x="23" y="20.5" width="15" height="7" rx="3.5" fill="#FBBC05" />
          <circle cx="23" cy="24" r="7" fill="#FBBC05" />
          <circle cx="38" cy="24" r="5.5" fill="#F9AB00" />
          <rect x="14" y="31.5" width="26" height="7" rx="3.5" fill="#34A853" />
          <circle cx="14" cy="35" r="7" fill="#34A853" />
          <circle cx="40" cy="35" r="7" fill="#34A853" />
        </svg>
        <span>Sign in with Connections</span>
      </a>

      <p class="mt-5 text-xs text-muted-foreground/70">
        {{ auth.ownerClaimed ? 'Only the account that owns this orchestrator can get in.' : 'No owner yet: the first verified sign-in claims this install.' }}
      </p>
      <p v-if="callbackNote()" class="mt-3 text-xs text-warning">{{ callbackNote() }}</p>
    </div>
  </div>
</template>

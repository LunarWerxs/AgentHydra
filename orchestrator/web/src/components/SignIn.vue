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
      <img src="/favicon.svg" alt="" class="mx-auto mb-3 size-14" />
      <h1 class="mb-1 text-xl font-semibold tracking-tight">Orchestrator</h1>
      <p class="mx-auto mb-7 max-w-xs text-sm leading-relaxed text-muted-foreground">
        The fleet's decision dashboard, and the switch that lets it act. Owner only.
      </p>

      <a
        class="inline-flex h-11 items-center gap-2.5 rounded-xl border border-border bg-secondary px-5 text-sm font-semibold text-foreground transition-colors hover:bg-accent active:translate-y-px"
        href="/oauth/login"
      >
        <!-- The Connections brand mark keeps its own palette, so it ships as an asset rather than themed markup. -->
        <img src="/connections-mark.svg" alt="" width="20" height="20" />
        <span>Sign in with Connections</span>
      </a>

      <p class="mt-5 text-xs text-muted-foreground/70">
        {{ auth.ownerClaimed ? 'Only the account that owns this orchestrator can get in.' : 'No owner yet: the first verified sign-in claims this install.' }}
      </p>
      <p v-if="callbackNote()" class="mt-3 text-xs text-warning">{{ callbackNote() }}</p>
    </div>
  </div>
</template>

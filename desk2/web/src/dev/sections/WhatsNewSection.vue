<script setup lang="ts">
import { Button } from '@/components/ui/button'
import WhatsNewDialog from '@/components/shell/WhatsNewDialog.vue'
import { whatsNew } from '@/lib/whats-new'

function show() {
  whatsNew.value = {
    version: '9.9.9',
    updated: true,
    count: 3,
    groups: [
      {
        version: '9.9.9',
        date: '2026-10-09',
        entries: [
          { headline: 'The row restarts you onto an update', detail: 'One click applies the release and restarts the server, then this pop-up lists what changed.' },
          { headline: 'Dialogs keep their focus on Got it', detail: '' },
        ],
      },
      {
        version: null,
        date: null,
        entries: [{ headline: 'A long chat reads once per poll', detail: 'Each session file is checked with its items, so an unchanged session costs nothing.' }],
      },
    ],
  }
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <h3 class="text-[13px] font-semibold text-text">What's new</h3>
    <div>
      <Button size="sm" @click="show">Show the pop-up</Button>
    </div>
    <WhatsNewDialog />
  </div>
</template>

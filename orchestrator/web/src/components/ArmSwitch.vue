<script setup lang="ts">
// THE SWITCH. Green = the tray icon is up and the lanes may act; amber = the icon is up but
// paused from its menu; gray = no icon, nothing acts. Turning it ON from here runs
// `python orch.py arm` on the machine (registers any missing lane, starts the icon, waits for
// its first heartbeat); OFF runs `orch.py disarm`. The owner's own words: "it can't be running
// without the status bar icon, so I can terminate it if I want" - this is that, from a phone.
import { Loader2, Power, PowerOff } from '@lucide/vue'
import { ref } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useGateway } from '@/composables/useGateway'

const { switchState, switching, setArmed } = useGateway()
const confirmOpen = ref(false)

async function apply(on: boolean): Promise<void> {
  confirmOpen.value = false
  try {
    const r = await setArmed(on)
    if (r.ok)
      toast.success(
        on
          ? 'Armed - the tray icon is up and the lanes may act.'
          : 'Disarmed - the icon is closed; nothing acts.',
      )
    else
      toast.error(`${on ? 'arm' : 'disarm'} failed (exit ${r.code ?? 'none'})`, {
        description: r.output.split('\n').slice(-3).join('\n'),
      })
  } catch (err) {
    toast.error(`${on ? 'arm' : 'disarm'} failed`, {
      description: err instanceof Error ? err.message : String(err),
    })
  }
}
</script>

<template>
  <div class="flex items-center gap-2">
    <span
      class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium"
      :class="
        !switchState
          ? 'border-border text-muted-foreground'
          : switchState.up && !switchState.paused
            ? 'border-success/40 bg-success/10 text-success'
            : switchState.up
              ? 'border-warning/40 bg-warning/10 text-warning'
              : 'border-border bg-muted text-muted-foreground'
      "
      :title="switchState?.why || ''"
    >
      <span
        class="size-2 rounded-full"
        :class="!switchState ? 'bg-muted-foreground' : switchState.up && !switchState.paused ? 'bg-success' : switchState.up ? 'bg-warning' : 'bg-muted-foreground'"
      />
      <template v-if="!switchState">switch: unknown</template>
      <template v-else-if="switchState.up && !switchState.paused">ARMED · the eyes are firing</template>
      <template v-else-if="switchState.up">PAUSED from the icon's menu</template>
      <template v-else>OFF · nothing acts</template>
    </span>

    <Button v-if="switchState?.up" variant="outline" size="sm" :disabled="switching" @click="apply(false)">
      <Loader2 v-if="switching" class="animate-spin" />
      <PowerOff v-else />
      Turn off
    </Button>
    <Button v-else size="sm" :disabled="switching || !switchState" @click="confirmOpen = true">
      <Loader2 v-if="switching" class="animate-spin" />
      <Power v-else />
      Turn on
    </Button>

    <Dialog v-model:open="confirmOpen">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Arm the orchestrator?</DialogTitle>
          <DialogDescription>
            This starts the tray icon on the machine. While it is up the nine lanes act on their own every
            five minutes: archives, console landings, balance moves, staged deliveries, wake-ups. Close the
            icon (or turn it off here) and everything stops.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="confirmOpen = false">Cancel</Button>
          <Button @click="apply(true)"><Power /> Arm</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

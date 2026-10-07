<script setup lang="ts">
import { ref } from 'vue'
import type { DevWebProject } from '@shared/devwebui'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { removeProject, setProjectEnabled, updateProject } from '../api'
import { useDevServers } from '../store'
import { BTN_DANGER, BTN_GHOST, BTN_PRIMARY, INPUT } from './kit/kit'
import ColorPicker from './kit/ColorPicker.vue'
import Field from './kit/Field.vue'
import FormSection from './kit/FormSection.vue'
import SwitchRow from './kit/SwitchRow.vue'

// A project's edit view (a sub-view of the Dev servers page): its name and color, saved by the footer; the master autostart
// switch, saved at once; and removing it behind a confirm (the servers AgentHydra started stop, the .devwebui file is kept).
const props = defineProps<{ project: DevWebProject }>()
const emit = defineEmits<{ saved: []; cancel: []; removed: [] }>()
const servers = useDevServers()

const name = ref(props.project.name)
const color = ref(props.project.color ?? '')
const error = ref<string | null>(null)
const saving = ref(false)

async function attempt(fn: () => Promise<unknown>): Promise<boolean> {
  error.value = null
  try {
    await fn()
    await servers.refresh()
    return true
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    return false
  }
}

async function save() {
  saving.value = true
  // An emptied name keeps the old one rather than saving a project with no name.
  const ok = await attempt(() => updateProject(props.project.id, { name: name.value.trim() || props.project.name, color: color.value || null }))
  saving.value = false
  if (ok) emit('saved')
}
const setEnabled = (on: boolean) => attempt(() => setProjectEnabled(props.project.id, on))

const removing = ref(false)
async function remove() {
  removing.value = false
  const ok = await attempt(async () => {
    await removeProject(props.project.id)
    servers.select(null)
  })
  if (ok) emit('removed')
}
</script>

<template>
  <form class="flex min-h-full flex-col" @submit.prevent="save">
    <div class="mx-auto flex w-full max-w-[640px] flex-col gap-6 p-4 pb-6">
      <FormSection title="Project" description="How it reads in the list.">
        <Field label="Name">
          <template #default="{ id, describedBy, invalid }">
            <input :id="id" v-model="name" :class="[INPUT, 'max-w-[360px]']" :aria-describedby="describedBy" :aria-invalid="invalid" />
          </template>
        </Field>
        <div class="flex flex-col gap-1.5">
          <span class="text-[12px] font-medium leading-4 text-text-2">Color</span>
          <ColorPicker v-model="color" label="Project color" />
        </div>
      </FormSection>

      <FormSection title="Autostart">
        <SwitchRow label="Autostart is on for this project" description="Off leaves every server of it out of autostart, whatever each server says." :model-value="project.enabled" @update:model-value="setEnabled" />
      </FormSection>

      <FormSection title="Danger zone" tone="danger">
        <div class="flex flex-wrap items-center gap-3">
          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span class="text-[13px] leading-5 text-text">Remove this project</span>
            <span class="text-[12px] leading-4 text-text-muted">Stops the servers AgentHydra started for it and takes it off the list. Its .devwebui file is kept.</span>
          </div>
          <button type="button" :class="BTN_DANGER" @click="removing = true">Remove project…</button>
        </div>
      </FormSection>
    </div>

    <div class="sticky bottom-0 mt-auto flex flex-wrap items-center gap-2 border-t border-border bg-bg-page/95 px-4 py-3 backdrop-blur">
      <p v-if="error" role="alert" class="min-w-0 flex-1 text-[12px] leading-4 text-danger-text">{{ error }}</p>
      <span v-else class="flex-1" />
      <button type="button" :class="BTN_GHOST" @click="emit('cancel')">Cancel</button>
      <button type="submit" :class="BTN_PRIMARY" :disabled="saving">Save</button>
    </div>

    <Dialog :open="removing" @update:open="(o: boolean) => !o && (removing = false)">
      <DialogContent :aria-describedby="undefined">
        <DialogTitle>Remove {{ project.name }}?</DialogTitle>
        <DialogDescription>This stops the servers AgentHydra started for it and takes it off the list. Its .devwebui file is kept.</DialogDescription>
        <DialogFooter>
          <Button variant="ghost" @click="removing = false">Cancel</Button>
          <Button variant="destructive" @click="remove">Remove project</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </form>
</template>

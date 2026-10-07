<script setup lang="ts">
import { useId } from 'vue'

// One field of a form: its label above, the control, then a line of help (or the error, in its place). The slot gets
// the id to put on the control, so the label and the help belong to it:
//   <Field label="Port" help="..."><template #default="{ id, describedBy }"><input :id="id" :aria-describedby="describedBy" /></template></Field>
const props = defineProps<{ label: string; help?: string; error?: string | null; optional?: boolean }>()
const id = useId()
const helpId = `${id}-help`
</script>

<template>
  <div class="flex min-w-0 flex-col gap-1.5">
    <label :for="id" class="flex items-baseline gap-1.5 text-[12px] font-medium leading-4 text-text-2">
      {{ props.label }}
      <span v-if="optional" class="font-normal text-text-muted">Optional</span>
    </label>
    <slot v-bind="{ id, describedBy: help || error ? helpId : undefined, invalid: !!error }" />
    <p v-if="error" :id="helpId" role="alert" class="text-[12px] leading-4 text-danger-text">{{ error }}</p>
    <p v-else-if="help" :id="helpId" class="text-[12px] leading-4 text-text-muted">{{ help }}</p>
  </div>
</template>

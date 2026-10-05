import { ref } from 'vue'

/** The last sidebar or title-bar row action that failed, in words; the sidebar lists it and the session header says it, so it shows wherever the action began. */
export const actionError = ref<string | null>(null)

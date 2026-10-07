// The sidebar's Active only switch (Filter menu, owner, 2026-10-07): the list shows only the rows whose dot is
// active (logic.ts isActive), in both lists. Remembered, as Clean sidebar is.
import { ref, watch } from 'vue'

const KEY = 'hydra-desk.sidebar.activeOnly'
const storage = typeof localStorage === 'undefined' ? null : localStorage
/** On: only the active rows. Remembered. */
export const activeOnly = ref(storage?.getItem(KEY) === '1')
watch(activeOnly, (v) => storage?.setItem(KEY, v ? '1' : '0'))

// The chrome bar's Clean sidebar button (owner, 2026-10-06): the sidebar's rows show their dot and title
// only, without the account number, the time since the last activity or a working chat's elapsed time. The
// desk list and the cloud list both show those, so it works with Cloud off too (owner, 2026-10-07).
// What still needs the owner stays: a limited chat's reset time, the CliMayte count, a row's sub-items.
// On unless turned off (owner, 2026-10-08: "Make it default on"); the button is blue only while it is off.
import { ref, watch } from 'vue'

const KEY = 'hydra-desk.sidebar.clean'
const storage = typeof localStorage === 'undefined' ? null : localStorage
/** On: rows without their details. Remembered; on until the button turns it off. */
export const cleanSidebar = ref(storage?.getItem(KEY) !== '0')
watch(cleanSidebar, (v) => storage?.setItem(KEY, v ? '1' : '0'))

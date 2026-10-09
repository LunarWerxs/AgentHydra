// The New screen's project tiles show their name and icon only; the folder path and the git status chip appear
// on hover or keyboard focus, or on every tile at once behind a toggle beside the filter (owner, 2026-10-08:
// "by default, hide the folder and the committed status ... only display that on hover. So it fits more vertically").
// Off unless turned on: the tiles stay short by default, and the toggle remembers the owner's choice like Clean sidebar.
import { ref, watch } from 'vue'

const KEY = 'hydra-desk.new.project-details'
const storage = typeof localStorage === 'undefined' ? null : localStorage

/** Whether the saved value turns the details on. Anything but a saved '1' (none yet, or '0') keeps them hidden. */
export function detailsOn(saved: string | null): boolean {
  return saved === '1'
}

/** On: every project tile shows its folder and git status in place. Remembered; off until the toggle turns it on. */
export const showProjectDetails = ref(detailsOn(storage?.getItem(KEY) ?? null))
watch(showProjectDetails, (v) => storage?.setItem(KEY, v ? '1' : '0'))

const HIDDEN_KEY = 'hydra-desk.new.show-hidden-projects'
/** On: hidden projects are listed on the New screen, dimmed, with Unhide. Remembered like the details toggle. */
export const showHiddenProjects = ref(detailsOn(storage?.getItem(HIDDEN_KEY) ?? null))
watch(showHiddenProjects, (v) => storage?.setItem(HIDDEN_KEY, v ? '1' : '0'))

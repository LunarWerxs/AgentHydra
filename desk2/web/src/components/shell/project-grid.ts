import { shallowRef } from 'vue'
import type { ProjectsResponse } from '@shared/protocol'

/** The New screen's last project grid, shared so the folder pill reads the logos the grid already loaded. */
export const gridProjects = shallowRef<ProjectsResponse | null>(null)

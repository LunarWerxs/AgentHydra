// Hydra Desk 2: HSwarm's jobs for the sidebar. The server reads them (every 10 s, on the poller's timer) and pushes
// them in the swarm.update event, which the desk store keeps; nothing is fetched here.
import { computed, type ComputedRef, type Ref } from 'vue'
import type { SwarmJob } from '@shared/protocol'
import { useDesk } from '@/stores/desk'

/** This PC's jobs, and the other PCs' too while `cloud` is on (owner, 2026-10-05: with the cloud off, no other PC's). */
export function useSwarmJobs(cloud: Ref<boolean>): ComputedRef<SwarmJob[]> {
  const { swarmJobs, remoteSwarmJobs } = useDesk()
  return computed(() => (cloud.value ? [...swarmJobs.value, ...remoteSwarmJobs.value] : swarmJobs.value))
}

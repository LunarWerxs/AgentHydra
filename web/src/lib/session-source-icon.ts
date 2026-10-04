// web/src/lib/session-source-icon.ts - the small icon a Sessions row wears for the tool that ran it,
// in the badge slot where CliMayte's rows put their cloud. An icon, never a coloured pill: the
// name is its hover. The tool name wins for the swarms, which share a reader with other tools.
import { Bot, Network, Sparkles, SquareTerminal } from '@lucide/vue'
import type { Component } from 'vue'

const BY_SOURCE: Record<string, Component> = {
  claude: Sparkles,
  codex: SquareTerminal,
  // The source id `zswarm` is HSwarm's jobs since ZSwarm retired (2026-10-03).
  zswarm: Network,
}
const BY_LABEL: Record<string, Component> = {
  // A swarm job's label is TOOL_NAME.zswarm, 'HSwarm' (session-labels.ts).
  hswarm: Network,
}

export function sessionSourceIcon(source: string, label: string): Component {
  return BY_LABEL[label.toLowerCase()] ?? BY_SOURCE[source] ?? Bot
}

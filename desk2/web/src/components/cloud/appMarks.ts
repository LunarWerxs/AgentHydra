import type { Component } from 'vue'
import { Bot, Code, Cpu, Network, Sparkles, Terminal } from '@lucide/vue'

/** One muted mark per app that is not Claude, the same in the cloud list and the desk list. */
const APP_MARKS: Record<string, Component> = { codex: Code, opencode: Terminal, hermes: Sparkles, dsh: Cpu, zswarm: Network }

/** The mark of an app (cloud/logic.ts appLead); an app with none of its own gets a bot. */
export const appMark = (app: string): Component => APP_MARKS[app] ?? Bot

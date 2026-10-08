// HSwarm table columns and row models, using the same InstanceColumn structure as Instances tables.
// States map to the Instances colour language: ready=success, resting=waiting, disabled=off/error.

import type { InstanceColumn } from '@/lib/instance-table'

export type HSwarmProviderColumn = Extract<
  InstanceColumn,
  { key: 'providerState' | 'providerName' | 'readyCount' | 'restingCount' | 'disabledCount' | 'keyCount' | 'enabled' | 'actions' }
>

export type HSwarmKeyColumn = Extract<
  InstanceColumn,
  { key: 'keyMasked' | 'keyFingerprint' | 'keyPriority' | 'keyState' | 'actions' }
>

export type HSwarmModelColumn = Extract<
  InstanceColumn,
  { key: 'modelEnabled' | 'modelPriority' | 'modelName' | 'modelProvider' | 'modelKind' | 'modelPrice' | 'modelContext' | 'actions' }
>

export const hswarmProviderColumns: InstanceColumn[] = [
  {
    key: 'providerState',
    label: 'hswarm.v.providers.state',
    sortable: true,
    head: { width: '20' },
    skeleton: { line: 'chip', width: '16' },
  },
  {
    key: 'providerName',
    label: 'hswarm.v.providers.colProvider',
    sortable: true,
    head: { width: 'grow' },
    skeleton: { line: 'title', width: '28' },
  },
  {
    key: 'readyCount',
    label: 'hswarm.v.providers.readyKeys',
    sortable: true,
    head: { width: '16', align: 'end' },
    skeleton: { line: 'text', width: '8' },
  },
  {
    key: 'restingCount',
    label: 'hswarm.v.providers.restingKeys',
    sortable: true,
    head: { width: '16', align: 'end' },
    skeleton: { line: 'text', width: '8' },
  },
  {
    key: 'disabledCount',
    label: 'hswarm.v.providers.disabledKeys',
    sortable: true,
    head: { width: '16', align: 'end' },
    skeleton: { line: 'text', width: '8' },
  },
  {
    key: 'keyCount',
    label: 'hswarm.v.providers.colKeys',
    sortable: true,
    head: { width: '16', align: 'end' },
    skeleton: { line: 'text', width: '8' },
  },
  {
    key: 'enabled',
    label: 'hswarm.v.providers.on',
    sortable: false,
    head: { width: '12' },
    skeleton: { line: 'chip', width: '8' },
  },
  { key: 'actions', label: 'instances.colActions', head: { align: 'end' }, skeleton: { line: 'button', width: '20' } },
]

export const hswarmKeyColumns: InstanceColumn[] = [
  {
    key: 'keyMasked',
    label: 'hswarm.v.providers.key',
    sortable: true,
    head: { width: 'grow' },
    skeleton: { line: 'text', width: '24' },
  },
  {
    key: 'keyFingerprint',
    label: 'hswarm.v.providers.fingerprint',
    sortable: true,
    head: { width: '48' },
    skeleton: { line: 'text', width: '32' },
  },
  {
    key: 'keyPriority',
    label: 'hswarm.v.providers.priority',
    sortable: true,
    head: { width: '20' },
    skeleton: { line: 'text', width: '8' },
  },
  {
    key: 'keyState',
    label: 'hswarm.v.providers.state',
    sortable: true,
    head: { width: '24' },
    skeleton: { line: 'chip', width: '16' },
  },
  { key: 'actions', label: 'instances.colActions', head: { width: '20', align: 'end' }, skeleton: { line: 'button', width: '20' } },
]

export const hswarmModelColumns: InstanceColumn[] = [
  {
    key: 'modelEnabled',
    label: 'hswarm.v.models.colEnabled',
    sortable: false,
    head: { width: '12' },
    skeleton: { line: 'chip', width: '8' },
  },
  {
    key: 'modelPriority',
    label: 'hswarm.v.models.colPriority',
    sortable: true,
    head: { width: '12' },
    skeleton: { line: 'chip', width: '8' },
  },
  {
    key: 'modelName',
    label: 'hswarm.v.models.colModel',
    sortable: true,
    head: { width: 'grow' },
    skeleton: { line: 'title', width: '28' },
  },
  {
    key: 'modelProvider',
    label: 'hswarm.v.models.colProvider',
    sortable: true,
    head: { width: '32' },
    skeleton: { line: 'text', width: '24' },
  },
  {
    key: 'modelKind',
    label: 'hswarm.v.models.colKind',
    sortable: false,
    head: { width: '20' },
    skeleton: { line: 'chip', width: '16' },
  },
  {
    key: 'modelPrice',
    label: 'hswarm.v.models.colPrice',
    sortable: true,
    head: { width: '24', align: 'end' },
    skeleton: { line: 'text', width: '12' },
  },
  {
    key: 'modelContext',
    label: 'hswarm.v.models.colContext',
    sortable: true,
    head: { width: '16', align: 'end' },
    skeleton: { line: 'text', width: '12' },
  },
]

export const hswarmModelTypedColumns: InstanceColumn[] = [
  {
    key: 'modelEnabled',
    label: 'hswarm.v.models.colEnabled',
    sortable: false,
    head: { width: '12' },
    skeleton: { line: 'chip', width: '8' },
  },
  {
    key: 'modelName',
    label: 'hswarm.v.models.colModel',
    sortable: true,
    head: { width: 'grow' },
    skeleton: { line: 'title', width: '28' },
  },
  {
    key: 'modelProvider',
    label: 'hswarm.v.models.colProvider',
    sortable: true,
    head: { width: '32' },
    skeleton: { line: 'text', width: '24' },
  },
]

export interface HSwarmProviderRowModel {
  id: string
  name: string
  state: { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
  readyCount: number
  restingCount: number
  disabledCount: number
  keyCount: number
  enabled: boolean
  onEnabledChange?: (enabled: boolean) => void
  onOpen?: (path: string[]) => void
  menu?: { name: string; actions: any[] }
}

export interface HSwarmKeyRowModel {
  id: string
  fingerprint: string
  masked: string
  priority: number | null
  state: { label: string; variant: 'default' | 'secondary' | 'destructive' }
  disabled: boolean
  resting_s?: number
  free_only?: boolean
  editable?: boolean
  onPriorityChange?: (priority: number | null) => void
  onEnabledChange?: (enabled: boolean) => void
  onCheck?: () => void
  onRemove?: () => void
}

export interface HSwarmModelRowModel {
  id: string
  name: string
  label?: string
  enabled: boolean
  switched_off?: boolean
  priority: number | null
  provider?: string
  kind?: string
  usd_per_1m?: number | null
  ctx?: number | null
  custom?: boolean
  vision?: boolean
  tools?: boolean | null
  auto?: boolean
  onEnabledChange: (enabled: boolean) => void | Promise<void>
  onPriorityChange: (priority: number | null) => void | Promise<void>
  onToggleStar: () => void | Promise<void>
}

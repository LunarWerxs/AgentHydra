// What the shell (frame, sidebar, title bar, new-session screen) reads and does. The live app reads the
// store; the Gallery provides fixtures under SHELL_SOURCE so the shell renders without a server.
import { inject, type InjectionKey, type Ref } from 'vue'
import type {
  AccountInfo,
  ChatPatch,
  ChatSummary,
  CliMayteWorker,
  DeskSettings,
  ExternalSession,
  HomeStats,
  HomeStatsRange,
  ProjectChoiceKind,
  ProjectsResponse,
  QueueAddRequest,
  QueueItem,
  QueuePatch,
  QueueSettingsPatch,
  QueueState,
  SearchHit,
  SessionMetaPatch,
  TranscriptItem
} from '@shared/protocol'
import { useDesk } from '@/stores/desk'
import type { View } from './logic'

export interface ShellSource {
  chats: Readonly<Ref<ChatSummary[]>>
  itemsByChat: Readonly<Ref<Map<string, TranscriptItem[]>>>
  /** Why a chat's history did not load, by chat id, while it is tried again. Optional: a fixture source loads all it has. */
  itemsError?: Readonly<Ref<ReadonlyMap<string, string>>>
  workers: Readonly<Ref<CliMayteWorker[]>>
  /** Hydra Desk 2: the other PCs' CliMayte workers (each with `pc`), kept apart from `workers` so they never count as this PC's; only the sidebar's task rows read them. A source without them (the Gallery) has none. */
  remoteWorkers?: Readonly<Ref<CliMayteWorker[]>>
  external: Readonly<Ref<ExternalSession[]>>
  accounts: Readonly<Ref<AccountInfo[]>>
  settings: Readonly<Ref<DeskSettings | null>>
  selected: Readonly<Ref<View>>
  /** The key a chat's sidebar row keeps: a real chat that replaced a placeholder keeps the placeholder's. Optional: a fixture source has none. */
  rowKeyOf?(id: string): string
  select(view: View): void
  /** The footer gear, the chrome menu and the account popup's Settings row. */
  openSettings(): void
  updateChat(id: string, patch: ChatPatch): Promise<unknown>
  removeChat(id: string): Promise<unknown>
  interrupt(id: string): Promise<unknown>
  loadItems(id: string): Promise<unknown>
  updateSettings(patch: Partial<DeskSettings>): Promise<unknown>
  /** The row menu's Fork: a new chat continuing from a copy of the session (answers it). */
  forkChat(id: string): Promise<ChatSummary>
  forkExternal(sessionId: string): Promise<ChatSummary>
  /** Hydra Desk's marks on an outside session (pin, archive, unread, title, group). */
  updateSessionMeta(sessionId: string, patch: SessionMetaPatch): Promise<unknown>
  /**
   * Lists an outside session `external` lacks (it holds the last 24 hours; a search hit can be older) by
   * fetching it on its own; rejects when AgentHydra does not know it. Optional: a fixture source lists all it has.
   */
  ensureExternal?(sessionId: string): Promise<unknown>
  /**
   * The stand-in chat of an outside session the composer can carry on now (external/logic.ts), else null:
   * the title bar's Account menu picks where it continues. Optional: a fixture source has no stand-ins.
   */
  standInOf?(sessionId: string): ChatSummary | null
  /** Open in > File Explorer. */
  revealFolder(path: string): Promise<unknown>
  /** The native folder picker (POST /api/folders/pick); null when cancelled. Optional: a fixture source has none. */
  pickFolder?(): Promise<string | null>
  /** Adds (`on`) or removes a folder of the New screen's grid (POST or DELETE /api/projects/:kind). Optional, like pickFolder. */
  changeProjectChoice?(kind: ProjectChoiceKind, path: string, on: boolean): Promise<unknown>
  /** AgentHydra's transcript search (GET /api/search); rejects with a SearchError. */
  search(query: string): Promise<SearchHit[]>
  /**
   * The stats card's figures over every source AgentHydra counts (GET /api/stats/home): `homeStats` asks the
   * server and keeps the answer in this browser, `cachedHomeStats` is the kept one (a reload paints it at
   * once). Optional: a source without them shows Hydra Desk's own chats only.
   */
  homeStats?(range: HomeStatsRange): Promise<HomeStats>
  cachedHomeStats?(range: HomeStatsRange): HomeStats | null
  /**
   * The New screen's project grid (GET /api/projects): Project Hydra's projects and the folders of the chats, each
   * with its git sync state; `wait` answers once what was stale (`pending`) is read again. `cachedProjects` is the last
   * answer kept in this browser. Optional: without them the screen shows no grid.
   */
  projects?(opts?: { wait?: boolean; hidden?: boolean }): Promise<ProjectsResponse>
  cachedProjects?(): ProjectsResponse | null
  /**
   * The managed send queue (SPEC "Send queue"); null until the server reports one. Optional, like every
   * queue member below: the composer shows no queue UI for a source without them (the Gallery, parity).
   */
  queue?: Readonly<Ref<QueueState | null>>
  queueAdd?(req: QueueAddRequest): Promise<QueueItem>
  queueEdit?(id: string, patch: QueuePatch): Promise<QueueItem>
  queueRemove?(id: string): Promise<unknown>
  /** One place up or down within the item's own chat (or among new chats); nothing at the end. */
  queueMove?(id: string, direction: -1 | 1): Promise<unknown>
  queueSendNow?(id: string): Promise<unknown>
  queueRetry?(id: string): Promise<unknown>
  queueResume?(chatId: string): Promise<unknown>
  queueSettings?(patch: QueueSettingsPatch): Promise<unknown>
}

export const SHELL_SOURCE: InjectionKey<ShellSource> = Symbol('shell-source')

export function useShellSource(): ShellSource {
  const provided = inject(SHELL_SOURCE, null)
  if (provided) return provided
  const desk = useDesk()
  return desk as unknown as ShellSource
}

import { type CodexAppTools, connectCodexAppTools } from './codex-app-tools'
import { type CodexDesktopTarget, openCodexDesktop } from './codex-desktop'

interface Sidebar {
  sections: { sectionId: string; name: string; itemKeys: string[] }[]
}

interface VisibilityDependencies {
  open: typeof openCodexDesktop
  connect: (target: CodexDesktopTarget, threadId: string) => Promise<CodexAppTools>
}

/** Complete the user-visible half of the move through the destination's own native app tools. */
export async function showMigratedCodexChat(
  target: CodexDesktopTarget,
  threadId: string,
  overrides: Partial<VisibilityDependencies> = {},
): Promise<void> {
  const deps = { open: openCodexDesktop, connect: connectCodexAppTools, ...overrides }
  const opened = await deps.open(target)
  if (!opened.ok) throw new Error(opened.message ?? 'Codex did not open the destination desktop.')
  const app = await deps.connect(target, threadId)
  const navigation = await app.call<{ navigated: boolean }>('navigate_to_codex_page', { threadId })
  if (navigation.navigated !== true) throw new Error('Codex did not open the imported chat.')
  const sidebar = await app.call<Sidebar>('list_threads', { limit: 20 })
  const existing = sidebar.sections.find((section) => section.name === 'Migrated chats')
  const sectionId =
    existing?.sectionId ??
    (await app.call<{ sectionId: string }>('create_sidebar_section', { name: 'Migrated chats' }))
      .sectionId
  if (!sectionId) throw new Error('Codex did not create the migration sidebar section.')
  const itemKey = `codex:thread:local:${threadId}`
  if (!existing?.itemKeys.includes(itemKey)) {
    const moved = await app.call<{ threadId: string; sectionId: string; hostId: string }>(
      'move_thread_to_sidebar_section',
      {
        threadId,
        hostId: 'local',
        source: 'codex',
        sectionId,
      },
    )
    if (moved.threadId !== threadId || moved.sectionId !== sectionId || moved.hostId !== 'local')
      throw new Error('Codex did not place the imported chat in the sidebar.')
  }
  const verified = await app.call<Sidebar>('list_threads', { limit: 20 })
  if (
    !verified.sections.some(
      (section) => section.sectionId === sectionId && section.itemKeys.includes(itemKey),
    )
  ) {
    throw new Error('The imported chat could not be verified in the destination sidebar.')
  }
}

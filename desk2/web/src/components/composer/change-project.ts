// "Change project" on a message of yours or on the box's unsent draft (ChangeProjectMenu): which folders it
// offers, and what the message becomes in the folder chosen. No Vue here, so web/test/composer can test it.

import type { ChatSummary, CreateChatRequest, ImageRef } from '@shared/protocol'
import { folderRows, sameFolder, type FolderRow } from './folders'

/** The recent folders a message can go to: every one but the folder it is in. */
export function projectRows(recent: string[], current: string | null): FolderRow[] {
  return folderRows(current === null ? recent : recent.filter((p) => !sameFolder(p, current)), null)
}

/**
 * A sent message moved to another folder: a new chat there that sends the same text and pictures, with the
 * chat's model, effort, permissions and CliMayte setting. The account is picked again (auto), as for any new chat.
 */
export function movedChat(
  from: Pick<ChatSummary, 'model' | 'effort' | 'permissionMode' | 'delegateToCliMayte'> | null,
  cwd: string,
  message: { text: string; images?: ImageRef[] }
): CreateChatRequest {
  return {
    cwd,
    prompt: message.text,
    ...(message.images?.length ? { images: message.images } : {}),
    ...(from ? { model: from.model, effort: from.effort, permissionMode: from.permissionMode, delegateToCliMayte: from.delegateToCliMayte } : {})
  }
}

/** A moved draft goes below what already waits in the other folder's new-session box, never over it. */
export function joinDrafts(waiting: string, moved: string): string {
  return waiting.trim() ? `${waiting.replace(/\s+$/, '')}\n\n${moved}` : moved
}

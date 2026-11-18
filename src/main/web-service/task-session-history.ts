import { sanitizeExportMarkdown } from '../../shared/conversation-export'
import {
  projectConversationMessage,
  resolveActiveConversationActivities,
  resolveActiveConversationMessages
} from '../../shared/conversation-graph'
import {
  SESSION_HISTORY_PAGE_SIZE,
  SessionHistoryCursorStaleError,
  type LoadSessionHistoryPageRequest,
  type SessionHistoryPage
} from '../../shared/session-history'
import { isHiddenControlMessage } from '../../shared/session-persistence'
import type { TaskSessionHistoryPage } from '../../shared/task-api'

const SNAPSHOT_CURSOR_PREFIX = 'snapshot:'

type VisibleHistorySlice = {
  messageBranchId?: string
  messages: SessionHistoryPage['session']['messages']
  activities: NonNullable<SessionHistoryPage['session']['activities']>
  hasMore: boolean
  beforeCursor?: string
}

// Legacy and branched Sessions return a complete snapshot to the desktop history loader.
// Page the active visible path for SDK callers without exposing its full persistence authority.
function pageCompleteSnapshot(
  page: SessionHistoryPage,
  request: LoadSessionHistoryPageRequest
): VisibleHistorySlice {
  const session = page.session
  const graph = session.conversationGraph
  const messageBranchId = graph?.frames.find(({ id }) => id === graph.activeFrameId)?.activeBranchId
  const messages = graph
    ? resolveActiveConversationMessages(graph).map(projectConversationMessage)
    : session.messages
  const activities = graph
    ? resolveActiveConversationActivities(graph).activities
    : session.activities
  const hiddenPromptIds = new Set(messages.filter(isHiddenControlMessage).map(({ id }) => id))
  const records = [
    ...messages.flatMap((message, sortIndex) =>
      hiddenPromptIds.has(message.id)
        ? []
        : [{ message, sortIndex, id: message.id, createdAt: message.createdAt }]
    ),
    ...(activities ?? [])
      .filter(
        (activity) => !activity.promptMessageId || !hiddenPromptIds.has(activity.promptMessageId)
      )
      .map((activity) => ({
        activity,
        sortIndex: activity.sortIndex,
        id: activity.id,
        createdAt: activity.createdAt
      }))
  ].sort(
    (left, right) =>
      left.createdAt - right.createdAt ||
      left.sortIndex - right.sortIndex ||
      left.id.localeCompare(right.id)
  )
  const scope = [page.projectId, page.sessionId, page.revision, session.updatedAt, messageBranchId]
  let before = records.length
  if (request.beforeCursor) {
    try {
      if (!request.beforeCursor.startsWith(SNAPSHOT_CURSOR_PREFIX)) throw new Error()
      const cursor = JSON.parse(
        Buffer.from(
          request.beforeCursor.slice(SNAPSHOT_CURSOR_PREFIX.length),
          'base64url'
        ).toString('utf8')
      ) as { scope: unknown; before: number }
      if (
        JSON.stringify(cursor.scope) !== JSON.stringify(scope) ||
        !Number.isSafeInteger(cursor.before) ||
        cursor.before < 1 ||
        cursor.before >= records.length
      ) {
        throw new Error()
      }
      before = cursor.before
    } catch {
      throw new SessionHistoryCursorStaleError()
    }
  }
  const start = Math.max(0, before - (request.limit ?? SESSION_HISTORY_PAGE_SIZE))
  const items = records.slice(start, before)
  return {
    messageBranchId,
    messages: items.flatMap((item) => ('message' in item ? [item.message] : [])),
    activities: items.flatMap((item) => ('activity' in item ? [item.activity] : [])),
    hasMore: start > 0,
    beforeCursor:
      start > 0
        ? SNAPSHOT_CURSOR_PREFIX +
          Buffer.from(JSON.stringify({ scope, before: start })).toString('base64url')
        : undefined
  }
}

export function projectTaskSessionHistory(
  page: SessionHistoryPage,
  request: LoadSessionHistoryPageRequest
): TaskSessionHistoryPage {
  const display = page.complete
    ? pageCompleteSnapshot(page, request)
    : { ...page, messages: page.session.messages, activities: page.session.activities ?? [] }
  const hiddenPromptIds = new Set(
    display.messages.filter(isHiddenControlMessage).map(({ id }) => id)
  )
  return {
    projectId: page.projectId,
    sessionId: page.sessionId,
    revision: page.revision,
    ...(display.messageBranchId ? { messageBranchId: display.messageBranchId } : {}),
    messages: display.messages
      .filter((message) => !hiddenPromptIds.has(message.id))
      .map((message) => ({
        id: message.id,
        role: message.role,
        content:
          message.role === 'agent' ? sanitizeExportMarkdown(message.content) : message.content,
        status: message.status,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
        ...(message.responseToMessageId && !hiddenPromptIds.has(message.responseToMessageId)
          ? { responseToMessageId: message.responseToMessageId }
          : {}),
        ...(message.artifactIds ? { artifactIds: message.artifactIds } : {}),
        ...(message.uploads?.length
          ? {
              attachments: message.uploads.map(({ id, versionId, name, mimeType, size }) => ({
                id,
                ...(versionId ? { versionId } : {}),
                name,
                ...(mimeType ? { mimeType } : {}),
                size
              }))
            }
          : {})
      })),
    activities: display.activities
      .filter(
        (activity) => !activity.promptMessageId || !hiddenPromptIds.has(activity.promptMessageId)
      )
      .map(({ id, title, status, createdAt, updatedAt, promptMessageId }) => ({
        id,
        title,
        status,
        createdAt,
        updatedAt,
        ...(promptMessageId ? { promptMessageId } : {})
      })),
    hasMore: display.hasMore,
    ...(display.beforeCursor ? { beforeCursor: display.beforeCursor } : {})
  }
}

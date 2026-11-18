import { createHash } from 'node:crypto'
import type { AcpPermissionResponse } from '../../shared/acp'
import type { AcpPermissionRequest } from '../../shared/acp-permission-contract'
import { resolveActiveConversationMessages } from '../../shared/conversation-graph'
import {
  materializeSessionConversationGraph,
  resolveRestorablePermissionToolAuthority,
  sanitizeSessionPermissionRuntimeContext,
  type PersistedChatSession,
  type SessionPermissionRuntimeContext,
  type SessionRuntimeContext
} from '../../shared/session-persistence'
import type {
  SessionCatalog,
  SessionMutation,
  SessionPersistenceCoordinator,
  SessionRuntimeContextCommands
} from '../session-persistence/coordinator'
import type {
  DurablePermissionWaitCandidate,
  PermissionConfirmationDecision,
  PermissionConfirmationScope,
  PermissionConfirmationSnapshot
} from './permission-broker'
import { opencodeTransportProviderId } from '../agent-framework/opencode'
import { projectPermissionRequest } from './runtime-publication-owner'

type PermissionWaitSessions = SessionRuntimeContextCommands &
  Pick<SessionCatalog, 'containsMessageOnActiveBranch' | 'loadSessionForContinuation'> &
  Partial<
    Pick<SessionCatalog, 'sessionProjectId'> &
      Pick<SessionPersistenceCoordinator, 'readSessionSnapshot'> &
      SessionMutation
  >

type RestoredPermissionDecision = Readonly<{
  permission: SessionPermissionRuntimeContext
  option?: SessionPermissionRuntimeContext['request']['options'][number]
  denied: boolean
}>

type PreparedRestoredPermissionConfirmation = Readonly<{
  status: 'ready'
  response: AcpPermissionResponse
  decision: RestoredPermissionDecision
  claim(authorizeAtClaim: () => boolean): Promise<'claimed' | 'unavailable'>
}>

type RestoredPermissionConfirmation = Readonly<{
  snapshot: PermissionConfirmationSnapshot
  permission: SessionPermissionRuntimeContext
  revision: number
}>

const supportsRestoredPermissionOption = (
  option: AcpPermissionRequest['options'][number]
): boolean =>
  ['allow_once', 'allow_always', 'reject_once', 'reject_always'].includes(option.kind.toLowerCase())

const resolvePermissionDecision = (
  permission: SessionPermissionRuntimeContext,
  response: AcpPermissionResponse
): RestoredPermissionDecision => {
  if (response.cancelled || !response.optionId) return { permission, denied: true }
  const option = permission.request.options.find(
    (candidate) => candidate.optionId === response.optionId
  )
  if (!option) throw new Error('The restored permission option is no longer available.')
  if (!supportsRestoredPermissionOption(option)) {
    throw new Error('The restored permission option cannot be replayed safely.')
  }
  return { permission, option, denied: option.kind.toLowerCase().startsWith('reject_') }
}

const projectRestoredPermissionConfirmation = (
  session: PersistedChatSession | undefined,
  { projectId, sessionId }: PermissionConfirmationScope,
  requestId: string
): RestoredPermissionConfirmation | undefined => {
  if (
    !session ||
    session.projectId !== projectId ||
    session.id !== sessionId ||
    session.archivedAt !== undefined ||
    session.packageOrigin ||
    session.status !== 'waiting-permission'
  )
    return undefined

  const graph = session.conversationGraph
  const runtime = session.runtimeContext
  const authority = resolveRestorablePermissionToolAuthority(session)
  const permission = authority?.permission
  const frame = graph?.frames.find(({ id }) => id === graph.activeFrameId)
  const branch = graph?.branches.find(({ id }) => id === frame?.activeBranchId)
  const prompt = graph?.messages.find(({ id }) => id === permission?.originatingPromptMessageId)
  const segment = graph?.runtimeSegments.find(({ id }) => id === prompt?.runtimeSegmentId)
  if (
    !graph ||
    !authority ||
    !runtime ||
    !permission ||
    !frame ||
    !branch ||
    !prompt ||
    !segment ||
    permission.state !== 'pending' ||
    permission.request.requestId !== requestId ||
    permission.request.appOwned ||
    permission.request.delegated ||
    frame.id !== graph.rootFrameId ||
    frame.kind !== 'root' ||
    branch.agentFrameId !== frame.id ||
    prompt.role !== 'user' ||
    prompt.status !== 'complete' ||
    prompt.agentFrameId !== frame.id ||
    prompt.introducedOnBranchId !== branch.id ||
    authority.activity.agentFrameId !== frame.id ||
    authority.activity.messageBranchId !== branch.id ||
    authority.activity.runtimeSegmentId !== segment.id ||
    segment.agentFrameId !== frame.id ||
    (session.resumeRecovery?.promptMessageId !== undefined &&
      session.resumeRecovery.promptMessageId !== prompt.id)
  )
    return undefined

  const configuration = session.agentConfiguration
  const sourceModel = segment.model ?? configuration?.model ?? session.agentModel
  const sourceProviderId = segment.providerId ?? configuration?.providerId
  const opencodeModelId =
    segment.frameworkId === 'opencode' && sourceProviderId && sourceModel
      ? `${opencodeTransportProviderId(sourceProviderId, sourceModel)}/${sourceModel}`
      : undefined
  if (
    !sourceModel ||
    (session.agentModel &&
      session.agentModel !== sourceModel &&
      session.agentModel !== opencodeModelId) ||
    (configuration?.model && configuration.model !== sourceModel) ||
    (session.agentFrameworkId && session.agentFrameworkId !== segment.frameworkId) ||
    (session.agentBackendId && segment.backendId && session.agentBackendId !== segment.backendId) ||
    (configuration?.providerId &&
      segment.providerId &&
      configuration.providerId !== segment.providerId)
  )
    return undefined

  const request = projectPermissionRequest(permission.request)
  const options = request.options.filter(
    (option) => option.optionId && supportsRestoredPermissionOption(option)
  )
  if (new Set(request.options.map(({ optionId }) => optionId)).size !== request.options.length)
    return undefined
  const disclosure = { ...request, options }
  const allowedDecisions: PermissionConfirmationDecision[] = [
    ...options.map(({ optionId }) => `option:${optionId}` as const),
    'cancel'
  ]
  const version = createHash('sha256')
    .update(
      JSON.stringify([
        'restored-mcp-permission-confirmation-v1',
        projectId,
        sessionId,
        runtime.revision,
        frame.id,
        branch.id,
        branch.createdAt,
        prompt.id,
        segment,
        sourceModel,
        session.agentFrameworkId,
        session.agentBackendId,
        session.agentModel,
        configuration,
        authority.activity.status,
        authority.flatActivity.status,
        permission,
        disclosure
      ])
    )
    .digest('hex')
  return {
    snapshot: { version, request: disclosure, allowedDecisions },
    permission,
    revision: runtime.revision
  }
}

type PublishPermissionWaitSession = (session: PersistedChatSession) => Promise<void> | void

const isRevisionConflict = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 'revision-conflict'

const LITERATURE_SAVE_PERMISSION_IDENTITY = 'open-science-library/save_to_inbox'
const MAX_PERMISSION_PREVIEW_TITLE_CHARS = 512

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Durable permission state needs a human-readable preview, not a second copy of every abstract and
// author. The original request remains live for execution and its full fingerprint is persisted.
const requestForPersistence = (request: AcpPermissionRequest): AcpPermissionRequest => {
  if (request.mcpIdentity !== LITERATURE_SAVE_PERMISSION_IDENTITY || !isRecord(request.rawInput)) {
    return request
  }
  const input = isRecord(request.rawInput.arguments) ? request.rawInput.arguments : request.rawInput
  if (!Array.isArray(input.candidates)) return request

  return {
    ...request,
    rawInput: {
      candidates: input.candidates.slice(0, 10).flatMap((candidate) => {
        if (!isRecord(candidate) || !isRecord(candidate.item)) return []
        const title = candidate.item.title
        return typeof title === 'string' && title.trim()
          ? [{ item: { title: title.trim().slice(0, MAX_PERMISSION_PREVIEW_TITLE_CHARS) } }]
          : []
      })
    }
  }
}

class AcpPermissionWaitOwner {
  constructor(
    private readonly sessions?: PermissionWaitSessions,
    private readonly publishSessionUpdated?: PublishPermissionWaitSession,
    private readonly prepareRuntimeTranscript?: (
      candidate: DurablePermissionWaitCandidate
    ) => Promise<unknown>
  ) {}

  async persist(candidate: DurablePermissionWaitCandidate): Promise<boolean> {
    if (!this.sessions || !candidate.projectId || !candidate.promptMessageId) return false
    if (
      !(await this.sessions.containsMessageOnActiveBranch(
        candidate.projectId,
        candidate.request.sessionId,
        candidate.promptMessageId
      ))
    ) {
      if (candidate.restoredContinuation)
        throw new Error('The restored permission request is not on the active Message Branch.')
      return false
    }

    const permission = sanitizeSessionPermissionRuntimeContext({
      state: 'pending',
      request: requestForPersistence(candidate.request),
      originatingPromptMessageId: candidate.promptMessageId,
      fingerprint: candidate.fingerprint,
      categoryKey: candidate.categoryKey,
      capability: candidate.capability,
      createdAt: Date.now()
    })
    if (!permission) throw new Error('Permission request could not be persisted safely.')

    // Commit the exact tool witness before exposing durable approval authority. Reuse the
    // reviewed persistence preview so a delayed provider notification cannot bypass its limits.
    await this.prepareRuntimeTranscript?.({ ...candidate, request: permission.request })

    let replacingContinuation = false
    const assertCurrentContinuation = (): void => {
      const continuation = candidate.restoredContinuation
      if (
        continuation &&
        (!continuation.isCurrent?.() ||
          continuation.interactionSequence === undefined ||
          !continuation.agentFrameId ||
          !continuation.messageBranchId ||
          continuation.projectId !== candidate.projectId ||
          continuation.sessionId !== candidate.request.sessionId ||
          continuation.promptMessageId !== candidate.promptMessageId)
      )
        throw new Error('The restored permission continuation is no longer active.')
    }
    await this.patch(
      candidate.projectId,
      candidate.request.sessionId,
      (context) => {
        replacingContinuation = false
        const continuation = candidate.restoredContinuation
        assertCurrentContinuation()
        const currentPermission = context.permission
        if (currentPermission) {
          if (
            currentPermission.state === 'pending' &&
            currentPermission.request.requestId === permission.request.requestId
          ) {
            return currentPermission
          }
          if (
            currentPermission.state === 'continuing' &&
            continuation &&
            !continuation.handedOff &&
            continuation.handoffStarted &&
            currentPermission.request.requestId === continuation.requestId &&
            currentPermission.originatingPromptMessageId === continuation.promptMessageId &&
            currentPermission.fingerprint === continuation.fingerprint
          ) {
            replacingContinuation = true
            return permission
          }
          throw new Error('Another durable permission request already owns this Session.')
        }
        return permission
      },
      'waiting-permission',
      () => {
        // Commit may succeed even if the subsequent renderer publication fails. Never let that
        // notification failure re-arm the consumed old decision over its committed successor.
        if (replacingContinuation && candidate.restoredContinuation)
          candidate.restoredContinuation.handedOff = true
      },
      candidate.restoredContinuation
        ? (session) => {
            // This runs inside the Session's persistence queue after its final read. Do not call back
            // into the coordinator here: its reads use the same queue.
            assertCurrentContinuation()
            const graph = materializeSessionConversationGraph(session).conversationGraph
            const continuation = candidate.restoredContinuation!
            const frame = graph?.frames.find(({ id }) => id === graph.activeFrameId)
            if (
              !graph ||
              !frame ||
              frame.id !== continuation.agentFrameId ||
              frame.activeBranchId !== continuation.messageBranchId ||
              !resolveActiveConversationMessages(graph).some(
                ({ id }) => id === candidate.promptMessageId
              )
            )
              throw new Error(
                'The restored permission request is not on the active Message Branch.'
              )
          }
        : undefined
    )
    return true
  }

  async clearLive(candidate: DurablePermissionWaitCandidate): Promise<void> {
    if (!this.sessions || !candidate.projectId || !candidate.promptMessageId) return
    await this.clear(
      candidate.projectId,
      candidate.request.sessionId,
      candidate.request.requestId,
      'running'
    )
  }

  async clearAfterContinuation(
    projectId: string,
    sessionId: string,
    requestId: string
  ): Promise<boolean> {
    if (!this.sessions) return false
    return this.patch(
      projectId,
      sessionId,
      (context) => {
        const permission = context.permission
        if (!permission || permission.request.requestId !== requestId) return permission
        if (permission.state !== 'continuing') {
          throw new Error('The restored permission continuation is no longer active.')
        }
        return undefined
      },
      'idle'
    )
  }

  async cancelContinuation(projectId: string, sessionId: string, requestId: string): Promise<void> {
    if (!this.sessions) return
    await this.patch(
      projectId,
      sessionId,
      (context) => {
        const permission = context.permission
        if (!permission) return undefined
        if (permission.request.requestId !== requestId) {
          return permission
        }
        return undefined
      },
      'idle'
    )
  }

  async cancelPendingSession(sessionId: string): Promise<string | undefined> {
    if (!this.sessions?.sessionProjectId) return undefined
    const projectId = await this.sessions.sessionProjectId(sessionId)
    if (!projectId) return undefined
    let cancelledRequestId: string | undefined
    const cleared = await this.patch(
      projectId,
      sessionId,
      (context) => {
        const permission = context.permission
        if (
          !permission ||
          permission.state !== 'pending' ||
          permission.request.sessionId !== sessionId
        ) {
          return permission
        }
        cancelledRequestId = permission.request.requestId
        return undefined
      },
      'idle'
    )
    return cleared ? cancelledRequestId : undefined
  }

  async beginContinuation(projectId: string, sessionId: string, requestId: string): Promise<void> {
    await this.transitionContinuation(
      projectId,
      sessionId,
      requestId,
      'pending',
      'continuing',
      'running'
    )
  }

  async rearmContinuation(projectId: string, sessionId: string, requestId: string): Promise<void> {
    await this.transitionContinuation(
      projectId,
      sessionId,
      requestId,
      'continuing',
      'pending',
      'waiting-permission'
    )
  }

  private async readRestoredConfirmation(
    scope: PermissionConfirmationScope,
    requestId: string
  ): Promise<RestoredPermissionConfirmation | undefined> {
    const session = await this.sessions?.readSessionSnapshot?.(scope.projectId, scope.sessionId, {
      preserveRuntimeState: true
    })
    return projectRestoredPermissionConfirmation(session, scope, requestId)
  }

  async readPendingRestoredConfirmation(
    scope: PermissionConfirmationScope,
    requestId: string
  ): Promise<PermissionConfirmationSnapshot | undefined> {
    return (await this.readRestoredConfirmation(scope, requestId))?.snapshot
  }

  async prepareRestoredConfirmation(
    scope: PermissionConfirmationScope,
    requestId: string,
    version: string,
    selected: PermissionConfirmationDecision
  ): Promise<
    PreparedRestoredPermissionConfirmation | { status: 'unavailable' | 'invalid-decision' }
  > {
    const { projectId, sessionId } = scope
    const restored = { projectId, sessionId }
    const confirmation = await this.readRestoredConfirmation(restored, requestId)
    if (!confirmation || confirmation.snapshot.version !== version) return { status: 'unavailable' }
    if (!confirmation.snapshot.allowedDecisions.includes(selected))
      return { status: 'invalid-decision' }
    const response: AcpPermissionResponse =
      selected === 'cancel'
        ? { requestId, restored, cancelled: true }
        : { requestId, restored, optionId: selected.slice('option:'.length) }

    return {
      status: 'ready',
      response,
      decision: resolvePermissionDecision(confirmation.permission, response),
      claim: (authorizeAtClaim) =>
        this.claimRestoredConfirmation(
          { projectId, sessionId },
          requestId,
          version,
          confirmation.revision,
          authorizeAtClaim
        )
    }
  }

  private async claimRestoredConfirmation(
    scope: PermissionConfirmationScope,
    requestId: string,
    version: string,
    expectedRevision: number,
    authorizeAtClaim: () => boolean
  ): Promise<'claimed' | 'unavailable'> {
    const unavailable = new Error('The restored permission confirmation is no longer available.')
    let committed = false
    try {
      const changed = await this.patch(
        scope.projectId,
        scope.sessionId,
        (context) => {
          const permission = context.permission
          if (
            context.revision !== expectedRevision ||
            permission?.state !== 'pending' ||
            permission.request.requestId !== requestId
          )
            return permission
          return { ...permission, state: 'continuing' }
        },
        'running',
        () => {
          committed = true
        },
        (session) => {
          // The Session owner runs this after the authoritative load and revision check inside its
          // write queue. Never await or call back into the Session coordinator from this fence.
          const current = projectRestoredPermissionConfirmation(session, scope, requestId)
          if (current?.snapshot.version !== version || !authorizeAtClaim()) throw unavailable
        }
      )
      return changed ? 'claimed' : 'unavailable'
    } catch (error) {
      // Publication can fail after the durable marker has won. The continuation still owns it.
      if (committed) return 'claimed'
      if (error === unavailable) return 'unavailable'
      throw error
    }
  }

  async resolveRestored(
    response: AcpPermissionResponse,
    projectId: string,
    sessionId: string
  ): Promise<RestoredPermissionDecision> {
    if (!this.sessions || !response.restored) {
      throw new Error('The restored permission request is no longer available.')
    }
    if (response.restored.sessionId !== sessionId || response.restored.projectId !== projectId) {
      throw new Error('Restored permission Session context does not match the active Session.')
    }

    const context = await this.sessions.readSessionRuntimeContext(projectId, sessionId)
    const permission = context.permission
    if (
      !permission ||
      permission.state !== 'pending' ||
      permission.request.requestId !== response.requestId ||
      permission.request.sessionId !== sessionId
    ) {
      throw new Error('The restored permission request is stale or no longer pending.')
    }
    if (
      !(await this.sessions.containsMessageOnActiveBranch(
        projectId,
        sessionId,
        permission.originatingPromptMessageId
      ))
    ) {
      throw new Error('The restored permission request is not on the active Message Branch.')
    }

    return resolvePermissionDecision(permission, response)
  }

  private async clear(
    projectId: string,
    sessionId: string,
    requestId: string,
    sessionStatus: 'running' | 'idle'
  ): Promise<void> {
    await this.patch(
      projectId,
      sessionId,
      (context) =>
        context.permission?.request.requestId === requestId ? undefined : context.permission,
      sessionStatus
    )
  }

  private async transitionContinuation(
    projectId: string,
    sessionId: string,
    requestId: string,
    expectedState: SessionPermissionRuntimeContext['state'],
    state: SessionPermissionRuntimeContext['state'],
    sessionStatus: 'waiting-permission' | 'running'
  ): Promise<void> {
    if (!this.sessions) return
    await this.patch(
      projectId,
      sessionId,
      (context) => {
        const permission = context.permission
        if (
          !permission ||
          permission.request.requestId !== requestId ||
          permission.state !== expectedState
        ) {
          throw new Error('The restored permission request is stale or no longer pending.')
        }
        return { ...permission, state }
      },
      sessionStatus
    )
  }

  private async patch(
    projectId: string,
    sessionId: string,
    update: (context: SessionRuntimeContext) => SessionPermissionRuntimeContext | undefined,
    sessionStatus: 'waiting-permission' | 'running' | 'idle',
    onCommitted?: () => void,
    beforePersist?: (session: PersistedChatSession) => void
  ): Promise<boolean> {
    if (!this.sessions) return false
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const context = await this.sessions.readSessionRuntimeContext(projectId, sessionId)
      const permission = update(context)
      if (permission === context.permission) return false
      try {
        await this.sessions.patchSessionRuntimeContext({
          projectId,
          sessionId,
          expectedRevision: context.revision,
          patch: { permission },
          sessionStatus: context.networkApprovals?.some(({ state }) => state === 'pending')
            ? 'waiting-permission'
            : sessionStatus,
          ...(beforePersist ? { beforePersist } : {})
        })
        onCommitted?.()
        if (this.publishSessionUpdated) {
          const session = await this.sessions.loadSessionForContinuation(projectId, sessionId)
          await this.publishSessionUpdated(session)
        }
        return true
      } catch (error) {
        if (!isRevisionConflict(error) || attempt === 2) throw error
      }
    }
    return false
  }
}

export { AcpPermissionWaitOwner }
export type {
  PermissionWaitSessions,
  PreparedRestoredPermissionConfirmation,
  PublishPermissionWaitSession,
  RestoredPermissionDecision
}

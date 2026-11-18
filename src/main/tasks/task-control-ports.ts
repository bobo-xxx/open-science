import { createHash } from 'node:crypto'
import type { AcpStateSnapshot } from '../../shared/acp'
import type { ComputeApprovalDecision, ComputeApprovalRequest } from '../../shared/compute'
import { projectAnswerableDelegatedQuestions } from '../../shared/delegated-work-projection'
import {
  projectPersistedSessionWaits,
  type PersistedChatSession
} from '../../shared/session-persistence'
import type {
  TaskConfigurationOptions,
  TaskPendingSessionInteraction,
  TaskSessionRuntimePermission
} from '../../shared/task-api'

type InteractionScope = Readonly<{
  projectId: string
  sessionId: string
  interactionId: string
}>

type ConfirmationRead = Readonly<{ hostId: string; issuedAt: number; signature: string }>
type SignedConfirmation<Decision> = Readonly<{
  challengeId: string
  decision: Decision
  signature: string
}>

type ConfirmationClaim = 'claimed' | 'unavailable' | 'invalid-proof' | 'invalid-decision'
type ConfirmationChallenge = Readonly<{ id: string; expiresAt: number; envelope: string }>

type TaskInteractionScope = Pick<TaskPendingSessionInteraction, 'projectId' | 'sessionId'>
type TaskPendingQuestion = { requestId: string; fieldCount: number }

type TaskControlPorts = {
  specialists: {
    resolve(reference: string): Promise<{ id: string }>
  }
  configuration?: {
    listSpecialists(): Promise<TaskConfigurationOptions['specialists']>
    listComputeHosts(): Promise<TaskConfigurationOptions['computeHosts']>
    runtimePermission(sessionId: string): TaskSessionRuntimePermission | undefined
  }
  trustedCompute?: {
    issue(
      scope: InteractionScope,
      read: ConfirmationRead,
      isCurrent: () => boolean
    ): Promise<ConfirmationChallenge | undefined>
    claim(
      scope: InteractionScope,
      proof: SignedConfirmation<ComputeApprovalDecision>,
      isCurrent: () => boolean
    ): Promise<ConfirmationClaim>
    reset(): void
  }
  listPendingSessionInteractions?(
    scope: TaskInteractionScope
  ): Promise<readonly TaskPendingSessionInteraction[] | undefined>
}

const projectDelegatedTaskQuestions = (session: PersistedChatSession): TaskPendingQuestion[] => {
  const work = session.runtimeContext?.delegatedWork
  return projectAnswerableDelegatedQuestions(session).flatMap((request) => {
    const record = work?.records.find(({ agentFrameId }) => agentFrameId === request.sourceFrameId)
    const attempt = record?.attempts.at(-1)
    const hasSourcePrompt = session.conversationGraph?.messages.some(
      ({ agentFrameId, role }) => agentFrameId === request.sourceFrameId && role === 'user'
    )
    return attempt?.id === request.sourceAttemptId &&
      attempt.runtimeSegmentIds.includes(request.sourceRuntimeSegmentId) &&
      (attempt.executionModel ?? record?.attempts[0]?.executionModel) &&
      hasSourcePrompt
      ? [{ requestId: request.requestId, fieldCount: request.questions.length }]
      : []
  })
}

const taskInteractionId = (
  { projectId, sessionId }: TaskInteractionScope,
  kind: TaskPendingSessionInteraction['kind'],
  ownerId: string
): string =>
  createHash('sha256')
    .update(JSON.stringify(['task-pending-interaction-v1', projectId, sessionId, kind, ownerId]))
    .digest('hex')

// Owner IDs correlate polls and resolve a scoped request. A trusted confirmation uses the complete
// owner disclosure. The public projection excludes the inputs, option labels, commands, provider data and answer fields.
const projectTaskPendingSessionInteractions = (
  { projectId, sessionId }: TaskInteractionScope,
  state: Pick<AcpStateSnapshot, 'pendingPermissions' | 'pendingElicitations'>,
  computeApprovals: ReadonlyArray<Pick<ComputeApprovalRequest, 'id' | 'operation'>>,
  session?: PersistedChatSession
): TaskPendingSessionInteraction[] => {
  const identifier = (
    kind: TaskPendingSessionInteraction['kind'],
    ownerId: string
  ): TaskInteractionScope & { id: string; status: 'pending' } => ({
    id: taskInteractionId({ projectId, sessionId }, kind, ownerId),
    projectId,
    sessionId,
    status: 'pending'
  })
  const entries: TaskPendingSessionInteraction[] = [
    ...state.pendingPermissions
      .filter((request) => request.sessionId === sessionId)
      .map((request) => ({
        ...identifier('permission', request.requestId),
        kind: 'permission' as const,
        isMcp: request.isMcp === true,
        delegated: request.delegated !== undefined
      })),
    ...(state.pendingElicitations ?? [])
      .filter((request) => request.sessionId === sessionId)
      .map((request) => ({
        ...identifier('question', request.requestId),
        kind: 'question' as const,
        fieldCount: request.fields.length
      })),
    ...computeApprovals.map(({ id, operation }) => ({
      ...identifier('compute', id),
      kind: 'compute' as const,
      operation
    }))
  ]
  const pending = new Map(entries.map((entry) => [entry.id, entry]))
  if (
    !session ||
    session.projectId !== projectId ||
    session.id !== sessionId ||
    session.packageOrigin ||
    session.archivedAt !== undefined
  ) {
    return [...pending.values()]
  }

  const addDurable = (entry: TaskPendingSessionInteraction): void => {
    if (!pending.has(entry.id)) pending.set(entry.id, entry)
  }
  const { permission, questions } = projectPersistedSessionWaits(session)
  if (permission) {
    addDurable({
      ...identifier('permission', permission.requestId),
      kind: 'permission',
      isMcp: true,
      delegated: permission.delegated
    })
  }
  for (const { requestId, fieldCount } of [
    ...questions,
    ...projectDelegatedTaskQuestions(session)
  ]) {
    addDurable({ ...identifier('question', requestId), kind: 'question', fieldCount })
  }
  return [...pending.values()]
}

export { projectTaskPendingSessionInteractions, taskInteractionId }
export type {
  ConfirmationChallenge,
  ConfirmationClaim,
  ConfirmationRead,
  InteractionScope,
  SignedConfirmation,
  TaskControlPorts
}

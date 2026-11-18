import { createHash } from 'node:crypto'
import type { AcpStateSnapshot } from '../../shared/acp'
import type { ComputeApprovalRequest } from '../../shared/compute'
import type {
  TaskConfigurationOptions,
  TaskPendingSessionInteraction,
  TaskSessionRuntimePermission
} from '../../shared/task-api'

type TaskInteractionScope = Pick<TaskPendingSessionInteraction, 'projectId' | 'sessionId'>

type TaskControlPorts = {
  specialists: {
    resolve(reference: string): Promise<{ id: string }>
  }
  configuration?: {
    listSpecialists(): Promise<TaskConfigurationOptions['specialists']>
    listComputeHosts(): Promise<TaskConfigurationOptions['computeHosts']>
    runtimePermission(sessionId: string): TaskSessionRuntimePermission | undefined
  }
  listPendingSessionInteractions?(
    scope: TaskInteractionScope
  ): Promise<readonly TaskPendingSessionInteraction[] | undefined>
}

// Owner IDs are used only to correlate polls while an interaction remains pending. The public
// projection excludes the inputs, option labels, commands, provider data and answer fields.
const projectTaskPendingSessionInteractions = (
  { projectId, sessionId }: TaskInteractionScope,
  state: Pick<AcpStateSnapshot, 'pendingPermissions' | 'pendingElicitations'>,
  computeApprovals: ReadonlyArray<Pick<ComputeApprovalRequest, 'id' | 'operation'>>
): TaskPendingSessionInteraction[] => {
  const identifier = (
    kind: TaskPendingSessionInteraction['kind'],
    ownerId: string
  ): TaskInteractionScope & { id: string; status: 'pending' } => ({
    id: createHash('sha256')
      .update(JSON.stringify(['task-pending-interaction-v1', projectId, sessionId, kind, ownerId]))
      .digest('hex'),
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
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()]
}

export { projectTaskPendingSessionInteractions }
export type { TaskControlPorts }

import { createHash } from 'node:crypto'
import { createLogger, diagnosticErrorFields } from '@aipoch/diagnostics/node'
import type { AcpPermissionRequest } from '../../shared/acp'
import { activeSandboxNetworkApprovals } from '../../shared/sandbox-network-approval'
import {
  projectPersistedSessionWaits,
  type PersistedChatSession
} from '../../shared/session-persistence'
import {
  readRestoredElicitationConfirmationAuthority,
  type RestoredElicitationConfirmationAuthority
} from '../acp/durable-continuation-context-owner'
import type { RestoredPermissionConfirmationSource } from '../acp/permission-continuation-workflow'
import type { AcpRuntimeCoordinator } from '../acp/runtime-coordinator'
import type { SessionPersistenceCoordinator } from '../session-persistence/coordinator'
import {
  taskInteractionId,
  type ConfirmationClaim,
  type ConfirmationPermissionDecision,
  type ConfirmationQuestionDecision,
  type InteractionScope
} from '../tasks/task-control-ports'
import { taskAgentResumeRequest, type TaskAgentPort } from '../tasks/task-runner'
import { describeQuestionConfirmationDecision } from '../tasks/trusted-interaction-decisions'

const log = createLogger('trusted-restored-interactions')
const restoredVersionPrefix = 'restored:'

type SessionAdmission = <Result>(
  scope: InteractionScope,
  operation: () => Result | Promise<Result>
) => Promise<Result | undefined>

type RestoredInteractionOptions = {
  sessions: Pick<SessionPersistenceCoordinator, 'readSessionSnapshot'>
  runtime: Pick<
    AcpRuntimeCoordinator,
    | 'isRestoredInteractionUnowned'
    | 'readRestoredPermissionConfirmation'
    | 'claimRestoredPermissionConfirmation'
    | 'claimRestoredElicitation'
    | 'respondToElicitation'
    | 'forgetPreparedElicitationContinuation'
  >
  agent: Pick<TaskAgentPort, 'listAttachedSessionIds' | 'resumeSession'>
  withSessionAvailable: SessionAdmission
}

type RestoredPermissionLocator = { requestId: string; source: RestoredPermissionConfirmationSource }

const permissionLocator = (
  scope: InteractionScope,
  session: PersistedChatSession
): RestoredPermissionLocator | undefined => {
  const matches = ({ requestId }: { requestId: string }): boolean =>
    taskInteractionId(scope, 'permission', requestId) === scope.interactionId
  const wait = projectPersistedSessionWaits(session).permission
  if (wait && !wait.delegated && matches(wait)) {
    return { requestId: wait.requestId, source: 'mcp' }
  }
  const network = activeSandboxNetworkApprovals(session).find(
    (record) => record.state === 'pending' && record.decision === undefined && matches(record)
  )
  return network && { requestId: network.requestId, source: 'sandbox-network' }
}

const questionVersion = (authority: RestoredElicitationConfirmationAuthority): string =>
  restoredVersionPrefix +
  createHash('sha256')
    .update(JSON.stringify(['restored-acp-question-v1', authority]))
    .digest('hex')

const permissionVersion = (source: RestoredPermissionConfirmationSource, version: string): string =>
  restoredVersionPrefix + source + ':' + version

const composeTrustedRestoredInteractions = ({
  sessions,
  runtime,
  agent,
  withSessionAvailable
}: RestoredInteractionOptions): {
  readPermission(scope: InteractionScope): Promise<
    | {
        version: string
        disclosure: AcpPermissionRequest
        allowedDecisions: readonly ConfirmationPermissionDecision[]
      }
    | undefined
  >
  claimPermission(
    scope: InteractionScope,
    version: string,
    decision: ConfirmationPermissionDecision,
    authorizeAtClaim: () => boolean
  ): Promise<ConfirmationClaim>
  readQuestion(scope: InteractionScope): Promise<
    | {
        version: string
        disclosure: RestoredElicitationConfirmationAuthority['request']
        allowedDecisions: readonly ConfirmationQuestionDecision['action'][]
      }
    | undefined
  >
  claimQuestion(
    scope: InteractionScope,
    version: string,
    decision: ConfirmationQuestionDecision,
    authorizeAtClaim: () => boolean
  ): Promise<ConfirmationClaim>
} => {
  const readSession = async (
    scope: InteractionScope
  ): Promise<PersistedChatSession | undefined> => {
    const session = await sessions.readSessionSnapshot(scope.projectId, scope.sessionId, {
      preserveRuntimeState: true
    })
    return session?.projectId === scope.projectId &&
      session.id === scope.sessionId &&
      !session.packageOrigin &&
      session.archivedAt === undefined
      ? session
      : undefined
  }

  const attachSession = async (
    scope: InteractionScope,
    isCurrent: () => boolean
  ): Promise<boolean> =>
    (await withSessionAvailable(scope, async () => {
      if (!isCurrent()) return false
      const session = await readSession(scope)
      if (!session) return false
      if (!(await agent.listAttachedSessionIds()).includes(session.id)) {
        if (!isCurrent()) return false
        await agent.resumeSession(taskAgentResumeRequest(session))
      }
      return true
    })) ?? false

  const readQuestion = async (
    scope: InteractionScope
  ): Promise<RestoredElicitationConfirmationAuthority | undefined> => {
    const session = await readSession(scope)
    if (!session) return undefined
    const question = projectPersistedSessionWaits(session).questions.find(
      ({ requestId }) => taskInteractionId(scope, 'question', requestId) === scope.interactionId
    )
    if (!question || !runtime.isRestoredInteractionUnowned(scope, question.requestId, 'question')) {
      return undefined
    }
    return readRestoredElicitationConfirmationAuthority(session, question.requestId)
  }

  return {
    async readPermission(scope) {
      const session = await readSession(scope)
      const locator = session && permissionLocator(scope, session)
      if (!locator) return undefined
      const { requestId, source } = locator
      const current = await runtime.readRestoredPermissionConfirmation(scope, requestId, source)
      return (
        current && {
          version: permissionVersion(source, current.version),
          disclosure: current.request,
          allowedDecisions: current.allowedDecisions
        }
      )
    },
    async claimPermission(scope, version, decision, authorizeAtClaim) {
      const session = await readSession(scope)
      const locator = session && permissionLocator(scope, session)
      if (!locator) return 'unavailable'
      const { requestId, source } = locator
      const versionPrefix = permissionVersion(source, '')
      if (!version.startsWith(versionPrefix) || !authorizeAtClaim()) return 'unavailable'
      if (source === 'mcp' && !(await attachSession(scope, authorizeAtClaim))) return 'unavailable'
      const result = await withSessionAvailable(scope, () =>
        runtime.claimRestoredPermissionConfirmation(
          scope,
          requestId,
          source,
          version.slice(versionPrefix.length),
          decision,
          authorizeAtClaim
        )
      )
      if (result?.status === 'claimed') {
        void result.completion.catch((error: unknown) =>
          log.warn('restored permission continuation failed', diagnosticErrorFields(error))
        )
      }
      return result?.status ?? 'unavailable'
    },
    async readQuestion(scope) {
      const authority = await readQuestion(scope)
      return (
        authority && {
          version: questionVersion(authority),
          disclosure: authority.request,
          allowedDecisions: ['accept', 'decline', 'cancel']
        }
      )
    },
    async claimQuestion(scope, version, decision, authorizeAtClaim) {
      const authority = await readQuestion(scope)
      if (!authority || questionVersion(authority) !== version || !authorizeAtClaim()) {
        return 'unavailable'
      }
      const requestId = authority.request.requestId
      const [, payload] = describeQuestionConfirmationDecision(decision)
      const result = await withSessionAvailable(scope, () =>
        runtime.claimRestoredElicitation({
          projectId: scope.projectId,
          sessionId: scope.sessionId,
          requestId,
          ...decision,
          authorizeAtClaim: (current, canonical) => {
            if (!authorizeAtClaim() || questionVersion(current) !== version) return 'unavailable'
            return describeQuestionConfirmationDecision(canonical)[1] === payload
              ? 'authorized'
              : 'invalid-decision'
          }
        })
      )
      if (result?.status !== 'claimed') return result?.status ?? 'unavailable'
      void (async () => {
        await result.completion.catch((error: unknown) =>
          log.warn('saved question confirmation could not publish', diagnosticErrorFields(error))
        )
        if (result.decision.action === 'cancel') return
        const response = { requestId, request: result.request, ...result.decision }
        try {
          const attached = await attachSession(scope, () => true)
          if (!attached) return
        } catch (error) {
          await withSessionAvailable(scope, () =>
            runtime.respondToElicitation({
              ...response,
              continuationFailure: (error instanceof Error ? error.message : String(error)).slice(
                0,
                4_000
              )
            })
          )
          throw error
        }
        await withSessionAvailable(scope, () => runtime.respondToElicitation(response))
      })()
        .catch((error: unknown) =>
          log.warn('restored question continuation failed', diagnosticErrorFields(error))
        )
        .finally(() => runtime.forgetPreparedElicitationContinuation(scope.sessionId, requestId))
      return 'claimed'
    }
  }
}

export { composeTrustedRestoredInteractions, restoredVersionPrefix }

import { createHash, randomUUID } from 'node:crypto'
import { currentAttempt, sameSession } from './delegated-work-record-invariants'
import type {
  DelegatedWorkDurableRecords,
  DurableAttempt,
  DurableChild,
  DurableSnapshot
} from './delegated-work-record-types'
import type {
  RootDelegatePermissionConfirmationClaim,
  RootDelegatePermissionConfirmationDecision,
  RootDelegatePermissionConfirmationSnapshot,
  RootDelegatePermissionEvent,
  RootDelegatePermissionLocator,
  RootDelegatePermissionRequest,
  RootDelegatePermissionResponse
} from './durable-delegated-work-contract'
import { DurableDelegatedWorkError } from './durable-delegated-work-error'
import type { DelegateExecutionEvent, RunningDelegateExecution } from './execution-port'

type PermissionExecutionBinding = Readonly<{
  messageBranchId: string
  runtimeSegmentId: string
  promptMessageId: string
}>
type Permission = RootDelegatePermissionRequest &
  Readonly<{
    execution: RunningDelegateExecution
    generation: string
    binding?: PermissionExecutionBinding
  }>
type TakenPermissions = Array<[string, Permission]>
type ActivePermission = Readonly<{
  key: string
  permission: Permission
  child: DurableChild
  attempt: DurableAttempt
}>

class RootDelegatePermissionOwner {
  private readonly permissions = new Map<string, Permission>()

  constructor(
    private readonly records: Pick<DelegatedWorkDurableRecords, 'snapshot'>,
    private readonly onEvent?: (event: RootDelegatePermissionEvent) => void
  ) {}

  observe(
    frameId: string,
    attemptId: string,
    childTitle: string,
    execution: RunningDelegateExecution,
    event: DelegateExecutionEvent,
    binding?: PermissionExecutionBinding
  ): void {
    if (event.kind !== 'permission') return
    const key = this.key(frameId, attemptId, event.requestId)
    if (!event.awaiting) {
      this.delete(key)
      return
    }
    this.set(key, {
      requestId: event.requestId,
      frameId,
      attemptId,
      childTitle,
      action: event.title,
      providerToolName: event.providerToolName,
      isMcp: event.isMcp,
      toolKind: event.toolKind,
      riskScope: this.riskScope(event.options),
      options: event.options.map(({ optionId, name, kind, scope }) => ({
        optionId,
        name,
        kind,
        ...(scope ? { scope } : {})
      })),
      execution,
      generation: randomUUID(),
      ...(binding
        ? {
            binding: {
              messageBranchId: binding.messageBranchId,
              runtimeSegmentId: binding.runtimeSegmentId,
              promptMessageId: binding.promptMessageId
            }
          }
        : {})
    })
  }

  hasAwaiting(frameId: string, attemptId: string): boolean {
    return [...this.permissions.values()].some(
      (permission) => permission.frameId === frameId && permission.attemptId === attemptId
    )
  }

  takeAttempt(frameId: string, attemptId: string): TakenPermissions {
    const prefix = `${frameId}\u0000${attemptId}\u0000`
    const taken = [...this.permissions.entries()].filter(([key]) => key.startsWith(prefix))
    for (const [key] of taken) this.delete(key)
    return taken
  }

  clearAttempt(frameId: string, attemptId: string): void {
    this.takeAttempt(frameId, attemptId)
  }

  restoreAttempt(taken: TakenPermissions): void {
    for (const [key, permission] of taken) {
      if (!this.permissions.has(key)) this.set(key, { ...permission, generation: randomUUID() })
    }
  }

  async requests(
    session: DurableSnapshot['session']
  ): Promise<readonly RootDelegatePermissionRequest[]> {
    const snapshot = await this.records.snapshot()
    if (!sameSession(snapshot.session, session)) return []
    const currentAttempts = new Map(
      snapshot.records.map((child) => [child.frameId, currentAttempt(child)])
    )
    return [...this.permissions.values()]
      .filter((permission) => {
        const child = snapshot.records.find((candidate) => candidate.frameId === permission.frameId)
        const attempt = currentAttempts.get(permission.frameId)
        return (
          child?.originBindingState === 'validated' &&
          snapshot.originMessageIds.includes(child.originMessageId) &&
          attempt?.id === permission.attemptId &&
          attempt.status === 'running'
        )
      })
      .map((permission) => this.request(permission))
  }

  async respond(
    session: DurableSnapshot['session'],
    response: RootDelegatePermissionResponse
  ): Promise<void> {
    const snapshot = await this.records.snapshot()
    const active = this.findActive(snapshot, session, response)
    if (!active) {
      throw new DurableDelegatedWorkError(
        'conflict',
        'permission request is no longer active for the current delegated Attempt'
      )
    }
    await this.deliver(active, response)
  }

  async readPendingConfirmation(
    session: DurableSnapshot['session'],
    locator: RootDelegatePermissionLocator
  ): Promise<RootDelegatePermissionConfirmationSnapshot | undefined> {
    const snapshot = await this.records.snapshot()
    const active = this.findActive(snapshot, session, locator)
    return active && this.confirmation(snapshot, active)
  }

  async claimPendingConfirmation(
    session: DurableSnapshot['session'],
    locator: RootDelegatePermissionLocator,
    version: string,
    decision: RootDelegatePermissionConfirmationDecision,
    authorizeAtClaim: () => boolean
  ): Promise<RootDelegatePermissionConfirmationClaim> {
    const snapshot = await this.records.snapshot()
    const active = this.findActive(snapshot, session, locator)
    if (!active) return { status: 'unavailable' }
    const confirmation = this.confirmation(snapshot, active)
    if (!confirmation || confirmation.version !== version) return { status: 'unavailable' }
    if (!confirmation.allowedDecisions.includes(decision)) return { status: 'invalid-decision' }

    const response: RootDelegatePermissionResponse =
      decision === 'cancel'
        ? { ...locator, cancelled: true }
        : { ...locator, optionId: decision.slice('option:'.length) }
    if (!authorizeAtClaim() || this.permissions.get(active.key) !== active.permission) {
      return { status: 'unavailable' }
    }
    return { status: 'claimed', completion: this.deliver(active, response) }
  }

  private findActive(
    snapshot: DurableSnapshot,
    session: DurableSnapshot['session'],
    locator: RootDelegatePermissionLocator
  ): ActivePermission | undefined {
    const child = sameSession(snapshot.session, session)
      ? snapshot.records.find((candidate) => candidate.frameId === locator.frameId)
      : undefined
    const attempt = child && currentAttempt(child)
    const key = this.key(locator.frameId, locator.attemptId, locator.requestId)
    const permission = this.permissions.get(key)
    if (
      !permission ||
      child?.originBindingState !== 'validated' ||
      !snapshot.originMessageIds.includes(child.originMessageId) ||
      !attempt ||
      attempt.id !== locator.attemptId ||
      attempt.status !== 'running'
    ) {
      return undefined
    }
    return { key, permission, child, attempt }
  }

  private confirmation(
    snapshot: DurableSnapshot,
    { permission, child, attempt }: ActivePermission
  ): RootDelegatePermissionConfirmationSnapshot | undefined {
    const binding = permission.binding
    if (
      !binding ||
      child.parentFrameId !== snapshot.rootFrameId ||
      binding.messageBranchId !== child.messageBranchId ||
      binding.runtimeSegmentId !== attempt.runtimeSegmentIds.at(-1)
    ) {
      return undefined
    }
    const request = this.request(permission)
    const version = createHash('sha256')
      .update(
        JSON.stringify([
          'live-delegated-permission-confirmation-v1',
          snapshot.session.projectId,
          snapshot.session.sessionId,
          snapshot.rootFrameId,
          snapshot.rootBranchId,
          snapshot.rootBranchRevision,
          child.originMessageId,
          child.parentFrameId,
          child.messageBranchId,
          attempt.initiatingTurnMessageId,
          attempt.startedAt,
          attempt.runtimeSegmentIds,
          binding,
          permission.generation,
          request
        ])
      )
      .digest('hex')
    return {
      version,
      request,
      allowedDecisions: [
        ...request.options.map(({ optionId }) => `option:${optionId}` as const),
        'cancel'
      ]
    }
  }

  private async deliver(
    { key, permission }: ActivePermission,
    response: RootDelegatePermissionResponse
  ): Promise<void> {
    this.delete(key)
    try {
      await permission.execution.respondToPermission({
        requestId: response.requestId,
        ...(response.optionId ? { optionId: response.optionId } : {}),
        ...(response.cancelled ? { cancelled: true } : {})
      })
    } catch (error) {
      const latest = (await this.records.snapshot()).records.find(
        (candidate) => candidate.frameId === response.frameId
      )
      if (
        latest &&
        currentAttempt(latest).id === response.attemptId &&
        currentAttempt(latest).status === 'running'
      ) {
        this.restoreAttempt([[key, permission]])
      }
      throw error
    }
  }

  private key(frameId: string, attemptId: string, requestId: string): string {
    return `${frameId}\u0000${attemptId}\u0000${requestId}`
  }

  private request(permission: Permission): RootDelegatePermissionRequest {
    const {
      execution: _execution,
      generation: _generation,
      binding: _binding,
      ...request
    } = permission
    void _execution
    void _generation
    void _binding
    return Object.freeze({
      ...request,
      options: Object.freeze(request.options.map((option) => Object.freeze({ ...option })))
    })
  }

  private publish(kind: RootDelegatePermissionEvent['kind'], permission: Permission): void {
    this.onEvent?.({ kind, request: this.request(permission) })
  }

  private set(key: string, permission: Permission): void {
    const isNew = !this.permissions.has(key)
    this.permissions.set(key, permission)
    if (isNew) this.publish('requested', permission)
  }

  private delete(key: string): Permission | undefined {
    const permission = this.permissions.get(key)
    if (!permission) return undefined
    this.permissions.delete(key)
    this.publish('settled', permission)
    return permission
  }

  private riskScope(
    options: readonly Readonly<{
      kind: string
      scope?: 'once' | 'session' | 'project' | 'global'
    }>[]
  ): string {
    const scopes = new Set(options.map(({ scope }) => scope).filter(Boolean))
    if (scopes.has('global')) return 'Global, project, session, or this call'
    if (scopes.has('project')) return 'This project, this session, or this call'
    if (scopes.has('session')) return 'This session or this call'
    const kinds = new Set(options.map(({ kind }) => kind.toLowerCase()))
    return kinds.has('allow_always') ? 'This session or this call' : 'This call only'
  }
}

export { RootDelegatePermissionOwner }
export type { TakenPermissions }

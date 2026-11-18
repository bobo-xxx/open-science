import {
  requiresNetworkException,
  normalizeNetworkHostname
} from '../../shared/notebook-network-settings'
import type { NetworkApprovalRecordStatus } from '../../shared/sandbox-network-approval'
import { type NetworkDestinationGrant } from '../../shared/network-destination-grants'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { AcpPermissionResponse } from '../../shared/acp'
import {
  activeSandboxNetworkApprovals,
  sandboxNetworkApprovalRequest,
  type SandboxNetworkApproval
} from '../../shared/sandbox-network-approval'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession,
  type SessionRuntimeContext
} from '../../shared/session-persistence'
import type {
  AcpPermissionBroker,
  AppPermissionRequest,
  PermissionConfirmationDecision,
  PermissionConfirmationScope,
  PermissionConfirmationSnapshot,
  SandboxNetworkPermissionBinding
} from './permission-broker'
import type { PermissionWaitSessions, PublishPermissionWaitSession } from './permission-wait-owner'
import { projectPermissionRequest } from './runtime-publication-owner'

const assertSnapshot = (context: SessionRuntimeContext, approval: SandboxNetworkApproval): void => {
  if (!approval.evidence) return
  const current = context.networkApprovals?.find((entry) => entry.requestId === approval.requestId)
  if (!current?.evidence) throw new Error('Network approval changed. Review the current request.')
}

const persistentDecision = (
  decision: string | undefined
): decision is 'always-allow' | 'project-allow' =>
  decision === 'always-allow' || decision === 'project-allow'

type SandboxNetworkConfirmationClaim =
  { status: 'claimed'; completion: Promise<void> } | { status: 'unavailable' | 'invalid-decision' }

type NetworkApprovalPatchFence = {
  beforePersist(session: PersistedChatSession): void
  onCommitted?: () => void
}

type NetworkConfirmationFences = {
  assertPendingContext(context: SessionRuntimeContext): void
  claim: NetworkApprovalPatchFence
  assertContinuing(session: PersistedChatSession, context?: SessionRuntimeContext): void
}

type SandboxNetworkPermissionPort = Pick<
  AcpPermissionBroker,
  'readSandboxNetworkApproval' | 'claimSandboxNetworkApproval'
>

type SendSandboxNetworkPermission = (
  input: AppPermissionRequest,
  binding: SandboxNetworkPermissionBinding
) => Promise<string | undefined>

type LiveSandboxNetworkWait = {
  abort: AbortController
  settled: Promise<void>
  binding: SandboxNetworkPermissionBinding
  approval: SandboxNetworkApproval
  isAdmitted(): boolean
  apply(
    rawOptionId: string | undefined,
    authorization: () => boolean,
    fences?: NetworkConfirmationFences
  ): Promise<void>
}

const confirmationUnavailable = new Error('Network confirmation is no longer available.')

const sameApproval = (
  current: SandboxNetworkApproval | undefined,
  expected: SandboxNetworkApproval
): boolean => isDeepStrictEqual(structuredClone(current), structuredClone(expected))

const scopedActiveApproval = (
  session: PersistedChatSession | undefined,
  { projectId, sessionId }: PermissionConfirmationScope,
  requestId: string,
  context = session?.runtimeContext
): SandboxNetworkApproval | undefined => {
  if (
    !session ||
    session.projectId !== projectId ||
    session.id !== sessionId ||
    session.archivedAt !== undefined ||
    session.packageOrigin
  )
    return undefined
  return activeSandboxNetworkApprovals({
    ...materializeSessionConversationGraph(session),
    runtimeContext: context
  }).find((approval) => approval.requestId === requestId)
}

const projectNetworkConfirmation = (
  approval: SandboxNetworkApproval,
  projectId: string,
  revision: number
): PermissionConfirmationSnapshot => {
  const request = sandboxNetworkApprovalRequest(approval, true)
  return {
    request,
    version: createHash('sha256')
      .update(
        JSON.stringify([
          'restored-sandbox-network-confirmation-v1',
          projectId,
          revision,
          approval,
          request
        ])
      )
      .digest('hex'),
    allowedDecisions: [
      ...request.options.map(({ optionId }) => `option:${optionId}` as const),
      'cancel'
    ]
  }
}

// Owns only destination authority. The provider permission slot and its tool replay stay separate.
export class SandboxNetworkApprovalOwner {
  private readonly exactRequests = new Map<string, Promise<string | undefined>>()
  private readonly admittingRequests = new Set<string>()
  private readonly liveRequests = new Map<string, LiveSandboxNetworkWait>()
  private readonly cancellationStates = new Map<string, { active: boolean }>()
  private readonly globalDecisions = new Map<
    string,
    {
      projectId: string
      sessionId: string
      abort: AbortController
      isCommitted: () => boolean
      done: Promise<void>
      rollbackFailure?: AggregateError
    }
  >()

  constructor(
    private readonly sessions?: PermissionWaitSessions,
    private readonly publish?: PublishPermissionWaitSession,
    _allowDomain?: (
      hostname: string,
      assertCurrent?: () => Promise<void>,
      finalize?: () => Promise<void>
    ) => Promise<unknown>,
    private readonly allowDestination?: (
      grant: NetworkDestinationGrant,
      assertCurrent?: () => Promise<void>,
      finalize?: () => Promise<void>
    ) => Promise<unknown>
  ) {}

  request(
    input: AppPermissionRequest,
    promptMessageId: string | undefined,
    send: SendSandboxNetworkPermission,
    isCurrent: () => boolean = () => !input.signal?.aborted
  ): Promise<string | undefined> {
    const id = input.networkApproval?.evidence?.recordId
    if (!id) return this.requestInternal(input, promptMessageId, send, isCurrent)
    const existing = this.exactRequests.get(id)
    if (existing) return existing
    const result = this.requestInternal(input, promptMessageId, send, isCurrent)
    this.exactRequests.set(id, result)
    void result.finally(() => this.exactRequests.delete(id)).catch(() => {})
    return result
  }

  private async requestInternal(
    input: AppPermissionRequest,
    promptMessageId: string | undefined,
    send: SendSandboxNetworkPermission,
    isCurrent: () => boolean = () => !input.signal?.aborted
  ): Promise<string | undefined> {
    const network = input.networkApproval
    if (!network || !this.sessions || !promptMessageId || input.signal?.aborted) return undefined
    const current = this.cancellationGuard(network.projectId, input.sessionId, isCurrent)
    const session = materializeSessionConversationGraph(
      await this.sessions.loadSessionForContinuation(network.projectId, input.sessionId)
    )
    const graph = session.conversationGraph
    const frame = graph?.frames.find(({ id }) => id === graph.activeFrameId)
    if (!frame) return undefined
    const { projectId, ...destination } = network
    const approval: SandboxNetworkApproval = {
      ...destination,
      version: 1,
      kind: 'sandbox-network',
      state: 'pending',
      requestId: network.evidence?.recordId ?? randomUUID(),
      sessionId: input.sessionId,
      originatingPromptMessageId: promptMessageId,
      agentFrameId: frame.id,
      messageBranchId: frame.activeBranchId,
      createdAt: Date.now()
    }
    const sameDestination = (candidate: SandboxNetworkApproval): boolean =>
      candidate.runtime === network.runtime &&
      candidate.commandFingerprint === network.commandFingerprint &&
      candidate.hostname === network.hostname &&
      candidate.port === network.port &&
      (candidate.protocol ?? 'https') === (network.protocol ?? 'https') &&
      (!network.evidence ? !candidate.evidence : Boolean(candidate.evidence))
    const grant = activeSandboxNetworkApprovals(session).find(
      (candidate) =>
        candidate.state === 'continuing' &&
        candidate.decision === undefined &&
        sameDestination(candidate)
    )
    const previous = activeSandboxNetworkApprovals(session).find(
      (candidate) => candidate.requestId === approval.requestId
    )
    if (
      previous?.decision === 'deny' ||
      activeSandboxNetworkApprovals(session).some(
        (candidate) =>
          candidate.decision === 'deny' &&
          candidate.originatingPromptMessageId === promptMessageId &&
          sameDestination(candidate)
      )
    )
      return 'deny'
    if (grant && grant.executionId === network.executionId && network.evidence)
      return 'retry-required'
    if (grant) {
      await this.patch(
        network.projectId,
        input.sessionId,
        (context) => {
          if (!context.networkApprovals?.some(({ requestId }) => requestId === grant.requestId))
            throw new Error('Network approval was already consumed.')
          return context.networkApprovals.filter(({ requestId }) => requestId !== grant.requestId)
        },
        grant,
        false,
        current
      )
      if (!current() || input.signal?.aborted) return undefined
      if (grant.evidence) input.onNetworkAddressesApproved?.(grant.evidence.addresses)
      return 'allow-once'
    }
    this.admittingRequests.add(approval.requestId)
    try {
      await this.patch(
        network.projectId,
        input.sessionId,
        (context) => {
          if ((context.networkApprovals?.length ?? 0) >= 32)
            throw new Error('Too many pending network approvals.')
          return [
            ...(context.networkApprovals ?? []).filter(
              (entry) => entry.requestId !== approval.requestId
            ),
            approval
          ]
        },
        approval,
        false,
        current
      )
      if (!current() || input.signal?.aborted) {
        await this.patch(network.projectId, input.sessionId, (context) =>
          (context.networkApprovals ?? []).filter(
            ({ requestId }) => requestId !== approval.requestId
          )
        )
        return undefined
      }
    } finally {
      this.admittingRequests.delete(approval.requestId)
    }
    // The durable row exists before the broker exposes its request to any client.
    const request = sandboxNetworkApprovalRequest(approval)
    let admitted = false
    const recoveryAbort = new AbortController()
    const settled = Promise.withResolvers<void>()
    const binding: SandboxNetworkPermissionBinding = Object.freeze({
      scope: Object.freeze({ projectId, sessionId: input.sessionId }),
      requestId: approval.requestId,
      isCurrent: () =>
        current() &&
        !recoveryAbort.signal.aborted &&
        this.liveRequests.get(approval.requestId)?.binding === binding
    })
    const live: LiveSandboxNetworkWait = {
      abort: recoveryAbort,
      settled: settled.promise,
      approval,
      binding,
      isAdmitted: () => admitted,
      apply: (rawOptionId, authorization, fences) =>
        this.applyLiveDecision(input, projectId, approval, rawOptionId, authorization, fences)
    }
    this.liveRequests.set(approval.requestId, live)
    try {
      const selected = await send(
        {
          ...input,
          signal: input.signal
            ? AbortSignal.any([input.signal, recoveryAbort.signal])
            : recoveryAbort.signal,
          onAdmitted: () => {
            input.onAdmitted?.()
            admitted = true
          },
          ...request,
          durable: true,
          ...(approval.evidence
            ? { refreshRequest: () => sandboxNetworkApprovalRequest(approval) }
            : {}),
          beforeRespond: (rawOptionId) => live.apply(rawOptionId, current)
        },
        binding
      )
      return approval.evidence && selected && selected !== 'deny' ? 'retry-required' : selected
    } finally {
      this.liveRequests.delete(approval.requestId)
      settled.resolve()
      if (!admitted) {
        await this.patch(network.projectId, input.sessionId, (context) =>
          (context.networkApprovals ?? []).filter(
            (candidate) =>
              candidate.requestId !== approval.requestId || candidate.state !== 'pending'
          )
        )
      }
    }
  }

  private async applyLiveDecision(
    input: AppPermissionRequest,
    projectId: string,
    approval: SandboxNetworkApproval,
    rawOptionId: string | undefined,
    isCurrent: () => boolean,
    confirmation?: NetworkConfirmationFences
  ): Promise<void> {
    const optionId = rawOptionId?.split('@')[0]
    if (persistentDecision(optionId)) {
      await this.grantGlobal(
        projectId,
        { ...approval, decision: optionId },
        false,
        isCurrent,
        false,
        confirmation
      )
      return
    }
    await this.patch(
      projectId,
      approval.sessionId,
      (context) => {
        confirmation?.assertPendingContext(context)
        if (optionId === 'allow-once') assertSnapshot(context, approval)
        if (
          context.networkApprovals?.some(
            (candidate) =>
              candidate.requestId === approval.requestId && persistentDecision(candidate.decision)
          )
        )
          throw new Error('Network approval was already answered.')
        return (context.networkApprovals ?? []).flatMap((candidate) =>
          candidate.requestId !== approval.requestId
            ? [candidate]
            : optionId === 'allow-once' &&
                !input.signal?.aborted &&
                (approval.evidence !== undefined || input.canResume?.() === false)
              ? [{ ...candidate, state: 'continuing' as const }]
              : approval.evidence
                ? [{ ...candidate, state: 'continuing' as const, decision: 'deny' as const }]
                : []
        )
      },
      optionId === 'allow-once' ? approval : undefined,
      false,
      confirmation ? isCurrent : undefined,
      confirmation?.claim
    )
  }

  async recordStatus(
    projectId: string,
    sessionId: string,
    recordId: string
  ): Promise<NetworkApprovalRecordStatus | undefined> {
    if (!this.sessions) return undefined
    const session = await this.sessions.loadSessionForContinuation(projectId, sessionId)
    if (session.projectId !== projectId || session.id !== sessionId) return undefined
    const record = activeSandboxNetworkApprovals(session).find(
      (entry) => entry.evidence?.recordId === recordId
    )
    if (!record) return undefined
    return {
      status:
        record.decision === 'deny'
          ? 'denied'
          : record.state === 'pending' || persistentDecision(record.decision)
            ? 'pending'
            : 'approved',
      hostname: record.hostname,
      port: record.port,
      protocol: record.protocol ?? 'https',
      scope:
        record.decision === 'project-allow'
          ? 'project'
          : record.decision === 'always-allow'
            ? 'global'
            : 'once'
    }
  }

  private async readLiveWait(
    scope: PermissionConfirmationScope,
    requestId: string,
    permissions: SandboxNetworkPermissionPort
  ): Promise<
    | {
        live: LiveSandboxNetworkWait
        approval: SandboxNetworkApproval
        revision: number
        brokerVersion: string
        snapshot: PermissionConfirmationSnapshot
      }
    | undefined
  > {
    const live = this.liveRequests.get(requestId)
    if (
      !live?.isAdmitted() ||
      live.binding.scope.projectId !== scope.projectId ||
      live.binding.scope.sessionId !== scope.sessionId
    )
      return undefined
    const session = await this.sessions?.readSessionSnapshot?.(scope.projectId, scope.sessionId, {
      preserveRuntimeState: true
    })
    const context = session?.runtimeContext
    const approval = scopedActiveApproval(session, scope, requestId, context)
    if (
      !context ||
      !approval ||
      !sameApproval(approval, live.approval) ||
      !live.binding.isCurrent()
    )
      return undefined
    const published = permissions.readSandboxNetworkApproval(live.binding)
    if (
      !published ||
      !isDeepStrictEqual(
        structuredClone(published.request),
        structuredClone(projectPermissionRequest(sandboxNetworkApprovalRequest(approval)))
      )
    )
      return undefined
    return {
      live,
      approval,
      revision: context.revision,
      brokerVersion: published.version,
      snapshot: {
        ...published,
        version: createHash('sha256')
          .update(
            JSON.stringify([
              'live-sandbox-network-confirmation-v1',
              scope.projectId,
              scope.sessionId,
              context.revision,
              approval,
              published
            ])
          )
          .digest('hex')
      }
    }
  }

  async readLiveConfirmation(
    scope: PermissionConfirmationScope,
    requestId: string,
    permissions: SandboxNetworkPermissionPort
  ): Promise<PermissionConfirmationSnapshot | undefined> {
    return (await this.readLiveWait(scope, requestId, permissions))?.snapshot
  }

  async claimLiveConfirmation(
    scope: PermissionConfirmationScope,
    requestId: string,
    version: string,
    decision: PermissionConfirmationDecision,
    authorizeAtClaim: () => boolean,
    permissions: SandboxNetworkPermissionPort
  ): Promise<SandboxNetworkConfirmationClaim> {
    const pending = await this.readLiveWait(scope, requestId, permissions)
    if (!pending || pending.snapshot.version !== version) return { status: 'unavailable' }
    if (!pending.snapshot.allowedDecisions.includes(decision)) return { status: 'invalid-decision' }
    const rawOptionId = decision === 'cancel' ? undefined : decision.slice('option:'.length)
    const current = (): boolean => pending.live.binding.isCurrent() && authorizeAtClaim()
    return this.acknowledgeConfirmedDecision(
      scope,
      pending,
      rawOptionId,
      current,
      async (fences) => {
        const claim = permissions.claimSandboxNetworkApproval(
          pending.live.binding,
          pending.brokerVersion,
          decision,
          current,
          (selected) => {
            if (selected !== rawOptionId) return Promise.reject(confirmationUnavailable)
            return pending.live.apply(selected, current, fences)
          }
        )
        if (claim.status !== 'claimed') throw confirmationUnavailable
        await claim.completion
      }
    )
  }

  private async readPendingConfirmation(
    scope: PermissionConfirmationScope,
    requestId: string
  ): Promise<
    | {
        approval: SandboxNetworkApproval
        revision: number
        snapshot: PermissionConfirmationSnapshot
      }
    | undefined
  > {
    const current = this.cancellationGuard(scope.projectId, scope.sessionId)
    const session = await this.sessions?.readSessionSnapshot?.(scope.projectId, scope.sessionId, {
      preserveRuntimeState: true
    })
    const context = session?.runtimeContext
    const approval = scopedActiveApproval(session, scope, requestId, context)
    if (
      approval?.state !== 'pending' ||
      approval.decision !== undefined ||
      !context ||
      !current() ||
      this.hasNativeWait(requestId) ||
      this.globalDecisions.has(requestId)
    )
      return undefined
    return {
      approval,
      revision: context.revision,
      snapshot: projectNetworkConfirmation(approval, scope.projectId, context.revision)
    }
  }

  async readRestoredConfirmation(
    scope: PermissionConfirmationScope,
    requestId: string
  ): Promise<PermissionConfirmationSnapshot | undefined> {
    return (await this.readPendingConfirmation(scope, requestId))?.snapshot
  }

  async claimRestoredConfirmation(
    scope: PermissionConfirmationScope,
    requestId: string,
    version: string,
    decision: PermissionConfirmationDecision,
    authorizeAtClaim: () => boolean
  ): Promise<SandboxNetworkConfirmationClaim> {
    const { projectId, sessionId } = scope
    const isCurrent = this.cancellationGuard(projectId, sessionId, authorizeAtClaim)
    const pending = await this.readPendingConfirmation(scope, requestId)
    if (!pending || pending.snapshot.version !== version || !isCurrent())
      return { status: 'unavailable' }
    if (!pending.snapshot.allowedDecisions.includes(decision)) return { status: 'invalid-decision' }
    const rawOptionId = decision === 'cancel' ? undefined : decision.slice('option:'.length)
    const current = (): boolean => isCurrent() && !this.hasNativeWait(requestId)
    return this.acknowledgeConfirmedDecision(scope, pending, rawOptionId, current, (fences) =>
      this.applyRestoredDecision(
        projectId,
        pending.approval,
        rawOptionId?.split('@')[0],
        current,
        fences
      )
    )
  }

  private async acknowledgeConfirmedDecision(
    scope: PermissionConfirmationScope,
    { approval, revision }: { approval: SandboxNetworkApproval; revision: number },
    rawOptionId: string | undefined,
    isCurrent: () => boolean,
    begin: (fences: NetworkConfirmationFences) => Promise<void>
  ): Promise<SandboxNetworkConfirmationClaim> {
    const { requestId } = approval
    const optionId = rawOptionId?.split('@')[0]
    const claim = Promise.withResolvers<SandboxNetworkConfirmationClaim>()
    let acknowledged = false
    const completion = begin({
      assertPendingContext: (context) => {
        const current = context.networkApprovals?.find(
          (candidate) => candidate.requestId === requestId
        )
        if (context.revision !== revision || !sameApproval(current, approval))
          throw confirmationUnavailable
      },
      claim: {
        beforePersist: (session) => {
          const current = scopedActiveApproval(session, scope, requestId)
          if (!isCurrent() || !sameApproval(current, approval)) throw confirmationUnavailable
        },
        onCommitted: () => {
          acknowledged = true
          claim.resolve({ status: 'claimed', completion })
        }
      },
      assertContinuing: (session, context) => {
        const current = scopedActiveApproval(session, scope, requestId, context)
        if (
          !isCurrent() ||
          !persistentDecision(optionId) ||
          !sameApproval(current, { ...approval, state: 'continuing', decision: optionId })
        )
          throw confirmationUnavailable
      }
    })
    void completion.then(
      () => {
        if (!acknowledged) claim.resolve({ status: 'unavailable' })
      },
      (error: unknown) => {
        if (acknowledged) return
        if (error === confirmationUnavailable) claim.resolve({ status: 'unavailable' })
        else claim.reject(error)
      }
    )
    return claim.promise
  }

  private hasNativeWait(requestId: string): boolean {
    return this.admittingRequests.has(requestId) || this.liveRequests.has(requestId)
  }

  async respondRestored(response: AcpPermissionResponse, projectId: string): Promise<boolean> {
    if (!this.sessions || !response.restored || response.restored.projectId !== projectId)
      return false
    const isCurrent = this.cancellationGuard(
      projectId,
      response.restored.sessionId,
      () => !this.hasNativeWait(response.requestId)
    )
    const session = await this.sessions.loadSessionForContinuation(
      projectId,
      response.restored.sessionId
    )
    const approval = session.runtimeContext?.networkApprovals?.find(
      ({ requestId }) => requestId === response.requestId
    )
    if (!approval) return false
    if (approval.state !== 'pending' || this.hasNativeWait(response.requestId))
      throw new Error('Network approval is live or was already answered.')
    const rawOptionId = response.cancelled ? undefined : response.optionId
    const optionId = rawOptionId?.split('@')[0]
    if (
      optionId &&
      !sandboxNetworkApprovalRequest(approval).options.some(
        (option) => option.optionId === rawOptionId
      )
    )
      throw new Error('Invalid network approval option.')
    await this.applyRestoredDecision(projectId, approval, optionId, isCurrent)
    return true
  }

  private async applyRestoredDecision(
    projectId: string,
    approval: SandboxNetworkApproval,
    optionId: string | undefined,
    isCurrent: () => boolean,
    confirmation?: NetworkConfirmationFences
  ): Promise<void> {
    if (persistentDecision(optionId)) {
      await this.grantGlobal(
        projectId,
        {
          ...approval,
          ...(optionId === 'project-allow' ? { decision: 'project-allow' as const } : {})
        },
        true,
        isCurrent,
        false,
        confirmation
      )
      return
    }
    await this.patch(
      projectId,
      approval.sessionId,
      (context) => {
        confirmation?.assertPendingContext(context)
        assertSnapshot(context, approval)
        const current = context.networkApprovals?.find(
          ({ requestId }) => requestId === approval.requestId
        )
        if (current?.state !== 'pending') throw new Error('Network approval was already answered.')
        return (context.networkApprovals ?? []).flatMap((candidate) =>
          candidate.requestId !== approval.requestId
            ? [candidate]
            : optionId === 'allow-once'
              ? [{ ...candidate, state: 'continuing' as const }]
              : approval.evidence
                ? [{ ...candidate, state: 'continuing' as const, decision: 'deny' as const }]
                : []
        )
      },
      optionId === 'allow-once' ? approval : undefined,
      true,
      isCurrent,
      confirmation?.claim
    )
  }

  // Called by host Session hydration, without creating a provider connection or replaying a tool.
  async recoverSession(session: PersistedChatSession): Promise<PersistedChatSession> {
    if (!this.sessions) return session
    const obsolete = (approval: SandboxNetworkApproval): boolean =>
      !requiresNetworkException(
        normalizeNetworkHostname(approval.hostname) ?? approval.hostname,
        approval.protocol
      ) &&
      !this.liveRequests.has(approval.requestId) &&
      !this.globalDecisions.has(approval.requestId)
    if (session.runtimeContext?.networkApprovals?.some(obsolete)) {
      // Recovery removes obsolete waits without claiming an execution is running.
      await this.patch(
        session.projectId,
        session.id,
        (context) => (context.networkApprovals ?? []).filter((approval) => !obsolete(approval)),
        undefined,
        true
      )
    }
    const context = await this.sessions.readSessionRuntimeContext(session.projectId, session.id)
    for (const approval of context.networkApprovals ?? []) {
      if (approval.state !== 'continuing' || !persistentDecision(approval.decision)) continue
      const live = this.globalDecisions.get(approval.requestId)
      if (live && !live.rollbackFailure) {
        // Never take over a live choice. Concurrent recovery readers may join an already saved one.
        if (live.isCommitted()) await live.done
        continue
      }
      await this.grantGlobal(session.projectId, approval, true, () => true, true)
      const request = this.liveRequests.get(approval.requestId)
      if (request) {
        // A failed live Settings rollback may have left its broker wait pending. Recovery only
        // finishes authorization: settle that old operation through the broker's existing abort
        // path, which publishes settlement and requires an explicit command retry.
        request.abort.abort()
        await request.settled
      }
    }
    return this.sessions.loadSessionForContinuation(session.projectId, session.id)
  }

  async cancel(projectId: string, sessionId: string): Promise<void> {
    if (!this.sessions) return
    const cancellation = { active: true }
    this.cancellationStates.set(JSON.stringify([projectId, sessionId]), cancellation)
    try {
      const decisions = [...this.globalDecisions.values()].filter(
        (decision) => decision.projectId === projectId && decision.sessionId === sessionId
      )
      for (const decision of decisions) {
        if (!decision.isCommitted()) decision.abort.abort()
      }
      // Settings owns a serialized write/rollback transaction. Do not finish cancellation while
      // a revoked decision can still persist or hot-apply authority.
      const results = await Promise.allSettled(decisions.map(({ done }) => done))
      for (const result of results) {
        // A rejected decision normally means revocation succeeded. Failed Settings rollback is
        // different: preserve its durable row and surface the failure instead of claiming a Stop.
        if (result.status === 'rejected' && result.reason instanceof AggregateError)
          throw result.reason
      }
      let context = await this.sessions.readSessionRuntimeContext(projectId, sessionId)
      if (!context.networkApprovals?.length) return
      if (context.networkApprovals.some((approval) => persistentDecision(approval.decision))) {
        // A decision saved by a prior process is already consent, not an unanswered request.
        await this.recoverSession(
          await this.sessions.loadSessionForContinuation(projectId, sessionId)
        )
        context = await this.sessions.readSessionRuntimeContext(projectId, sessionId)
        if (!context.networkApprovals?.length) return
      }
      await this.patch(projectId, sessionId, () => [], undefined, true)
    } finally {
      cancellation.active = false
    }
  }

  private cancellationGuard(
    projectId: string,
    sessionId: string,
    isCurrent: () => boolean = () => true
  ): () => boolean {
    const key = JSON.stringify([projectId, sessionId])
    const generation = this.cancellationStates.get(key)
    const admitted = !generation?.active
    return () => admitted && this.cancellationStates.get(key) === generation && isCurrent()
  }

  private assertBound(session: PersistedChatSession, approval: SandboxNetworkApproval): void {
    if (
      !activeSandboxNetworkApprovals({
        ...materializeSessionConversationGraph(session),
        runtimeContext: { networkApprovals: [approval] }
      }).length
    )
      throw new Error('Network approval is not on the active Message Branch.')
  }

  private grantGlobal(
    projectId: string,
    approval: SandboxNetworkApproval,
    restored = false,
    isCurrent: () => boolean = () => true,
    recovering = false,
    confirmation?: NetworkConfirmationFences
  ): Promise<void> {
    const previous = this.globalDecisions.get(approval.requestId)
    if (previous && !previous.rollbackFailure)
      return Promise.reject(
        confirmation
          ? confirmationUnavailable
          : new Error('Network approval is already being saved.')
      )
    const abort = new AbortController()
    let committed = recovering
    let rollbackFailure: AggregateError | undefined
    const done = this.commitGlobal(
      projectId,
      approval,
      restored,
      () => !abort.signal.aborted && isCurrent(),
      () => {
        committed = true
      },
      recovering,
      confirmation
    )
      .catch((error: unknown) => {
        if (error instanceof AggregateError) rollbackFailure = error
        throw error
      })
      .finally(() => {
        const decision = this.globalDecisions.get(approval.requestId)
        if (decision?.done !== done) return
        // A repeated Stop must not erase evidence of an unsuccessful rollback. Session hydration
        // can retry the saved Global decision and reconcile both durable stores.
        if (rollbackFailure) decision.rollbackFailure = rollbackFailure
        else this.globalDecisions.delete(approval.requestId)
      })
    this.globalDecisions.set(approval.requestId, {
      projectId,
      sessionId: approval.sessionId,
      abort,
      isCommitted: () => committed,
      done
    })
    return done
  }

  private async commitGlobal(
    projectId: string,
    approval: SandboxNetworkApproval,
    restored: boolean,
    isCurrent: () => boolean,
    markCommitted: () => void,
    recovering: boolean,
    confirmation?: NetworkConfirmationFences
  ): Promise<void> {
    const decision = approval.decision === 'project-allow' ? 'project-allow' : 'always-allow'
    const persist = (
      assertCurrent: () => Promise<void>,
      finalize: () => Promise<void>
    ): Promise<unknown> => {
      if (!this.allowDestination) throw new Error('Network settings are unavailable.')
      return this.allowDestination(
        {
          id: approval.requestId,
          hostname: approval.hostname,
          port: approval.port,
          protocol: approval.protocol ?? 'https',
          approvedAddresses: approval.evidence?.addresses ?? [],
          scope: decision === 'project-allow' ? 'project' : 'global',
          projectId,
          sessionId: approval.sessionId,
          recordId: approval.evidence?.recordId ?? approval.requestId,
          createdAt: approval.createdAt
        },
        assertCurrent,
        finalize
      )
    }
    // A recovery resumes saved consent; a live response first claims an unanswered request.
    if (!recovering)
      await this.patch(
        projectId,
        approval.sessionId,
        (context) => {
          confirmation?.assertPendingContext(context)
          assertSnapshot(context, approval)
          const current = context.networkApprovals?.find(
            ({ requestId }) => requestId === approval.requestId
          )
          if (current?.state !== 'pending')
            throw new Error('Network approval is no longer pending.')
          return context.networkApprovals!.map((candidate) =>
            candidate.requestId === approval.requestId
              ? { ...candidate, state: 'continuing' as const, decision }
              : candidate
          )
        },
        approval,
        restored,
        isCurrent,
        confirmation?.claim
      )
    const alreadySettled = new Error('Saved network approval was already settled.')
    let authorityValidated = !recovering
    let confirmationRemovedRow = false
    const matchesContinuingConfirmation = (candidate: SandboxNetworkApproval): boolean =>
      sameApproval(candidate, { ...approval, state: 'continuing', decision })
    try {
      await persist(
        async () => {
          if (!isCurrent()) throw new Error('Network approval execution is no longer current.')
          const session = await this.sessions!.loadSessionForContinuation(
            projectId,
            approval.sessionId
          )
          // The raw durable decision is authoritative, including after process loss.
          const context = await this.sessions!.readSessionRuntimeContext(
            projectId,
            approval.sessionId
          )
          const current = context.networkApprovals?.find(
            ({ requestId }) => requestId === approval.requestId
          )
          if (current?.state !== 'continuing' || !persistentDecision(current.decision)) {
            // A catalog snapshot may outlive another reader's completed transaction. The Settings
            // owner runs this first guard before writing; never resurrect that settled decision.
            if (!authorityValidated) throw alreadySettled
            throw new Error('Network approval is no longer current.')
          }
          if (!isCurrent()) throw new Error('Network approval is no longer current.')
          authorityValidated = true
          if (!recovering) this.assertBound(session, approval)
          confirmation?.assertContinuing(session, context)
        },
        async () => {
          await this.patch(
            projectId,
            approval.sessionId,
            (context) =>
              (context.networkApprovals ?? []).filter(
                ({ requestId }) => requestId !== approval.requestId
              ),
            recovering ? undefined : approval,
            recovering ? 'preserve' : restored,
            isCurrent,
            confirmation && {
              beforePersist: (session) => confirmation.assertContinuing(session),
              onCommitted: () => {
                confirmationRemovedRow = true
              }
            }
          )
          if (!isCurrent()) throw new Error('Network approval execution is no longer current.')
          // This synchronous fence is the commit point. Later Stop preserves completed consent.
          markCommitted()
        }
      )
    } catch (error) {
      if (error === alreadySettled) return
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'network-grant-revoked'
      ) {
        await this.patch(
          projectId,
          approval.sessionId,
          (context) =>
            (context.networkApprovals ?? []).filter(
              (entry) =>
                entry.requestId !== approval.requestId ||
                (confirmation !== undefined && !matchesContinuingConfirmation(entry))
            ),
          undefined,
          true
        )
        return
      }
      try {
        await this.patch(
          projectId,
          approval.sessionId,
          (context) => {
            const { decision: _previousDecision, ...retryableApproval } = approval
            void _previousDecision
            const retry: SandboxNetworkApproval =
              recovering || error instanceof AggregateError
                ? { ...approval, state: 'continuing', decision }
                : { ...retryableApproval, state: 'pending' }
            const approvals = context.networkApprovals ?? []
            if (!approvals.some(({ requestId }) => requestId === approval.requestId)) {
              if (confirmation && !confirmationRemovedRow) return approvals
              if (approvals.length >= 32) throw new Error('Too many pending network approvals.')
              return [...approvals, retry]
            }
            return approvals.map((candidate) => {
              if (
                candidate.requestId !== approval.requestId ||
                !persistentDecision(candidate.decision) ||
                (confirmation !== undefined && !matchesContinuingConfirmation(candidate))
              )
                return candidate
              return retry
            })
          },
          undefined,
          recovering ? 'preserve' : restored
        )
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], 'Could not restore the network approval.')
      }
      throw error
    }
  }

  private async patch(
    projectId: string,
    sessionId: string,
    update: (context: SessionRuntimeContext) => readonly SandboxNetworkApproval[],
    authority?: SandboxNetworkApproval,
    restored: boolean | 'preserve' = false,
    isCurrent?: () => boolean,
    confirmation?: NetworkApprovalPatchFence
  ): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const context = await this.sessions!.readSessionRuntimeContext(projectId, sessionId)
      const next = update(context)
      try {
        await this.sessions!.patchSessionRuntimeContext({
          projectId,
          sessionId,
          expectedRevision: context.revision,
          patch: { networkApprovals: next.length ? next : undefined },
          sessionStatus:
            restored === 'preserve'
              ? undefined
              : next.some(({ state }) => state === 'pending') ||
                  context.permission?.state === 'pending'
                ? 'waiting-permission'
                : restored
                  ? 'idle'
                  : 'running',
          ...(authority || confirmation || isCurrent
            ? {
                beforePersist: (session: PersistedChatSession) => {
                  confirmation?.beforePersist(session)
                  if (isCurrent?.() === false) {
                    throw confirmation
                      ? confirmationUnavailable
                      : new Error('Network approval execution is no longer current.')
                  }
                  if (authority) this.assertBound(session, authority)
                }
              }
            : {})
        })
        confirmation?.onCommitted?.()
        await this.publish?.(await this.sessions!.loadSessionForContinuation(projectId, sessionId))
        return
      } catch (error) {
        if (
          !(
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'revision-conflict'
          ) ||
          attempt === 4
        )
          throw error
      }
    }
  }
}

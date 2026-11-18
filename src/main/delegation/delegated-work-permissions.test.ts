import { describe, expect, it, vi, type Mock } from 'vitest'
import { RootDelegatePermissionOwner } from './delegated-work-permissions'
import type { DurableSnapshot } from './delegated-work-record-types'
import type { RootDelegatePermissionEvent } from './durable-delegated-work-contract'
import type { DelegateExecutionEvent, RunningDelegateExecution } from './execution-port'

const session = { projectId: 'project', sessionId: 'session' }
const locator = { frameId: 'child-frame', attemptId: 'attempt-1', requestId: 'permission-1' }
const event: Extract<DelegateExecutionEvent, { kind: 'permission'; awaiting: true }> = {
  kind: 'permission',
  awaiting: true,
  requestId: locator.requestId,
  title: 'Read sample metadata',
  providerToolName: 'get_samples',
  isMcp: true,
  options: [
    { optionId: 'cancel', name: 'Allow once', kind: 'allow_once', scope: 'once' },
    { optionId: 'session-id', name: 'This session', kind: 'allow_always', scope: 'session' },
    { optionId: 'project-id', name: 'This project', kind: 'allow_always', scope: 'project' },
    { optionId: 'global-id', name: 'Every project', kind: 'allow_always', scope: 'global' },
    { optionId: 'reject-id', name: 'Deny', kind: 'reject_once' }
  ]
}

const fixture = (): {
  owner: RootDelegatePermissionOwner
  state: { snapshot: DurableSnapshot }
  snapshot: Mock<() => Promise<DurableSnapshot>>
  changed: Mock<(event: RootDelegatePermissionEvent) => void>
  respond: Mock<RunningDelegateExecution['respondToPermission']>
  observe(event: DelegateExecutionEvent): void
} => {
  const state: { snapshot: DurableSnapshot } = {
    snapshot: {
      session,
      rootFrameId: 'root-frame',
      rootBranchId: 'root-branch',
      rootBranchRevision: 'root-branch:1',
      originMessageIds: ['root-prompt'],
      records: [
        {
          frameId: locator.frameId,
          parentFrameId: 'root-frame',
          originMessageId: 'root-prompt',
          originBindingState: 'validated',
          title: 'Sample analyst',
          task: 'Inspect samples',
          inputs: [],
          messageBranchId: 'child-branch',
          attempts: [
            {
              id: locator.attemptId,
              status: 'running',
              resolvedAgent: { kind: 'main' },
              runtimeSegmentIds: ['segment-1'],
              initiatingTurnMessageId: 'root-prompt',
              startedAt: 1
            }
          ]
        }
      ],
      messages: [],
      messageCommands: [],
      questionRequests: []
    }
  }
  const snapshot = vi.fn(async () => state.snapshot)
  const changed = vi.fn<(event: RootDelegatePermissionEvent) => void>()
  const respond = vi
    .fn<RunningDelegateExecution['respondToPermission']>()
    .mockResolvedValue(undefined)
  const execution: RunningDelegateExecution = {
    accepted: Promise.resolve('provider_prompt_accepted'),
    completion: Promise.resolve({ status: 'completed', response: 'done' }),
    subscribe: () => () => undefined,
    sendMessage: async () => 'provider_prompt_accepted',
    setPermissionProfile: async () => undefined,
    respondToPermission: respond,
    cancel: async () => undefined
  }
  const owner = new RootDelegatePermissionOwner({ snapshot }, changed)
  const observe = (update: DelegateExecutionEvent): void =>
    owner.observe(locator.frameId, locator.attemptId, 'Sample analyst', execution, update, {
      messageBranchId: 'child-branch',
      runtimeSegmentId: 'segment-1',
      promptMessageId: 'child-prompt'
    })
  observe(event)
  return { owner, state, snapshot, changed, respond, observe }
}

describe('delegated permission confirmation', () => {
  it('reads exact native choices and claims separately from provider delivery', async () => {
    const { owner, changed, respond } = fixture()
    const read = (await owner.readPendingConfirmation(session, locator))!
    expect(read.request).toMatchObject({
      ...locator,
      action: event.title,
      childTitle: 'Sample analyst',
      providerToolName: event.providerToolName,
      riskScope: 'Global, project, session, or this call',
      options: event.options
    })
    expect(read.allowedDecisions).toEqual([
      'option:cancel',
      'option:session-id',
      'option:project-id',
      'option:global-id',
      'option:reject-id',
      'cancel'
    ])
    const delivered = Promise.withResolvers<void>()
    let authorized = false
    const authorizeAtClaim = vi.fn(() => {
      authorized = true
      return true
    })
    respond.mockImplementationOnce(() => {
      expect(authorized).toBe(true)
      return delivered.promise
    })
    const claim = await owner.claimPendingConfirmation(
      session,
      locator,
      read.version,
      'option:cancel',
      authorizeAtClaim
    )
    if (claim.status !== 'claimed') throw new Error('Expected an accepted permission decision.')
    expect(authorizeAtClaim).toHaveBeenCalledOnce()
    expect(respond).toHaveBeenCalledExactlyOnceWith({
      requestId: locator.requestId,
      optionId: 'cancel'
    })
    expect(changed.mock.calls.map(([entry]) => entry.kind)).toEqual(['requested', 'settled'])
    await expect(owner.readPendingConfirmation(session, locator)).resolves.toBeUndefined()
    await expect(
      owner.respond(session, { ...locator, optionId: 'reject-id' })
    ).rejects.toMatchObject({ code: 'conflict' })
    delivered.resolve()
    await expect(claim.completion).resolves.toBeUndefined()
  })

  it('checks authorization after waiting for the active Attempt snapshot', async () => {
    const { owner, state, snapshot, respond } = fixture()
    const read = (await owner.readPendingConfirmation(session, locator))!
    const loaded = Promise.withResolvers<DurableSnapshot>()
    snapshot.mockReturnValueOnce(loaded.promise)
    const authorize = vi.fn(() => false)
    const pending = owner.claimPendingConfirmation(
      session,
      locator,
      read.version,
      'option:global-id',
      authorize
    )
    expect(authorize).not.toHaveBeenCalled()
    loaded.resolve(state.snapshot)
    await expect(pending).resolves.toEqual({ status: 'unavailable' })
    expect(authorize).toHaveBeenCalledOnce()
    expect(respond).not.toHaveBeenCalled()
    await expect(owner.readPendingConfirmation(session, locator)).resolves.toEqual(read)
  })

  it('lets a native response win while the signed claim is loading Session authority', async () => {
    const { owner, state, snapshot, respond } = fixture()
    const read = (await owner.readPendingConfirmation(session, locator))!
    const loaded = Promise.withResolvers<DurableSnapshot>()
    snapshot.mockReturnValueOnce(loaded.promise)
    const authorize = vi.fn(() => true)
    const pending = owner.claimPendingConfirmation(
      session,
      locator,
      read.version,
      'option:global-id',
      authorize
    )
    await owner.respond(session, { ...locator, optionId: 'reject-id' })
    loaded.resolve(state.snapshot)
    await expect(pending).resolves.toEqual({ status: 'unavailable' })
    expect(authorize).not.toHaveBeenCalled()
    expect(respond).toHaveBeenCalledExactlyOnceWith({
      requestId: locator.requestId,
      optionId: 'reject-id'
    })
  })

  it('rejects a replaced request, changed branch and invalid scope without consuming the native wait', async () => {
    const { owner, state, respond, observe } = fixture()
    const first = (await owner.readPendingConfirmation(session, locator))!
    const allowed = vi.fn(() => true)
    observe({ ...event, title: 'Read updated sample metadata' })
    const updated = (await owner.readPendingConfirmation(session, locator))!
    expect(updated.request.action).not.toBe(first.request.action)
    await expect(
      owner.claimPendingConfirmation(session, locator, first.version, 'option:global-id', allowed)
    ).resolves.toEqual({ status: 'unavailable' })

    state.snapshot = {
      ...state.snapshot,
      rootBranchId: 'new-branch',
      rootBranchRevision: 'new-branch:2'
    }
    await expect(
      owner.claimPendingConfirmation(session, locator, updated.version, 'option:global-id', allowed)
    ).resolves.toEqual({ status: 'unavailable' })
    const current = (await owner.readPendingConfirmation(session, locator))!
    await expect(
      owner.claimPendingConfirmation(session, locator, current.version, 'option:unoffered', allowed)
    ).resolves.toEqual({ status: 'invalid-decision' })
    await expect(
      owner.readPendingConfirmation({ ...session, projectId: 'other' }, locator)
    ).resolves.toBeUndefined()
    expect(allowed).not.toHaveBeenCalled()
    expect(respond).not.toHaveBeenCalled()
    await owner.respond(session, { ...locator, optionId: 'reject-id' })
    await expect(
      owner.claimPendingConfirmation(session, locator, current.version, 'cancel', allowed)
    ).resolves.toEqual({ status: 'unavailable' })
  })

  it('reopens a failed provider delivery under a new version and keeps cancellation distinct', async () => {
    const { owner, respond } = fixture()
    const first = (await owner.readPendingConfirmation(session, locator))!
    respond.mockRejectedValueOnce(new Error('provider temporarily unavailable'))
    const failed = await owner.claimPendingConfirmation(
      session,
      locator,
      first.version,
      'option:global-id',
      () => true
    )
    if (failed.status !== 'claimed') throw new Error('Expected a claim before provider failure.')
    await expect(failed.completion).rejects.toThrow('provider temporarily unavailable')
    const next = (await owner.readPendingConfirmation(session, locator))!
    expect(next.request).toEqual(first.request)
    expect(next.version).not.toBe(first.version)
    await expect(
      owner.claimPendingConfirmation(
        session,
        locator,
        first.version,
        'option:global-id',
        () => true
      )
    ).resolves.toEqual({ status: 'unavailable' })
    const cancelled = await owner.claimPendingConfirmation(
      session,
      locator,
      next.version,
      'cancel',
      () => true
    )
    if (cancelled.status !== 'claimed')
      throw new Error('Expected the new version to allow cancellation.')
    await cancelled.completion
    expect(respond).toHaveBeenLastCalledWith({ requestId: locator.requestId, cancelled: true })
  })

  it('requires the emitting child branch and Runtime Segment to remain current', async () => {
    const { owner, state, respond } = fixture()
    const approval = (await owner.readPendingConfirmation(session, locator))!
    const initial = state.snapshot
    const [child] = initial.records
    const [attempt] = child.attempts
    const authorizeAtClaim = vi.fn(() => true)
    for (const changed of [
      { ...child, messageBranchId: 'child-branch-2' },
      { ...child, attempts: [{ ...attempt, runtimeSegmentIds: ['segment-1', 'segment-2'] }] },
      { ...child, attempts: [{ ...attempt, id: 'attempt-2' }] }
    ]) {
      state.snapshot = { ...initial, records: [changed] }
      await expect(owner.readPendingConfirmation(session, locator)).resolves.toBeUndefined()
      await expect(
        owner.claimPendingConfirmation(
          session,
          locator,
          approval.version,
          'option:cancel',
          authorizeAtClaim
        )
      ).resolves.toEqual({ status: 'unavailable' })
    }
    expect(authorizeAtClaim).not.toHaveBeenCalled()
    expect(respond).not.toHaveBeenCalled()
  })
})

import { describe, expect, it, vi } from 'vitest'

import {
  materializeSessionConversationGraph,
  type PersistedChatSession,
  type SessionRuntimeContext
} from '../../shared/session-persistence'
import { resolveActiveConversationMessages } from '../../shared/conversation-graph'
import { opencodeTransportProviderId } from '../agent-framework/opencode'
import type {
  DurablePermissionWaitCandidate,
  RestoredPermissionContinuation
} from './permission-broker'
import { AcpPermissionWaitOwner, type PermissionWaitSessions } from './permission-wait-owner'

const createCandidate = (): DurablePermissionWaitCandidate => ({
  request: {
    requestId: 'permission-1',
    sessionId: 'session-1',
    toolCallId: 'tool-1',
    title: 'Run npm test',
    providerToolName: 'Bash',
    rawInput: { command: 'npm test' },
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once', scope: 'once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
    ]
  },
  projectId: 'project-1',
  promptMessageId: 'prompt-1',
  fingerprint: 'a'.repeat(64),
  categoryKey: 'shell:npm-test',
  capability: { kind: 'execution', key: 'shell:npm-test' }
})

const continuationFor = (candidate = createCandidate()): RestoredPermissionContinuation => ({
  projectId: candidate.projectId!,
  sessionId: candidate.request.sessionId,
  requestId: candidate.request.requestId,
  promptMessageId: candidate.promptMessageId!,
  fingerprint: candidate.fingerprint,
  interactionSequence: 7,
  agentFrameId: 'root-frame-session-1',
  messageBranchId: 'message-branch-session-1',
  isCurrent: () => true,
  released: true,
  handoffStarted: true,
  handedOff: false
})

const successorFor = (
  continuation: RestoredPermissionContinuation
): DurablePermissionWaitCandidate => {
  const candidate = createCandidate()
  return {
    ...candidate,
    request: { ...candidate.request, requestId: 'permission-2', toolCallId: 'tool-2' },
    fingerprint: 'b'.repeat(64),
    restoredContinuation: continuation
  }
}

const createSessions = (
  containsMessage = true
): {
  sessions: PermissionWaitSessions
  context: () => SessionRuntimeContext
  session: () => PersistedChatSession
  patches: ReturnType<typeof vi.fn<PermissionWaitSessions['patchSessionRuntimeContext']>>
} => {
  let context: SessionRuntimeContext = { version: 1, revision: 0 }
  const session: PersistedChatSession = {
    id: 'session-1',
    projectId: 'project-1',
    title: 'Permission wait',
    cwd: '/workspace',
    status: 'idle',
    messages: [
      {
        id: 'prompt-1',
        role: 'user',
        content: 'Run npm test',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      }
    ],
    createdAt: 1,
    updatedAt: 1
  }
  const patches = vi.fn<PermissionWaitSessions['patchSessionRuntimeContext']>(async (command) => {
    await command.beforePersist?.(structuredClone(session))
    context = {
      ...context,
      ...command.patch,
      revision: context.revision + 1
    }
    session.runtimeContext = structuredClone(context)
    session.status = command.sessionStatus ?? session.status
    session.updatedAt += 1
    return structuredClone(context)
  })
  return {
    sessions: {
      readSessionRuntimeContext: vi.fn(async () => structuredClone(context)),
      patchSessionRuntimeContext: patches,
      containsMessageOnActiveBranch: vi.fn(async () => containsMessage),
      loadSessionForContinuation: vi.fn(async () => structuredClone(session)),
      readSessionSnapshot: vi.fn(async () => structuredClone(session))
    },
    context: () => context,
    session: () => session,
    patches
  }
}

const scope = { projectId: 'project-1', sessionId: 'session-1' }

const createRestoredConfirmation = async (): Promise<
  ReturnType<typeof createSessions> & {
    owner: AcpPermissionWaitOwner
    version: string
    requestId: string
  }
> => {
  const fixture = createSessions()
  const owner = new AcpPermissionWaitOwner(fixture.sessions)
  const session = fixture.session()
  const candidate = createCandidate()
  const request = {
    ...candidate.request,
    isMcp: true,
    providerToolName: 'mcp__samples__query',
    mcpIdentity: 'samples/query',
    options: [
      ...candidate.request.options,
      {
        optionId: 'bind-project',
        name: 'This project',
        kind: 'allow_always',
        scope: 'project' as const
      }
    ]
  }
  session.agentModel = 'model-a'
  session.agentFrameworkId = 'codex'
  session.agentBackendId = 'fixture-backend'
  session.agentConfiguration = {
    providerId: 'fixture-provider',
    model: 'model-a',
    reasoningEffort: 'medium'
  }
  session.activities = [
    {
      id: request.toolCallId,
      kind: 'tool',
      title: request.title,
      status: 'pending',
      promptMessageId: candidate.promptMessageId,
      sortIndex: 1,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
  ]
  session.conversationGraph = materializeSessionConversationGraph(session).conversationGraph
  await owner.persist({ ...candidate, request })
  const confirmation = await owner.readPendingRestoredConfirmation(scope, request.requestId)
  if (!confirmation) throw new Error('Expected an authoritative restored MCP permission.')
  return { ...fixture, owner, version: confirmation.version, requestId: request.requestId }
}

describe('trusted restored MCP permission wait', () => {
  it('matches the exact OpenCode transport alias to the saved provider and model', async () => {
    const fixture = await createRestoredConfirmation()
    const session = fixture.session()
    const graph = session.conversationGraph!
    const providerId = session.agentConfiguration!.providerId
    const model = session.agentConfiguration!.model
    if (!providerId || !model) throw new Error('Expected a configured fixture Provider and model.')
    session.agentFrameworkId = 'opencode'
    session.conversationGraph = {
      ...graph,
      runtimeSegments: graph.runtimeSegments.map((segment) => ({
        ...segment,
        frameworkId: 'opencode',
        model
      }))
    }
    session.agentModel = `${opencodeTransportProviderId(providerId, model)}/${model}`
    await expect(
      fixture.owner.readPendingRestoredConfirmation(scope, fixture.requestId)
    ).resolves.toBeDefined()
    session.agentModel = `${opencodeTransportProviderId('another-provider', model)}/${model}`
    await expect(
      fixture.owner.readPendingRestoredConfirmation(scope, fixture.requestId)
    ).resolves.toBeUndefined()
  })

  it('prepares the exact native restored choice and claims the durable wait once', async () => {
    const { owner, sessions, context, requestId, version } = await createRestoredConfirmation()
    const read = (await owner.readPendingRestoredConfirmation(scope, requestId))!
    expect(read.allowedDecisions).toEqual([
      'option:allow-once',
      'option:deny',
      'option:bind-project',
      'cancel'
    ])
    expect(read.request.options.map(({ optionId }) => optionId)).toEqual([
      'allow-once',
      'deny',
      'bind-project'
    ])
    expect(sessions.readSessionSnapshot).toHaveBeenLastCalledWith(
      scope.projectId,
      scope.sessionId,
      { preserveRuntimeState: true }
    )
    expect(sessions.loadSessionForContinuation).not.toHaveBeenCalled()
    await expect(
      owner.prepareRestoredConfirmation(scope, requestId, version, 'option:not-offered')
    ).resolves.toEqual({ status: 'invalid-decision' })
    const prepared = await owner.prepareRestoredConfirmation(
      scope,
      requestId,
      version,
      'option:bind-project'
    )
    if (prepared.status !== 'ready') throw new Error('Expected a prepared restored permission.')
    const nativeDecision = await owner.resolveRestored(
      prepared.response,
      scope.projectId,
      scope.sessionId
    )
    expect(prepared.decision).toEqual(nativeDecision)
    expect(prepared.decision.option).toMatchObject({ optionId: 'bind-project', scope: 'project' })
    expect(context().permission?.state).toBe('pending')
    const authorize = vi.fn(() => true)
    await expect(prepared.claim(authorize)).resolves.toBe('claimed')
    expect(context().permission?.state).toBe('continuing')
    await expect(prepared.claim(authorize)).resolves.toBe('unavailable')
    expect(authorize).toHaveBeenCalledOnce()
    await owner.rearmContinuation(scope.projectId, scope.sessionId, requestId)
    expect((await owner.readPendingRestoredConfirmation(scope, requestId))?.version).not.toBe(
      version
    )
  })

  it.each(['revoked', 'branch', 'model', 'request'] as const)(
    'rejects %s evidence at the persistence fence without consuming the pending wait',
    async (change) => {
      const fixture = await createRestoredConfirmation()
      const { owner, patches, requestId, version } = fixture
      const prepared = await owner.prepareRestoredConfirmation(scope, requestId, version, 'cancel')
      if (prepared.status !== 'ready') throw new Error('Expected cancellation to be ready.')
      expect(prepared.response.cancelled).toBe(true)
      expect(prepared.decision.option).toBeUndefined()
      let authorized = true
      const atWrite = Promise.withResolvers<void>()
      const continueWrite = Promise.withResolvers<void>()
      const patch = patches.getMockImplementation()!
      patches.mockImplementationOnce(async (command) => {
        atWrite.resolve()
        await continueWrite.promise
        return patch(command)
      })
      const authorize = vi.fn(() => authorized)
      const pending = prepared.claim(authorize)
      await atWrite.promise
      expect(authorize).not.toHaveBeenCalled()
      const session = fixture.session()
      if (change === 'revoked') authorized = false
      else if (change === 'model') session.agentModel = 'changed-model'
      else if (change === 'request') {
        const current = session.runtimeContext!
        const permission = current.permission!
        session.runtimeContext = {
          ...current,
          permission: {
            ...permission,
            request: { ...permission.request, title: 'A different tool operation' }
          }
        }
      } else {
        const graph = session.conversationGraph!
        const original = graph.branches[0]
        graph.branches.push({
          ...original,
          id: 'sibling-branch',
          parentBranchId: original.id,
          forkMessageId: 'prompt-1'
        })
        graph.frames[0].activeBranchId = 'sibling-branch'
        expect(resolveActiveConversationMessages(graph).some(({ id }) => id === 'prompt-1')).toBe(
          true
        )
      }
      continueWrite.resolve()
      await expect(pending).resolves.toBe('unavailable')
      expect(fixture.context().permission?.state).toBe('pending')
      expect(authorize).toHaveBeenCalledTimes(change === 'revoked' ? 1 : 0)
    }
  )

  it('leaves the signed preparation inert when the native owner wins or a session is unavailable', async () => {
    const { owner, session, requestId, version } = await createRestoredConfirmation()
    await expect(
      owner.readPendingRestoredConfirmation({ ...scope, projectId: 'another-project' }, requestId)
    ).resolves.toBeUndefined()
    session().archivedAt = 99
    await expect(owner.readPendingRestoredConfirmation(scope, requestId)).resolves.toBeUndefined()
    session().archivedAt = undefined
    const prepared = await owner.prepareRestoredConfirmation(
      scope,
      requestId,
      version,
      'option:allow-once'
    )
    if (prepared.status !== 'ready') throw new Error('Expected a ready permission preparation.')
    await owner.beginContinuation(scope.projectId, scope.sessionId, requestId)
    const authorize = vi.fn(() => true)
    await expect(prepared.claim(authorize)).resolves.toBe('unavailable')
    expect(authorize).not.toHaveBeenCalled()
  })

  it('does not re-open a trusted denial when notification fails after the durable write', async () => {
    const { sessions, context, requestId, version } = await createRestoredConfirmation()
    const publish = vi.fn(async () => {
      throw new Error('renderer was replaced')
    })
    const owner = new AcpPermissionWaitOwner(sessions, publish)
    const prepared = await owner.prepareRestoredConfirmation(
      scope,
      requestId,
      version,
      'option:deny'
    )
    if (prepared.status !== 'ready') throw new Error('Expected a ready permission decision.')
    expect(prepared.decision).toMatchObject({ denied: true, option: { optionId: 'deny' } })
    expect(prepared.response.cancelled).toBeUndefined()
    await expect(prepared.claim(() => true)).resolves.toBe('claimed')
    expect(publish).toHaveBeenCalledOnce()
    expect(context().permission?.state).toBe('continuing')
    await expect(owner.readPendingRestoredConfirmation(scope, requestId)).resolves.toBeUndefined()
  })

  it('rechecks proof authorization after a durable revision conflict', async () => {
    const { owner, session, patches, context, requestId, version } =
      await createRestoredConfirmation()
    const prepared = await owner.prepareRestoredConfirmation(
      scope,
      requestId,
      version,
      'option:allow-once'
    )
    if (prepared.status !== 'ready') throw new Error('Expected a ready permission decision.')
    patches.mockImplementationOnce(async (command) => {
      await command.beforePersist?.(structuredClone(session()))
      throw Object.assign(new Error('revision conflict'), { code: 'revision-conflict' })
    })
    const authorize = vi.fn(() => false).mockReturnValueOnce(true)
    await expect(prepared.claim(authorize)).resolves.toBe('unavailable')
    expect(authorize).toHaveBeenCalledTimes(2)
    expect(context().permission?.state).toBe('pending')
  })
})

describe('ACP durable permission wait owner', () => {
  it('atomically hands the restored wait to a fresh pending decision and fences old cleanup', async () => {
    const fixture = createSessions()
    const owner = new AcpPermissionWaitOwner(fixture.sessions)
    await owner.persist(createCandidate())
    await owner.beginContinuation('project-1', 'session-1', 'permission-1')
    fixture.patches.mockClear()
    const continuation = continuationFor()

    await owner.persist(successorFor(continuation))

    expect(fixture.patches).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        expectedRevision: 2,
        sessionStatus: 'waiting-permission',
        patch: {
          permission: expect.objectContaining({
            state: 'pending',
            request: expect.objectContaining({ requestId: 'permission-2' })
          })
        }
      })
    )
    expect(continuation.handedOff).toBe(true)
    expect(await owner.clearAfterContinuation('project-1', 'session-1', 'permission-1')).toBe(false)
    await owner.cancelContinuation('project-1', 'session-1', 'permission-1')
    await expect(owner.rearmContinuation('project-1', 'session-1', 'permission-1')).rejects.toThrow(
      'stale'
    )
    expect(fixture.patches).toHaveBeenCalledOnce()
    const restarted = new AcpPermissionWaitOwner(fixture.sessions)
    await expect(
      restarted.resolveRestored(
        {
          requestId: 'permission-2',
          optionId: 'allow-once',
          restored: { projectId: 'project-1', sessionId: 'session-1' }
        },
        'project-1',
        'session-1'
      )
    ).resolves.toMatchObject({
      permission: { state: 'pending', request: { requestId: 'permission-2' } }
    })
  })

  it.each([
    { projectId: 'another-project' },
    { sessionId: 'another-session' },
    { promptMessageId: 'another-prompt' },
    { requestId: 'another-permission' },
    { fingerprint: 'c'.repeat(64) },
    { interactionSequence: undefined },
    { agentFrameId: undefined },
    { messageBranchId: undefined },
    { isCurrent: () => false },
    { handoffStarted: false },
    { handedOff: true }
  ])('rejects a handoff without its exact live continuation authority: %o', async (invalid) => {
    const fixture = createSessions()
    const owner = new AcpPermissionWaitOwner(fixture.sessions)
    await owner.persist(createCandidate())
    await owner.beginContinuation('project-1', 'session-1', 'permission-1')
    fixture.patches.mockClear()
    await expect(
      owner.persist(successorFor({ ...continuationFor(), ...invalid }))
    ).rejects.toThrow()
    expect(fixture.patches).not.toHaveBeenCalled()
    expect(fixture.context().permission).toMatchObject({
      state: 'continuing',
      request: { requestId: 'permission-1' }
    })
  })

  it('does not downgrade a restored handoff to a transient wait when its prompt is already off branch', async () => {
    const fixture = createSessions()
    const owner = new AcpPermissionWaitOwner(fixture.sessions)
    await owner.persist(createCandidate())
    await owner.beginContinuation('project-1', 'session-1', 'permission-1')
    vi.mocked(fixture.sessions.containsMessageOnActiveBranch).mockResolvedValue(false)
    fixture.patches.mockClear()
    const continuation = continuationFor()

    await expect(owner.persist(successorFor(continuation))).rejects.toThrow('active Message Branch')

    expect(fixture.patches).not.toHaveBeenCalled()
    expect(continuation.handedOff).toBe(false)
    expect(fixture.context().permission).toMatchObject({
      state: 'continuing',
      request: { requestId: 'permission-1' }
    })
  })

  it('rechecks continuation liveness after the transcript preparation await', async () => {
    const fixture = createSessions()
    const owner = new AcpPermissionWaitOwner(fixture.sessions)
    await owner.persist(createCandidate())
    await owner.beginContinuation('project-1', 'session-1', 'permission-1')
    const continuation = continuationFor()
    const delayed = new AcpPermissionWaitOwner(fixture.sessions, undefined, async () => {
      continuation.isCurrent = () => false
    })
    fixture.patches.mockClear()
    await expect(delayed.persist(successorFor(continuation))).rejects.toThrow('no longer active')
    expect(fixture.patches).not.toHaveBeenCalled()
  })

  it.each(['cancelled', 'branch-changed', 'sibling-branch'] as const)(
    'rejects %s while queued for the persistence owner',
    async (change) => {
      const fixture = createSessions()
      const owner = new AcpPermissionWaitOwner(fixture.sessions)
      await owner.persist(createCandidate())
      await owner.beginContinuation('project-1', 'session-1', 'permission-1')
      const continuation = continuationFor()
      const patch = fixture.patches.getMockImplementation()!
      fixture.patches.mockImplementationOnce(async (command) => {
        if (change === 'cancelled') continuation.isCurrent = () => false
        else if (change === 'branch-changed') fixture.session().messages = []
        else {
          const graph = materializeSessionConversationGraph(fixture.session()).conversationGraph!
          const original = graph.branches[0]
          graph.branches.push({
            ...original,
            id: 'sibling-branch',
            parentBranchId: original.id,
            forkMessageId: 'prompt-1'
          })
          graph.frames[0].activeBranchId = 'sibling-branch'
          fixture.session().conversationGraph = graph
          expect(resolveActiveConversationMessages(graph).some(({ id }) => id === 'prompt-1')).toBe(
            true
          )
        }
        return patch(command)
      })
      await expect(owner.persist(successorFor(continuation))).rejects.toThrow()
      expect(continuation.handedOff).toBe(false)
      expect(fixture.context().permission).toMatchObject({
        state: 'continuing',
        request: { requestId: 'permission-1' }
      })
    }
  )

  it('revalidates the exact owner after a revision conflict rather than overwriting another wait', async () => {
    const fixture = createSessions()
    const owner = new AcpPermissionWaitOwner(fixture.sessions)
    await owner.persist(createCandidate())
    await owner.beginContinuation('project-1', 'session-1', 'permission-1')
    const patch = fixture.patches.getMockImplementation()!
    fixture.patches.mockImplementationOnce(async () => {
      await patch({
        projectId: 'project-1',
        sessionId: 'session-1',
        expectedRevision: fixture.context().revision,
        patch: {
          permission: {
            ...fixture.context().permission!,
            state: 'pending',
            request: { ...createCandidate().request, requestId: 'unrelated' }
          }
        },
        sessionStatus: 'waiting-permission'
      })
      throw Object.assign(new Error('revision conflict'), { code: 'revision-conflict' })
    })
    const continuation = continuationFor()
    await expect(owner.persist(successorFor(continuation))).rejects.toThrow('already owns')
    expect(continuation.handedOff).toBe(false)
    expect(fixture.context().permission?.request.requestId).toBe('unrelated')
  })

  it('marks the handoff committed before publication can fail and preserves the successor', async () => {
    const fixture = createSessions()
    const owner = new AcpPermissionWaitOwner(fixture.sessions)
    await owner.persist(createCandidate())
    await owner.beginContinuation('project-1', 'session-1', 'permission-1')
    const continuation = continuationFor()
    const failingPublisher = new AcpPermissionWaitOwner(fixture.sessions, async () => {
      expect(continuation.handedOff).toBe(true)
      throw new Error('renderer publication failed')
    })
    await expect(failingPublisher.persist(successorFor(continuation))).rejects.toThrow(
      'publication failed'
    )
    await owner.cancelContinuation('project-1', 'session-1', 'permission-1')
    expect(fixture.context().permission).toMatchObject({
      state: 'pending',
      request: { requestId: 'permission-2' }
    })
  })

  it('publishes the authoritative Session after permission authority is durable', async () => {
    const fixture = createSessions()
    const publishSessionUpdated = vi.fn()
    const owner = new AcpPermissionWaitOwner(fixture.sessions, publishSessionUpdated)

    await expect(owner.persist(createCandidate())).resolves.toBe(true)

    expect(publishSessionUpdated).toHaveBeenCalledOnce()
    expect(publishSessionUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'session-1',
        status: 'waiting-permission',
        runtimeContext: expect.objectContaining({
          permission: expect.objectContaining({
            state: 'pending',
            request: expect.objectContaining({ requestId: 'permission-1' })
          })
        })
      })
    )

    await owner.clearLive(createCandidate())

    expect(publishSessionUpdated).toHaveBeenCalledTimes(2)
    expect(publishSessionUpdated).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'session-1',
        status: 'running',
        runtimeContext: expect.not.objectContaining({ permission: expect.anything() })
      })
    )
  })

  it('persists, revalidates, and clears one prompt-bound permission authority', async () => {
    const fixture = createSessions()
    const owner = new AcpPermissionWaitOwner(fixture.sessions)
    const candidate = createCandidate()

    await expect(owner.persist(candidate)).resolves.toBe(true)
    expect(fixture.patches).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        sessionId: 'session-1',
        expectedRevision: 0,
        sessionStatus: 'waiting-permission',
        patch: {
          permission: expect.objectContaining({
            state: 'pending',
            request: expect.objectContaining({ requestId: 'permission-1' }),
            originatingPromptMessageId: 'prompt-1',
            fingerprint: 'a'.repeat(64)
          })
        }
      })
    )

    await expect(
      owner.resolveRestored(
        {
          requestId: 'permission-1',
          optionId: 'allow-once',
          restored: { sessionId: 'session-1', projectId: 'project-1' }
        },
        'project-1',
        'session-1'
      )
    ).resolves.toMatchObject({
      denied: false,
      option: { optionId: 'allow-once' },
      permission: { originatingPromptMessageId: 'prompt-1' }
    })

    await owner.beginContinuation('project-1', 'session-1', 'permission-1')
    expect(fixture.context().permission).toMatchObject({ state: 'continuing' })
    await expect(
      owner.resolveRestored(
        {
          requestId: 'permission-1',
          optionId: 'allow-once',
          restored: { sessionId: 'session-1', projectId: 'project-1' }
        },
        'project-1',
        'session-1'
      )
    ).rejects.toThrow('stale or no longer pending')

    await owner.rearmContinuation('project-1', 'session-1', 'permission-1')
    expect(fixture.context().permission).toMatchObject({ state: 'pending' })

    await owner.beginContinuation('project-1', 'session-1', 'permission-1')
    await owner.clearAfterContinuation('project-1', 'session-1', 'permission-1')
    expect(fixture.context().permission).toBeUndefined()
    expect(fixture.patches).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionStatus: 'idle', patch: { permission: undefined } })
    )
  })

  it('does not persist authority for a prompt outside the active Message Branch', async () => {
    const fixture = createSessions(false)
    const owner = new AcpPermissionWaitOwner(fixture.sessions)

    await expect(owner.persist(createCandidate())).resolves.toBe(false)
    expect(fixture.patches).not.toHaveBeenCalled()
  })

  it('persists a bounded preview for a large Literature Inbox save', async () => {
    const fixture = createSessions()
    const owner = new AcpPermissionWaitOwner(fixture.sessions)
    const candidate = createCandidate()

    await expect(
      owner.persist({
        ...candidate,
        request: {
          ...candidate.request,
          isMcp: true,
          mcpIdentity: 'open-science-library/save_to_inbox',
          rawInput: {
            candidates: [
              {
                item: { title: 'Paper one', abstract: 'a'.repeat(12_000) },
                source: { provider: 'pubmed', rawMetadata: { secret: 'omitted' } }
              }
            ]
          }
        }
      })
    ).resolves.toBe(true)

    expect(fixture.context().permission).toMatchObject({
      fingerprint: 'a'.repeat(64),
      request: {
        rawInput: { candidates: [{ item: { title: 'Paper one' } }] }
      }
    })
    expect(JSON.stringify(fixture.context().permission)).not.toContain('omitted')
  })

  it('persists other permission waits without an oversized optional input preview', async () => {
    const fixture = createSessions()
    const owner = new AcpPermissionWaitOwner(fixture.sessions)
    const candidate = createCandidate()

    await expect(
      owner.persist({
        ...candidate,
        request: {
          ...candidate.request,
          rawInput: { code: 'x'.repeat(12_000) }
        }
      })
    ).resolves.toBe(true)

    expect(fixture.context().permission).toMatchObject({
      fingerprint: 'a'.repeat(64),
      request: { requestId: 'permission-1' }
    })
    expect(fixture.context().permission?.request.rawInput).toBeUndefined()
  })

  it('does not let a new durable wait replace an active continuation', async () => {
    const fixture = createSessions()
    const owner = new AcpPermissionWaitOwner(fixture.sessions)
    const candidate = createCandidate()

    await owner.persist(candidate)
    await owner.beginContinuation('project-1', 'session-1', 'permission-1')

    await expect(
      owner.persist({
        ...candidate,
        request: {
          ...candidate.request,
          requestId: 'permission-2',
          toolCallId: 'tool-2'
        }
      })
    ).rejects.toThrow('Another durable permission request already owns this Session.')
    expect(fixture.context().permission).toMatchObject({
      state: 'continuing',
      request: { requestId: 'permission-1' }
    })
  })

  it('cancels matching pending and continuing authority idempotently', async () => {
    const fixture = createSessions()
    const owner = new AcpPermissionWaitOwner(fixture.sessions)
    const candidate = createCandidate()

    await owner.persist(candidate)
    await owner.cancelContinuation('project-1', 'session-1', 'permission-1')
    expect(fixture.context().permission).toBeUndefined()

    await owner.persist(candidate)
    await owner.beginContinuation('project-1', 'session-1', 'permission-1')
    await owner.cancelContinuation('project-1', 'session-1', 'permission-1')
    await owner.cancelContinuation('project-1', 'session-1', 'permission-1')

    expect(fixture.context().permission).toBeUndefined()
    expect(fixture.patches).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionStatus: 'idle', patch: { permission: undefined } })
    )
  })

  it('rejects a restored locator that does not match the durable Session', async () => {
    const fixture = createSessions()
    const owner = new AcpPermissionWaitOwner(fixture.sessions)
    await owner.persist(createCandidate())

    await expect(
      owner.resolveRestored(
        {
          requestId: 'permission-1',
          optionId: 'allow-once',
          restored: { sessionId: 'session-1', projectId: 'other-project' }
        },
        'project-1',
        'session-1'
      )
    ).rejects.toThrow('does not match the active Session')
  })
})

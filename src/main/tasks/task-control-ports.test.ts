import { describe, expect, it } from 'vitest'
import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { PendingElicitationRequest } from '../../shared/elicitation'
import type { PersistedChatSession, PersistedToolActivity } from '../../shared/session-persistence'
import { projectTaskPendingSessionInteractions } from './task-control-ports'

const scope = { projectId: 'project-1', sessionId: 'session-1' }
const prompt = {
  id: 'private-prompt-id',
  role: 'user',
  content: 'Private prompt',
  status: 'complete',
  eventIds: [],
  createdAt: 1,
  updatedAt: 1
} as const
const permission = {
  requestId: 'private-permission-id',
  sessionId: scope.sessionId,
  toolCallId: 'private-tool-id',
  title: 'Private tool',
  isMcp: true,
  options: [{ optionId: 'private-option-id', name: 'Private option', kind: 'allow_once' }]
}
const question: PendingElicitationRequest = {
  requestId: 'private-question-id',
  sessionId: scope.sessionId,
  toolCallId: 'private-tool-id',
  message: 'Private question',
  fields: [{ id: 'private-field-id', label: 'Private field', kind: 'text' }]
}

const withActivity = (
  elicitation?: PersistedToolActivity['elicitation']
): PersistedChatSession & {
  conversationGraph: ReturnType<typeof createLinearConversationGraph>
  activities: PersistedToolActivity[]
} => {
  const messages = [{ ...prompt, eventIds: [] }]
  const graph = createLinearConversationGraph({
    sessionId: scope.sessionId,
    messages,
    frameworkId: 'open-science-agent',
    createdAt: 1,
    updatedAt: 1
  })
  const activity: PersistedToolActivity = {
    id: permission.toolCallId,
    kind: 'tool',
    title: 'Private tool',
    status: 'in_progress',
    sortIndex: 1,
    eventIds: [],
    promptMessageId: prompt.id,
    createdAt: 1,
    updatedAt: 1,
    ...(elicitation ? { elicitation } : {})
  }
  graph.activities = [
    {
      ...activity,
      agentFrameId: graph.rootFrameId,
      messageBranchId: graph.branches[0].id,
      promptMessageId: prompt.id,
      runtimeSegmentId: graph.runtimeSegments[0].id
    }
  ]
  return {
    id: scope.sessionId,
    projectId: scope.projectId,
    title: 'Private session',
    cwd: '/private',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    messages,
    activities: [activity],
    conversationGraph: graph
  }
}

const permissionSession = () => ({
  ...withActivity(),
  status: 'waiting-permission' as const,
  runtimeContext: {
    version: 1 as const,
    revision: 1,
    permission: {
      state: 'pending' as const,
      request: permission,
      originatingPromptMessageId: prompt.id,
      fingerprint: 'private-fingerprint',
      createdAt: 1
    }
  }
})

const questionSession = (state: NonNullable<PersistedToolActivity['elicitation']>['state']) => ({
  ...withActivity({
    message: question.message,
    fields: question.fields,
    state,
    durable: { kind: 'agent-user-choice', requestId: question.requestId }
  }),
  status: 'waiting-for-user' as const
})

const delegatedQuestionSession = () => {
  const session = withActivity()
  const graph = session.conversationGraph
  graph.frames.push({
    id: 'child',
    kind: 'delegate',
    parentFrameId: graph.rootFrameId,
    originBindingState: 'validated',
    originMessageId: prompt.id,
    delegateName: 'Private child',
    activeBranchId: 'child-branch',
    status: 'completed',
    createdAt: 1
  })
  graph.branches.push({
    id: 'child-branch',
    agentFrameId: 'child',
    headMessageId: 'child-prompt',
    createdAt: 1,
    updatedAt: 1
  })
  graph.messages.push({
    ...graph.messages[0],
    id: 'child-prompt',
    revisionRootMessageId: 'child-prompt',
    agentFrameId: 'child',
    introducedOnBranchId: 'child-branch',
    runtimeSegmentId: 'child-runtime'
  })
  graph.runtimeSegments.push({
    id: 'child-runtime',
    agentFrameId: 'child',
    frameworkId: 'open-science-agent',
    startedAt: 1,
    endedAt: 2
  })
  const work = {
    questionRequests: [
      {
        requestId: 'private-delegated-question-id',
        canonicalDigest: 'a'.repeat(64),
        sourceFrameId: 'child',
        sourceAttemptId: 'child-attempt',
        sourceRuntimeSegmentId: 'child-runtime',
        sourceMessageBranchId: 'child-branch',
        rootOriginMessageId: prompt.id,
        rootBranchId: graph.branches[0].id,
        sourceName: 'Private child',
        questions: [{ question: 'Private question', options: [{ label: 'Private answer' }] }],
        askedAt: 1,
        status: 'pending' as const,
        draftAnswers: [],
        draftQuestionIndex: 0
      }
    ],
    records: [
      {
        agentFrameId: 'child',
        attempts: [
          {
            id: 'child-attempt',
            status: 'completed' as const,
            resolvedAgent: { kind: 'main' as const },
            executionModel: {
              frameworkId: 'open-science-agent',
              providerId: 'private-provider',
              backendId: 'private-backend',
              modelRoute: 'open-science-agent',
              model: 'private-model',
              reasoningEffort: 'default'
            } as const,
            runtimeSegmentIds: ['child-runtime'],
            startedAt: 1,
            endedAt: 2
          }
        ]
      }
    ]
  }
  return { ...session, runtimeContext: { version: 1 as const, revision: 1, delegatedWork: work } }
}

const observe = (session: PersistedChatSession) =>
  projectTaskPendingSessionInteractions(scope, { pendingPermissions: [] }, [], session)

describe('Task pending interaction snapshots', () => {
  it('projects a detached MCP wait with the same opaque ID it had while connected', () => {
    const session = permissionSession()
    const live = projectTaskPendingSessionInteractions(
      scope,
      { pendingPermissions: [permission] },
      []
    )
    expect(live).toEqual([
      {
        ...scope,
        id: expect.stringMatching(/^[a-f0-9]{64}$/),
        status: 'pending',
        kind: 'permission',
        isMcp: true,
        delegated: false
      }
    ])
    expect(observe(session)).toEqual(live)
    expect(observe({ ...session, projectId: 'other-project' })).toEqual([])
    expect(observe({ ...session, id: 'other-session' })).toEqual([])
    expect(observe({ ...session, archivedAt: 3 })).toEqual([])
  })

  it('omits continuing, non-MCP, or inactive-branch permission records', () => {
    const session = permissionSession()
    const patch = (
      permissionPatch: Partial<NonNullable<PersistedChatSession['runtimeContext']>['permission']>
    ) => ({
      ...session,
      runtimeContext: {
        ...session.runtimeContext,
        permission: { ...session.runtimeContext.permission, ...permissionPatch }
      }
    })
    expect(observe(patch({ state: 'continuing' }))).toEqual([])
    expect(observe(patch({ request: { ...permission, isMcp: false } }))).toEqual([])
    expect(observe(patch({ originatingPromptMessageId: 'abandoned-prompt' }))).toEqual([])
    expect(observe({ ...session, status: 'idle' })).toEqual([])
  })

  it('deduplicates the same question while preserving current live metadata', () => {
    const session = questionSession('pending')
    const detached = observe(session)
    expect(detached).toEqual([
      {
        ...scope,
        id: expect.stringMatching(/^[a-f0-9]{64}$/),
        status: 'pending',
        kind: 'question',
        fieldCount: 1
      }
    ])
    const live = {
      ...question,
      fields: [
        ...question.fields,
        { id: 'private-other-field', label: 'Private', kind: 'text' as const }
      ]
    }
    expect(
      projectTaskPendingSessionInteractions(
        scope,
        { pendingPermissions: [], pendingElicitations: [live] },
        [],
        session
      )
    ).toEqual([{ ...detached[0], fieldCount: 2 }])
  })

  it.each(['answered', 'declined', 'cancelled'] as const)('omits a %s question', (state) => {
    expect(observe(questionSession(state))).toEqual([])
  })

  it('omits a question from a prior turn or a conflicting flat activity', () => {
    const stale = questionSession('pending')
    stale.conversationGraph.activities[0].messageBranchId = 'inactive-branch'
    expect(observe(stale)).toEqual([])
    const conflicting = questionSession('pending')
    conflicting.activities[0] = { ...conflicting.activities[0], title: 'Different private title' }
    expect(observe(conflicting)).toEqual([])
  })

  it('projects a detached delegated question only for the active source Attempt and Branch', () => {
    const session = delegatedQuestionSession()
    expect(observe(session)).toEqual([
      {
        ...scope,
        id: expect.stringMatching(/^[a-f0-9]{64}$/),
        status: 'pending',
        kind: 'question',
        fieldCount: 1
      }
    ])
    const work = session.runtimeContext.delegatedWork
    const attempt = work.records[0].attempts[0]
    work.records[0].attempts.push({ ...attempt, id: 'new-attempt' })
    expect(observe(session)).toEqual([])
    work.records[0].attempts.pop()
    session.conversationGraph.frames[1].activeBranchId = 'another-child-branch'
    expect(observe(session)).toEqual([])
  })
})

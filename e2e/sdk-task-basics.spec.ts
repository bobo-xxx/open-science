import { expect } from '@playwright/test'

import type { OpenScienceClient } from '../packages/open-science/index'
import { test, type ElectronApp } from './fixtures/electron-app'

async function connect(app: ElectronApp): Promise<OpenScienceClient> {
  const sdkEntry = '../packages/open-science/index.mjs'
  const { OpenScienceClient: Client } = (await import(
    sdkEntry
  )) as typeof import('../packages/open-science/index')
  const url = new URL(await app.authenticatedWebUrl())
  const token = url.searchParams.get('token')
  if (!token) throw new Error('Missing isolated fixture token')
  return new Client({ baseUrl: url.origin, token })
}

test('runs a task with project defaults and reads the same result through a new SDK client', async ({
  app
}) => {
  test.setTimeout(120_000)
  await app.configureFakeAgent()

  const client = await connect(app)
  const capabilities = await client.getCapabilities()
  expect(capabilities.taskCapabilities).toEqual(
    expect.arrayContaining([
      'configuration-options',
      'durable-submissions',
      'session-history',
      'session-run-attachments'
    ])
  )
  const configuration = await client.listConfigurationOptions()
  const model = configuration.models.find((option) => option.model === 'e2e-model')
  expect(model?.selectable).toBe(true)

  const project = await client.createProject({ name: 'SDK task verification' })
  const defaults = await client.getProjectSessionDefaults(project.id)
  await client.updateProjectSessionDefaults(project.id, {
    expectedUpdatedAt: defaults.updatedAt,
    patch: { permissionProfile: 'ask', delegationPolicy: 'deny', memoryEnabled: false }
  })

  const prompt = 'Reply with a short greeting for the SDK task test.'
  const run = await client.startRun({ project: project.id, prompt }, { requestId: 'sdk-test-run' })
  const session = await client.getSessionConfiguration(run.sessionId)
  expect(session.effective).toMatchObject({
    permissionProfile: 'ask',
    delegationPolicy: 'deny',
    memoryEnabled: false
  })

  const reconnected = await connect(app)
  const result = await reconnected.waitForRun(run.id, { timeoutMs: 45_000 })
  expect(result.status).toBe('completed')
  expect(result.output).toBeTruthy()
  const page = await reconnected.getSessionHistory(project.id, result.sessionId, { limit: 20 })
  expect(page.messages.map((message) => message.role)).toEqual(
    expect.arrayContaining(['user', 'agent'])
  )
  expect(page.messages.some((message) => message.content.includes(prompt))).toBe(true)

  const attachment = await reconnected.stageRunAttachment(project.id, result.sessionId, {
    name: 'observations.txt',
    mimeType: 'text/plain',
    bytes: new TextEncoder().encode('sample = 42\n')
  })
  const followup = await reconnected.startRun(
    {
      project: project.id,
      sessionId: result.sessionId,
      prompt: 'Acknowledge the attachment for the SDK task test.',
      attachmentIds: [attachment.id]
    },
    { requestId: 'sdk-test-attachment-run' }
  )
  expect((await reconnected.waitForRun(followup.id, { timeoutMs: 45_000 })).status).toBe(
    'completed'
  )
  const afterFollowup = await reconnected.getSessionHistory(project.id, result.sessionId)
  expect(afterFollowup.messages.flatMap((message) => message.attachments ?? [])).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'observations.txt' })])
  )

  const answer = afterFollowup.messages.findLast(
    (message) => message.role === 'agent' && message.status === 'complete'
  )
  if (!answer) throw new Error('Expected a completed answer to review')
  const review = await reconnected.startSessionReview(result.sessionId, {
    projectId: project.id,
    turnMessageId: answer.id,
    messageBranchId: afterFollowup.messageBranchId
  })
  if (!review.started) throw new Error(`Reviewer did not start: ${review.reason}`)
  await expect
    .poll(async () => {
      const current = await reconnected.getSessionReview(result.sessionId, review.reviewId, {
        projectId: project.id
      })
      return current.lifecycle
    })
    .toBe('complete')
})

test('observes an actual permission wait and cancels the Run', async ({ app }) => {
  await app.configureFakeAgent()
  const client = await connect(app)
  const project = await client.createProject({ name: 'SDK interaction verification' })
  const run = await client.startRun({
    project: project.id,
    prompt: 'Request fixture permission.',
    permissionProfile: 'ask'
  })
  try {
    await expect
      .poll(() => client.listPendingSessionInteractions(project.id, run.sessionId))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'permission',
            status: 'pending',
            projectId: project.id,
            sessionId: run.sessionId
          })
        ])
      )
  } finally {
    await client.cancelRun(run.id)
  }
  expect((await client.waitForRun(run.id, { timeoutMs: 30_000 })).status).toBe('cancelled')
})

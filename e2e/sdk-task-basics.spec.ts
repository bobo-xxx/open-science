import { expect } from '@playwright/test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'

import type { OpenScienceClient } from '../packages/open-science/index'
import { test, type ElectronApp } from './fixtures/electron-app'
import { openSettingsPage } from './fixtures/settings-preferences'

async function connect(app: ElectronApp): Promise<OpenScienceClient> {
  const sdkEntry = '../packages/open-science/index.mjs'
  const { connectToOpenScience } = (await import(
    sdkEntry
  )) as typeof import('../packages/open-science/index')
  await app.authenticatedWebUrl()
  return connectToOpenScience({ configRoot: app.isolatedConfigRoot() })
}

test('runs a task with project defaults and reads the same result through a new SDK client', async ({
  app
}) => {
  test.setTimeout(120_000)
  await app.configureFakeAgent()

  const client = await connect(app)
  expect(await client.health()).not.toHaveProperty('configRoot')
  expect((await client.listCitationStyles()).length).toBeGreaterThan(0)
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
  const fork = await reconnected.forkSession(project.id, result.sessionId)
  expect(fork?.projectId).toBe(project.id)
  expect(fork?.sessionId).not.toBe(result.sessionId)
})

test('watches a permission wait appear and clear when the Run is cancelled', async ({ app }) => {
  await app.configureFakeAgent()
  const client = await connect(app)
  const project = await client.createProject({ name: 'SDK interaction verification' })
  const run = await client.startRun({
    project: project.id,
    prompt: 'Request fixture permission.',
    permissionProfile: 'ask'
  })
  let cancelled = false
  let cleared = false
  try {
    const watch = client.watchPendingSessionInteractions(project.id, run.sessionId, {
      signal: AbortSignal.timeout(20_000),
      pollIntervalMs: 100
    })
    for await (const snapshot of watch) {
      if (cancelled && snapshot.length === 0) {
        cleared = true
        break
      }
      if (
        !cancelled &&
        snapshot.some(
          ({ kind, status, projectId, sessionId }) =>
            kind === 'permission' &&
            status === 'pending' &&
            projectId === project.id &&
            sessionId === run.sessionId
        )
      ) {
        await client.cancelRun(run.id)
        cancelled = true
      }
    }
    expect(cancelled).toBe(true)
    expect(cleared).toBe(true)
  } finally {
    if (!cancelled) await client.cancelRun(run.id)
  }
  expect((await client.waitForRun(run.id, { timeoutMs: 30_000 })).status).toBe('cancelled')
})

test('reviews a trusted host key in Desktop and revokes it through local Web', async ({
  app,
  browser
}) => {
  const page = await app.completeOnboarding()
  await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
  await page.reload({ waitUntil: 'domcontentloaded' })
  const sdk = await connect(app)
  expect((await sdk.getCapabilities()).taskCapabilities).toContain('trusted-compute-decisions')
  expect(await sdk.health()).not.toHaveProperty('rpcChannels')

  const { publicKey } = generateKeyPairSync('ed25519')
  const rawKey = publicKey.export({ format: 'jwk' }).x
  if (!rawKey) throw new Error('Ed25519 public key is missing.')
  const fingerprint = createHash('sha256').update(Buffer.from(rawKey, 'base64url')).digest('hex')

  const desktopSettings = await openSettingsPage(page, 'Permissions')
  await desktopSettings.getByRole('button', { name: 'Register host', exact: true }).click()
  await desktopSettings.getByRole('textbox', { name: 'Host component name' }).fill('Fixture host')
  await desktopSettings.getByRole('textbox', { name: 'Ed25519 public key' }).fill(rawKey)
  await desktopSettings.getByRole('button', { name: 'Review host key' }).click()
  await expect(desktopSettings.getByText(fingerprint, { exact: true })).toBeVisible()
  await desktopSettings.getByRole('button', { name: 'Confirm host registration' }).click()
  await expect(desktopSettings.getByRole('button', { name: 'Revoke Fixture host' })).toBeVisible()

  const web = await browser.newPage()
  try {
    await web.goto(await app.authenticatedWebUrl())
    const webSettings = await openSettingsPage(web, 'Permissions')
    await expect(webSettings.getByText(fingerprint, { exact: true })).toBeVisible()
    await webSettings.getByRole('button', { name: 'Revoke Fixture host' }).click()
    await expect(webSettings.getByText('No trusted hosts registered.')).toBeVisible()
    await expect(page.evaluate(() => window.api.trustedHosts?.list())).resolves.toEqual([])
  } finally {
    await web.close()
  }
})

type FixtureSigner = {
  signDecision(envelope: string, payload: string): string
  disclose(
    sessionId: string,
    kind: 'permission' | 'question',
    selectId?: string
  ): Promise<{ interactionId: string; challenge: { id: string; envelope: string } }>
}

async function registerFixtureSigner(
  app: ElectronApp,
  sdk: OpenScienceClient,
  projectId: string
): Promise<FixtureSigner> {
  const signer = generateKeyPairSync('ed25519')
  const rawKey = signer.publicKey.export({ format: 'jwk' }).x
  if (!rawKey) throw new Error('Ed25519 public key is missing.')
  const hostId = await app.page.evaluate(async (publicKey) => {
    const hosts = window.api.trustedHosts
    if (!hosts) throw new Error('Trusted host registration is unavailable.')
    return (await hosts.enroll(await hosts.review({ label: 'Fixture signer', publicKey }))).id
  }, rawKey)

  const signText = (text: string): string =>
    sign(null, Buffer.from(text, 'utf8'), signer.privateKey).toString('base64url')
  const readMessage = (
    kind: 'permission' | 'question',
    sessionId: string,
    interactionId: string,
    time: number
  ): string =>
    'Open Science trusted interaction read v1\n' +
    JSON.stringify([kind, projectId, sessionId, interactionId, hostId, time])
  const signDecision = (envelope: string, payload: string): string =>
    signText('Open Science trusted interaction decision v1\n' + envelope + '\n' + payload)

  const disclose = async (
    sessionId: string,
    kind: 'permission' | 'question',
    selectId?: string
  ): Promise<{
    interactionId: string
    challenge: { id: string; envelope: string }
  }> => {
    const poll = async (): Promise<string | undefined> =>
      (await sdk.listPendingSessionInteractions(projectId, sessionId)).find(
        (item) => item.kind === kind && (!selectId || item.id === selectId)
      )?.id
    await expect.poll(poll).toBeTruthy()
    const interactionId = await poll()
    if (!interactionId) throw new Error('The fixture interaction is no longer pending.')
    const issuedAt = Date.now()
    const challenge = await sdk.createInteractionConfirmationChallenge(
      projectId,
      sessionId,
      interactionId,
      kind,
      {
        hostId,
        issuedAt,
        signature: signText(readMessage(kind, sessionId, interactionId, issuedAt))
      }
    )
    return { interactionId, challenge }
  }

  return { signDecision, disclose }
}

test('continues SDK tasks after signed live permission and question decisions', async ({ app }) => {
  await app.configureFakeAgent()
  const sdk = await connect(app)
  expect((await sdk.getCapabilities()).taskCapabilities).toEqual(
    expect.arrayContaining(['trusted-permission-decisions', 'trusted-question-decisions'])
  )
  const project = await sdk.createProject({ name: 'Trusted SDK task fixtures' })
  const { disclose, signDecision } = await registerFixtureSigner(app, sdk, project.id)

  const permissionRun = await sdk.startRun({
    project: project.id,
    prompt: 'Request fixture permission.',
    permissionProfile: 'ask'
  })
  const permission = await disclose(permissionRun.sessionId, 'permission')
  const decision = 'option:allow-once'
  const permissionProof = {
    challengeId: permission.challenge.id,
    decision,
    signature: signDecision(permission.challenge.envelope, decision)
  } as const
  await expect(
    sdk.submitInteractionConfirmationDecision(
      project.id,
      permissionRun.sessionId,
      permission.interactionId,
      'permission',
      permissionProof
    )
  ).resolves.toEqual({ status: 'claimed' })
  await expect(
    sdk.submitInteractionConfirmationDecision(
      project.id,
      permissionRun.sessionId,
      permission.interactionId,
      'permission',
      permissionProof
    )
  ).rejects.toMatchObject({ code: 'trusted_confirmation_unavailable' })
  expect((await sdk.waitForRun(permissionRun.id)).status).toBe('completed')

  const questionRun = await sdk.startRun({
    project: project.id,
    prompt: 'Ask a restart verification question. Include four questions.'
  })
  const question = await disclose(questionRun.sessionId, 'question')
  const answers = Array.from({ length: 4 }, (_, index) => ({
    fieldId: 'question_' + index,
    value: 'Dataset Alpha'
  }))
  const signedPayload = JSON.stringify([
    'accept',
    answers.map(({ fieldId, value }) => [fieldId, 'answered', value])
  ])
  await expect(
    sdk.submitInteractionConfirmationDecision(
      project.id,
      questionRun.sessionId,
      question.interactionId,
      'question',
      {
        challengeId: question.challenge.id,
        decision: { action: 'accept', answers },
        signature: signDecision(question.challenge.envelope, signedPayload)
      }
    )
  ).resolves.toEqual({ status: 'claimed' })
  const result = await sdk.waitForRun(questionRun.id)
  expect(result.status).toBe('completed')
  expect(result.output).toContain('Question answer delivered.')
})

test('routes signed decisions to the delegated permission and question owners', async ({ app }) => {
  await app.configureFakeAgent()
  const sdk = await connect(app)
  const project = await sdk.createProject({ name: 'Trusted delegated task fixtures' })
  const { disclose, signDecision } = await registerFixtureSigner(app, sdk, project.id)

  const permissionRun = await sdk.startRun({
    project: project.id,
    prompt: 'Run the production delegated permission journey.',
    permissionProfile: 'ask'
  })
  const permission = await disclose(permissionRun.sessionId, 'permission')
  expect(
    JSON.parse(Buffer.from(permission.challenge.envelope, 'base64url').toString('utf8'))
  ).toMatchObject({
    disclosure: { delegated: { childTitle: 'Request the delegated fixture permission.' } }
  })
  const decision = 'option:allow-once'
  await expect(
    sdk.submitInteractionConfirmationDecision(
      project.id,
      permissionRun.sessionId,
      permission.interactionId,
      'permission',
      {
        challengeId: permission.challenge.id,
        decision,
        signature: signDecision(permission.challenge.envelope, decision)
      }
    )
  ).resolves.toEqual({ status: 'claimed' })
  expect((await sdk.waitForRun(permissionRun.id)).output).toContain(
    'Production delegated permission journey completed.'
  )

  const questionRun = await sdk.startRun({
    project: project.id,
    prompt: 'Run the production delegated user question journey.'
  })
  expect((await sdk.waitForRun(questionRun.id)).output).toContain(
    'Production delegated user question is pending.'
  )
  const queryPending = async (): Promise<string[]> =>
    (await sdk.listPendingSessionInteractions(project.id, questionRun.sessionId))
      .filter(({ kind }) => kind === 'question')
      .map(({ id }) => id)
  await expect.poll(queryPending).toHaveLength(2)
  for (const id of await queryPending()) {
    const { interactionId, challenge } = await disclose(questionRun.sessionId, 'question', id)
    const envelope = JSON.parse(Buffer.from(challenge.envelope, 'base64url').toString('utf8'))
    expect(envelope).toMatchObject({
      disclosure: { source: 'delegated' },
      allowedDecisions: ['accept']
    })
    const values =
      envelope.disclosure.sourceName === 'Delegated scope researcher'
        ? ['Focused', 'Narrative']
        : ['Footnotes']
    const answers = values.map((value, index) => ({ fieldId: String(index), value }))
    const payload = JSON.stringify([
      'accept',
      answers.map(({ fieldId, value }) => [fieldId, 'answered', value])
    ])
    await expect(
      sdk.submitInteractionConfirmationDecision(
        project.id,
        questionRun.sessionId,
        interactionId,
        'question',
        {
          challengeId: challenge.id,
          decision: { action: 'accept', answers },
          signature: signDecision(challenge.envelope, payload)
        }
      )
    ).resolves.toEqual({ status: 'claimed' })
  }
  await expect.poll(queryPending).toEqual([])
  await expect
    .poll(async () =>
      app.page.evaluate(async (sessionId) => {
        const { sessions } = await window.api.sessions.loadAll()
        return sessions
          .find(({ id }) => id === sessionId)
          ?.runtimeContext?.delegatedWork?.records.map(({ attempts }) => {
            const attempt = attempts.at(-1)
            return { status: attempt?.status, ...(attempt?.error ? { error: attempt.error } : {}) }
          })
      }, questionRun.sessionId)
    )
    .toEqual([{ status: 'completed' }, { status: 'completed' }])
})

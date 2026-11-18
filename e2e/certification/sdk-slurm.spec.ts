import { expect } from '@playwright/test'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { promisify } from 'node:util'
import { resolveSshBinary, shellSingleQuote } from '@aipoch/compute/node'
import type { Run } from '../../packages/open-science/index'
import type { JobSummary } from '../../src/shared/compute'
import { runWithCleanup, test } from '../fixtures/electron-app'

const enabled = process.env.OPEN_SCIENCE_E2E_REAL_SLURM === '1'
const sshAlias = process.env.COMPUTE_TEST_SSH_ALIAS
const scratchBase = process.env.COMPUTE_SLURM_SCRATCH_ROOT

test.use({ windowMode: 'normal', trace: 'off' })
test.skip(!enabled, 'Requires explicit opt-in to an authorized real Slurm test host.')

for (const scenario of ['witness', 'cancel'] as const) {
  const name =
    scenario === 'witness'
      ? 'runs an SDK task with first-party Slurm approval and downloads the scheduler witness'
      : 'cancels a running Slurm job from an SDK-initiated task'
  test(name, async ({ app }, testInfo) => {
    test.setTimeout(360_000)
    if (
      !sshAlias ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(sshAlias) ||
      !scratchBase ||
      (!posix.isAbsolute(scratchBase) && !scratchBase.startsWith('~/'))
    ) {
      throw new Error(
        'Set a concrete SSH alias and an absolute or home-relative scratch directory.'
      )
    }
    const ssh = async (command: string): Promise<string> => {
      try {
        const { stdout } = await promisify(execFile)(
          resolveSshBinary(),
          ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', sshAlias, command],
          { timeout: 15_000, windowsHide: true }
        )
        return stdout
      } catch {
        throw new Error('The Slurm SSH preflight or empty scratch container cleanup failed.')
      }
    }
    const scratchRoot = scratchBase.startsWith('~/')
      ? posix.join((await ssh('printf "%s\\n" "$HOME"')).trim(), scratchBase.slice(2))
      : scratchBase
    if (!posix.isAbsolute(scratchRoot) || posix.resolve(scratchRoot) === '/') {
      throw new Error('The isolated test scratch parent must resolve below the remote root.')
    }
    const remoteScratch = posix.join(scratchRoot, `open-science-sdk-${randomUUID()}`)
    await ssh(
      `test -w ${shellSingleQuote(scratchRoot)} && command -v sbatch && command -v squeue && command -v scancel`
    )

    await app.completeOnboarding()
    const page = await app.configureFakeAgent()
    await app.isolatedDataRoot()
    const address = new URL(await app.authenticatedWebUrl())
    const token = address.searchParams.get('token')
    if (!token) throw new Error('The isolated Task service did not provide a test token.')
    const sdkEntry = '../../packages/open-science/index.mjs'
    const { OpenScienceClient } = (await import(
      sdkEntry
    )) as typeof import('../../packages/open-science/index')
    const client = new OpenScienceClient({ baseUrl: address.origin, token })
    const providerId = await page.evaluate(
      async ({ alias, scratch }) => {
        const host = await window.api.compute.create({
          sshAlias: alias,
          displayName: 'SDK Slurm acceptance host',
          executionMode: 'slurm'
        })
        await window.api.compute.scratchSet(host.providerId, scratch)
        const probe = await window.api.compute.probe(host.providerId)
        if (probe.detectedScheduler !== 'slurm')
          throw new Error('The test host did not report Slurm.')
        return host.providerId
      },
      { alias: sshAlias, scratch: remoteScratch }
    )
    const project = await client.createProject({ name: 'SDK Slurm acceptance' })
    if (
      !(await client.listConfigurationOptions()).computeHosts.some(
        (host) => host.providerId === providerId && host.executionMode === 'slurm'
      )
    ) {
      throw new Error('The test host is missing from the SDK configuration catalog.')
    }

    const runs = new Set<string>()
    const listJobs = (sessionId: string): Promise<JobSummary[]> =>
      page.evaluate((id) => window.api.compute.jobsList({ sessionId: id }), sessionId)
    const request = async (action: 'deny' | 'finish' | 'cancel'): Promise<Run> => {
      const run = await client.startRun({
        project: project.id,
        prompt: `Start the SDK Slurm acceptance job: ${action}.`,
        permissionProfile: 'auto',
        computeHostIds: [providerId]
      })
      runs.add(run.id)
      expect(run.preferredComputeHostIds).toHaveLength(1)
      const approval = page.getByRole('dialog', { name: 'Allow remote job submission?' })
      const waiting = new AbortController()
      try {
        await Promise.race([
          approval.waitFor({ timeout: 60_000 }),
          client
            .waitForRun(run.id, { signal: waiting.signal, timeoutMs: 65_000 })
            .then((result) => {
              throw new Error(`Task ${result.status} before opening its Slurm approval.`)
            })
        ])
      } finally {
        waiting.abort()
      }
      await expect(approval).toContainText('SDK Slurm acceptance')
      await expect(approval).toContainText('#SBATCH --cpus-per-task=1')
      if (action !== 'deny') {
        await approval.getByRole('button', { name: 'Choose authorization scope' }).click()
        await page.getByRole('menuitemradio', { name: /^Once\b/ }).click()
      }
      const decision = action === 'deny' ? 'Deny' : 'Allow once'
      await approval.getByRole('button', { name: decision, exact: true }).click()
      const result = await client.waitForRun(run.id, { timeoutMs: 50_000 })
      expect(result.status).toBe('completed')
      return result
    }
    const getJobId = (output: string | undefined): string => {
      const jobId = output?.match(/^SDK Slurm submitted: ([a-f0-9-]+)$/)?.[1]
      if (!jobId) throw new Error('SDK Task did not return a persisted Compute Job ID.')
      return jobId
    }

    await runWithCleanup(
      async () => {
        if (scenario === 'witness') {
          const denied = await request('deny')
          expect(denied.output).toBe('SDK Slurm submission denied.')
          expect(await listJobs(denied.sessionId)).toHaveLength(0)

          const submitted = await request('finish')
          const finishedJobId = getJobId(submitted.output)
          await expect
            .poll(
              async () => {
                const job = (await listJobs(submitted.sessionId)).find(
                  (entry) => entry.job_id === finishedJobId
                )
                return [
                  job?.status,
                  job?.exit_code,
                  job?.stdout_tail?.includes('sdk-slurm-stdout'),
                  job?.stderr_tail?.includes('sdk-slurm-stderr'),
                  Boolean(job?.harvested_at)
                ]
              },
              { timeout: 90_000 }
            )
            .toEqual(['success', 0, true, true, true])
          const publish = await client.startRun({
            project: project.id,
            sessionId: submitted.sessionId,
            prompt: `Publish the SDK Slurm acceptance witness: ${finishedJobId}.`
          })
          runs.add(publish.id)
          const result = await client.waitForRun(publish.id, { timeoutMs: 30_000 })
          expect(result.output).toBe('SDK Slurm witness published.')
          const artifact = (await client.listArtifacts(submitted.sessionId)).find(
            (entry) => entry.name === 'slurm-witness.txt'
          )
          if (!artifact) throw new Error('The Slurm witness is missing from SDK artifacts.')
          expect(await (await client.downloadArtifact(artifact.id)).text()).toBe(
            'sdk-slurm-witness\n'
          )
          await testInfo.attach('slurm-sdk-acceptance', {
            contentType: 'application/json',
            body: JSON.stringify({
              deniedWithoutSubmission: true,
              exitCode: 0,
              stdout: true,
              stderr: true,
              artifactDownloaded: true
            })
          })
          return
        }

        const started = await request('cancel')
        const jobId = getJobId(started.output)
        await expect
          .poll(
            async () => {
              const job = (await listJobs(started.sessionId)).find(
                (entry) => entry.job_id === jobId
              )
              return job?.status
            },
            { timeout: 60_000 }
          )
          .toBe('running')
        await page.evaluate((scope) => window.api.compute.jobsCancel(scope), {
          sessionId: started.sessionId,
          projectId: project.id,
          providerId,
          jobId
        })
        await expect
          .poll(
            async () => {
              const job = (await listJobs(started.sessionId)).find(
                (entry) => entry.job_id === jobId
              )
              return job?.cancellation_status
            },
            { timeout: 30_000 }
          )
          .toBe('cancelled')
        await testInfo.attach('slurm-sdk-acceptance', {
          contentType: 'application/json',
          body: JSON.stringify({
            cancellationConfirmed: true
          })
        })
      },
      async () => {
        for (const runId of runs) {
          if ((await client.getRun(runId)).status === 'running') await client.cancelRun(runId)
        }
        for (const session of await client.listSessions(project.id)) {
          const cleanup = await page.evaluate((scope) => window.api.sessions.deleteSession(scope), {
            projectId: project.id,
            sessionId: session.id
          })
          expect(cleanup.status).toBe('deleted')
          if (cleanup.status === 'deleted') expect(cleanup.cleanupPending).not.toBe(true)
        }
        // The deletion owner reaps the jobs. Only empty, UUID-scoped fixture containers remain.
        for (const directory of [
          `${remoteScratch}/.open-science/jobs`,
          `${remoteScratch}/.open-science`,
          remoteScratch
        ]) {
          const path = shellSingleQuote(directory)
          await ssh(`if [ -d ${path} ]; then rmdir -- ${path}; fi`)
        }
      }
    )
  })
}

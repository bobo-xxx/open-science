import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => fixture.home
}))

import { connectToOpenScience } from './index.mjs'
import { parseCliArgs, runTaskCommand } from './cli.mjs'

beforeEach(async () => {
  fixture.home = await mkdtemp(join(tmpdir(), 'osci-discovery-'))
  for (const [index, name] of ['.open-science-project', '.open-science'].entries()) {
    const root = join(fixture.home, name)
    await mkdir(root)
    await writeFile(
      join(root, 'web-service.json'),
      JSON.stringify({ pid: process.pid, port: 44100 + index, startedAt: new Date().toISOString() })
    )
    await writeFile(join(root, 'web-token'), `fixture-token-${index}`)
  }
})
afterEach(async () => {
  await rm(fixture.home, { recursive: true, force: true })
})

const refused = (): TypeError =>
  new TypeError('fetch failed', {
    cause: Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })
  })

it.each([401, 403, 500])(
  'preserves HTTP %s over connection refusal in either candidate order',
  async (status) => {
    for (const reverse of [false, true]) {
      const fetch = vi.fn(async (url: string) => {
        if (url.includes(reverse ? ':44101/' : ':44100/')) return Response.json({}, { status })
        throw refused()
      })
      const log = vi.fn()
      await expect(
        runTaskCommand(parseCliArgs(['doctor', '--json']), {
          connect: () => connectToOpenScience({ env: {}, fetch }),
          log
        })
      ).rejects.toMatchObject({ status })
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(log).not.toHaveBeenCalled()
    }
  }
)

it('reports a missing daemon when both candidates refuse connections', async () => {
  const log = vi.fn()
  const setExitCode = vi.fn()
  const fetch = vi.fn().mockRejectedValue(refused())
  await runTaskCommand(parseCliArgs(['doctor', '--json']), {
    connect: () => connectToOpenScience({ env: {}, fetch }),
    log,
    setExitCode
  })
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
    ready: false,
    checks: { daemon: { status: 'missing' } }
  })
  expect(setExitCode).toHaveBeenCalledWith(3)
})

it('still connects to a healthy later candidate after an earlier HTTP rejection', async () => {
  const fetch = vi.fn(async (url: string) =>
    Response.json({}, { status: url.includes(':44100/') ? 401 : 200 })
  )
  const client = await connectToOpenScience({ env: {}, fetch })
  expect(client.baseUrl).toBe('http://127.0.0.1:44101')
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('uses the announced Task credential and ignores stale Task credentials on legacy runtimes', async () => {
  const modern = join(fixture.home, '.open-science-project')
  const legacy = join(fixture.home, '.open-science')
  await writeFile(
    join(modern, 'web-service.json'),
    JSON.stringify({
      pid: process.pid,
      port: 44100,
      startedAt: new Date().toISOString(),
      taskCredentialVersion: 1
    })
  )
  await writeFile(join(modern, 'task-token'), 'modern-task-token')
  await writeFile(join(legacy, 'task-token'), 'stale-task-token')
  const fetch = vi.fn(async () => Response.json({}))
  await connectToOpenScience({ configRoot: modern, fetch })
  await connectToOpenScience({ configRoot: legacy, fetch })
  expect(fetch).toHaveBeenNthCalledWith(
    1,
    'http://127.0.0.1:44100/api/bootstrap',
    expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer modern-task-token' })
    })
  )
  expect(fetch).toHaveBeenNthCalledWith(
    2,
    'http://127.0.0.1:44101/api/bootstrap',
    expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer fixture-token-1' })
    })
  )
})

it('fails closed when the modern Task credential is missing or rejected', async () => {
  const configRoot = join(fixture.home, '.open-science-project')
  await writeFile(
    join(configRoot, 'web-service.json'),
    JSON.stringify({
      pid: process.pid,
      port: 44100,
      startedAt: new Date().toISOString(),
      taskCredentialVersion: 1
    })
  )
  const fetch = vi.fn(async () => Response.json({}, { status: 401 }))
  await expect(connectToOpenScience({ configRoot, fetch })).rejects.toMatchObject({
    code: 'ENOENT'
  })
  expect(fetch).not.toHaveBeenCalled()
  await writeFile(join(configRoot, 'task-token'), 'rejected-task-token')
  await expect(connectToOpenScience({ configRoot, fetch })).rejects.toMatchObject({ status: 401 })
  expect(fetch).toHaveBeenCalledOnce()
})

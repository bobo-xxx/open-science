/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Exercise the installed SDK against a deterministic local Agent. Linux also runs the Notebook
// sandbox, interpreter and process recovery checks in its existing isolated environment.
import assert from 'node:assert/strict'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { readFile, readdir, mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

assert.ok(['linux', 'darwin', 'win32'].includes(process.platform))
const verifyNotebook = process.platform === 'linux'
const fakeAgent = process.env.OPEN_SCIENCE_TEST_FAKE_AGENT
assert.ok(fakeAgent, 'Set OPEN_SCIENCE_TEST_FAKE_AGENT to the bundled existing E2E agent fixture.')
const packageRoot = resolve(
  process.env.OPEN_SCIENCE_TEST_PACKAGE ?? '/usr/local/lib/node_modules/@aipoch/open-science'
)
const { connectToOpenScience } = await import(pathToFileURL(join(packageRoot, 'index.mjs')).href)
const { locateBackend } = await import(pathToFileURL(join(packageRoot, 'locate-backend.mjs')).href)
const backend = await locateBackend()
const backendLabel = backend.development ? 'source-built backend' : 'installed backend'
console.log(`Verifying ${backendLabel} on ${process.platform}/${process.arch}.`)
const root = await mkdtemp(join(tmpdir(), 'open-science-installed-'))
const bin = join(root, 'bin')
await mkdir(bin)
const agentLauncher = join(bin, process.platform === 'win32' ? 'opencode.cmd' : 'opencode')
const shellArg = (value) => "'" + value.replaceAll("'", "'\\''") + "'"
const batchArg = (value) => '"' + value.replaceAll('%', '%%') + '"'
const launcherContent =
  process.platform === 'win32'
    ? '@echo off\r\nsetlocal DisableDelayedExpansion\r\n' +
      batchArg(process.execPath) +
      ' ' +
      batchArg(resolve(fakeAgent)) +
      ' %*\r\n'
    : '#!/bin/sh\nexec ' +
      shellArg(process.execPath) +
      ' ' +
      shellArg(resolve(fakeAgent)) +
      ' "$@"\n'
await writeFile(agentLauncher, launcherContent, { mode: 0o700 })
const env = {
  // The deterministic Agent and Web service use only loopback. A workstation's proxy setup
  // should not affect the isolated backend or send fixture requests to another machine.
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(?:https?|all|no)_proxy$/iu.test(key))
  ),
  PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter),
  OPEN_SCIENCE_CONFIG_ROOT: root,
  OPEN_SCIENCE_WEB_PORT: '0'
}
const exec = promisify(execFile)
const cli = async (...args) =>
  (
    await exec(process.execPath, [join(packageRoot, 'cli.mjs'), ...args], {
      env,
      timeout: 90_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    })
  ).stdout
const start = () =>
  verifyNotebook
    ? cli('start', '--no-open', '--password-store=gnome-libsecret')
    : cli('start', '--no-open')
let running = false
let abortEvents
let consumeEvents
let restoreMacKeychain
const passed = (message) => console.log(`PASS ${message}`)
const configureMacKeychain = async () => {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Run macOS SDK verification on a hosted runner.')
  assert.equal(process.env.RUNNER_OS, 'macOS')
  assert.equal(backend.development, false)
  const { secretExecutablePath } = createRequire(backend.entry)(
    '@aipoch/credential-identity-probe-native'
  )
  const security = async (...args) => {
    try {
      return await exec('/usr/bin/security', args, { timeout: 10_000 })
    } catch {
      // Do not include command arguments: setup passes disposable passwords on the argv.
      throw new Error(`macOS SDK test Keychain operation failed: ${args[0]}.`)
    }
  }
  const { stdout } = await security('list-keychains', '-d', 'user')
  const previous = stdout
    .split('\n')
    .map((line) => line.trim().match(/^"(.*)"$/u)?.[1])
    .filter(Boolean)
  assert.ok(previous.length, 'Could not save the original Keychain search list.')
  const keychain = join(root, 'test.keychain-db')
  const password = randomUUID()
  await security('create-keychain', '-p', password, keychain)
  restoreMacKeychain = async () => {
    try {
      await security('list-keychains', '-d', 'user', '-s', ...previous)
    } finally {
      await security('delete-keychain', keychain)
    }
  }
  await security('set-keychain-settings', '-lut', '3600', keychain)
  await security('unlock-keychain', '-p', password, keychain)
  await security('list-keychains', '-d', 'user', '-s', keychain)
  // Use the native helper in the verified package with a fresh, disposable OSCrypt identity.
  await security(
    'add-generic-password',
    '-a',
    'Open-Science Key',
    '-s',
    'Open-Science Safe Storage',
    '-w',
    randomUUID(),
    '-T',
    secretExecutablePath,
    keychain
  )
}

const verifyInstalledSdk = async (client) => {
  const project = await client.createProject({ name: 'Installed SDK verification' })
  const defaults = await client.getProjectSessionDefaults(project.id)
  await client.updateProjectSessionDefaults(project.id, {
    expectedUpdatedAt: defaults.updatedAt,
    patch: { permissionProfile: 'ask', delegationPolicy: 'deny', memoryEnabled: false }
  })

  const prompt = 'Reply with a short greeting for the installed SDK test.'
  const request = { project: project.id, prompt }
  const requestId = 'installed-sdk-basic'
  const first = await client.startRun(request, { requestId, timeoutMs: 90_000 })
  const restartedClient = await connectToOpenScience({ configRoot: root })
  const receipt = await restartedClient.submitRun(requestId, request)
  assert.equal(receipt.runId, first.id, 'Retry must keep the original Run identity.')
  const result = await restartedClient.waitForRun(first.id, { timeoutMs: 60_000 })
  assert.equal(result.status, 'completed', result.error)
  assert.match(result.output, /Deterministic reply/)
  const { effective } = await restartedClient.getSessionConfiguration(result.sessionId)
  assert.equal(effective.permissionProfile, 'ask')
  assert.equal(effective.delegationPolicy, 'deny')
  assert.equal(effective.memoryEnabled, false)
  const history = await restartedClient.getSessionHistory(project.id, result.sessionId)
  assert.ok(
    history.messages.some((message) => message.role === 'user' && message.content === prompt)
  )
  assert.ok(history.messages.some((message) => message.role === 'agent'))

  const attachment = await restartedClient.stageRunAttachment(project.id, result.sessionId, {
    name: 'installed-observations.txt',
    mimeType: 'text/plain',
    bytes: new TextEncoder().encode('observation = 42\n')
  })
  const next = await restartedClient.startRun(
    {
      project: project.id,
      sessionId: result.sessionId,
      prompt: 'Acknowledge the attachment for the installed SDK test.',
      attachmentIds: [attachment.id]
    },
    { requestId: 'installed-sdk-attachment', timeoutMs: 90_000 }
  )
  assert.equal(
    (await restartedClient.waitForRun(next.id, { timeoutMs: 60_000 })).status,
    'completed'
  )
  const after = await restartedClient.getSessionHistory(project.id, result.sessionId)
  assert.ok(
    after.messages.some((message) =>
      message.attachments?.some(
        (upload) => upload.name === 'installed-observations.txt' && upload.versionId
      )
    )
  )
  passed('SDK applied defaults, reattached to a durable Run, and published a scoped attachment')
  return { projectId: project.id, sessionId: result.sessionId, runId: next.id }
}

const descendants = async (pid) => {
  const children = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8').catch(() => '')
  const result = []
  for (const child of children.trim().split(/\s+/).filter(Boolean)) {
    const stat = await readFile(`/proc/${child}/stat`, 'utf8').catch(() => '')
    if (stat)
      result.push({ pid: child, started: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] })
    result.push(...(await descendants(child)))
  }
  return result
}
try {
  if (process.platform === 'darwin') await configureMacKeychain()
  // Even if a competing start fails, the successful owner must still be stopped in finally.
  running = true
  const starts = await Promise.allSettled([start(), start()])
  for (const result of starts) assert.equal(result.status, 'fulfilled', result.reason?.message)
  passed('concurrent CLI starts reuse one owner')
  const status = JSON.parse(await cli('status', '--json'))
  assert.equal(status.running, true)
  let state = JSON.parse(await readFile(join(root, 'web-service.json'), 'utf8'))
  const token = (await readFile(join(root, 'web-token'), 'utf8')).trim()
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'x-open-science-client': randomUUID()
  }
  const rpc = async (channel, ...args) => {
    const response = await fetch(
      `http://127.0.0.1:${state.port}/rpc/${encodeURIComponent(channel)}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ protocolVersion: 1, args })
      }
    )
    const body = await response.json()
    assert.equal(body.ok, true, `${channel}: ${JSON.stringify(body)}`)
    return body.result
  }
  const html = await fetch(`http://127.0.0.1:${state.port}/`, { headers })
  assert.equal(html.status, 200)
  assert.match(await html.text(), /<html/)
  passed('authenticated Web UI')
  const project = JSON.parse(await cli('project', 'create', 'Standalone verification', '--json'))
  const projectId = project.id
  assert.ok(projectId)
  if (verifyNotebook) {
    const python = process.env.OPEN_SCIENCE_TEST_PYTHON ?? '/usr/bin/python3'
    await rpc('runtime:register-interpreter', { language: 'python', path: python })
    const environments = await rpc('runtime:list-environments')
    const selected = environments.python.find((entry) => entry.interpreterPath === python)
    assert.ok(selected?.runnable)
    await rpc('runtime:set-environment-enabled', {
      language: 'python',
      envId: selected.envId,
      enabled: true
    })
  }
  const snapshot = await rpc('settings:upsert-provider', {
    type: 'custom',
    name: 'Standalone fixture',
    apiEndpoints: ['chat-completions'],
    baseUrl: 'http://127.0.0.1:9/v1',
    model: 'e2e-model',
    key: 'fixture-key',
    supportsImageInput: true
  })
  const provider = snapshot.providers.find((item) => item.name === 'Standalone fixture')
  assert.deepEqual(provider?.apiEndpoints, ['chat-completions'])
  await rpc('settings:set-active-provider', { id: provider.id, model: 'e2e-model' })
  await rpc('settings:set-agent-framework', { id: 'opencode' })
  const detected = await rpc('settings:detect-opencode')
  assert.equal(detected.opencode.resolvedPath, agentLauncher)
  assert.equal(detected.credentialStore, 'os')

  const client = await connectToOpenScience({ configRoot: root })
  const { appVersion, platform, taskCapabilities } = await client.getCapabilities()
  assert.ok(appVersion)
  assert.equal(platform, process.platform)
  for (const capability of [
    'configuration-options',
    'durable-submissions',
    'session-history',
    'session-run-attachments'
  ]) {
    assert.ok(taskCapabilities.includes(capability), `Installed SDK lacks ${capability}.`)
  }
  assert.ok(
    (await client.listConfigurationOptions()).models.some(
      ({ providerId, model, selectable }) =>
        providerId === provider.id && model === 'e2e-model' && selectable
    )
  )
  passed(`SDK capability and configured model discovery through the ${backendLabel}`)
  abortEvents = new AbortController()
  const events = client.events({ signal: abortEvents.signal })
  await events.ready
  const observed = []
  consumeEvents = (async () => {
    for await (const event of events) observed.push(event)
  })()
  const sdkRun = await verifyInstalledSdk(client)
  let notebook
  if (verifyNotebook) {
    const task = JSON.parse(
      await cli(
        'run',
        '--project',
        projectId,
        '--prompt',
        'Verify Python background completion delivery.',
        '--approval-profile',
        'auto',
        '--wait',
        '--json'
      )
    )
    assert.equal(task.status, 'completed')
    assert.match(task.output, /Background execution submitted/)
    const historyPage = await client.getSessionHistory(projectId, task.sessionId)
    assert.ok(historyPage.messages.some((message) => message.role === 'user'))
    assert.ok(historyPage.messages.some((message) => message.role === 'agent'))
    passed('SDK history projection for a Notebook task')
    const scope = { projectId, sessionId: task.sessionId, workspaceCwd: task.cwd }
    const first = await rpc('notebook:execute', {
      ...scope,
      language: 'python',
      code: 'value = 40\nvalue + 2'
    })
    assert.equal(first.status, 'completed', first.text.stderr)
    assert.ok(
      first.outputs.some(
        (output) => output.type === 'display' && output.data['text/plain'] === '42'
      )
    )
    const second = await rpc('notebook:execute', {
      ...scope,
      language: 'python',
      code: 'value + 3'
    })
    assert.equal(second.status, 'completed', second.text.stderr)
    assert.ok(
      second.outputs.some(
        (output) => output.type === 'display' && output.data['text/plain'] === '43'
      )
    )
    passed('CLI task → real Agent protocol/MCP → sandboxed stateful Python → Web Notebook')
    notebook = { scope, firstRunId: first.runId }
  }

  const eventDeadline = Date.now() + 10_000
  while (!observed.some((event) => event.runId === sdkRun.runId) && Date.now() < eventDeadline) {
    await new Promise((done) => setTimeout(done, 50))
  }
  assert.ok(observed.some((event) => event.runId === sdkRun.runId))
  for (let index = 1; index < observed.length; index++)
    assert.ok(observed[index].sequence > observed[index - 1].sequence)
  passed('SDK event delivery and ordering')

  const held = await client.startRun({
    project: projectId,
    prompt: 'Cold recovery held child.',
    permissionProfile: 'auto'
  })
  await cli('run', 'cancel', held.id, '--json')
  assert.equal((await client.waitForRun(held.id)).status, 'cancelled')
  passed('CLI cancellation of an SDK-started task')
  abortEvents.abort()
  await consumeEvents
  const ownedChildren = verifyNotebook ? await descendants(state.pid) : []
  if (verifyNotebook)
    assert.ok(ownedChildren.length > 0, 'Exercise shutdown with owned child processes.')
  const stopped = JSON.parse(await cli('stop', '--json'))
  running = false
  assert.equal(stopped.result, 'stopped')
  for (const child of ownedChildren) {
    const stat = await readFile(`/proc/${child.pid}/stat`, 'utf8').catch(() => '')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    assert.ok(
      !stat || fields[0] === 'Z' || fields[19] !== child.started,
      `Owned child ${child.pid} remains running.`
    )
  }
  if (verifyNotebook)
    passed('graceful shutdown with live Notebook kernel and no surviving owned children')
  await start()
  running = true
  state = JSON.parse(await readFile(join(root, 'web-service.json'), 'utf8'))
  const reopened = await connectToOpenScience({ configRoot: root })
  assert.equal((await reopened.getRun(sdkRun.runId)).status, 'completed')
  const restoredHistory = await reopened.getSessionHistory(sdkRun.projectId, sdkRun.sessionId)
  assert.ok(
    restoredHistory.messages.some((message) =>
      message.attachments?.some(
        (upload) => upload.name === 'installed-observations.txt' && upload.versionId
      )
    )
  )
  assert.equal(
    (await rpc('settings:detect-opencode')).providers.find((item) => item.id === provider.id)
      .hasKey,
    true
  )
  passed('SDK Run, attachment history and OS-encrypted credentials survived service restart')
  if (notebook) {
    const { scope, firstRunId } = notebook
    const restored = await rpc('sessions:load-one', { projectId, sessionId: scope.sessionId })
    assert.equal(restored.id, scope.sessionId)
    const history = await rpc('notebook:state', scope)
    assert.ok(JSON.stringify(history).includes(firstRunId))
    passed('session/Notebook recovery and OS-encrypted credentials after restart')

    const owner = JSON.parse(await readFile(join(root, 'runtime-owner.json'), 'utf8'))
    const current = JSON.parse(await cli('status', '--json'))
    assert.equal(owner.pid, current.pid)
    process.kill(owner.pid, 'SIGKILL') // This authenticated owner belongs to the isolated test.
    await new Promise((done) => setTimeout(done, 100))
    await start()
    state = JSON.parse(await readFile(join(root, 'web-service.json'), 'utf8'))
    assert.notEqual(state.pid, owner.pid)
    assert.equal(
      (await rpc('sessions:load-one', { projectId, sessionId: scope.sessionId })).id,
      scope.sessionId
    )
    passed('abnormal exit releases ownership; stale records do not prevent recovery')
  }
} catch (error) {
  for (const file of await readdir(root)) {
    if (file.startsWith('cli-daemon-'))
      console.error((await readFile(join(root, file), 'utf8')).slice(-4000))
  }
  throw error
} finally {
  abortEvents?.abort()
  await consumeEvents?.catch(() => undefined)
  try {
    if (running) await cli('stop', '--json')
  } finally {
    await restoreMacKeychain?.()
  }
  // Managed skill snapshots are intentionally read-only; restore only our test directory modes.
  const writableDirectories = async (directory) => {
    await chmod(directory, 0o700)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await writableDirectories(join(directory, entry.name))
    }
  }
  await writableDirectories(root)
  await rm(root, { recursive: true, force: true })
}

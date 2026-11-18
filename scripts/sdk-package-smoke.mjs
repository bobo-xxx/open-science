/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function verifyPackagedSdk({ resourceRoot, endpoint, auth, expectedVersion }) {
  if (process.env.OPEN_SCIENCE_VERIFY_PACKAGED_SDK !== '1') return

  const token = new URLSearchParams(auth).get('token')
  assert.ok(token, 'Missing the isolated package smoke credential')
  const entry = pathToFileURL(join(resourceRoot, 'packages/open-science/index.mjs')).href
  const { OpenScienceClient } = await import(entry)
  const client = new OpenScienceClient({ baseUrl: endpoint, token, requestTimeoutMs: 15000 })
  const capabilities = await client.getCapabilities()
  assert.equal(capabilities.appVersion, expectedVersion)
  assert.equal(capabilities.platform, process.platform)
  for (const capability of [
    'configuration-options',
    'session-history',
    'session-reviews',
    'session-run-attachments'
  ]) {
    assert.ok(capabilities.taskCapabilities.includes(capability), `Missing ${capability}`)
  }
  const options = await client.listConfigurationOptions()
  assert.ok(Array.isArray(options.models) && Array.isArray(options.computeHosts))
  assert.ok(Array.isArray(await client.listProjects()))
  console.log('PASS packaged SDK loading, capability discovery and authenticated reads')
}

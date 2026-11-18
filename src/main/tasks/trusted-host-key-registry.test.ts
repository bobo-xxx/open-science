import { createHash, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createElectronCallerContext,
  createTaskCallerContext,
  createWebCallerContext
} from '../caller-context'
import {
  createTrustedHostKeyRegistry,
  type TrustedHostKeyEnrollment
} from './trusted-host-key-registry'

const desktop = createElectronCallerContext(1)
const web = createWebCallerContext('browser')
const roots: string[] = []

const createProfile = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'open-science-trusted-hosts-'))
  roots.push(root)
  return root
}

const generateHost = (
  label: string
): { input: TrustedHostKeyEnrollment; privateKey: KeyObject } => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const raw = publicKey.export({ format: 'jwk' }).x
  if (!raw) throw new Error('Missing Ed25519 public key.')
  return { input: { label, publicKey: raw }, privateKey }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('trusted host key registry', () => {
  it('persists a profile-scoped public key and keeps its registration ID stable across restart', async () => {
    const root = await createProfile()
    const registry = await createTrustedHostKeyRegistry(root)
    const host = generateHost('Local host')
    const enrollment = await registry.enroll(desktop, host.input)
    const fingerprint = createHash('sha256')
      .update(Buffer.from(host.input.publicKey, 'base64url'))
      .digest('hex')
    expect(enrollment).toMatchObject({ ...host.input, fingerprint })
    expect(registry.list(web)).toEqual([enrollment])
    const contents = await readFile(join(root, 'trusted-host-keys.json'), 'utf8')
    expect(JSON.parse(contents)).toEqual({
      version: 1,
      keys: [{ ...host.input, id: enrollment.id, createdAt: enrollment.createdAt }]
    })

    const reopened = await createTrustedHostKeyRegistry(root)
    expect(reopened.list(web)).toEqual([enrollment])
    const message = Buffer.from('a host confirmation')
    const key = reopened.resolve(enrollment.id)
    expect(key?.asymmetricKeyType).toBe('ed25519')
    expect(key && verify(null, message, key, sign(null, message, host.privateKey))).toBe(true)
    const other = await createTrustedHostKeyRegistry(await createProfile())
    expect(other.resolve(enrollment.id)).toBeUndefined()
  })

  it('requires a current local human for enrollment, listing and revocation', async () => {
    const registry = await createTrustedHostKeyRegistry(await createProfile())
    const host = generateHost('Local browser host')
    const enrollment = await registry.enroll(web, host.input)
    const otherHost = generateHost('Other host')
    for (const caller of [
      createTaskCallerContext(),
      createWebCallerContext('raw-bearer', {
        principalKind: 'automation',
        actionOrigin: 'automation'
      }),
      createWebCallerContext('remote-browser', {
        location: 'remote',
        authorities: ['manage-remote-pairing']
      }),
      createWebCallerContext('expired-browser', { isAuthorizationCurrent: () => false })
    ]) {
      expect(() => registry.list(caller)).toThrow('current local user')
      await expect(registry.enroll(caller, otherHost.input)).rejects.toThrow('current local user')
      await expect(registry.revoke(caller, enrollment.id)).rejects.toThrow('current local user')
    }
    expect(registry.list(desktop)).toEqual([enrollment])
  })

  it('rejects malformed, noncanonical and oversized enrollment input', async () => {
    const registry = await createTrustedHostKeyRegistry(await createProfile())
    const { input } = generateHost('Local host')
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const alias = `${input.publicKey.slice(0, -1)}${alphabet[alphabet.indexOf(input.publicKey.at(-1)!) + 1]}`
    expect(Buffer.from(alias, 'base64url')).toEqual(Buffer.from(input.publicKey, 'base64url'))
    for (const publicKey of [alias, `${input.publicKey}=`, 'too-short', 'x'.repeat(44)]) {
      await expect(registry.enroll(desktop, { ...input, publicKey })).rejects.toThrow('Ed25519')
    }
    await expect(registry.enroll(desktop, { ...input, label: ' ' })).rejects.toThrow()
    await expect(registry.enroll(desktop, { ...input, label: 'x'.repeat(121) })).rejects.toThrow()
    expect(registry.list(desktop)).toEqual([])
  })

  it('serializes concurrent enrollment and revocation without leaving duplicate active IDs', async () => {
    const root = await createProfile()
    const registry = await createTrustedHostKeyRegistry(root)
    const firstHost = generateHost('First host')
    const secondHost = generateHost('Second host')
    const [first, second] = await Promise.all([
      registry.enroll(desktop, firstHost.input),
      registry.enroll(web, secondHost.input)
    ])
    await expect(registry.enroll(web, firstHost.input)).rejects.toThrow('already enrolled')
    const mutations = Promise.all([
      registry.revoke(web, first.id),
      registry.enroll(desktop, firstHost.input),
      registry.revoke(desktop, first.id)
    ])
    await Promise.resolve()
    expect(registry.resolve(first.id)).toBeUndefined()
    const [revoked, reEnrolled, absent] = await mutations
    expect([revoked, absent]).toEqual([true, false])
    expect(registry.resolve(first.id)).toBeUndefined()
    expect(reEnrolled.id).not.toBe(first.id)
    const reopened = await createTrustedHostKeyRegistry(root)
    expect(reopened.list(desktop)).toEqual([second, reEnrolled])
    expect(reopened.resolve(first.id)).toBeUndefined()
  })

  it('does not publish an enrollment when the durable write fails', async () => {
    const root = await createProfile()
    const registry = await createTrustedHostKeyRegistry(root)
    const path = join(root, 'trusted-host-keys.json')
    await mkdir(path)
    const { input } = generateHost('Local host')
    await expect(registry.enroll(desktop, input)).rejects.toThrow()
    expect(registry.list(desktop)).toEqual([])
    await rmdir(path)
    const entry = await registry.enroll(desktop, input)
    expect(registry.resolve(entry.id)?.asymmetricKeyType).toBe('ed25519')
  })

  it('rechecks authority immediately before publishing after the asynchronous write', async () => {
    const root = await createProfile()
    const registry = await createTrustedHostKeyRegistry(root)
    let authorizationChecks = 0
    const expired = createWebCallerContext('expiring-browser', {
      isAuthorizationCurrent: () => ++authorizationChecks <= 2
    })
    const { input } = generateHost('Local host')
    await expect(registry.enroll(expired, input)).rejects.toThrow('current local user')
    expect(registry.list(desktop)).toEqual([])
    const reopened = await createTrustedHostKeyRegistry(root)
    expect(reopened.list(desktop)).toEqual([])
  })

  it('never recovers a revoked key from older temporary documents', async () => {
    const root = await createProfile()
    const registry = await createTrustedHostKeyRegistry(root)
    const path = join(root, 'trusted-host-keys.json')
    const { input } = generateHost('Local host')
    const enrolled = await registry.enroll(desktop, input)
    const previous = await readFile(path, 'utf8')
    await registry.revoke(desktop, enrolled.id)
    await writeFile(`${path}.123.tmp`, previous)

    await writeFile(path, '{')
    await expect(createTrustedHostKeyRegistry(root)).rejects.toThrow()
    await rm(path)
    const reopened = await createTrustedHostKeyRegistry(root)
    expect(reopened.resolve(enrolled.id)).toBeUndefined()
    expect(reopened.list(desktop)).toEqual([])
  })

  it.each(['{', '{"version":2,"keys":[]}', '{"version":1,"keys":[{}]}'])(
    'rejects malformed or unsupported registry contents %s',
    async (contents) => {
      const root = await createProfile()
      await writeFile(join(root, 'trusted-host-keys.json'), contents)
      await expect(createTrustedHostKeyRegistry(root)).rejects.toThrow()
    }
  )
})

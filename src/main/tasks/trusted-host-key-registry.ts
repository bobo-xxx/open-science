import { createHash, createPublicKey, randomUUID, type KeyObject } from 'node:crypto'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { readFileWithinLimit, writeDurableJsonFile } from '@aipoch/durable-files'
import { z } from 'zod'
import { canSatisfyHumanApproval, type CallerContext } from '../caller-context'
import {
  storedTrustedHostKeySchema,
  trustedHostKeyEnrollmentSchema,
  type StoredTrustedHostKey,
  type TrustedHostKey,
  type TrustedHostKeyEnrollment,
  type TrustedHostKeyReview
} from '../../shared/trusted-host-keys'

const TRUSTED_HOST_KEY_FILE = 'trusted-host-keys.json'
const MAX_REGISTRY_BYTES = 1024 * 1024
const registrySchema = z.strictObject({
  version: z.literal(1),
  keys: z.array(storedTrustedHostKeySchema)
})

type RegistryEntry = { stored: StoredTrustedHostKey; view: TrustedHostKey; key: KeyObject }

type TrustedHostKeyRegistry = {
  resolve(id: string): KeyObject | undefined
  list(context: CallerContext): readonly TrustedHostKey[]
  review(context: CallerContext, input: TrustedHostKeyEnrollment): TrustedHostKeyReview
  enroll(context: CallerContext, input: TrustedHostKeyEnrollment): Promise<TrustedHostKey>
  revoke(context: CallerContext, id: string): Promise<boolean>
}

const requireLocalHuman = (context: CallerContext): void => {
  if (
    context.location !== 'local' ||
    (context.surface !== 'electron' && context.surface !== 'web') ||
    !canSatisfyHumanApproval(context)
  ) {
    throw new Error('Trusted host keys require a current local user.')
  }
}

const fingerprint = (publicKey: string): string =>
  createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex')

const createEntry = (stored: StoredTrustedHostKey): RegistryEntry => ({
  stored,
  view: Object.freeze({ ...stored, fingerprint: fingerprint(stored.publicKey) }),
  key: createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: stored.publicKey } })
})

const decodeRegistry = (contents: string): Map<string, RegistryEntry> => {
  const { keys } = registrySchema.parse(JSON.parse(contents))
  const entries = new Map<string, RegistryEntry>()
  const publicKeys = new Set<string>()
  for (const stored of keys) {
    if (entries.has(stored.id) || publicKeys.has(stored.publicKey)) {
      throw new Error('Trusted host key registry contains duplicate keys.')
    }
    entries.set(stored.id, createEntry(stored))
    publicKeys.add(stored.publicKey)
  }
  return entries
}

const readRegistry = async (path: string): Promise<Map<string, RegistryEntry>> => {
  // Crash residues may contain a key that was later revoked. Only load the published primary.
  try {
    return decodeRegistry(await readFileWithinLimit(path, MAX_REGISTRY_BYTES))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return new Map()
    throw error
  }
}

const createTrustedHostKeyRegistry = async (
  configRoot: string
): Promise<TrustedHostKeyRegistry> => {
  const path = join(configRoot, TRUSTED_HOST_KEY_FILE)
  let entries = await readRegistry(path)
  let mutationTail = Promise.resolve()
  let revokingId: string | undefined
  let available = true

  const requireRegistry = (context: CallerContext): void => {
    requireLocalHuman(context)
    if (!available) throw new Error('Trusted host key storage is unavailable.')
  }

  const enqueue = <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const mutation = mutationTail.then(operation)
    mutationTail = mutation.then(
      () => undefined,
      () => undefined
    )
    return mutation
  }

  const commit = async (
    context: CallerContext,
    next: Map<string, RegistryEntry>
  ): Promise<void> => {
    const keys = Array.from(next.values(), ({ stored }) => stored)
    const contents = JSON.stringify({ version: 1, keys }, null, 2) + '\n'
    if (Buffer.byteLength(contents) > MAX_REGISTRY_BYTES) {
      throw new Error('Trusted host key registry is full.')
    }
    let replaced = false
    try {
      await writeDurableJsonFile(path, contents, {
        rename: async (source, destination) => {
          requireRegistry(context)
          await rename(source, destination)
          replaced = true
        }
      })
    } catch (error) {
      // A failed durability acknowledgement after publication leaves the old memory view stale.
      if (replaced) available = false
      throw error
    }
    entries = next
  }

  return {
    resolve(id) {
      return available && id !== revokingId ? entries.get(id)?.key : undefined
    },
    list(context) {
      requireRegistry(context)
      return Array.from(entries.values(), ({ view }) => view)
    },
    review(context, input) {
      requireRegistry(context)
      const enrollment = trustedHostKeyEnrollmentSchema.parse(input)
      return Object.freeze({ ...enrollment, fingerprint: fingerprint(enrollment.publicKey) })
    },
    async enroll(context, input) {
      requireRegistry(context)
      const enrollment = trustedHostKeyEnrollmentSchema.parse(input)
      return enqueue(async () => {
        requireRegistry(context)
        if (
          Array.from(entries.values()).some(
            ({ stored }) => stored.publicKey === enrollment.publicKey
          )
        ) {
          throw new Error('This trusted host key is already enrolled.')
        }
        const entry = createEntry({ ...enrollment, id: randomUUID(), createdAt: Date.now() })
        const next = new Map(entries).set(entry.stored.id, entry)
        await commit(context, next)
        return entry.view
      })
    },
    async revoke(context, id) {
      requireRegistry(context)
      return enqueue(async () => {
        requireRegistry(context)
        if (!entries.has(id)) return false
        const next = new Map(entries)
        next.delete(id)
        revokingId = id
        try {
          await commit(context, next)
          return true
        } finally {
          revokingId = undefined
        }
      })
    }
  }
}

export { createTrustedHostKeyRegistry }
export type { TrustedHostKey, TrustedHostKeyEnrollment, TrustedHostKeyRegistry }

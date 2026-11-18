import { z } from 'zod'
import { defineApplicationCommandContract } from './application-command-contract'

// A raw Ed25519 key is 32 bytes. The unused bits in the last base64url digit are zero.
const publicKeySchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u,
    'Expected a canonical base64url Ed25519 public key.'
  )
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const trustedHostKeyEnrollmentSchema = z.strictObject({
  label: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine((value) => !/[\p{Cc}\p{Bidi_Control}]/u.test(value)),
  publicKey: publicKeySchema
})
const trustedHostKeyReviewSchema = trustedHostKeyEnrollmentSchema.extend({
  fingerprint: fingerprintSchema
})
const storedTrustedHostKeySchema = trustedHostKeyEnrollmentSchema.extend({
  id: z.uuidv4(),
  createdAt: z.int().nonnegative()
})
const trustedHostKeySchema = storedTrustedHostKeySchema.extend({ fingerprint: fingerprintSchema })

type TrustedHostKeyEnrollment = z.infer<typeof trustedHostKeyEnrollmentSchema>
type TrustedHostKeyReview = Readonly<z.infer<typeof trustedHostKeyReviewSchema>>
type StoredTrustedHostKey = z.infer<typeof storedTrustedHostKeySchema>
type TrustedHostKey = Readonly<z.infer<typeof trustedHostKeySchema>>

const trustedHostKeyCommandContracts = {
  list: defineApplicationCommandContract(z.tuple([]), z.array(trustedHostKeySchema).readonly()),
  review: defineApplicationCommandContract(
    z.tuple([trustedHostKeyEnrollmentSchema]),
    trustedHostKeyReviewSchema
  ),
  enroll: defineApplicationCommandContract(
    z.tuple([trustedHostKeyReviewSchema]),
    trustedHostKeySchema
  ),
  revoke: defineApplicationCommandContract(z.tuple([z.uuidv4()]), z.boolean())
}

export {
  storedTrustedHostKeySchema,
  trustedHostKeyCommandContracts,
  trustedHostKeyEnrollmentSchema
}
export type { StoredTrustedHostKey, TrustedHostKey, TrustedHostKeyEnrollment, TrustedHostKeyReview }

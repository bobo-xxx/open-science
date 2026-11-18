import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type {
  ConfirmationChallenge,
  ConfirmationRead,
  InteractionScope,
  SignedConfirmation
} from './task-control-ports'
import { TrustedInteractionDecisions } from './trusted-interaction-decisions'

const scope = { projectId: 'project', sessionId: 'session', interactionId: 'id' }
const hostId = 'host-id'
const disclosure = { command_full: 'printf approved' }
const key = generateKeyPairSync('ed25519')
const otherKey = generateKeyPairSync('ed25519')
const now = 1_000_000
const signText = (message: string, signer = key): string =>
  sign(null, Buffer.from(message), signer.privateKey).toString('base64url')

const signRead = (target: InteractionScope, issuedAt = now, signer = key): ConfirmationRead => ({
  hostId,
  issuedAt,
  signature: signText(
    'Open Science trusted interaction read v1\n' +
      JSON.stringify([
        'compute-approval',
        target.projectId,
        target.sessionId,
        target.interactionId,
        hostId,
        issuedAt
      ]),
    signer
  )
})

const signDecision = (
  challenge: ConfirmationChallenge,
  decision: string,
  signer = key
): SignedConfirmation<string> => ({
  challengeId: challenge.id,
  decision,
  signature: signText(
    'Open Science trusted interaction decision v1\n' + challenge.envelope + '\n' + decision,
    signer
  )
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const createFixture = () => {
  let version = 'first'
  let pending = true
  let enrolled = true
  let clock = now
  const allowedDecisions = ['deny', 'once']
  const claim = vi.fn((_: InteractionScope, expected: string) => {
    if (!pending || expected !== version) return 'unavailable' as const
    pending = false
    return 'claimed' as const
  })
  const owner = {
    kind: 'compute-approval',
    read: vi.fn(() => (pending ? { disclosure, version, allowedDecisions } : undefined)),
    claim
  }
  const broker = new TrustedInteractionDecisions(
    owner,
    (id) => (enrolled && id === hostId ? key.publicKey : undefined),
    () => clock
  )
  const issue = (): ConfirmationChallenge => {
    const challenge = broker.issue(scope, signRead(scope, clock))
    if (!challenge) throw new Error('Expected a pending confirmation challenge.')
    return challenge
  }
  return {
    broker,
    owner,
    issue,
    revoke: () => {
      enrolled = false
    },
    advance: (ms: number) => {
      clock += ms
    },
    revise: () => {
      version = 'second'
    },
    settleNatively: () => {
      pending = false
    }
  }
}

describe('trusted interaction decisions', () => {
  it('discloses only the exact scope signed by an enrolled host', () => {
    const { broker, owner, issue } = createFixture()
    const read = signRead(scope)
    expect(broker.issue({ ...scope, projectId: 'other-project' }, read)).toBeUndefined()
    expect(broker.issue(scope, signRead(scope, now, otherKey))).toBeUndefined()
    expect(broker.issue(scope, signRead(scope, now - 30_001))).toBeUndefined()
    expect(broker.issue(scope, signRead(scope, now + 5_001))).toBeUndefined()
    expect(broker.issue(scope, { ...read, hostId: 'unknown' })).toBeUndefined()
    expect(owner.read).not.toHaveBeenCalled()

    const challenge = issue()
    expect(issue()).toBe(challenge)
    expect(JSON.parse(Buffer.from(challenge.envelope, 'base64url').toString('utf8'))).toEqual({
      ...scope,
      version: 1,
      kind: 'compute-approval',
      serviceGeneration: expect.any(String),
      id: challenge.id,
      hostId,
      expiresAt: now + 120_000,
      contentVersion: 'first',
      disclosure,
      allowedDecisions: ['deny', 'once']
    })
  })

  it('rejects signature tampering and submits one exact decision once', async () => {
    const { broker, owner, issue } = createFixture()
    const challenge = issue()
    const proof = signDecision(challenge, 'once')
    expect(broker.claim(scope, { ...proof, decision: 'deny' })).toBe('invalid-proof')
    expect(broker.claim(scope, signDecision(challenge, 'once', otherKey))).toBe('invalid-proof')
    expect(broker.claim({ ...scope, sessionId: 'other-session' }, proof)).toBe('unavailable')
    expect(owner.claim).not.toHaveBeenCalled()
    const results = await Promise.all(
      [proof, proof].map(async (input) => broker.claim(scope, input))
    )
    expect(results).toEqual(['claimed', 'unavailable'])
    expect(owner.claim).toHaveBeenCalledExactlyOnceWith(scope, 'first', 'once')
  })

  it('rejects a signed scope the owner did not offer', () => {
    const { broker, owner, issue } = createFixture()
    expect(broker.claim(scope, signDecision(issue(), 'global'))).toBe('invalid-decision')
    expect(owner.claim).not.toHaveBeenCalled()
  })

  it('rechecks the owner version and competes with native settlement', () => {
    const { broker, issue, revise, settleNatively } = createFixture()
    const old = issue()
    revise()
    expect(broker.claim(scope, signDecision(old, 'once'))).toBe('unavailable')
    const current = issue()
    settleNatively()
    expect(broker.claim(scope, signDecision(current, 'deny'))).toBe('unavailable')
    expect(broker.issue(scope, signRead(scope))).toBeUndefined()
  })

  it.each(['expiry', 'revocation', 'service restart'] as const)(
    'invalidates an unconsumed proof after %s',
    (cause) => {
      const fixture = createFixture()
      const challenge = fixture.issue()
      if (cause === 'expiry') fixture.advance(120_000)
      if (cause === 'revocation') fixture.revoke()
      if (cause === 'service restart') fixture.broker.reset()
      expect(fixture.broker.claim(scope, signDecision(challenge, 'once'))).toBe('unavailable')
      expect(fixture.owner.claim).not.toHaveBeenCalled()
    }
  )
})

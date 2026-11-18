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
const isCurrent = (): boolean => true
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
const createFixture = (admission?: Promise<void>) => {
  let version = 'first'
  let pending = true
  let enrolled = true
  let clock = now
  const allowedDecisions = ['deny', 'once']
  const claim = vi.fn(
    async (
      _: InteractionScope,
      expected: string,
      _decision: string,
      authorizeAtClaim: () => boolean
    ) => {
      await admission
      if (!authorizeAtClaim() || !pending || expected !== version) return 'unavailable' as const
      pending = false
      return 'claimed' as const
    }
  )
  const owner = {
    kind: 'compute-approval',
    describeDecision: (decision: string): readonly [string, string] => [decision, decision],
    read: vi.fn(() => (pending ? { disclosure, version, allowedDecisions } : undefined)),
    claim
  }
  const broker = new TrustedInteractionDecisions(
    owner,
    (id) => (enrolled && id === hostId ? key.publicKey : undefined),
    () => clock
  )
  const issue = async (): Promise<ConfirmationChallenge> => {
    const challenge = await broker.issue(scope, signRead(scope, clock), isCurrent)
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
  it('discloses only the exact scope signed by an enrolled host', async () => {
    const { broker, owner, issue } = createFixture()
    const read = signRead(scope)
    expect(
      await broker.issue({ ...scope, projectId: 'other-project' }, read, isCurrent)
    ).toBeUndefined()
    expect(await broker.issue(scope, signRead(scope, now, otherKey), isCurrent)).toBeUndefined()
    expect(await broker.issue(scope, signRead(scope, now - 30_001), isCurrent)).toBeUndefined()
    expect(await broker.issue(scope, signRead(scope, now + 5_001), isCurrent)).toBeUndefined()
    expect(await broker.issue(scope, { ...read, hostId: 'unknown' }, isCurrent)).toBeUndefined()
    expect(owner.read).not.toHaveBeenCalled()

    const challenge = await issue()
    expect(await issue()).toBe(challenge)
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
    const challenge = await issue()
    const proof = signDecision(challenge, 'once')
    expect(await broker.claim(scope, { ...proof, decision: 'deny' }, isCurrent)).toBe(
      'invalid-proof'
    )
    expect(await broker.claim(scope, signDecision(challenge, 'once', otherKey), isCurrent)).toBe(
      'invalid-proof'
    )
    expect(await broker.claim({ ...scope, sessionId: 'other-session' }, proof, isCurrent)).toBe(
      'unavailable'
    )
    expect(owner.claim).not.toHaveBeenCalled()
    const results = await Promise.all(
      [proof, proof].map((input) => broker.claim(scope, input, isCurrent))
    )
    expect(results).toEqual(['claimed', 'unavailable'])
    expect(owner.claim).toHaveBeenCalledExactlyOnceWith(
      scope,
      'first',
      'once',
      expect.any(Function)
    )
  })

  it('rejects a signed scope the owner did not offer', async () => {
    const { broker, owner, issue } = createFixture()
    expect(await broker.claim(scope, signDecision(await issue(), 'global'), isCurrent)).toBe(
      'invalid-decision'
    )
    expect(owner.claim).not.toHaveBeenCalled()
  })

  it('rechecks the owner version and competes with native settlement', async () => {
    const { broker, issue, revise, settleNatively } = createFixture()
    const old = await issue()
    revise()
    expect(await broker.claim(scope, signDecision(old, 'once'), isCurrent)).toBe('unavailable')
    const current = await issue()
    settleNatively()
    expect(await broker.claim(scope, signDecision(current, 'deny'), isCurrent)).toBe('unavailable')
    expect(await broker.issue(scope, signRead(scope), isCurrent)).toBeUndefined()
  })

  it.each(['expiry', 'revocation', 'service restart'] as const)(
    'invalidates an unconsumed proof after %s',
    async (cause) => {
      const fixture = createFixture()
      const challenge = await fixture.issue()
      if (cause === 'expiry') fixture.advance(120_000)
      if (cause === 'revocation') fixture.revoke()
      if (cause === 'service restart') fixture.broker.reset()
      expect(await fixture.broker.claim(scope, signDecision(challenge, 'once'), isCurrent)).toBe(
        'unavailable'
      )
      expect(fixture.owner.claim).not.toHaveBeenCalled()
    }
  )
  it.each(['expiry', 'revocation', 'service restart', 'caller disconnect'] as const)(
    'rechecks a reserved proof at the owner claim after %s',
    async (cause) => {
      const admission = Promise.withResolvers<void>()
      const fixture = createFixture(admission.promise)
      let connected = true
      const caller = (): boolean => connected
      const challenge = await fixture.issue()
      const proof = signDecision(challenge, 'once')
      const waiting = fixture.broker.claim(scope, proof, caller)
      expect(fixture.owner.claim).toHaveBeenCalledOnce()
      expect(await fixture.broker.claim(scope, proof, caller)).toBe('unavailable')
      if (cause === 'expiry') fixture.advance(120_000)
      if (cause === 'revocation') fixture.revoke()
      if (cause === 'service restart') fixture.broker.reset()
      if (cause === 'caller disconnect') connected = false
      admission.resolve()
      expect(await waiting).toBe('unavailable')
    }
  )
})

import { randomUUID, verify, type KeyObject } from 'node:crypto'
import type { ElicitationResponse } from '../../shared/elicitation'

import type {
  ConfirmationChallenge,
  ConfirmationClaim,
  ConfirmationRead,
  InteractionScope,
  SignedConfirmation
} from './task-control-ports'

type ConfirmationSnapshot<Disclosure, Decision> = Readonly<{
  version: string
  disclosure: Disclosure
  allowedDecisions: readonly Decision[]
}>

type ConfirmationOwner<Disclosure, Decision, Choice extends string> = {
  kind: string
  read(scope: InteractionScope): ConfirmationSnapshot<Disclosure, Choice> | undefined
  describeDecision(decision: Decision): readonly [choice: Choice, payload: string]
  claim(scope: InteractionScope, version: string, decision: Decision): ConfirmationClaim
}

type StoredChallenge<Decision> = {
  challenge: ConfirmationChallenge
  hostId: string
  scope: InteractionScope
  version: string
  allowedDecisions: readonly Decision[]
}

const READ_MAX_AGE_MS = 30_000
const READ_MAX_FUTURE_MS = 5_000
const CHALLENGE_TTL_MS = 120_000
const MAX_ACTIVE_CHALLENGES = 32
const MAX_ENVELOPE_BYTES = 1024 * 1024
const READ_DOMAIN = 'Open Science trusted interaction read v1\n'
const DECISION_DOMAIN = 'Open Science trusted interaction decision v1\n'

const checkSignature = (key: KeyObject, message: string, signature: string): boolean => {
  if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return false
  const bytes = Buffer.from(signature, 'base64url')
  if (bytes.toString('base64url') !== signature) return false
  return verify(null, Buffer.from(message, 'utf8'), key, bytes)
}

const sameScope = (first: InteractionScope, second: InteractionScope): boolean =>
  first.projectId === second.projectId &&
  first.sessionId === second.sessionId &&
  first.interactionId === second.interactionId

// One broker belongs to one profile's running application. Challenges are process-local.
class TrustedInteractionDecisions<Disclosure, Decision, Choice extends string = Decision & string> {
  private serviceGeneration = randomUUID()
  private readonly challenges = new Map<string, StoredChallenge<Choice>>()

  constructor(
    private readonly owner: ConfirmationOwner<Disclosure, Decision, Choice>,
    private readonly getHostKey: (id: string) => KeyObject | undefined,
    private readonly now: () => number = Date.now
  ) {}

  reset(): void {
    this.challenges.clear()
    this.serviceGeneration = randomUUID()
  }

  issue(scope: InteractionScope, read: ConfirmationRead): ConfirmationChallenge | undefined {
    const now = this.now()
    if (
      !Number.isSafeInteger(read.issuedAt) ||
      read.issuedAt < now - READ_MAX_AGE_MS ||
      read.issuedAt > now + READ_MAX_FUTURE_MS
    ) {
      return undefined
    }
    const key = this.getHostKey(read.hostId)
    if (!key) return undefined
    const readMessage =
      READ_DOMAIN +
      JSON.stringify([
        this.owner.kind,
        scope.projectId,
        scope.sessionId,
        scope.interactionId,
        read.hostId,
        read.issuedAt
      ])
    if (!checkSignature(key, readMessage, read.signature)) return undefined

    const snapshot = this.owner.read(scope)
    if (!snapshot) return undefined

    for (const [id, stored] of this.challenges) {
      if (stored.challenge.expiresAt <= now) {
        this.challenges.delete(id)
      } else if (stored.hostId === read.hostId && sameScope(stored.scope, scope)) {
        if (stored.version === snapshot.version) return stored.challenge
        this.challenges.delete(id)
      }
    }
    if (this.challenges.size >= MAX_ACTIVE_CHALLENGES) return undefined

    const id = randomUUID()
    const expiresAt = now + CHALLENGE_TTL_MS
    const envelope = Buffer.from(
      JSON.stringify({
        version: 1,
        kind: this.owner.kind,
        serviceGeneration: this.serviceGeneration,
        id,
        hostId: read.hostId,
        projectId: scope.projectId,
        sessionId: scope.sessionId,
        interactionId: scope.interactionId,
        expiresAt,
        contentVersion: snapshot.version,
        disclosure: snapshot.disclosure,
        allowedDecisions: snapshot.allowedDecisions
      }),
      'utf8'
    ).toString('base64url')
    if (envelope.length > MAX_ENVELOPE_BYTES) return undefined
    const challenge = Object.freeze({ id, expiresAt, envelope })
    this.challenges.set(id, {
      challenge,
      hostId: read.hostId,
      scope: { ...scope },
      version: snapshot.version,
      allowedDecisions: [...snapshot.allowedDecisions]
    })
    return challenge
  }

  claim(scope: InteractionScope, proof: SignedConfirmation<Decision>): ConfirmationClaim {
    const stored = this.challenges.get(proof.challengeId)
    if (!stored || !sameScope(stored.scope, scope)) return 'unavailable'
    if (stored.challenge.expiresAt <= this.now()) {
      this.challenges.delete(proof.challengeId)
      return 'unavailable'
    }
    const key = this.getHostKey(stored.hostId)
    if (!key) {
      this.challenges.delete(proof.challengeId)
      return 'unavailable'
    }
    const [choice, payload] = this.owner.describeDecision(proof.decision)
    const message = DECISION_DOMAIN + stored.challenge.envelope + '\n' + payload
    if (!checkSignature(key, message, proof.signature)) return 'invalid-proof'

    // The verified proof and the application owner's pending decision are consumed in the same
    // synchronous call. Native responses still settle through that owner's normal claim path.
    this.challenges.delete(proof.challengeId)
    if (stored.challenge.expiresAt <= this.now()) return 'unavailable'
    if (!stored.allowedDecisions.includes(choice)) return 'invalid-decision'
    return this.owner.claim(stored.scope, stored.version, proof.decision)
  }
}

const describeQuestionConfirmationDecision = ({
  action,
  answers
}: Pick<ElicitationResponse, 'action' | 'answers'>): readonly [typeof action, string] => [
  action,
  JSON.stringify([
    action,
    answers?.map((answer) =>
      answer.status === 'skipped'
        ? [answer.fieldId, 'skipped']
        : [answer.fieldId, 'answered', answer.value]
    ) ?? null
  ])
]

export { describeQuestionConfirmationDecision, TrustedInteractionDecisions }

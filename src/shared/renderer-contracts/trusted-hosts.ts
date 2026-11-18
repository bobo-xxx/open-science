import type {
  TrustedHostKey,
  TrustedHostKeyEnrollment,
  TrustedHostKeyReview
} from '../trusted-host-keys'
import { callable, LOCAL, RUNTIME_VALIDATED } from './definition'

export const contracts = {
  'trustedHosts.list': callable<() => Promise<readonly TrustedHostKey[]>>()(
    'trusted-hosts',
    ['trusted-hosts:list', LOCAL, undefined, undefined, RUNTIME_VALIDATED],
    { optionalRoot: true }
  ),
  'trustedHosts.review': callable<
    (input: TrustedHostKeyEnrollment) => Promise<TrustedHostKeyReview>
  >()('trusted-hosts', ['trusted-hosts:review', LOCAL, undefined, undefined, RUNTIME_VALIDATED], {
    optionalRoot: true
  }),
  'trustedHosts.enroll': callable<(input: TrustedHostKeyReview) => Promise<TrustedHostKey>>()(
    'trusted-hosts',
    ['trusted-hosts:enroll', LOCAL, undefined, undefined, RUNTIME_VALIDATED],
    { optionalRoot: true }
  ),
  'trustedHosts.revoke': callable<(id: string) => Promise<boolean>>()(
    'trusted-hosts',
    ['trusted-hosts:revoke', LOCAL, undefined, undefined, RUNTIME_VALIDATED],
    { optionalRoot: true }
  )
} as const

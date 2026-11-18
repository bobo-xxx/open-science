import { ApplicationCommandError } from '../../shared/application-command-contract'
import { trustedHostKeyCommandContracts as contracts } from '../../shared/trusted-host-keys'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar,
  type ApplicationInvocation
} from '../application-command-router'
import { createCallerContext, type CallerContext } from '../caller-context'
import type { TrustedHostKeyRegistry } from './trusted-host-key-registry'

const trustedHostKeyCommandGroup = defineApplicationCommandGroup('trusted-hosts', [
  defineApplicationCommand('trusted-hosts:list', contracts.list),
  defineApplicationCommand('trusted-hosts:review', contracts.review),
  defineApplicationCommand('trusted-hosts:enroll', contracts.enroll),
  defineApplicationCommand('trusted-hosts:revoke', contracts.revoke)
] as const)

const currentCaller = ({
  callerContext,
  callerLease
}: ApplicationInvocation<readonly unknown[]>): CallerContext =>
  createCallerContext({
    ...callerContext,
    isAuthorizationCurrent: () =>
      callerContext.isAuthorizationCurrent() &&
      !callerLease.signal.aborted &&
      callerLease.isCurrent()
  })

const registerTrustedHostKeyCommands = (
  registrar: ApplicationCommandRegistrar,
  owner: TrustedHostKeyRegistry | undefined
): ApplicationCommandInstallation => {
  const requireOwner = (): TrustedHostKeyRegistry => {
    if (owner) return owner
    throw new ApplicationCommandError('command-unavailable', 'Trusted host keys are unavailable.')
  }
  const scope = registrar.createScope()
  try {
    scope.registerGroup(trustedHostKeyCommandGroup, {
      'trusted-hosts:list': ({ callerContext }) => requireOwner().list(callerContext),
      'trusted-hosts:review': ({ callerContext, args: [input] }) =>
        requireOwner().review(callerContext, input),
      'trusted-hosts:enroll': (invocation) => {
        const [{ fingerprint, ...input }] = invocation.args
        const caller = currentCaller(invocation)
        const registry = requireOwner()
        if (registry.review(caller, input).fingerprint !== fingerprint) {
          throw new ApplicationCommandError(
            'invalid-command-arguments',
            'The reviewed fingerprint changed.'
          )
        }
        return registry.enroll(caller, input)
      },
      'trusted-hosts:revoke': (invocation) =>
        requireOwner().revoke(currentCaller(invocation), invocation.args[0])
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}

export { registerTrustedHostKeyCommands, trustedHostKeyCommandGroup }

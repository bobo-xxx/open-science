import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { TrustedHostKey, TrustedHostKeyReview } from '../../../../shared/trusted-host-keys'
import { WEB_CALLER_LOCATION_ATTRIBUTE } from '../../../../shared/web-caller-location'
import { SettingsSection } from './SettingsLayout'

type TrustedHostsApi = NonNullable<Window['api']['trustedHosts']>

const TrustedHostsSettings = ({ api }: { api: TrustedHostsApi }): React.JSX.Element => {
  const { t } = useTranslation()
  const [hosts, setHosts] = useState<readonly TrustedHostKey[]>()
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState('')
  const [publicKey, setPublicKey] = useState('')
  const [review, setReview] = useState<TrustedHostKeyReview>()

  useEffect(() => {
    let current = true
    void api.list().then(
      (keys) => current && setHosts(keys),
      () => current && setError(true)
    )
    return () => {
      current = false
    }
  }, [api])

  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(false)
    try {
      await operation()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  const closeEditor = (): void => {
    setEditing(false)
    setLabel('')
    setPublicKey('')
    setReview(undefined)
    setError(false)
  }

  return (
    <SettingsSection
      title={t('Trusted hosts')}
      description={t(
        'Registered host components can submit decisions you confirm in their interface.'
      )}
      className="pt-5"
      data-settings-anchor="permissions.trusted-hosts"
      action={
        hosts && !editing ? (
          <Button type="button" variant="outline" onClick={() => setEditing(true)} disabled={busy}>
            {t('Register host')}
          </Button>
        ) : undefined
      }
    >
      {error && <ErrorNotice inline title={t('Could not manage trusted hosts.')} />}
      {hosts?.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('No trusted hosts registered.')}</p>
      )}
      {hosts?.map((host) => (
        <div
          key={host.id}
          className="flex flex-wrap items-start justify-between gap-3 border-b border-border py-3"
        >
          <dl className="min-w-0 flex-1 space-y-1 text-sm">
            <dt className="font-medium break-words">{host.label}</dt>
            <dd className="text-muted-foreground">
              {t('Key fingerprint')} <code className="break-all">{host.fingerprint}</code>
            </dd>
            <dd className="text-muted-foreground">
              {t('Registration ID')} <code className="break-all">{host.id}</code>
            </dd>
          </dl>
          <Button
            type="button"
            variant="outline"
            aria-label={t('Revoke {{name}}', { name: host.label })}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api.revoke(host.id)
                setHosts((previous) => previous?.filter(({ id }) => id !== host.id))
              })
            }
          >
            {t('Revoke host')}
          </Button>
        </div>
      ))}
      {editing && (
        <div className="mt-4 max-w-xl space-y-3">
          {review ? (
            <>
              <p className="text-sm">
                {t('Compare this fingerprint with the one shown by your host component.')}
              </p>
              <p className="text-sm font-medium break-words">{review.label}</p>
              <code className="block text-sm break-all">{review.fingerprint}</code>
            </>
          ) : (
            <>
              <label className="block space-y-1 text-sm">
                <span>{t('Host component name')}</span>
                <Input
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  maxLength={120}
                  disabled={busy}
                />
              </label>
              <label className="block space-y-1 text-sm">
                <span>{t('Ed25519 public key')}</span>
                <Input
                  value={publicKey}
                  onChange={(event) => setPublicKey(event.target.value)}
                  spellCheck={false}
                  disabled={busy}
                />
              </label>
            </>
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={closeEditor}>
              {t('Cancel')}
            </Button>
            {review ? (
              <Button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const host = await api.enroll(review)
                    setHosts((previous) => [...(previous ?? []), host])
                    closeEditor()
                  })
                }
              >
                {t('Confirm host registration')}
              </Button>
            ) : (
              <Button
                type="button"
                disabled={busy || !label.trim() || !publicKey.trim()}
                onClick={() =>
                  void run(async () => {
                    setReview(
                      await api.review({ label: label.trim(), publicKey: publicKey.trim() })
                    )
                  })
                }
              >
                {t('Review host key')}
              </Button>
            )}
          </div>
        </div>
      )}
    </SettingsSection>
  )
}

const TrustedHostsSection = (): React.JSX.Element | null => {
  const api = window.api.trustedHosts
  if (!api || document.documentElement.getAttribute(WEB_CALLER_LOCATION_ATTRIBUTE) === 'remote') {
    return null
  }
  return <TrustedHostsSettings api={api} />
}

export { TrustedHostsSection }

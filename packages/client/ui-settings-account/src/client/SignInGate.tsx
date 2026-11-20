/** Blocking Web sign-in surface; plain browsers have no Desktop Welcome window. */
import { useId, useState } from 'react'
import { Button, IconLoadingOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SignInAttemptId, SignInAttemptView } from '@deepseek-ai/dsh-deepseek-account/types'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { AccountSnapshot } from './AccountSection.tsx'
import { authorizeUrlWithTheme } from './authorize-url.ts'
import type { AccountKey } from './locales.ts'
import { OnboardingSurface } from './OnboardingSurface.tsx'
import css from './SignInGate.module.css'

/** Account and theme streams plus the device-authorization actions owned by the account plugin. */
export interface SignInGateInjected {
  hooks: {
    account: HostObservable<AccountSnapshot>
    theme: HostObservable<ThemeSnapshot>
  }
  /** @returns after the login attempt is created. */
  start: () => Promise<void>
  /** @param id - attempt to cancel. @returns after cancellation or an already-admitted commit. */
  cancel: (id: SignInAttemptId) => Promise<void>
}

/** One rendered gate screen; both text fields name `settings.account` keys, never copy. */
interface GateScreen {
  headingKey: AccountKey
  bodyKey: AccountKey
  /** The attempt awaits the account center: shows its authorization link and Cancel instead of Sign in. */
  running: boolean
  /** Start a fresh attempt after a terminal outcome instead of the first sign-in. */
  retry: boolean
  /** No command this process can run advances the screen, so the card renders none. */
  noAction?: true
}

const entry: GateScreen = { headingKey: 'webSignInTitle', bodyKey: 'webSignInDescription', running: false, retry: false }
const loading: GateScreen = { ...entry, bodyKey: 'loading' }
const failure: GateScreen = { headingKey: 'failureTitle', bodyKey: 'failed', running: false, retry: true }
// The account's data root belongs to another process, so the only way forward is to start the
// application again; the card names that and offers no command this process can run.
const rootRestart: GateScreen = {
  headingKey: 'rootRestartTitle', bodyKey: 'rootRestartDescription', running: false, retry: false, noAction: true,
}

/** Screen per attempt phase; `succeeded` keeps progress until the stored-credential frame arrives. */
const screenByPhase: Record<SignInAttemptView['phase'], GateScreen> = {
  initializing: { headingKey: 'browserTitle', bodyKey: 'initializing', running: true, retry: false },
  'waiting-browser': { headingKey: 'browserTitle', bodyKey: 'waiting', running: true, retry: false },
  exchanging: { headingKey: 'browserTitle', bodyKey: 'completing', running: true, retry: false },
  committing: { headingKey: 'browserTitle', bodyKey: 'completing', running: true, retry: false },
  succeeded: { headingKey: 'browserTitle', bodyKey: 'completing', running: true, retry: false },
  cancelled: entry,
  expired: { headingKey: 'timeoutTitle', bodyKey: 'timeoutDescription', running: false, retry: true },
  failed: { headingKey: 'failureTitle', bodyKey: 'failed', running: false, retry: true },
}

/**
 * @param props - account and theme subscriptions, sign-in actions, and localized copy.
 * @returns the full-screen sign-in card, or nothing once a credential is stored.
 */
export function SignInGate({ useAccount, useTheme, start, cancel, t }:
  PropsRuntime<'shell.overlay'> & PropsLocale<'settings.account'> & InjectFace<SignInGateInjected>) {
  const headingId = useId()
  const account = useAccount(value => value)
  const colorScheme = useTheme(snapshot => snapshot.active.colorScheme)
  const [busy, setBusy] = useState(false)
  const view = account.view
  if (view?.status === 'credential-stored') return null
  const attempt = view?.attempt ?? null
  // A refused start request or a closed stream outranks any phase the Host still reports.
  const refused = account.failed || account.loginFailed === true
  // A sign-in that pointed this machine at another account's data root cannot serve that root from
  // this process, so the card names the restart instead of the attempt it just finished.
  const screen = view?.restartRequired === true ? rootRestart
    : view === undefined ? (refused ? failure : loading)
      : refused ? failure : attempt === null ? entry : screenByPhase[attempt.phase]
  const body: AccountKey = attempt?.phase === 'failed' && attempt.errorCode === 'no-response'
    ? 'noResponse' : screen.bodyKey
  const committing = attempt?.phase === 'committing'
  const link = attempt?.authorizeUrl === undefined
    ? undefined : authorizeUrlWithTheme(attempt.authorizeUrl, colorScheme)

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try { await action() } catch (_error) {
      // start() publishes loginFailed, which renders the failure screen.
    } finally { setBusy(false) }
  }

  return <OnboardingSurface>
    <section className={css.gate} aria-labelledby={headingId}>
      <h1 id={headingId} className={css.heading}>{t(screen.headingKey)}</h1>
      <p className={css.body} role={screen.running ? 'status' : undefined}>{t(body)}</p>
      {screen.running && link !== undefined ? <div className={css.link}>
        <a className={css.authorizeUrl} href={link} target="_blank" rel="noopener noreferrer">{link}</a>
        <Button variant="outline" className={css.secondaryButton}
          onClick={() => { window.open(link, '_blank', 'noopener,noreferrer') }}>{t('open')}</Button>
      </div> : null}
      {screen.noAction === true ? null : <div className={css.actions}>
        {screen.running
          ? <Button variant="outline" className={css.secondaryButton} disabled={busy || committing}
            onClick={() => { if (attempt !== null) void run(async () => { await cancel(attempt.id) }) }}>
            {t('cancel')}
          </Button>
          : <Button variant="primary" className={css.primaryButton} disabled={busy || view === undefined}
            onClick={() => { void run(async () => {
              if (screen.retry && attempt !== null) await cancel(attempt.id)
              await start()
            }) }}>
            {busy ? <IconLoadingOutlineRegular className={css.spinner} size={14} /> : t(screen.retry ? 'retry' : 'signIn')}
          </Button>}
      </div>}
    </section>
  </OnboardingSurface>
}

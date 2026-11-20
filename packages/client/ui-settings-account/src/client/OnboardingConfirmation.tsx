/** Setup confirmation with contained keyboard focus. */
import { Button, IconCloseOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DesktopOnboardingProps } from './onboarding-contract.ts'
import css from './DesktopOnboarding.module.css'

/** @param props - localized copy and navigation callbacks. @returns a focus-contained dialog. */
export function OnboardingConfirmation({ t, busy, onClose, onContinueSetup, onSkip }:
  Pick<DesktopOnboardingProps, 't'> & {
    busy: boolean
    onClose: () => void
    onContinueSetup: () => void
    onSkip: () => void
  }) {
  const title = t('onboardingSkipTitle')
  return <Modal open headless backdropBlur={false} title={title} onClose={onClose}>
    <div className={css.confirmation}>
      <div className={css.confirmationHeading}><h2>{title}</h2>
        <button type="button" className={css.confirmationClose} aria-label={t('close')} onClick={onClose}><IconCloseOutlineRegular size={14} /></button>
      </div>
      <p>{t('onboardingSkipDescription')}</p>
      <div className={css.confirmationActions}>
        <Button className={css.dialogButton} variant="outline" disabled={busy} onClick={onContinueSetup}>{t('onboardingKeepSetting')}</Button>
        <Button className={css.dialogButton} variant="primary" disabled={busy} onClick={onSkip}>{t('onboardingEnter')}</Button>
      </div>
    </div>
  </Modal>
}
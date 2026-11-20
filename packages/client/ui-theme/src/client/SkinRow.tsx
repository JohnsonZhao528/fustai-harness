/**
 * Skin row registered into the General section item slot: title + one card per
 * built-in skin with a palette preview. Registered by this package — the theme
 * feature owns its own settings surface. Selection follows the persisted skin,
 * never a resolved palette; the light/dark preference stays independent.
 */
import clsx from 'clsx'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSkin } from '../theme-settings.ts'
import type { ThemeKey } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { createSkinRowStore } from './settings-store.ts'
import css from './SkinRow.module.css'

/** Injected business face: the skin write (t rides the standard locale seat). */
export interface SkinRowInjected {
  /** Switch the palette skin. */
  setSkin: (skin: ThemeSkin) => void
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type SkinRowComponentProps =
  PropsRuntime<'settings.general.item'> & PropsStore<ReturnType<typeof createSkinRowStore>>
  & PropsLocale<'settings.theme'> & SkinRowInjected

/** Card order, copy keys, and the preview palette class per built-in skin. */
const SKINS: readonly { id: ThemeSkin; labelKey: ThemeKey; descriptionKey: ThemeKey; previewClass: string | undefined }[] = [
  { id: 'a', labelKey: 'skin.a', descriptionKey: 'skin.a.description', previewClass: css.previewA },
  { id: 'b', labelKey: 'skin.b', descriptionKey: 'skin.b.description', previewClass: css.previewB },
  { id: 'c', labelKey: 'skin.c', descriptionKey: 'skin.c.description', previewClass: css.previewC },
]

/**
 * Render the skin row.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function SkinRow({ t, setSkin, useStore }: SkinRowComponentProps) {
  const skin = useStore(s => s.skin)
  return (
    <div className={css.group}>
      <div className={css.title}>{t('skin.title')}</div>
      <div className={css.cardRow}>
        {SKINS.map(({ id, labelKey, descriptionKey, previewClass }) => (
          <button
            key={id}
            type="button"
            className={clsx(css.skinCard, skin === id && css.selected)}
            aria-pressed={skin === id}
            onClick={() => { setSkin(id) }}
          >
            <span className={clsx(css.preview, previewClass)} aria-hidden="true">
              <span className={css.previewSurface} />
              <span className={css.previewAccent} />
            </span>
            <span className={css.skinText}>
              <span className={css.skinName}>{t(labelKey)}</span>
              <span className={css.skinDescription}>{t(descriptionKey)}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

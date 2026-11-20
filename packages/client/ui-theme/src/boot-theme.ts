/**
 * Theme bootstrap row for the browser's pre-plugin interval. Each index
 * render embeds the current durable built-in preference, skin, font sizes, and
 * font-family lists. Head CSS colors the document canvas before script
 * execution; the body script installs the skin selector, the palette selector,
 * and font variables that the client presenters adopt.
 */

import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import {
  DEFAULT_FONT_SIZES, DEFAULT_PREFERENCE, DEFAULT_SKIN, FONT_ROLES, FONT_SIZE_SPECS, fontFamilyVariable, normalizeFontFamily,
  type FontFamilies, type FontSizes, type ThemePreference, type ThemeSkin,
} from './theme-settings.ts'

/**
 * Canvas colors per skin: the light and dark values each skin's
 * `--dsw-alias-bg-base` resolves to, so the first paint matches the skin
 * instead of flashing the default palette.
 */
const SKIN_BACKGROUNDS = {
  a: { light: '#f5f3ed', dark: '#121310' },
  b: { light: '#f7f7f5', dark: '#0b0b0c' },
  c: { light: '#fbf7f2', dark: '#141110' },
} as const satisfies Record<ThemeSkin, { light: string; dark: string }>

/** CSS that colors the document canvas before any script executes. */
function bootThemeStyle(preference: ThemePreference, skin: ThemeSkin): string {
  const background = SKIN_BACKGROUNDS[skin]
  const light = `:root{color-scheme:light}body{background-color:${background.light};--dsh-boot-bg:${background.light}}`
  const dark = `:root{color-scheme:dark}body{background-color:${background.dark};--dsh-boot-bg:${background.dark}}`
  if (preference === 'light') return light
  if (preference === 'dark') return dark
  return `${light}@media(prefers-color-scheme:dark){${dark}}`
}

/** Build the body script that installs the skin, palette selector, and font variables. */
function bootThemeBodyScript(
  preference: ThemePreference,
  skin: ThemeSkin,
  fontSizes: FontSizes,
  fontFamilies: FontFamilies,
): string {
  const sizes = FONT_ROLES.map(role =>
    `\n  document.body.style.setProperty(${JSON.stringify(FONT_SIZE_SPECS[role].variable)}, ${JSON.stringify(`${fontSizes[role]}px`)})`).join('')
  const families = FONT_ROLES.flatMap((kind) => {
    const list = normalizeFontFamily(fontFamilies[kind])
    return list === '' ? [] : [`\n  document.body.style.setProperty(${JSON.stringify(fontFamilyVariable(kind))}, ${JSON.stringify(list)})`]
  }).join('')
  return `(() => {
  const preference = ${JSON.stringify(preference)}
  const systemDark = preference === 'system'
    && typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-color-scheme: dark)').matches
  const dark = preference === 'dark' || systemDark
  document.documentElement.dataset.dsThemeSource = preference
  document.body.dataset.dshSkin = ${JSON.stringify(skin)}
  document.body.toggleAttribute('data-ds-dark-theme', dark)${sizes}${families}
})()`
}

/**
 * Theme bootstrap rows: head CSS colors the document canvas before
 * first paint, then the body script installs the skin selector, the palette
 * selector, and the font size and font families before the shell mount and
 * module script.
 * @param preference - Current Host-backed built-in preference.
 * @param skin - Current Host-backed skin.
 * @param fontSizes - Current Host-backed font sizes in px by role.
 * @param fontFamilies - Current Host-backed font lists; each is normalized before embedding.
 * @returns head and body script rows in execution order.
 */
export function bootThemeInjections(
  preference: ThemePreference = DEFAULT_PREFERENCE,
  skin: ThemeSkin = DEFAULT_SKIN,
  fontSizes: FontSizes = DEFAULT_FONT_SIZES,
  fontFamilies: FontFamilies = { text: '', code: '', terminal: '' },
): IndexInjection[] {
  return [
    { kind: 'style', text: bootThemeStyle(preference, skin) },
    { kind: 'script', placement: 'body', text: bootThemeBodyScript(preference, skin, fontSizes, fontFamilies) },
  ]
}

// @vitest-environment jsdom
/** Web sign-in gate: blocks the app, surfaces the authorization link, and releases on a stored credential. */
import type { AccountView, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AccountSnapshot } from '../src/client/AccountSection.tsx'
import { SignInGate } from '../src/client/SignInGate.tsx'
import type { AccountKey } from '../src/client/locales.ts'
import { en, zh } from '../src/client/locales.ts'

const attemptId = 'gate-attempt' as SignInAttemptId
const authorizeUrl = 'https://account.fustai.com/dsh/authorize?state=example'
const links = { usageUrl: 'https://example.com/usage', topUpUrl: 'https://example.com/top_up' }
let appRoot: HTMLDivElement

beforeEach(() => {
  appRoot = document.createElement('div')
  appRoot.id = 'root'
  appRoot.inert = false
  const content = document.createElement('p')
  content.textContent = 'workspace'
  appRoot.append(content)
  document.body.append(appRoot)
})

afterEach(() => {
  cleanup()
  appRoot.remove()
  vi.unstubAllGlobals()
})

const themeOf = (colorScheme: 'light' | 'dark'): ThemeSnapshot => ({
  preference: colorScheme, skin: 'a', fontSizes: { text: 14, code: 11, terminal: 13 },
  fontFamilies: { text: '', code: '', terminal: '' },
  active: { id: colorScheme, colorScheme, tokens: {} }, themes: [], revision: 0,
})

/** One attempt that awaits the account center, with the link the gate must surface. */
function awaitingBrowser(phase: 'initializing' | 'waiting-browser' | 'exchanging' | 'committing' | 'succeeded')
  : AccountView {
  return { status: 'signed-out', attempt: { id: attemptId, phase, authorizeUrl }, links }
}

function mount(initial: AccountView | undefined, copy: typeof en | typeof zh = en, colorScheme: 'light' | 'dark' = 'dark') {
  let account: AccountSnapshot = { view: initial, details: undefined, avatar: undefined, failed: false }
  const start = vi.fn(async () => {})
  const cancel = vi.fn(async () => {})
  // The gate consumes no global hooks; the shell supplies them in the application.
  const globals = {} as GlobalStandardProps
  const element = () => <SignInGate {...globals}
    useAccount={select => select(account)}
    useTheme={select => select(themeOf(colorScheme))}
    start={start} cancel={cancel} t={key => key in copy ? copy[key as AccountKey] : key} />
  const view = render(element())
  return {
    start,
    cancel,
    publish(next: AccountView | undefined, failed = false) {
      account = { view: next, details: undefined, avatar: undefined, failed }
      view.rerender(element())
    },
  }
}

it.each([[en], [zh]])('blocks the signed-out app behind the sign-in card', (copy) => {
  mount({ status: 'signed-out', attempt: null, links }, copy)
  expect(screen.getByRole('heading', { level: 1, name: copy.webSignInTitle })).toBeTruthy()
  expect(screen.getByText(copy.webSignInDescription).textContent).toBe(copy.webSignInDescription)
  const signIn = screen.getByRole('button', { name: copy.signIn }) as HTMLButtonElement
  expect(signIn.disabled).toBe(false)
  // The shell renders overlays beside the panels from one 'root' registration, so the gate masks the
  // app instead of unmounting it: `inert` removes the panels from focus, opacity 0 and visibility
  // hidden remove them from view and the accessibility tree, and only the portalled card stays reachable.
  expect(appRoot.inert).toBe(true)
  expect(appRoot.style.opacity).toBe('0')
  expect(appRoot.style.visibility).toBe('hidden')
  expect(screen.getByRole('heading', { level: 1 }).closest('#root')).toBeNull()
})

it('holds the card until the first account frame arrives', () => {
  const gate = mount(undefined)
  expect(screen.getByText(en.loading).textContent).toBe(en.loading)
  expect((screen.getByRole('button', { name: en.signIn }) as HTMLButtonElement).disabled).toBe(true)
  gate.publish({ status: 'signed-out', attempt: null, links })
  expect((screen.getByRole('button', { name: en.signIn }) as HTMLButtonElement).disabled).toBe(false)
})

it.each([[en], [zh]])('names the restart when a sign-in selected another account data root', (copy) => {
  const gate = mount({ status: 'signed-out', restartRequired: true,
    attempt: { id: attemptId, phase: 'succeeded', authorizeUrl }, links }, copy)
  expect(screen.getByRole('heading', { level: 1, name: copy.rootRestartTitle })).toBeTruthy()
  expect(screen.getByText(copy.rootRestartDescription).textContent).toBe(copy.rootRestartDescription)
  // Starting another attempt keeps pointing at the same root, so the card offers no command.
  expect(screen.queryAllByRole('button')).toHaveLength(0)
  expect(appRoot.inert).toBe(true)
  expect(gate.start).not.toHaveBeenCalled()
})

it('offers the authorization link and opens the sign-in page while an attempt runs', async () => {
  const opened = vi.spyOn(window, 'open').mockReturnValue(null)
  const gate = mount(awaitingBrowser('waiting-browser'))
  expect(screen.getByRole('heading', { level: 1, name: en.browserTitle })).toBeTruthy()
  expect(screen.getByRole('status').textContent).toBe(en.waiting)
  const link = screen.getByRole('link')
  expect(link.getAttribute('href')).toBe(`${authorizeUrl}&theme=dark`)
  expect(link.textContent).toBe(`${authorizeUrl}&theme=dark`)
  expect(screen.queryByRole('button', { name: en.signIn })).toBeNull()
  await act(async () => { screen.getByRole('button', { name: en.open }).click() })
  expect(opened).toHaveBeenCalledWith(`${authorizeUrl}&theme=dark`, '_blank', 'noopener,noreferrer')
  expect(gate.start).not.toHaveBeenCalled()
})

it('starts sign-in from the card and cancels back to the entry screen', async () => {
  const gate = mount({ status: 'signed-out', attempt: null, links })
  await act(async () => { screen.getByRole('button', { name: en.signIn }).click() })
  expect(gate.start).toHaveBeenCalledOnce()
  gate.publish(awaitingBrowser('waiting-browser'))
  await act(async () => { screen.getByRole('button', { name: en.cancel }).click() })
  expect(gate.cancel).toHaveBeenCalledExactlyOnceWith(attemptId)
  gate.publish({ status: 'signed-out', attempt: { id: attemptId, phase: 'cancelled', authorizeUrl }, links })
  expect(screen.getByRole('heading', { level: 1, name: en.webSignInTitle })).toBeTruthy()
  expect(screen.queryByRole('link')).toBeNull()
  expect(screen.getByRole('button', { name: en.signIn })).toBeTruthy()
})

it('reports a refused first frame and retries once an account view arrives', async () => {
  const gate = mount(undefined)
  gate.publish(undefined, true)
  expect(screen.getByRole('heading', { level: 1, name: en.failureTitle })).toBeTruthy()
  expect(screen.getByText(en.failed).textContent).toBe(en.failed)
  expect((screen.getByRole('button', { name: en.retry }) as HTMLButtonElement).disabled).toBe(true)
  gate.publish({ status: 'signed-out', attempt: null, links }, true)
  await act(async () => { screen.getByRole('button', { name: en.retry }).click() })
  expect(gate.start).toHaveBeenCalledOnce()
  expect(gate.cancel).not.toHaveBeenCalled()
})

it('keeps Cancel inert while the attempt commits its credential', () => {
  const gate = mount(awaitingBrowser('committing'))
  const cancel = screen.getByRole('button', { name: en.cancel }) as HTMLButtonElement
  expect(cancel.disabled).toBe(true)
  cancel.click()
  expect(gate.cancel).not.toHaveBeenCalled()
})

it('disables Cancel while a cancellation is in flight', async () => {
  const gate = mount(awaitingBrowser('waiting-browser'))
  let settle: () => void = () => {}
  gate.cancel.mockImplementation(() => new Promise<void>((resolve) => { settle = resolve }))
  act(() => { screen.getByRole('button', { name: en.cancel }).click() })
  expect((screen.getByRole('button', { name: en.cancel }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => { settle() })
  expect((screen.getByRole('button', { name: en.cancel }) as HTMLButtonElement).disabled).toBe(false)
})

it('offers a fresh attempt once the device code expires', async () => {
  const gate = mount({ status: 'signed-out',
    attempt: { id: attemptId, phase: 'expired', errorCode: 'expired', authorizeUrl }, links })
  expect(screen.getByRole('heading', { level: 1, name: en.timeoutTitle })).toBeTruthy()
  expect(screen.getByText(en.timeoutDescription).textContent).toBe(en.timeoutDescription)
  await act(async () => { screen.getByRole('button', { name: en.retry }).click() })
  expect(gate.cancel).toHaveBeenCalledExactlyOnceWith(attemptId)
  expect(gate.start).toHaveBeenCalledOnce()
})

it('reports a failed attempt without leaving the gate', () => {
  mount({ status: 'signed-out',
    attempt: { id: attemptId, phase: 'failed', errorCode: 'no-response', authorizeUrl }, links })
  expect(screen.getByRole('heading', { level: 1, name: en.failureTitle })).toBeTruthy()
  expect(screen.getByText(en.noResponse).textContent).toBe(en.noResponse)
  expect(screen.getByRole('button', { name: en.retry })).toBeTruthy()
})

it('refuses the app for a stream that reports no credential', async () => {
  const gate = mount({ status: 'signed-out', attempt: null, links })
  gate.publish({ status: 'signed-out', attempt: null, links }, true)
  expect(screen.getByRole('heading', { level: 1, name: en.failureTitle })).toBeTruthy()
  await act(async () => { screen.getByRole('button', { name: en.retry }).click() })
  expect(gate.start).toHaveBeenCalledOnce()
})

it('removes the card once a credential is stored', () => {
  const gate = mount({ status: 'signed-out', attempt: null, links })
  expect(appRoot.inert).toBe(true)
  gate.publish({ status: 'credential-stored', attempt: null, links })
  expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
  expect(appRoot.inert).toBe(false)
  expect(appRoot.style.opacity).toBe('')
  expect(appRoot.style.visibility).toBe('')
  expect(screen.getByText('workspace')).toBeTruthy()
})

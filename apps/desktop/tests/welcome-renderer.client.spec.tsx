// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Welcome } from '../src/client/WelcomePage.tsx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { AccountView, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
import type { WelcomeNotice } from '../src/welcome-api.ts'

const html = readFileSync(join(import.meta.dirname, '../renderer/welcome.html'), 'utf8')
afterEach(cleanup)

function mount(language = 'zh-CN', takeNotice = vi.fn<() => Promise<WelcomeNotice | undefined>>().mockResolvedValue(undefined)) {
  cleanup()
  const stopAccount = vi.fn()
  const api = {
    takeNotice,
    analytics: vi.fn(async (_event: string, _attributes: object) => {}),
    analyticsEnabled: async () => true,
    onAccountState: vi.fn((_listener: (state: AccountView) => void) => stopAccount),
    startSignIn: vi.fn(async (): Promise<AccountView> => ({ links: { usageUrl: 'http://localhost/usage', topUpUrl: 'http://localhost/top_up' }, status: 'signed-out', attempt: null })),
    cancelSignIn: vi.fn(async (): Promise<AccountView> => ({ links: { usageUrl: 'http://localhost/usage', topUpUrl: 'http://localhost/top_up' }, status: 'signed-out', attempt: null })),
    copySignInLink: vi.fn(async () => undefined),
    ...resolveDesktopLocale(language),
  }
  const mounted = render(<Welcome api={api} />)
  const button = (id: string) => document.querySelector<HTMLButtonElement>(id)!
  const publish = (state: AccountView) => {
    act(() => { view.api.onAccountState.mock.calls[0]![0](state) })
  }
  const copy = () => {
    const heading = document.querySelector('main')!.getAttribute('aria-labelledby')!
    return [
      document.title, document.querySelector('img')!.alt, document.getElementById(heading)!.textContent,
      ...heading === 'welcome-heading' ? [document.querySelector('#welcome-description')!.textContent] : [],
      ...[...document.querySelectorAll('button')].filter(item => item.closest('[hidden]') === null)
        .map(item => `${item.textContent || item.getAttribute('aria-label')}${item.disabled ? ' [disabled]' : ''}`),
      '',
    ].join('\n')
  }
  const copyAuth = () => copy() + document.querySelector('#auth-description')!.textContent + '\n'
  const view = { document, api, button, publish, copy, copyAuth, unmount: mounted.unmount, stopAccount }
  return view
}

function attempt(id: string, phase: AccountView['attempt'] extends null ? never : NonNullable<AccountView['attempt']>['phase'], extra: Partial<NonNullable<AccountView['attempt']>> = {}): AccountView {
  return { status: 'signed-out', links: { usageUrl: '', topUpUrl: '' }, attempt: { id: id as SignInAttemptId, phase, ...extra } }
}

describe('desktop welcome presentation', () => {
  it.each(['zh-CN', 'en'])('renders the %s entry with sign in as the only action', async (language) => {
    const view = mount(language)
    expect(view.document.documentElement.lang).toBe(language)
    expect(view.document.querySelector('img')!.getAttribute('src')).toBe('assets/welcome-brand.svg')
    expect(view.document.querySelector('input')).toBeNull()
    expect(view.document.querySelector('form')).toBeNull()
    await expect(view.copy()).toMatchFileSnapshot(`./expected/welcome/${language}.expected.txt`)
  })

  it('keeps visible copy in the shell dictionaries and denies network access', () => {
    expect([...html.matchAll(/>([^<]*\p{L}[^<]*)</gu)]).toEqual([])
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("form-action 'none'")
  })
})

it.each(['zh-CN', 'en'])('signs in from the %s entry and reports the click once', async (language) => {
  const view = mount(language)
  expect(view.api.analytics).not.toHaveBeenCalled()
  const waiting = attempt('waiting', 'waiting-browser', { authorizeUrl: 'https://example.test/login' })
  view.api.startSignIn.mockResolvedValueOnce(waiting)
  fireEvent.click(view.button('#sign-in'))
  expect(view.api.startSignIn).toHaveBeenCalledOnce()
  await vi.waitFor(() => { expect(view.button('#auth-copy').hidden).toBe(false) })
  expect(view.api.analytics.mock.calls).toEqual([['auth_page_click', { button_name: 'sign_in' }]])
  expect(view.document.querySelector('main')!.getAttribute('aria-labelledby')).toBe('auth-status')
})

it.each(['zh-CN', 'en'])('renders the %s browser fallback and copies only the active login link', async (language) => {
  const view = mount(language)
  view.publish(attempt('waiting', 'waiting-browser', { authorizeUrl: 'https://example.test/login' }))
  await expect(view.copyAuth()).toMatchFileSnapshot(`./expected/welcome/${language}-waiting.expected.txt`)
  fireEvent.click(view.button('#auth-copy'))
  await vi.waitFor(() => { expect(view.button('#auth-copy').textContent).toBe(view.api.messages.welcomeAuthCopied) })
  expect(view.api.copySignInLink).toHaveBeenCalledWith('waiting')
  view.publish(attempt('waiting', 'exchanging'))
  expect(view.button('#auth-copy').hidden).toBe(true)
  expect(view.button('#auth-loading').hidden).toBe(false)
  fireEvent.click(view.button('#auth-cancel'))
  await vi.waitFor(() => { expect(view.api.cancelSignIn).toHaveBeenCalledWith('waiting') })
  view.publish(attempt('waiting', 'cancelled'))
  expect(view.button('#sign-in').closest('[hidden]')).toBeNull()
})

it.each(['zh-CN', 'en'])('renders the %s timeout with manual retry', async (language) => {
  const view = mount(language)
  view.publish(attempt('expired', 'expired'))
  expect(view.button('#auth-retry').hidden).toBe(false)
  expect(view.button('#auth-cancel').hidden).toBe(true)
  expect(view.api.startSignIn).not.toHaveBeenCalled()
  await expect(view.copyAuth()).toMatchFileSnapshot(`./expected/welcome/${language}-timeout.expected.txt`)
  fireEvent.click(view.button('#auth-retry'))
  expect(view.api.analytics.mock.calls).toEqual([['auth_page_click', { button_name: 'sign_in' }]])
  expect(view.api.startSignIn).toHaveBeenCalledOnce()
})

it('keeps a newer account notification when the start response arrives late', async () => {
  const view = mount()
  const started = Promise.withResolvers<AccountView>()
  view.api.startSignIn.mockReturnValueOnce(started.promise)
  fireEvent.click(view.button('#sign-in'))
  expect(view.button('#auth-cancel').disabled).toBe(true)
  const expired = attempt('attempt', 'expired')
  view.publish(expired)
  await act(async () => { started.resolve(attempt('attempt', 'waiting-browser')); await started.promise })
  expect(view.document.querySelector('#auth-status')!.textContent).toBe(view.api.messages.welcomeAuthExpired)
  expect(view.button('#auth-retry').hidden).toBe(false)
})

it('does not restore a copied-link status after leaving the waiting phase', async () => {
  const view = mount()
  const copied = Promise.withResolvers<undefined>()
  view.api.copySignInLink.mockReturnValueOnce(copied.promise)
  const waiting = attempt('attempt', 'waiting-browser')
  view.publish(waiting)
  fireEvent.click(view.button('#auth-copy'))
  expect(view.button('#auth-copy').disabled).toBe(true)
  view.publish(attempt('attempt', 'exchanging'))
  await act(async () => { copied.resolve(undefined); await copied.promise })
  expect(view.button('#auth-copy').hidden).toBe(true)
  expect(view.button('#auth-copy').textContent).toBe(view.api.messages.welcomeAuthCopyLink)
})

it('releases the account subscription on unmount', () => {
  const view = mount()
  view.publish(attempt('expired', 'expired'))
  expect(view.button('#auth-retry').hidden).toBe(false)
  view.unmount()
  expect(view.stopAccount).toHaveBeenCalledOnce()
})

it.each(['copied', 'failed'] as const)('restores the copy action after %s feedback and cleans up on unmount', async (result) => {
  vi.useFakeTimers()
  try {
    const view = mount('en')
    if (result === 'failed') view.api.copySignInLink.mockRejectedValue(new Error('clipboard unavailable'))
    view.publish(attempt('waiting', 'waiting-browser'))
    const feedback = result === 'copied' ? view.api.messages.welcomeAuthCopied : view.api.messages.welcomeAuthCopyFailed
    const copy = async () => { await act(async () => { fireEvent.click(view.button('#auth-copy')) }) }
    await copy()
    expect(view.button('#auth-copy').textContent).toBe(feedback)
    expect(view.button('#auth-copy').disabled).toBe(result === 'copied')
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    await copy()
    expect(view.api.copySignInLink).toHaveBeenCalledTimes(result === 'copied' ? 1 : 2)
    await act(async () => { await vi.advanceTimersByTimeAsync(result === 'copied' ? 499 : 1999) })
    expect(view.button('#auth-copy').textContent).toBe(feedback)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(view.button('#auth-copy').textContent).toBe(view.api.messages.welcomeAuthCopyLink)
    expect(view.button('#auth-copy').disabled).toBe(false)
    await copy()
    expect(view.api.copySignInLink).toHaveBeenCalledTimes(result === 'copied' ? 2 : 3)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    cleanup()
    vi.useRealTimers()
  }
})

it.each(['zh-CN', 'en'])('keeps the expiry notice visible after returning to Welcome: %s', async (language) => {
  vi.useFakeTimers()
  try {
    const takeNotice = vi.fn<() => Promise<WelcomeNotice | undefined>>().mockResolvedValue(undefined).mockResolvedValueOnce('session-expired')
    const view = mount(language, takeNotice)
    await act(async () => {})
    view.publish({ status: 'signed-out', attempt: null, links: { usageUrl: 'http://localhost/usage', topUpUrl: 'http://localhost/top_up' } })
    const notice = screen.getByRole('alert')
    expect(notice.textContent).toBe(view.api.messages.welcomeSessionExpired)
    await expect(`${notice.textContent}\n`).toMatchFileSnapshot(`./expected/welcome/${language}-expired.expected.txt`)
    expect(view.button('#sign-in').closest('[hidden]')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(screen.queryByRole('alert')).toBeNull()
    await act(async () => { view.publish({ status: 'signed-out', attempt: null, links: { usageUrl: 'http://localhost/usage', topUpUrl: 'http://localhost/top_up' } }) })
    expect(screen.queryByRole('alert')).toBeNull()
    view.unmount()
    mount(language, takeNotice)
    await act(async () => {})
    expect(screen.queryByRole('alert')).toBeNull()
  } finally { cleanup(); vi.useRealTimers() }
})

it('does not infer a notification from a retained expired account snapshot', async () => {
  const view = mount()
  await act(async () => {
    view.publish({ status: 'signed-out', attempt: null, links: { usageUrl: 'http://localhost/usage', topUpUrl: 'http://localhost/top_up' } })
  })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(view.button('#sign-in').closest('[hidden]')).toBeNull()
})

it.each(['zh-CN', 'en'])('returns from completed sign-in to the entry after sign-out: %s', async (language) => {
  const view = mount(language)
  const links = { usageUrl: 'https://example.test/usage', topUpUrl: 'https://example.test/top_up' }
  view.publish({ status: 'credential-stored', links, attempt: { id: 'completed' as SignInAttemptId, phase: 'succeeded' } })
  expect(view.button('#auth-page').hidden).toBe(false)
  expect(view.button('#auth-cancel').disabled).toBe(true)
  view.publish({ status: 'signed-out', links, attempt: null })
  expect(view.button('#sign-in').closest('[hidden]')).toBeNull()
  await expect(view.copy()).toMatchFileSnapshot(`./expected/welcome/${language}.expected.txt`)
})

it('reports each return to the welcome entry once, including a cancelled start', async () => {
  const view = mount()
  expect(view.api.analytics).not.toHaveBeenCalled()
  const pending = Promise.withResolvers<AccountView>()
  view.api.startSignIn.mockReturnValueOnce(pending.promise)
  fireEvent.click(view.button('#sign-in'))
  await act(async () => { pending.resolve({ links: { usageUrl: 'http://localhost/usage', topUpUrl: 'http://localhost/top_up' }, status: 'signed-out', attempt: null }); await pending.promise })
  expect(view.api.analytics.mock.calls.map(([action]) => action)).toEqual(['auth_page_click', 'auth_page_view'])
})

it('keeps the entry usable when notification IPC fails', async () => {
  const view = mount('en', vi.fn<() => Promise<WelcomeNotice | undefined>>().mockRejectedValue(new Error('closed')))
  await act(async () => {})
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(view.button('#sign-in'))
  expect(view.api.startSignIn).toHaveBeenCalledOnce()
})

it('ignores a notification received after its renderer unmounts', async () => {
  const pending = Promise.withResolvers<WelcomeNotice | undefined>()
  const view = mount('en', vi.fn<() => Promise<WelcomeNotice | undefined>>().mockReturnValue(pending.promise))
  view.unmount()
  mount('en')
  await act(async () => { pending.resolve('session-expired') })
  expect(screen.queryByRole('alert')).toBeNull()
})

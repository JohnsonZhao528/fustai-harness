// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopOnboarding } from '../src/client/DesktopOnboarding.tsx'
import type { DesktopOnboardingProps, DesktopOnboardingState } from '../src/client/onboarding-contract.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function mount(step: DesktopOnboardingState['progress']['step'] = 'welcome',
  status: DesktopOnboardingState['status'] = 'ready', copy: typeof zh = zh) {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const track = vi.fn()
  const complete = vi.fn(async () => true)
  const retry = vi.fn(async () => true)
  let changeStatus: (value: DesktopOnboardingState['status']) => void = () => {}
  const update = vi.fn(async (_change: Parameters<DesktopOnboardingProps['update']>[0]) => true)
  function App() {
    const [state, setState] = useState<DesktopOnboardingState>({
      status, visible: true, error: status === 'error' ? 'settings' : null,
      progress: { version: 1, step, purpose: null, process: null, completion: null, usage: 'compact', developerTools: false },
    })
    changeStatus = (value) => { setState(current => ({ ...current, status: value })) }
    return <DesktopOnboarding track={track} locale={copy === zh ? 'zh' : 'en'} state={state} t={key => copy[key]} complete={complete} retry={retry}
      update={async (change) => {
        setState(current => ({ ...current, status: 'saving' }))
        const saved = await update(change)
        setState(current => ({ ...current, status: 'ready', progress: saved ? { ...current.progress, ...change } : current.progress }))
        return saved
      }} />
  }
  render(<App />)
  return {
    complete, update, retry, track, changeStatus: (value: DesktopOnboardingState['status']) => { changeStatus(value) },
  }
}

it('keeps welcome mandatory and enters the purpose page only through Start', async () => {
  const operations = mount()
  expect(screen.queryByRole('button', { name: zh.onboardingSkip })).toBeNull()
  expect(screen.queryByRole('button', { name: zh.onboardingBack })).toBeNull()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(operations.complete).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingStart })) })
  expect(document.querySelector('[data-desktop-onboarding="purpose"]')).toBeTruthy()
  expect(operations.update).toHaveBeenCalledWith({ step: 'purpose' })
})

it('resumes a step left at the retired credit page on the purpose page', () => {
  const operations = mount('credit')
  expect(document.querySelector('[data-desktop-onboarding="purpose"]')).toBeTruthy()
  expect(operations.track).toHaveBeenCalledWith('onboarding_page_view', { page_name: 'onboarding_use_case' })
})

it('covers the application without showing an unfinished step while durable settings load', () => {
  mount('welcome', 'loading')
  expect(screen.getByRole('status').textContent).toBe(zh.onboardingLoading)
  expect(screen.queryByRole('button', { name: zh.onboardingStart })).toBeNull()
  expect(document.querySelector('[data-desktop-onboarding]')).toBeNull()
})

it('allows both purposes and retains choices across back navigation', async () => {
  const operations = mount('purpose')
  expect(screen.queryByRole('button', { name: zh.onboardingContinue })).toBeNull()
  await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: zh.onboardingOffice })) })
  await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: zh.onboardingDevelopment })) })
  expect(operations.update).toHaveBeenLastCalledWith({ purpose: 'both' })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingContinue })) })
  expect(screen.getAllByRole('radio')).toHaveLength(3)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingBack })) })
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: zh.onboardingOffice }).checked).toBe(true)
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: zh.onboardingDevelopment }).checked).toBe(true)
})

it('finishes the office path without asking for process detail', async () => {
  const operations = mount('purpose')
  await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: zh.onboardingOffice })) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingContinue })) })
  expect(operations.complete).toHaveBeenCalledWith('completed')
  expect(screen.queryByRole('radiogroup')).toBeNull()
})

it('supports radio arrow keys and requires a process choice before finishing', async () => {
  const operations = mount('process')
  expect(screen.queryByRole('button', { name: zh.onboardingEnter })).toBeNull()
  await act(async () => { fireEvent.keyDown(screen.getAllByRole('radio')[0]!, { key: 'ArrowRight' }) })
  expect(operations.update).toHaveBeenCalledWith({ process: 'standard' })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingEnter })) })
  expect(operations.complete).toHaveBeenCalledWith('completed')
})

it.each(['purpose', 'process'] as const)('keeps the %s action mounted without native disabled dimming while a choice saves', async (step) => {
  const operations = mount(step)
  const choices = screen.getAllByRole(step === 'purpose' ? 'checkbox' : 'radio')
  await act(async () => { fireEvent.click(choices[0]!) })
  const button = screen.getByRole('button', { name: step === 'purpose' ? zh.onboardingContinue : zh.onboardingEnter })
  let finish!: (saved: boolean) => void
  operations.update.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve }))
  fireEvent.click(choices[1]!)
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(button.hasAttribute('disabled')).toBe(false)
  const writes = operations.update.mock.calls.length
  fireEvent.click(button)
  expect(operations.update).toHaveBeenCalledTimes(writes)
  expect(operations.complete).not.toHaveBeenCalled()
  await act(async () => { finish(true) })
  expect(screen.getByRole('button', { name: button.textContent })).toBe(button)
  expect(button.getAttribute('aria-disabled')).toBe('false')
})

it('requires explicit skip confirmation and Escape only closes that dialog', async () => {
  const operations = mount('purpose')
  fireEvent.click(screen.getByRole('button', { name: zh.onboardingSkip }))
  expect(screen.getByRole('dialog', { name: zh.onboardingSkipTitle })).toBeTruthy()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(operations.complete).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh.onboardingSkip }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingEnter })) })
  expect(operations.complete).toHaveBeenCalledWith('skipped')
})

it.each(['welcome', 'purpose', 'process'] as const)('records the %s page copy', async (step) => {
  mount(step)
  document.querySelectorAll('[data-desktop-onboarding] [aria-hidden="true"]').forEach((element) => { element.remove() })
  await expect(`${document.querySelector('[data-desktop-onboarding]')?.textContent}\n`)
    .toMatchFileSnapshot(`./expected/onboarding-${step}.txt`)
})

it.each(['welcome', 'purpose', 'process'] as const)('records English %s page copy', async (step) => {
  mount(step, 'ready', en)
  document.querySelectorAll('[data-desktop-onboarding] [aria-hidden="true"]').forEach((element) => { element.remove() })
  await expect(`${document.querySelector('[data-desktop-onboarding]')?.textContent}\n`)
    .toMatchFileSnapshot(`./expected/onboarding-${step}-en.txt`)
})

it.each([zh, en])('keeps purpose descriptions unchanged when selecting and deselecting cards', async (copy) => {
  mount('purpose', 'ready', copy)
  for (const name of [copy.onboardingOffice, copy.onboardingDevelopment]) {
    for (let click = 0; click < 2; click++) {
      await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name })) })
      expect(screen.getByText(copy.onboardingOfficeDescription)).toBeTruthy()
      expect(screen.getByText(copy.onboardingDevelopmentDescription)).toBeTruthy()
    }
  }
})

it('returns from process to purpose and from purpose to welcome', async () => {
  const operations = mount('process')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingBack })) })
  expect(operations.update).toHaveBeenCalledWith({ step: 'purpose' })
  cleanup()
  const start = mount('purpose')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingBack })) })
  expect(start.update).toHaveBeenCalledWith({ step: 'welcome' })
})

it('closes skip confirmation when saving fails so the page can show retry', async () => {
  const operations = mount('purpose')
  operations.complete.mockResolvedValueOnce(false)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingSkip })) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingEnter })) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.querySelector('[data-desktop-onboarding="purpose"]')).toBeTruthy()
})

it('retries a rejected settings write from the page alert', async () => {
  const h = mount('purpose', 'error')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingRetry })) })
  expect(h.retry).toHaveBeenCalledOnce()
})

it('keeps selection unchanged while a purpose write is pending', async () => {
  const h = mount('purpose')
  const pending = Promise.withResolvers<boolean>()
  h.update.mockReturnValueOnce(pending.promise)
  fireEvent.click(screen.getByRole('checkbox', { name: zh.onboardingOffice }))
  fireEvent.click(screen.getByRole('checkbox', { name: zh.onboardingDevelopment }))
  expect(h.update).toHaveBeenCalledOnce()
  await act(async () => { pending.resolve(true) })
})

it('supports both radio arrow directions, wraps around, and ignores other keys or pending writes', async () => {
  const h = mount('process')
  const radios = screen.getAllByRole('radio')
  for (const key of ['ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight']) {
    await act(async () => { fireEvent.keyDown(radios[0]!, { key }) })
    expect(h.update).toHaveBeenLastCalledWith({ process: key === 'ArrowLeft' || key === 'ArrowUp' ? 'detailed' : 'standard' })
  }
  const count = h.update.mock.calls.length
  fireEvent.keyDown(radios[0]!, { key: 'a' })
  expect(h.update).toHaveBeenCalledTimes(count)
  const pending = Promise.withResolvers<boolean>()
  h.update.mockReturnValueOnce(pending.promise)
  fireEvent.click(radios[0]!)
  fireEvent.keyDown(radios[1]!, { key: 'ArrowRight' })
  fireEvent.click(radios[1]!)
  expect(h.update).toHaveBeenCalledTimes(count + 1)
  await act(async () => { pending.resolve(true) })
})

it('traps Tab in confirmation, closes it, and keeps the selected page', async () => {
  mount('purpose')
  const trigger = screen.getByRole('button', { name: zh.onboardingSkip })
  trigger.focus()
  fireEvent.click(trigger)
  const dialog = screen.getByRole('dialog')
  const buttons = dialog.querySelectorAll('button')
  const first = buttons[0]!
  const last = buttons[buttons.length - 1]!
  expect(document.activeElement).toBe(first)
  fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(last)
  fireEvent.keyDown(last, { key: 'Tab' })
  expect(document.activeElement).toBe(first)
  fireEvent.keyDown(first, { key: 'Tab' })
  fireEvent.keyDown(last, { key: 'Tab', shiftKey: true })
  fireEvent.keyDown(first, { key: 'a' })
  fireEvent.click(screen.getByRole('button', { name: zh.onboardingKeepSetting }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('button', { name: zh.close }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('does not render a finished flow', () => {
  mount('done')
  expect(document.querySelector('[data-desktop-onboarding]')).toBeNull()
})

it.each(['complete', 'cancel', 'reduced'] as const)('settles the page transition when motion is %s', async (mode) => {
  const animation = Promise.withResolvers<undefined>()
  const animate = vi.fn(() => ({ finished: animation.promise, cancel: vi.fn() }))
  vi.stubGlobal('matchMedia', () => ({ matches: mode === 'reduced' }))
  const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate')
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate })
  try {
    mount()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingStart })) })
    if (mode === 'reduced') expect(animate).not.toHaveBeenCalled()
    else {
      expect(animate).toHaveBeenCalledOnce()
      await act(async () => {
        if (mode === 'cancel') animation.reject(new Error('cancelled'))
        else animation.resolve(undefined)
      })
    }
    expect(document.querySelector(`[data-desktop-onboarding="${mode === 'cancel' ? 'welcome' : 'purpose'}"]`)).not.toBeNull()
    cleanup()
  } finally {
    if (previous) Object.defineProperty(HTMLElement.prototype, 'animate', previous)
    else Reflect.deleteProperty(HTMLElement.prototype, 'animate')
  }
})

it('does not restore focus to a disconnected confirmation trigger', () => {
  mount('purpose')
  const trigger = screen.getByRole('button', { name: zh.onboardingSkip })
  trigger.focus()
  fireEvent.click(trigger)
  trigger.remove()
  fireEvent.click(screen.getByRole('button', { name: zh.close }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('reports visible pages, the skip popup, and page clicks once', async () => {
  const b = mount('purpose')
  expect(b.track).toHaveBeenCalledExactlyOnceWith('onboarding_page_view', { page_name: 'onboarding_use_case' })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingSkip })) })
  expect(b.track).toHaveBeenCalledWith('onboarding_popup_view', { popup_name: 'skip_setting' })
  b.track.mockClear()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.close })) })
  expect(b.track).toHaveBeenCalledExactlyOnceWith('onboarding_popup_click', { popup_name: 'skip_setting', button_name: 'close' })
  await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: zh.onboardingDevelopment })) })
  b.track.mockClear()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingContinue })) })
  expect(b.track).toHaveBeenCalledWith('onboarding_page_click', { page_name: 'onboarding_use_case', button_name: 'next', selected_content: 'code' })
})

it('reports the selected purpose and process content with a click', async () => {
  const b = mount('purpose')
  await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: zh.onboardingDevelopment })) })
  b.track.mockClear()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingBack })) })
  expect(b.track).toHaveBeenCalledWith('onboarding_page_click', { page_name: 'onboarding_use_case', button_name: 'back', selected_content: 'code' })
  cleanup()
  const process = mount('process')
  await act(async () => { fireEvent.click(screen.getAllByRole('radio')[2]!) })
  process.track.mockClear()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingBack })) })
  expect(process.track).toHaveBeenCalledWith('onboarding_page_click', { page_name: 'onboarding_process', button_name: 'back', selected_content: 'full_process' })
})

it('does not report the loading surface as a page', () => {
  expect(mount('welcome', 'loading').track).not.toHaveBeenCalled()
})

it('does not repeat page or popup exposure during save and refresh', () => {
  const b = mount('purpose')
  fireEvent.click(screen.getByRole('button', { name: zh.onboardingSkip }))
  act(() => { b.changeStatus('saving') })
  act(() => { b.changeStatus('loading') })
  act(() => { b.changeStatus('ready') })
  expect(b.track.mock.calls.filter(([name]) => name === 'onboarding_page_view')).toHaveLength(1)
})

it('reports closing the skip-settings popup', () => {
  const b = mount('purpose')
  fireEvent.click(screen.getByRole('button', { name: zh.onboardingSkip }))
  b.track.mockClear()
  fireEvent.click(screen.getByRole('button', { name: zh.close }))
  expect(b.track).toHaveBeenCalledExactlyOnceWith('onboarding_popup_click', { popup_name: 'skip_setting', button_name: 'close' })
})

it('reports continuing the current settings from the popup', () => {
  const b = mount('process')
  fireEvent.click(screen.getByRole('button', { name: zh.onboardingSkip }))
  b.track.mockClear()
  fireEvent.click(screen.getByRole('button', { name: zh.onboardingKeepSetting }))
  expect(b.track).toHaveBeenCalledExactlyOnceWith('onboarding_popup_click', { popup_name: 'skip_setting', button_name: 'setting' })
  expect(b.complete).not.toHaveBeenCalled()
})
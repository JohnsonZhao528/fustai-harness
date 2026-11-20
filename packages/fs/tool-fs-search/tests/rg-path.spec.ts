/**
 * Fallback tests for the lazy ripgrep resolution. The success path (the real
 * `@vscode/ripgrep` module) is exercised throughout tools.spec.ts; here the
 * module is mocked to throw at evaluation, proving a missing or corrupt
 * platform package (`--omit=optional`, partial install) degrades to the PATH
 * `rg` command instead of failing composition load or the first search.
 */

import { describe, expect, it, vi } from 'vitest'
import { resolveRgPath } from '@deepseek-ai/dsh-tool-fs-search'

// Any access to the mocked module's surface throws — the shape a missing
// platform package produces at module evaluation.
vi.mock('@vscode/ripgrep', () => new Proxy({}, {
  get() {
    throw new Error('platform package @vscode/ripgrep-win32-x64 is not installed')
  },
}))

describe('lazy ripgrep resolution without a platform package', () => {
  it('falls back to the PATH rg command', async () => {
    await expect(resolveRgPath()).resolves.toBe('rg')
  })

  it('reuses one memoized resolution', () => {
    expect(resolveRgPath()).toBe(resolveRgPath())
  })
})

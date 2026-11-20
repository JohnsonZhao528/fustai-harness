import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ACCOUNT_POINTER_FILENAME,
  AGENTS_HOME_DIR_NAME,
  DEFAULT_AGENTS_HOME_DISPLAY,
  DEFAULT_DSH_HOME_DISPLAY,
  DSH_ACCOUNTS_DIR_NAME,
  DSH_HOME_DIR_NAME,
  accountDataRoot,
  accountPointerPath,
  agentsHomeDisplay,
  canonicalizeWatchPath,
  defaultAgentsHome,
  defaultDshHome,
  dshBaseHome,
  dshCachePath,
  dshHomeDisplay,
  dshHomePath,
  expandHomePath,
  ownsHarnessHome,
  readAccountPointer,
  resolveAgentsHome,
  resolveDshHome,
  writeAccountPointer,
} from '@deepseek-ai/dsh-home-paths'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('dsh path helpers', () => {
  it('owns the shared default DSH home directory name', () => {
    expect(DSH_HOME_DIR_NAME).toBe('.dsh')
    expect(DEFAULT_DSH_HOME_DISPLAY).toBe('~/.dsh')
    expect(defaultDshHome()).toBe(join(homedir(), '.dsh'))
  })

  it('expands tilde paths without changing non-tilde paths', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/.dsh')).toBe(join(homedir(), '.dsh'))
    expect(expandHomePath('~\\.dsh')).toBe(join(homedir(), '.dsh'))
    expect(expandHomePath('/tmp/.dsh')).toBe('/tmp/.dsh')
    expect(expandHomePath('~other/.dsh')).toBe('~other/.dsh')
  })

  it('resolves explicit path before DSH_HOME and the default', () => {
    const envHome = join(homedir(), 'env-dsh')

    expect(resolveDshHome('/tmp/explicit-dsh', { DSH_HOME: '~/env-dsh' })).toBe(resolve('/tmp/explicit-dsh'))
    expect(resolveDshHome(undefined, { DSH_HOME: '~/env-dsh' })).toBe(envHome)
    expect(dshBaseHome(undefined, {})).toBe(defaultDshHome())
  })

  it('treats an empty or whitespace-only DSH_HOME as unset', () => {
    expect(dshBaseHome(undefined, { DSH_HOME: '' })).toBe(defaultDshHome())
    expect(dshBaseHome(undefined, { DSH_HOME: '   ' })).toBe(defaultDshHome())
  })

  it('joins child segments onto the resolved DSH_HOME', () => {
    vi.stubEnv('DSH_HOME', '~/env-dsh')
    expect(dshHomePath()).toBe(join(homedir(), 'env-dsh'))
    expect(dshHomePath('storages', 'cache')).toBe(join(homedir(), 'env-dsh', 'storages', 'cache'))
  })

  it('labels a resolved home by whether it is the default root', () => {
    expect(dshHomeDisplay(resolve(defaultDshHome()))).toBe('~/.dsh')
    expect(dshHomeDisplay('/some/other/root')).toBe('$DSH_HOME')
  })

  it('owns the shared default agents home directory name', () => {
    expect(AGENTS_HOME_DIR_NAME).toBe('.agents')
    expect(DEFAULT_AGENTS_HOME_DISPLAY).toBe('~/.agents')
    expect(defaultAgentsHome()).toBe(join(homedir(), '.agents'))
  })

  it('resolves an explicit agents home before DSH_AGENTS_HOME and the default', () => {
    const envHome = join(homedir(), 'env-agents')

    expect(resolveAgentsHome('/tmp/explicit-agents', { DSH_AGENTS_HOME: '~/env-agents' })).toBe(resolve('/tmp/explicit-agents'))
    expect(resolveAgentsHome(undefined, { DSH_AGENTS_HOME: '~/env-agents' })).toBe(envHome)
    expect(resolveAgentsHome(undefined, {})).toBe(defaultAgentsHome())
  })

  it('treats an empty or whitespace-only DSH_AGENTS_HOME as unset', () => {
    expect(resolveAgentsHome(undefined, { DSH_AGENTS_HOME: '' })).toBe(defaultAgentsHome())
    expect(resolveAgentsHome(undefined, { DSH_AGENTS_HOME: '   ' })).toBe(defaultAgentsHome())
  })

  it('labels a resolved agents home by whether it is the default root', () => {
    expect(agentsHomeDisplay(resolve(defaultAgentsHome()))).toBe('~/.agents')
    expect(agentsHomeDisplay('/some/other/root')).toBe('$DSH_AGENTS_HOME')
  })

  it.each([
    [undefined, join(homedir(), '.dsh')],
    ['', join(homedir(), '.dsh')],
    ['   ', join(homedir(), '.dsh')],
    ['~/env-dsh', join(homedir(), 'env-dsh')],
    ['./relative-dsh', resolve('./relative-dsh')],
  ] as const)('resolves cache paths with DSH_HOME=%j', (home, expectedHome) => {
    vi.stubEnv('DSH_HOME', home)
    try {
      expect(dshCachePath()).toBe(join(expectedHome, 'cache'))
      expect(dshCachePath('models', 'index.json')).toBe(join(expectedHome, 'cache', 'models', 'index.json'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('resolves configured cache homes before the environment', () => {
    vi.stubEnv('DSH_HOME', '~/env-dsh')
    try {
      expect(dshCachePath({ dshHome: '~/explicit-dsh' })).toBe(join(homedir(), 'explicit-dsh', 'cache'))
      expect(dshCachePath({ dshHome: './explicit-dsh' }, 'attachments', 'request-images'))
        .toBe(resolve('./explicit-dsh/cache/attachments/request-images'))
      expect(dshCachePath({}, 'attachments')).toBe(join(homedir(), 'env-dsh', 'cache', 'attachments'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('canonicalizes a watcher ancestor while preserving a missing suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-watch-path-'))
    const target = join(root, 'target')
    const alias = join(root, 'alias')
    try {
      await mkdir(target)
      await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(canonicalizeWatchPath(alias)).resolves.toBe(await realpath(target))
      await expect(canonicalizeWatchPath(join(alias, 'later', 'config.yml'))).resolves.toBe(
        join(await realpath(target), 'later', 'config.yml'),
      )
      const file = join(root, 'file')
      await writeFile(file, 'not a directory')
      await expect(canonicalizeWatchPath(join(file, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses the harness home itself when no account pointer exists', async () => {
    const base = await home()
    try {
      expect(readAccountPointer(base)).toBeUndefined()
      expect(ownsHarnessHome(undefined, 'owner')).toBe(false)
      expect(resolveDshHome(base)).toBe(resolve(base))
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('keeps the shared home for the first owner and scopes every later account', async () => {
    const base = await home()
    try {
      writeAccountPointer(base, { firstOwnerUid: 'owner', activeUid: 'owner' })
      expect(resolveDshHome(base)).toBe(resolve(base))
      expect(ownsHarnessHome(readAccountPointer(base), 'owner')).toBe(true)
      expect(ownsHarnessHome(readAccountPointer(base), 'guest')).toBe(false)

      writeAccountPointer(base, { firstOwnerUid: 'owner', activeUid: 'guest' })
      expect(resolveDshHome(base)).toBe(join(resolve(base), 'accounts', 'guest'))

      writeAccountPointer(base, { firstOwnerUid: 'owner', activeUid: null })
      expect(resolveDshHome(base)).toBe(resolve(base))
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('names the pointer and the account root with the shared layout', async () => {
    expect(ACCOUNT_POINTER_FILENAME).toBe('account.json')
    expect(DSH_ACCOUNTS_DIR_NAME).toBe('accounts')
    expect(accountPointerPath('/home/.dsh')).toBe(join('/home/.dsh', 'account.json'))
    expect(accountDataRoot('/home/.dsh', 'u-1')).toBe(join('/home/.dsh', 'accounts', 'u-1'))
    expect(() => accountDataRoot('/home/.dsh', '../escape')).toThrow(/account id/)
    expect(() => accountDataRoot('/home/.dsh', 'nested/id')).toThrow(/account id/)
  })

  it('resolves the root its parent already pointed at without nesting again', async () => {
    const base = await home()
    try {
      writeAccountPointer(base, { firstOwnerUid: 'owner', activeUid: 'guest' })
      const accountRoot = resolveDshHome(base)
      expect(resolveDshHome(undefined, { DSH_HOME: accountRoot })).toBe(accountRoot)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('refuses to fall back to the shared home when the pointer is unusable', async () => {
    const cases = ['not json', 'null', '[]', '{}', '{"version":2,"activeUid":null,"firstOwnerUid":null}',
      '{"version":1,"activeUid":1,"firstOwnerUid":null}', '{"version":1,"activeUid":"../out","firstOwnerUid":null}',
      '{"version":1,"activeUid":null}']
    for (const text of cases) {
      const base = await home()
      try {
        await writeFile(join(base, ACCOUNT_POINTER_FILENAME), text)
        expect(() => readAccountPointer(base)).toThrow(/account\.json|account id/)
        expect(() => resolveDshHome(base)).toThrow(/account\.json|account id/)
      } finally {
        await rm(base, { recursive: true, force: true })
      }
    }
  })

  it('reports a pointer it cannot read rather than treating it as absent', async () => {
    const base = await home()
    try {
      await mkdir(join(base, ACCOUNT_POINTER_FILENAME))
      expect(() => readAccountPointer(base)).not.toThrow(/ENOENT/)
      expect(() => readAccountPointer(base)).toThrow()
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('labels an account root by the home it sits under', () => {
    expect(dshHomeDisplay(join(resolve(defaultDshHome()), 'accounts', 'guest'))).toBe('~/.dsh/accounts/guest')
    expect(dshHomeDisplay(join(resolve(defaultDshHome()), 'accounts'))).toBe('~/.dsh/accounts')
  })
})

/** One fresh harness home a test can write a pointer into. */
async function home(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'dsh-account-'))
}

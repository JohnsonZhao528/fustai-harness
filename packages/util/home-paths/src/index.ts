/**
 * Shared filesystem path helpers for DeepSeek Harness user data.
 *
 * @module @deepseek-ai/dsh-home-paths
 */

import { opendir, realpath } from 'node:fs/promises'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

/** Directory name for the default DeepSeek Harness home under the OS home. */
export const DSH_HOME_DIR_NAME = '.dsh'

/** Stable user-facing display form for the default DeepSeek Harness home. */
export const DEFAULT_DSH_HOME_DISPLAY = `~/${DSH_HOME_DIR_NAME}`

/** Environment variable that overrides the default DeepSeek Harness home. */
export const DSH_HOME_ENV = 'DSH_HOME'

/** Directory inside a harness home that holds one data root per signed-in account. */
export const DSH_ACCOUNTS_DIR_NAME = 'accounts'

/** File inside a harness home recording which account's data root the harness uses. */
export const ACCOUNT_POINTER_FILENAME = 'account.json'

/** Layout of the account pointer file this build reads and writes. */
const ACCOUNT_POINTER_VERSION = 1

/**
 * Account identifier grammar: one filesystem-safe path segment, so a pointer
 * cannot escape the accounts directory. This is the same grammar that makes the
 * account-named `$DSH_HOME` in {@link resolveDshHome} a resolved value rather
 * than attacker-controlled text. Whoever receives an account id from another
 * system validates it here before storing it in a {@link AccountPointer} or a
 * credential payload.
 */
export const ACCOUNT_UID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/**
 * Which account's data the harness home holds. The pointer carries no secret: it
 * names a directory, while the credentials document lives inside that directory.
 */
export interface AccountPointer {
  /** Account whose data root the harness resolves; null while nobody is signed in. */
  readonly activeUid: string | null
  /** Account whose data already sits in the harness home itself; null until the first sign-in. */
  readonly firstOwnerUid: string | null
}

/** Directory name for the default shared agent configuration root under the OS home. */
export const AGENTS_HOME_DIR_NAME = '.agents'

/** Stable user-facing display form for the default shared agent configuration root. */
export const DEFAULT_AGENTS_HOME_DISPLAY = `~/${AGENTS_HOME_DIR_NAME}`

/** Environment variable that overrides the default shared agent configuration root. */
export const AGENTS_HOME_ENV = 'DSH_AGENTS_HOME'

/**
 * Give a native filesystem watcher one canonical spelling of a path, even
 * when its final components do not exist yet. The deepest existing ancestor
 * is resolved through {@link realpath}; when a suffix is missing, that
 * ancestor is also proved to be an enumerable directory before the suffix is
 * restored. This prevents Windows from treating a regular-file ancestor as
 * ordinary absence, and prevents short-name aliases from being mixed with
 * long paths emitted by the native watcher backend.
 * @param path - Watch target or root, resolved against the current directory.
 * @returns the target with its existing ancestor canonicalized.
 * @throws when ancestor traversal encounters an error other than absence, or
 * the existing ancestor of a missing suffix is not an enumerable directory.
 */
export async function canonicalizeWatchPath(path: string): Promise<string> {
  let current = resolve(path)
  const missing: string[] = []
  while (true) {
    try {
      const canonical = await realpath(current)
      if (missing.length > 0) {
        // A Windows file-as-parent probe reports ENOENT. Opening the resolved
        // ancestor preserves the cross-platform directory requirement.
        const directory = await opendir(canonical)
        await directory.close()
      }
      return join(canonical, ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      /* v8 ignore next -- a filesystem root exists, so traversal resolves before this guard */
      if (parent === current) throw error
      missing.push(basename(current))
      current = parent
    }
  }
}

/**
 * Resolve the default DeepSeek Harness home using Node's platform path rules.
 * @returns the absolute default harness home path.
 */
export function defaultDshHome(): string {
  return join(homedir(), DSH_HOME_DIR_NAME)
}

/**
 * Resolve the default shared agent configuration root using Node's platform path rules.
 * @returns the absolute default shared agent configuration root.
 */
export function defaultAgentsHome(): string {
  return join(homedir(), AGENTS_HOME_DIR_NAME)
}

/**
 * Expand supported tilde prefixes against the operating-system home.
 * @param path - configured path that may begin with `~`, `~/`, or `~\`.
 * @returns the expanded path, or the original value when no supported prefix is present.
 */
export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve one user-data root from an explicit path, an environment override, and a default.
 * @param configured - explicit path, which has highest precedence.
 * @param env - environment mapping to read.
 * @param envName - environment variable that overrides the default.
 * @param fallback - default root, used when neither the explicit path nor the environment provides one.
 * @returns the normalized absolute root.
 */
function resolveRoot(
  configured: string | undefined,
  env: Record<string, string | undefined>,
  envName: string,
  fallback: () => string,
): string {
  const fromEnv = env[envName]
  const selected = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : fallback())
  return resolve(expandHomePath(selected))
}

/**
 * Path of the account pointer inside a harness home.
 * @param baseHome - harness home returned by {@link dshBaseHome}.
 * @returns the absolute pointer path.
 */
export function accountPointerPath(baseHome: string): string {
  return join(baseHome, ACCOUNT_POINTER_FILENAME)
}

/**
 * Data root holding one account's sessions, settings, credentials and cache.
 * @param baseHome - harness home returned by {@link dshBaseHome}.
 * @param uid - account identifier accepted by {@link ACCOUNT_UID_PATTERN}.
 * @returns the absolute per-account data root.
 * @throws TypeError when `uid` is not one filesystem-safe path segment.
 */
export function accountDataRoot(baseHome: string, uid: string): string {
  if (!ACCOUNT_UID_PATTERN.test(uid)) {
    throw new TypeError(`home-paths: account id "${uid}" must match ${String(ACCOUNT_UID_PATTERN)}`)
  }
  return join(baseHome, DSH_ACCOUNTS_DIR_NAME, uid)
}

/**
 * Whether an account's data stays in the harness home instead of a per-account
 * root. The account that first signed in inherits the data already in the home,
 * so it never needs a move or a restart; later accounts get their own root.
 * @param pointer - pointer read from the harness home, or its absence.
 * @param uid - account identifier to test.
 * @returns true when resolving the home for `uid` keeps the shared root.
 */
export function ownsHarnessHome(pointer: AccountPointer | undefined, uid: string): boolean {
  return pointer !== undefined && pointer.firstOwnerUid === uid
}

/**
 * Read the account pointer. Absence means no account has claimed the home yet.
 * A file that exists but is not the layout this build writes is a failure: the
 * alternative — resolving to the shared root — would hand one account's data to
 * another process.
 * @param baseHome - harness home returned by {@link dshBaseHome}.
 * @returns the pointer, or undefined when no pointer file exists.
 * @throws when the pointer exists but cannot be parsed as {@link AccountPointer}.
 */
export function readAccountPointer(baseHome: string): AccountPointer | undefined {
  const path = accountPointerPath(baseHome)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const parsed: unknown = parsePointerJson(text, path)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`home-paths: ${path} must be an object with version, activeUid and firstOwnerUid`)
  }
  const fields = parsed as Record<string, unknown>
  if (fields['version'] !== ACCOUNT_POINTER_VERSION) {
    throw new TypeError(`home-paths: ${path} must be version ${String(ACCOUNT_POINTER_VERSION)}`)
  }
  return {
    activeUid: parseAccountUid(fields['activeUid'], path, 'activeUid'),
    firstOwnerUid: parseAccountUid(fields['firstOwnerUid'], path, 'firstOwnerUid'),
  }
}

/**
 * Write the account pointer. The temporary file and rename keep a reader seeing
 * either the previous or the new pointer, never a half-written one.
 * @param baseHome - harness home returned by {@link dshBaseHome}; created when absent.
 * @param pointer - account ids to record.
 * @throws when the home cannot be created or the pointer cannot be replaced.
 */
export function writeAccountPointer(baseHome: string, pointer: AccountPointer): void {
  const path = accountPointerPath(baseHome)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${String(process.pid)}.tmp`
  const text = `${JSON.stringify({ version: ACCOUNT_POINTER_VERSION, ...pointer }, null, 2)}\n`
  writeFileSync(temporary, text, { mode: 0o600 })
  renameSync(temporary, path)
}

/** Read one pointer field as an account id, or as null when the field records none. */
function parseAccountUid(value: unknown, path: string, field: string): string | null {
  if (value === null) return null
  if (typeof value === 'string' && ACCOUNT_UID_PATTERN.test(value)) return value
  throw new TypeError(`home-paths: ${path} field "${field}" must be an account id or null`)
}

/** Parse pointer JSON, reporting the file rather than the parser's position. */
function parsePointerJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new TypeError(`home-paths: ${path} is not valid JSON`)
  }
}

/**
 * Resolve the harness home before per-account scoping: an explicit configured
 * path, then `$DSH_HOME`, then `~/.dsh`.
 * @param configured - explicit harness-home override, which has highest precedence.
 * @param env - environment mapping used to read `DSH_HOME`.
 * @returns the normalized absolute harness home path.
 */
export function dshBaseHome(configured?: string, env: Record<string, string | undefined> = process.env): string {
  return resolveRoot(configured, env, DSH_HOME_ENV, defaultDshHome)
}

/**
 * Label one resolved user-data root symbolically for user-facing display.
 * @param resolvedRoot - absolute path returned by the matching resolver.
 * @param defaultRoot - absolute default root whose symbolic label applies to a match.
 * @param defaultLabel - symbolic label for the default root.
 * @param envName - environment variable name that labels any other root.
 * @returns the symbolic label.
 */
function rootDisplay(resolvedRoot: string, defaultRoot: string, defaultLabel: string, envName: string): string {
  return resolvedRoot === resolve(defaultRoot) ? defaultLabel : `$${envName}`
}

/**
 * Resolve the DeepSeek Harness home every user data lives under.
 *
 * Precedence for the harness home itself, highest first: an explicit configured
 * path, `$DSH_HOME`, then `~/.dsh`. An empty or whitespace-only `$DSH_HOME` is
 * treated as unset, so a blank override never resolves the home to the current
 * working directory.
 *
 * A signed-in account then narrows the home to its own data root. The account
 * that first signed in keeps the home unchanged, because the data already in the
 * home is its data; every later account resolves `<home>/accounts/<id>`, which
 * is why switching accounts restarts the runtime. The pointer lives in the home,
 * so a process whose `$DSH_HOME` already names an account root finds no pointer
 * there and resolves the same root its parent chose.
 * @param configured - explicit harness-home override, which has highest precedence.
 * @param env - environment mapping used to read `DSH_HOME`.
 * @returns the normalized absolute harness home path.
 * @throws when the account pointer exists but names an unusable account id.
 */
export function resolveDshHome(configured?: string, env: Record<string, string | undefined> = process.env): string {
  const baseHome = dshBaseHome(configured, env)
  const pointer = readAccountPointer(baseHome)
  if (pointer === undefined || pointer.activeUid === null || ownsHarnessHome(pointer, pointer.activeUid)) {
    return baseHome
  }
  return accountDataRoot(baseHome, pointer.activeUid)
}

/**
 * Resolve the shared agent configuration root.
 *
 * Precedence, highest first: an explicit configured path, `$DSH_AGENTS_HOME`,
 * then `~/.agents`. The root holds configuration shared with other agent tools,
 * so it stays independent of the DeepSeek Harness home. An empty or
 * whitespace-only `$DSH_AGENTS_HOME` is treated as unset, so a blank override
 * never resolves the root to the current working directory.
 * @param configured - explicit shared-root override, which has highest precedence.
 * @param env - environment mapping used to read `DSH_AGENTS_HOME`.
 * @returns the normalized absolute shared agent configuration root.
 */
export function resolveAgentsHome(configured?: string, env: Record<string, string | undefined> = process.env): string {
  return resolveRoot(configured, env, AGENTS_HOME_ENV, defaultAgentsHome)
}

/**
 * Join path segments onto the resolved DeepSeek Harness home.
 * @param segments - path segments appended to the Harness home; an empty list returns the home itself.
 * @returns the normalized absolute joined path.
 */
export function dshHomePath(...segments: string[]): string {
  return join(resolveDshHome(), ...segments)
}

/**
 * Join path segments onto the resolved Harness home's `cache` directory without creating it; no arguments returns the directory itself.
 * @param optionsOrSegment - explicit home override, or the first path segment; omission uses the default home resolution.
 * @param segments - additional path segments after the first child, if any.
 * @returns the normalized absolute cache path.
 */
export function dshCachePath(optionsOrSegment: { dshHome?: string } | string = {}, ...segments: string[]): string {
  if (typeof optionsOrSegment === 'string') return dshHomePath('cache', optionsOrSegment, ...segments)
  return join(resolveDshHome(optionsOrSegment.dshHome), 'cache', ...segments)
}

/**
 * Describe a resolved harness home symbolically for user-facing display.
 *
 * It never returns an absolute machine path: anything under the default home is
 * labelled from `~/.dsh`, so an account data root reads `~/.dsh/accounts/<id>`,
 * and any other home is labelled `$DSH_HOME`.
 * @param resolvedHome - the absolute path returned by {@link resolveDshHome}.
 * @returns the symbolic label.
 */
export function dshHomeDisplay(resolvedHome: string): string {
  const base = resolve(defaultDshHome())
  if (resolvedHome === base) return DEFAULT_DSH_HOME_DISPLAY
  if (resolvedHome.startsWith(base + sep)) {
    return `${DEFAULT_DSH_HOME_DISPLAY}/${relative(base, resolvedHome).split(sep).join('/')}`
  }
  return rootDisplay(resolvedHome, base, DEFAULT_DSH_HOME_DISPLAY, DSH_HOME_ENV)
}

/**
 * Describe a resolved shared agent configuration root symbolically for user-facing display.
 *
 * It never returns an absolute machine path: the default root is labelled
 * `~/.agents`, and any configured root is labelled `$DSH_AGENTS_HOME`.
 * @param resolvedHome - the absolute path returned by {@link resolveAgentsHome}.
 * @returns `~/.agents` for the default root, otherwise `$DSH_AGENTS_HOME`.
 */
export function agentsHomeDisplay(resolvedHome: string): string {
  return rootDisplay(resolvedHome, defaultAgentsHome(), DEFAULT_AGENTS_HOME_DISPLAY, AGENTS_HOME_ENV)
}

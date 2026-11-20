/** Desktop profile initialization and native recovery. */

import {
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  closeSync,
  readFileSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  DESKTOP_HOST_PACKAGE,
  desktopCorePackageOverrides,
  verifyDesktopCorePackageSet,
} from './core-package-set.ts'
import type { DesktopPaths } from './paths.ts'
import type { DesktopRelease } from './release.ts'
import { readDesktopRuntime } from './runtime-tree.ts'
import { seedProviderRoutes } from './provider-seed.ts'
import {
  initProfile, PROFILE_TEMPLATES, readProfileManifest, removeLinkProjections, sanitizeProfile, writeProfileBundles,
  type ProfileTemplate,
} from '@deepseek-ai/dsh-app-boot'

const PROJECT_NAME = '@deepseek-ai/dsh-desktop-runtime'
const DSH_PACKAGE = '@deepseek-ai/dsh'
const CORE_BUILD_PACKAGE = '@deepseek-ai/dsh-subprocess-local'
const WEB_PROFILE = PROFILE_TEMPLATES.web as ProfileTemplate
/** Shipped bundle that registers this Desktop as a Host for FustAI Harness mobile clients. */
const MOBILE_BUNDLE = 'ds-harness-remote'
/** Vendored mobile plugin staged beside the runtime project metadata. */
export const MOBILE_VENDOR_DIR = 'vendor/ds-harness-remote'
/** Bundles shipped by earlier releases; {@link MOBILE_BUNDLE} replaces both. */
const LEGACY_MOBILE_BUNDLES = ['dsh-plugin-mobile-gateway', 'dsh-mobile']
const DESKTOP_BUNDLES = [...WEB_PROFILE.bundles, MOBILE_BUNDLE]
/** Shipped bundles copied into the profile because the loader resolves them from disk, not from `app.asar`. */
const BUNDLED_PLUGIN_PACKAGES = [MOBILE_BUNDLE]
const WORKSPACE_SETTINGS = 'nodeLinker: hoisted\nautoInstallPeers: false\n'
function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 })
}

function workspaceFile(overrides: Readonly<Record<string, string>> = {}): string {
  const entries = Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right))
  const overrideSection = entries.length === 0
    ? ''
    : `overrides:\n${entries.map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`).join('\n')}\n`
  if (entries.length === 0) return `packages:\n  - .\n\n${WORKSPACE_SETTINGS}`
  const coreBuildSpec = overrides[CORE_BUILD_PACKAGE]
  const coreBuildKey = coreBuildSpec === undefined
    ? CORE_BUILD_PACKAGE
    : `${CORE_BUILD_PACKAGE}@${coreBuildSpec.replace('file:./', 'file:')}`
  return `packages:\n  - .\n\n${overrideSection}${WORKSPACE_SETTINGS}allowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  ${JSON.stringify(coreBuildKey)}: true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n`
}

function migrateProfileSettings(projectDir: string): void {
  const path = join(projectDir, 'pnpm-workspace.yaml')
  if (!existsSync(path)) return
  const legacy = `packages:\n  - .\n\n${WORKSPACE_SETTINGS}strictDepBuilds: true\nallowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  "${CORE_BUILD_PACKAGE}": true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n`
  if (readFileSync(path, 'utf8').replaceAll('\r\n', '\n') === legacy) {
    writeFileSync(path, workspaceFile())
  }
}

/** Initializes the Desktop profile and disables third-party bundles during recovery. */
export class DesktopProjectManager {
  /**
   * @param paths - Electron-owned package state and reserved desktop profile paths.
   * @param runtime - location of the bundled application runtime.
   */
  constructor(
    readonly paths: DesktopPaths,
    readonly runtime: { readonly dsh: string },
  ) {}

  /**
   * Back up the profile patch and disable third-party bundles without loading application resources.
   * The caller must stop the Host first.
   * @returns Backup path after the locked profile write, or undefined if the patch was absent.
   */
  async disableAllPlugins(): Promise<string | undefined> {
    return this.withLock(() => sanitizeProfile('dsh', this.paths.profile, DESKTOP_BUNDLES))
  }

  /**
   * Load application metadata and prepare the external plugin profile without installing packages.
   */
  async applyRelease(): Promise<void> {
    await this.withLock(() => {
      // Validation only: an unreadable or mismatched runtime descriptor stops preparation before the Host starts.
      readDesktopRuntime(this.runtime.dsh)
      migrateProfileSettings(this.paths.profile)
      materializeBundledPlugins(this.runtime.dsh, this.paths.profile)
      createPluginProfile(this.paths.profile)
      seedProviderRoutes(this.paths.profile)
      removeLinkProjections(this.paths.profile)
    })
  }

  private async withLock<T>(operation: () => T | Promise<T>): Promise<T> {
    mkdirSync(this.paths.profile, { recursive: true, mode: 0o700 })
    const lockPath = join(realpathSync(this.paths.profile), 'lock')
    let descriptor: number
    try {
      descriptor = openSync(lockPath, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const lock = lstatSync(lockPath)
        if (lock.isSymbolicLink() || !lock.isFile()) {
          throw new Error('desktop project: profile lock is not a regular file')
        }
        const owner = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10)
        let active = !Number.isSafeInteger(owner) || owner <= 0
        if (!active) {
          try {
            process.kill(owner, 0)
            active = true
          } catch (signalError) {
            active = (signalError as NodeJS.ErrnoException).code !== 'ESRCH'
          }
        }
        if (active) throw new Error('desktop project: another profile operation is active')
        unlinkSync(lockPath)
        descriptor = openSync(lockPath, 'wx', 0o600)
      } else {
        throw error
      }
    }
    try {
      writeSync(descriptor, `${String(process.pid)}\n`)
      fsyncSync(descriptor)
      return await operation()
    } finally {
      closeSync(descriptor)
      unlinkSync(lockPath)
    }
  }
}

/** Create build-only project metadata for materializing the signed runtime. */
export function createRuntimeProjectMetadata(projectDir: string, release: DesktopRelease): void {
  mkdirSync(projectDir, { recursive: true, mode: 0o700 })
  const packageSet = verifyDesktopCorePackageSet(projectDir, release.version)
  const manifest = {
    name: PROJECT_NAME,
    private: true,
    version: '0.0.0',
    dependencies: {
      ...desktopCorePackageOverrides(packageSet),
      [MOBILE_BUNDLE]: `file:./${MOBILE_VENDOR_DIR}`,
    },
    dsh: { profile: { bundles: [...DESKTOP_BUNDLES] } },
  }
  writeJson(join(projectDir, 'package.json'), manifest)
  writeFileSync(
    join(projectDir, 'pnpm-workspace.yaml'),
    workspaceFile(desktopCorePackageOverrides(packageSet)),
    { mode: 0o600 },
  )
}

/**
 * Create metadata for the unpackaged development project that links the current workspace.
 * @param projectDir - Disposable development profile directory.
 * @param release - Release identity shared by the linked CLI package and Electron shell.
 */
export function createDevelopmentProjectMetadata(projectDir: string, release: DesktopRelease): void {
  mkdirSync(projectDir, { recursive: true, mode: 0o700 })
  const manifest = {
    name: PROJECT_NAME,
    private: true,
    version: '0.0.0',
    dependencies: {
      [DSH_PACKAGE]: release.version,
      [DESKTOP_HOST_PACKAGE]: release.version,
    },
    dsh: { profile: { bundles: [...DESKTOP_BUNDLES] } },
  }
  writeJson(join(projectDir, 'package.json'), manifest)
  writeFileSync(join(projectDir, 'pnpm-workspace.yaml'), workspaceFile(), { mode: 0o600 })
}

/**
 * Activate the shipped mobile bundle in a profile created by an earlier release, and retire the bundles it replaces.
 * The retired packages' `file:` dependencies are dropped because their vendored directories no longer ship.
 * @param projectDir - Desktop profile directory holding the profile manifest.
 */
function enableDesktopBundles(projectDir: string): void {
  const manifest = readProfileManifest('dsh', projectDir)
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const dependencies = manifest.dependencies ?? {}
  const retired = LEGACY_MOBILE_BUNDLES.some(name => bundles.includes(name) || dependencies[name] !== undefined)
  if (!retired && (bundles.includes(MOBILE_BUNDLE) || dependencies[MOBILE_BUNDLE] !== undefined)) return
  const next = bundles.filter(bundle => !LEGACY_MOBILE_BUNDLES.includes(bundle))
  if (!next.includes(MOBILE_BUNDLE)) next.push(MOBILE_BUNDLE)
  const kept = manifest.dependencies === undefined
    ? undefined
    : Object.fromEntries(Object.entries(manifest.dependencies).filter(([name]) => !LEGACY_MOBILE_BUNDLES.includes(name)))
  writeProfileBundles(projectDir, kept === undefined ? manifest : { ...manifest, dependencies: kept }, next)
}

/**
 * Place shipped bundle packages in the profile's `node_modules`.
 * The loader resolves bundle entries with Node's module lookup from the profile directory, so a package that
 * exists only inside `app.asar` never mounts; copying keeps the shipped gateway loadable without a package install.
 * @param runtimeDsh - directory of the shipped `dsh` runtime tree.
 * @param projectDir - Desktop profile directory.
 */
function materializeBundledPlugins(runtimeDsh: string, projectDir: string): void {
  for (const name of BUNDLED_PLUGIN_PACKAGES) {
    const source = join(runtimeDsh, 'node_modules', name)
    const sourceManifest = join(source, 'package.json')
    if (!existsSync(sourceManifest)) continue
    const target = join(projectDir, 'node_modules', name)
    if (packageVersion(join(target, 'package.json')) === packageVersion(sourceManifest)) continue
    mkdirSync(join(projectDir, 'node_modules'), { recursive: true, mode: 0o700 })
    removeEntry(target)
    copyTree(source, target)
  }
}

function packageVersion(manifestPath: string): string | undefined {
  if (!existsSync(manifestPath)) return undefined
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : undefined
}

function removeEntry(path: string): void {
  const entry = lstatSync(path, { throwIfNoEntry: false })
  if (entry === undefined) return
  // Junctions and symlinks point at user-chosen directories; remove the link itself, never its target.
  if (entry.isSymbolicLink()) rmdirSync(path)
  else rmSync(path, { recursive: true, force: true })
}

function copyTree(source: string, target: string): void {
  mkdirSync(target, { recursive: true, mode: 0o700 })
  for (const name of readdirSync(source)) {
    const from = join(source, name)
    const to = join(target, name)
    if (statSync(from).isDirectory()) copyTree(from, to)
    else writeFileSync(to, readFileSync(from), { mode: 0o600 })
  }
}

/** Create the first external plugin profile without running a package manager. */
export function createPluginProfile(projectDir: string): void {
  initProfile(projectDir, DESKTOP_BUNDLES)
  enableDesktopBundles(projectDir)
}

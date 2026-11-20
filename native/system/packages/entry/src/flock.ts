/** Lazy POSIX flock entry; importing it does not load a native addon. */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { getSystemErrorName } from 'node:util'

interface FlockBinding {
  tryLock(fd: number, callback: (errno: number) => void): void
}

let binding: FlockBinding | undefined

/** Android's Node reports `'android'`, which the `NodeJS.Platform` union does not enumerate. */
const isAndroid = (process.platform as string) === 'android'

function loadBinding(): FlockBinding {
  if (binding) return binding
  // The Android app ships the addon as `$DSH_NATIVE_DIR/libdsh_flock.so`
  // (nativeLibraryDir); require() treats only `*.node` as native, so dlopen it.
  if (process.env.DSH_NATIVE_DIR !== undefined || isAndroid) {
    const nativeDir = process.env.DSH_NATIVE_DIR
    if (nativeDir === undefined) {
      throw Object.assign(new Error('flock on android requires DSH_NATIVE_DIR (libdsh_flock.so)'), {
        code: 'ERR_FLOCK_UNSUPPORTED_PLATFORM',
        syscall: 'flock',
      })
    }
    // dlopen fills `exports` in place; the holder only has to satisfy its parameter type.
    const holder = { exports: {} } as NodeModule
    process.dlopen(holder, join(nativeDir, 'libdsh_flock.so'))
    const loaded = holder.exports as FlockBinding
    binding = loaded
    return loaded
  }
  const { platform, arch } = process
  if (platform !== 'linux' && platform !== 'darwin') {
    throw Object.assign(new Error(`flock is not supported on ${platform}-${arch}`), {
      code: 'ERR_FLOCK_UNSUPPORTED_PLATFORM',
      syscall: 'flock',
    })
  }

  let filename = 'system.node'
  if (platform === 'linux') {
    // Node's report types omit the libc field supplied by Linux reports.
    const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } }
    filename = join(report.header.glibcVersionRuntime ? 'glibc' : 'musl', filename)
  }
  const require = createRequire(import.meta.url)
  const manifest = require.resolve(`@deepseek-ai/node-addon-system-${platform}-${arch}/package.json`)
  binding = require(join(dirname(manifest), 'bin', filename)) as FlockBinding
  return binding
}

/**
 * Attempt an exclusive, nonblocking POSIX flock on the caller's descriptor.
 * The syscall runs in asynchronous work, so acquisition can occur after this
 * call returns. Keep fd open until the promise settles; the binding never
 * opens, duplicates, or closes it. Closing the locked descriptor releases the
 * lock once all descriptors for its open file description are closed.
 * @param fd - Open file descriptor to lock; ownership remains with the caller.
 * @returns A promise resolving to void on acquisition. Contention rejects with
 *   EAGAIN/EWOULDBLOCK; other syscall failures also reject. Syscall errors carry
 *   code, positive errno, and syscall='flock'. Native setup errors, unsupported
 *   platforms, and addon loading failures reject; importing alone does not load it.
 */
export async function tryLockExclusive(fd: number): Promise<void> {
  const errno = await new Promise<number>((resolve) => {
    loadBinding().tryLock(fd, resolve)
  })
  if (errno === 0) return
  const code = getSystemErrorName(-errno)
  throw Object.assign(new Error(`${code}: flock failed`), {
    code,
    errno,
    syscall: 'flock',
  })
}

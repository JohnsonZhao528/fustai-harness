/**
 * Shared no-shell `execFile` and detached-launch runners for host-native OS integrations.
 * @module @deepseek-ai/dsh-native-command/runner
 */

import { execFile, spawn } from 'node:child_process'

/** Testable command boundary; native implementations never invoke a shell. */
export type NativeCommandRunner = (
  command: string,
  args: readonly string[],
  signal: AbortSignal,
  window: 'hidden' | 'visible',
) => Promise<{ stdout: string; stderr: string }>

/**
 * Run a host command with utf8 stdio, abort propagation, and explicit GUI visibility.
 * @param command - executable path or PATH name.
 * @param args - argv (never a shell string).
 * @param signal - caller/connection lifetime; abort terminates the child.
 * @param window - Windows startup visibility: `hidden` for background commands,
 * `visible` for GUI launchers. Ignored on other platforms.
 * @returns captured stdout/stderr on exit 0.
 */
export const runNativeCommand: NativeCommandRunner = (command, args, signal, window) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { encoding: 'utf8', signal, windowsHide: window === 'hidden' },
      (error, stdout, stderr) => {
        if (error !== null) {
          const failure = Object.assign(new Error(error.message, { cause: error }), {
            code: error.code,
            stdout,
            stderr,
          })
          reject(failure)
          return
        }
        resolve({ stdout, stderr })
      },
    )
  })

/** Testable hand-off boundary: start a GUI process and resolve once it runs. */
export type DetachedCommandLauncher = (
  command: string,
  args: readonly string[],
  signal: AbortSignal,
) => Promise<void>

/**
 * Start a detached GUI process that outlives the request, resolving once the OS
 * reports the child spawned. The signal is checked before launch only; passing it
 * to `spawn` would kill the editor as soon as the caller's request completes.
 * @param command - executable path or PATH name.
 * @param args - argv (never a shell string).
 * @param signal - caller lifetime checked before spawning.
 * @throws the caller's abort reason when the signal is already aborted, or the
 * spawn failure such as `ENOENT` when the executable cannot start.
 */
export const launchDetachedCommand: DetachedCommandLauncher = (command, args, signal) =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const child = spawn(command, [...args], { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })

/**
 * Host-side spawn of the detached helper (helper-protocol §4).
 *
 * The helper must survive the host it is replacing, so it is spawned `detached`
 * with its own process group and with stdout/stderr captured into the job's
 * `helper.log` — the UI's log view reads exactly that file.
 *
 * @module perse-updater/helper/spawn
 */

import { spawn } from 'node:child_process'
import { openSync, closeSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** What the host must tell the helper process. */
export interface SpawnHelperRequest {
  /** Package root that owns `apply-helper.mjs`. */
  readonly pluginRoot: string
  /** Job whose `request.json` the helper reads. */
  readonly jobId: string
  /** Harness home (`--home`). */
  readonly home: string
  /** File the helper's stdout/stderr are appended to. */
  readonly logPath: string
  /** Environment overrides (the acceptance harness relocates the launcher dir). */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** A spawned helper. */
export interface SpawnedHelper {
  /** Helper PID, when the OS reported one. */
  readonly pid?: number
  /** Command line as executed, for logs and evidence. */
  readonly command: string
}

/**
 * The exact argv the host spawns the helper with (helper-protocol §4).
 *
 * @param request - plugin root, job id, and home.
 * @returns the command array.
 */
export function helperArgv(request: Pick<SpawnHelperRequest, 'pluginRoot' | 'jobId' | 'home'>): string[] {
  return [join(request.pluginRoot, 'apply-helper.mjs'), '--job', request.jobId, '--home', request.home]
}

/**
 * Spawn the helper detached.
 *
 * @param request - plugin root, job id, home, log path, and environment.
 * @returns the spawned PID and the command line.
 * @throws {Error} when the process cannot be spawned; the caller maps that onto a Remote failure.
 */
export function spawnHelper(request: SpawnHelperRequest): SpawnedHelper {
  mkdirSync(dirname(request.logPath), { recursive: true })
  const argv = [process.execPath, ...helperArgv(request)]
  const fd = openSync(request.logPath, 'a')
  try {
    const child = spawn(argv[0] ?? process.execPath, argv.slice(1), {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, ...(request.env ?? {}) },
    })
    child.unref()
    return {
      ...(child.pid === undefined ? {} : { pid: child.pid }),
      command: argv.join(' '),
    }
  } finally {
    closeSync(fd)
  }
}

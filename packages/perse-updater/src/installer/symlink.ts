/**
 * Launcher symlink switch (migration-plan M-4).
 *
 * The pointer change is deliberately a single `ln -sfn <newBin> <symlinkPath>`
 * run as a child process: it is the command the migration plan specifies, it
 * needs no Node-level privilege, and its success is verified by reading the link
 * back rather than by trusting the exit code (the same "assert the product, not
 * the status" correction C-2 applies to installs). A failure restores the
 * previous target, so `update/switch-failed` always means "the running
 * generation is still the one on disk".
 *
 * @module perse-updater/installer/symlink
 */

import { lstatSync, mkdirSync, readlinkSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { assertAbsolute } from './paths.ts'
import { runCommand, type RunOptions } from './spawn.ts'
import { InstallerError } from './types.ts'

/** What {@link switchSymlink} needs. */
export interface SwitchRequest {
  /** Absolute path of the launcher symlink, e.g. `~/.local/bin/dsh`. */
  readonly symlinkPath: string
  /** Absolute path the symlink must end up pointing at. */
  readonly target: string
  /** `ln` binary to use; defaults to `ln` on `PATH`. */
  readonly lnBin?: string
  /** Kill budget and output bounds for the `ln` call. */
  readonly runOptions?: RunOptions
}

/** What {@link switchSymlink} did. */
export interface SwitchResult {
  /** Symlink that was switched. */
  readonly symlinkPath: string
  /** Target it points at after the switch. */
  readonly target: string
  /** Target it pointed at before, when it existed. */
  readonly previous?: string
  /** Whether the link actually moved. */
  readonly changed: boolean
  /** Command line as executed. */
  readonly command: string
}

/**
 * Atomically-enough switch the launcher symlink to `target`.
 *
 * @param request - link path and new target.
 * @returns the switch facts, including the previous target.
 * @throws {InstallerError} `switch-failed` when a non-symlink occupies the path, `ln` fails, or the link reads back wrong.
 */
export async function switchSymlink(request: SwitchRequest): Promise<SwitchResult> {
  const symlinkPath = assertAbsolute(request.symlinkPath, 'symlinkPath')
  const target = assertAbsolute(request.target, 'target')
  const lnBin = request.lnBin ?? 'ln'
  const previous = currentTarget(symlinkPath)

  // `ln -sfn` into an existing *directory* would silently create a nested link;
  // the design only ever moves a symlink, so refuse anything else outright.
  const existing = lstatOrUndefined(symlinkPath)
  if (existing !== undefined && !existing.isSymbolicLink()) {
    throw new InstallerError(
      'switch-failed',
      'switch',
      `${symlinkPath} exists and is not a symlink; refusing to replace it`,
    )
  }
  if (previous !== undefined && resolveTarget(symlinkPath, previous) === target) {
    return {
      symlinkPath,
      target,
      previous,
      changed: false,
      command: `${lnBin} -sfn ${target} ${symlinkPath}`,
    }
  }

  mkdirSync(dirname(symlinkPath), { recursive: true })
  const result = await runCommand(lnBin, ['-sfn', target, symlinkPath], request.runOptions ?? {})
  const after = currentTarget(symlinkPath)
  if (result.code !== 0 || after === undefined || resolveTarget(symlinkPath, after) !== target) {
    await restore(symlinkPath, previous, lnBin)
    throw new InstallerError(
      'switch-failed',
      'switch',
      `${result.command} did not produce a link to ${target} (exit=${result.code ?? 'signal'} readback=${after ?? 'none'})`,
      { logTail: result.output },
    )
  }
  return {
    symlinkPath,
    target,
    ...(previous === undefined ? {} : { previous }),
    changed: true,
    command: result.command,
  }
}

/** Raw target of the symlink, or `undefined` when absent or not a link. */
export function currentTarget(symlinkPath: string): string | undefined {
  try {
    return readlinkSync(symlinkPath)
  } catch {
    return undefined
  }
}

/** Put the link back where it was, best effort; a missing previous target means "unlink what we made". */
async function restore(symlinkPath: string, previous: string | undefined, lnBin: string): Promise<void> {
  if (previous === undefined) {
    await rm(symlinkPath, { force: true })
    return
  }
  await runCommand(lnBin, ['-sfn', previous, symlinkPath], {})
}

/** Resolve a (possibly relative) link target against the link's directory. */
function resolveTarget(symlinkPath: string, raw: string): string {
  return isAbsolute(raw) ? resolve(raw) : resolve(dirname(symlinkPath), raw)
}

/** `lstat`, treating "absent" as `undefined` and any other failure as a hard error. */
function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Path policy for the installer.
 *
 * Everything the installer writes or deletes is funnelled through these
 * assertions so a hostile or buggy caller cannot aim a `rm -rf` at the running
 * install: a version is exact SemVer (so it can never contain a path
 * separator), and every derived path must resolve to a location *under* the
 * runtime root (design/security.md §2).
 *
 * @module perse-updater/installer/paths
 */

import { rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { DSH_PACKAGE } from '../install.ts'
import { InstallerError } from './types.ts'

/** Refuse a path that is not absolute. */
export function assertAbsolute(path: string, label: string): string {
  if (typeof path !== 'string' || path === '' || !isAbsolute(path)) {
    throw new InstallerError('bad-request', 'validate', `${label} must be an absolute path, got ${JSON.stringify(path)}`)
  }
  return path
}

/**
 * Refuse a candidate path that escapes `root`.
 *
 * Comparison is done on resolved paths, so `..` segments and a sibling sharing
 * a name prefix (`/a/runtime-evil` vs `/a/runtime`) are both rejected.
 *
 * @param root - directory the candidate must stay inside.
 * @param candidate - path to check.
 * @param label - field name used in the refusal.
 * @returns the resolved candidate.
 */
export function assertUnder(root: string, candidate: string, label: string): string {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(candidate)
  const rel = relative(resolvedRoot, resolvedCandidate)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new InstallerError(
      'bad-request',
      'validate',
      `${label} ${resolvedCandidate} is not inside runtime root ${resolvedRoot}`,
    )
  }
  return resolvedCandidate
}

/** Package directory of a versioned prefix: `<prefix>/lib/node_modules/@deepseek-ai/dsh`. */
export function packageDirOf(prefix: string): string {
  return join(prefix, 'lib', 'node_modules', ...DSH_PACKAGE.split('/'))
}

/** Launcher entry the symlink must point at: `<prefix>/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`. */
export function binPathOf(prefix: string): string {
  return join(packageDirOf(prefix), 'lib', 'bin.js')
}

/** npm's own global launcher shim inside a prefix: `<prefix>/bin/dsh` (R3 C-8). */
export function prefixLauncherOf(prefix: string): string {
  return join(prefix, 'bin', ...DSH_PACKAGE.split('/').slice(-1))
}

/**
 * Delete a half-product directory, but only after re-proving it is under the
 * runtime root. This is the single `rm -rf` site of the installer.
 *
 * @param runtimeRoot - the only directory tree the installer may delete from.
 * @param target - the half-product prefix to remove.
 * @param label - field name used in the refusal.
 */
export async function removeUnder(runtimeRoot: string, target: string, label: string): Promise<void> {
  const guarded = assertUnder(runtimeRoot, target, label)
  await rm(guarded, { recursive: true, force: true })
}

/**
 * Helper-side re-validation of `jobs/<id>/request.json` (invariant H2).
 *
 * The helper never trusts the host's argv or the request document: every path is
 * re-derived from the home the helper was *told* on its own command line, and the
 * launcher symlink is constrained to the one directory the plugin is
 * allowed to move (`helper-protocol.md` §4, `security.md` §2). A request that
 * fails any check is refused before a single byte is written.
 *
 * @module perse-updater/helper/request
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { assertUnder } from '../installer/paths.ts'
import { parseVersion } from '../semver.ts'
import { StateError, type JobAction, type JobRequest } from '../state/types.ts'

/** What the helper knows independently of the request document. */
export interface RequestValidationOptions {
  /** `--home` value; the request's `dshHome` must equal it. */
  readonly home: string
  /** `<home>/runtime`, the only root an install may live under. */
  readonly runtimeRoot: string
  /** `~/.local/bin` by default, or the test override. */
  readonly localBinDir: string
}

/** Resolve the launcher directory, allowing the acceptance harness to relocate it. */
export function resolveLocalBinDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const override = env['DSH_UC_LOCAL_BIN_DIR']
  if (override !== undefined && override !== '') return resolve(override)
  return join(homedir(), '.local', 'bin')
}

/**
 * Validate one parsed request document.
 *
 * @param raw - parsed `request.json`.
 * @param options - independently-known home, runtime root, and launcher dir.
 * @returns the validated request, unchanged.
 * @throws {StateError} `bad-request` for any malformed or out-of-bounds field.
 */
export function assertHelperRequest(raw: unknown, options: RequestValidationOptions): JobRequest {
  const refuse: (reason: string) => never = reason => {
    throw new StateError('bad-request', 'helper-request', reason)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) refuse('request.json is not an object')
  const record = raw as Record<string, unknown>
  if (record['schema'] !== 1) refuse(`unsupported request schema ${String(record['schema'])}`)

  const action = record['action']
  if (action !== 'apply' && action !== 'restart' && action !== 'rollback') refuse(`invalid action ${JSON.stringify(action)}`)

  const version = requireString(record['version'], 'version')
  if (parseVersion(version) === undefined) refuse(`version ${JSON.stringify(version)} is not exact SemVer`)

  const dshHome = requireAbsolute(record['dshHome'], 'dshHome')
  if (resolve(dshHome) !== resolve(options.home)) {
    refuse(`request.dshHome ${dshHome} does not match --home ${options.home}`)
  }
  const runtimeRoot = requireAbsolute(record['runtimeRoot'], 'runtimeRoot')
  if (resolve(runtimeRoot) !== resolve(options.runtimeRoot)) {
    refuse(`request.runtimeRoot ${runtimeRoot} does not match ${options.runtimeRoot}`)
  }

  const targetPrefix = requireAbsolute(record['targetPrefix'], 'targetPrefix')
  under(runtimeRoot, targetPrefix, 'targetPrefix', refuse)

  const newBin = requireAbsolute(record['newBin'], 'newBin')
  under(targetPrefix, newBin, 'newBin', refuse)

  const previousBin = record['previousBin']
  if (previousBin !== undefined && previousBin !== null) {
    const absolute = requireAbsolute(previousBin, 'previousBin')
    if (!isAbsolute(absolute)) refuse(`previousBin ${absolute} is not absolute`)
  }

  const symlink = requireAbsolute(record['symlink'], 'symlink')
  const allowedSymlink = join(options.localBinDir, 'dsh')
  if (resolve(symlink) !== resolve(allowedSymlink)) {
    refuse(`symlink ${symlink} is not the launcher link ${allowedSymlink} (security §2)`)
  }

  const port = record['port']
  if (!Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65_535) {
    refuse(`port ${JSON.stringify(port)} is not a usable TCP port`)
  }

  const profile = requireString(record['profile'], 'profile')
  if (!/^[A-Za-z0-9._-]+$/.test(profile)) refuse(`profile ${JSON.stringify(profile)} is not a plain profile name`)

  const hostPid = record['hostPid']
  if (!Number.isSafeInteger(hostPid) || (hostPid as number) < 0) {
    refuse(`hostPid ${JSON.stringify(hostPid)} is not a PID`)
  }

  const patchPath = requireAbsolute(record['patchPath'], 'patchPath')
  under(join(dshHome, 'profiles'), patchPath, 'patchPath', refuse)

  // `reportId` is audit-only for `restart`/`rollback`; the host legitimately
  // sends '' when no preflight report is involved (WP8: a restart of a state
  // recorded outside an apply). It must still be a string.
  const reportId = record['reportId']
  if (typeof reportId !== 'string') refuse('reportId must be a string')
  const isolateBlocked = record['isolateBlocked']
  if (typeof isolateBlocked !== 'boolean') refuse('isolateBlocked must be a boolean')

  const isolateTargets = requireStringArray(record['isolateTargets'], 'isolateTargets')
  const blockedRules = requireStringArray(record['blockedRules'], 'blockedRules')
  const createdAt = requireString(record['createdAt'], 'createdAt')

  return {
    schema: 1,
    action: action as JobAction,
    version,
    targetPrefix,
    ...(previousBin === undefined || previousBin === null ? {} : { previousBin: String(previousBin) }),
    newBin,
    symlink,
    port: port as number,
    profile,
    hostPid: hostPid as number,
    dshHome,
    runtimeRoot,
    patchPath,
    reportId: String(reportId),
    isolateBlocked,
    isolateTargets,
    blockedRules,
    createdAt,
  }
}

/** Require a non-empty string. */
function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw new StateError('bad-request', 'helper-request', `${field} must be a non-empty string`)
  return value
}

/** Require an absolute path string. */
function requireAbsolute(value: unknown, field: string): string {
  const path = requireString(value, field)
  if (!isAbsolute(path)) throw new StateError('bad-request', 'helper-request', `${field} ${path} is not absolute`)
  return path
}

/** Require an array of strings. */
function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new StateError('bad-request', 'helper-request', `${field} must be an array of strings`)
  }
  return value as string[]
}

/** Re-assert containment, translating the installer's error into a state error. */
function under(root: string, path: string, field: string, refuse: (reason: string) => never): void {
  try {
    assertUnder(root, path, field)
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error))
  }
}

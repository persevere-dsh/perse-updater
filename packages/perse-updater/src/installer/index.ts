/**
 * Installer orchestrator: install → record → switch → farm.
 *
 * This is the WP6 seam `updateCenter.apply` calls. It performs exactly the three
 * state-changing steps the work package owns — versioned install, `current.json`
 * write, symlink switch — plus the conditional S4b farm pass. Restart,
 * self-check and rollback are deliberately absent: they belong to WP7's helper
 * process (`design/helper-protocol.md` §5), and `current.json` already carries
 * everything that helper will need.
 *
 * Ordering is the contract: the pointer record naming the old generation as
 * `previous` is written before the symlink moves (I4), and a failed switch
 * restores both the symlink and the record, so `update/switch-failed` never
 * leaves a half-applied generation behind.
 *
 * @module perse-updater/installer
 */

import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseVersion } from '../semver.ts'
import {
  entryFromSymlink,
  readCurrent,
  resolveCurrentPath,
  restoreCurrent,
  writeCurrentAtomic,
} from './current.ts'
import { cleanFarmPollution, type FarmCleanupResult } from './farm.ts'
import { assertAbsolute } from './paths.ts'
import { switchSymlink, type SwitchResult } from './symlink.ts'
import { installVersioned, type VersionedInstallResult } from './versioned-install.ts'
import { InstallerError, type CurrentState, type LauncherEntry } from './types.ts'
import type { UpdateStep } from '../types.ts'

export * from './types.ts'
export { resolveCurrentPath, readCurrent, writeCurrentAtomic, entryFromBin, entryFromSymlink, readSymlinkTarget } from './current.ts'
export { switchSymlink, currentTarget } from './symlink.ts'
export { installVersioned, collectAssertions, buildNpmArgs, DEFAULT_SCRIPT_ALLOWLIST, type NativeAssertion, type VersionedInstallResult } from './versioned-install.ts'
export { scanFarmPollution, cleanFarmPollution, type FarmCandidate, type FarmPollutionScan, type FarmCleanupResult } from './farm.ts'
export { assertUnder, assertAbsolute, binPathOf, packageDirOf, prefixLauncherOf, removeUnder } from './paths.ts'

/** Deployment knobs `updateCenter.apply` reads out of the plugin config. */
export interface InstallerOptions {
  /** Runtime root; defaults to `<dshHome>/runtime`. */
  readonly runtimeRoot?: string
  /** Launcher symlink to switch; defaults to `~/.local/bin/dsh`. */
  readonly symlinkPath?: string
  /** npm cache directory; defaults to a `$TMPDIR` cache. */
  readonly cacheDir?: string
  /** Candidate whitelist. When absent, `apply` derives it from the registry. */
  readonly allowedVersions?: readonly string[]
  /** Generation to record as `previous` when no `current.json` exists yet (M-2). */
  readonly previous?: LauncherEntry
  /** Patch backup path to record for a later rollback (I6); WP7 fills it. */
  readonly patchBackup?: string
  /** npm executable; defaults to `npm` on `PATH`. */
  readonly npmBin?: string
  /** Kill budget for the versioned install. */
  readonly installTimeoutMs?: number
  /** Whether to run the conditional S4b farm pass; defaults to `true`. */
  readonly cleanFarm?: boolean
  /** `--strict-allow-scripts` policy; defaults to `auto` (probe the installed npm). */
  readonly strictAllowScripts?: boolean | 'auto'
}

/** Concrete absolute paths the installer writes to; every one is parameterized for /tmp tests. */
export interface InstallerPaths {
  /** `<dshHome>/runtime`. */
  readonly runtimeRoot: string
  /** `<dshHome>/update-center/current.json`. */
  readonly currentPath: string
  /** Launcher symlink, `~/.local/bin/dsh` by default. */
  readonly symlinkPath: string
  /** npm cache directory. */
  readonly cacheDir: string
  /** `<dshHome>/profiles/node_modules`. */
  readonly farmDir: string
}

/**
 * Resolve the installer's paths from a harness home plus overrides.
 *
 * @param dshHome - harness home (`$DSH_HOME` or `~/.dsh`).
 * @param options - deployment overrides.
 * @param home - user home used for the default symlink path.
 * @returns the absolute paths.
 */
export function resolveInstallerPaths(
  dshHome: string,
  options: InstallerOptions = {},
  home: string = homedir(),
): InstallerPaths {
  return {
    runtimeRoot: options.runtimeRoot ?? join(dshHome, 'runtime'),
    currentPath: resolveCurrentPath(dshHome),
    symlinkPath: options.symlinkPath ?? join(home, '.local', 'bin', 'dsh'),
    cacheDir: options.cacheDir ?? join(tmpdir(), 'perse-updater-npm-cache'),
    farmDir: join(dshHome, 'profiles', 'node_modules'),
  }
}

/** Everything one install-and-switch pass needs. */
export interface InstallerRequest extends InstallerPaths {
  /** Exact version to install; must be in {@link InstallerRequest.allowedVersions}. */
  readonly version: string
  /** Candidate whitelist the version must hit (I2, installer side). */
  readonly allowedVersions: readonly string[]
  /** Recorded `previous` fallback when no `current.json` exists. */
  readonly previous?: LauncherEntry
  /** Patch backup path recorded in `current.json`. */
  readonly patchBackup?: string
  /** Script allowlist passed to npm. */
  readonly allowlist?: readonly string[]
  /** npm executable. */
  readonly npmBin?: string
  /** Node executable used for the native `require` assertion. */
  readonly nodeBin?: string
  /** Kill budget for the versioned install. */
  readonly installTimeoutMs?: number
  /** Extra npm environment. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** `--strict-allow-scripts` policy. */
  readonly strictAllowScripts?: boolean | 'auto'
  /** Whether to run the conditional farm pass; defaults to `true`. */
  readonly cleanFarm?: boolean
  /** Clock injection, for deterministic `updatedAt`. */
  readonly now?: () => Date
  /** Progress sink. */
  readonly log?: (line: string) => void
}

/** Outcome of one install-and-switch pass. */
export interface InstallerOutcome {
  /** Always `switched`: the symlink moved and `current.json` names the new generation. */
  readonly phase: 'switched'
  /** Installed version. */
  readonly version: string
  /** Versioned prefix. */
  readonly prefix: string
  /** Launcher entry the symlink now points at. */
  readonly bin: string
  /** The record written to `current.json`. */
  readonly current: CurrentState
  /** The generation a rollback would return to. */
  readonly previous?: LauncherEntry
  /** Versioned-install facts, including native assertions. */
  readonly install: VersionedInstallResult
  /** Symlink-switch facts. */
  readonly switch: SwitchResult
  /** Farm pass result; `undefined` when the pass was disabled. */
  readonly farm?: FarmCleanupResult
  /** Pipeline steps, in order, for the (WP7) state machine. */
  readonly steps: readonly UpdateStep[]
}

/**
 * Install one candidate version and move the launcher to it.
 *
 * @param request - version, whitelist, paths, and policy.
 * @returns what was installed, recorded, and switched.
 * @throws {InstallerError} `bad-request` (version/whitelist/path), `install-failed`, or `switch-failed`.
 */
export async function installAndSwitch(request: InstallerRequest): Promise<InstallerOutcome> {
  const log = request.log ?? ((): void => {})
  const steps: UpdateStep[] = []
  const version = assertCandidate(request.version, request.allowedVersions)
  const currentPath = assertAbsolute(request.currentPath, 'currentPath')
  const symlinkPath = assertAbsolute(request.symlinkPath, 'symlinkPath')
  const farmDir = assertAbsolute(request.farmDir, 'farmDir')
  log(`installer: validate ok version=${version} runtimeRoot=${request.runtimeRoot}`)

  const existing = await readCurrent(currentPath)
  const previous = choosePrevious(existing, request.previous, symlinkPath, version)

  log(`installer: install begin version=${version}`)
  const install = await installVersioned({
    version,
    runtimeRoot: request.runtimeRoot,
    cacheDir: request.cacheDir,
    ...(request.allowlist === undefined ? {} : { allowlist: request.allowlist }),
    ...(request.npmBin === undefined ? {} : { npmBin: request.npmBin }),
    ...(request.nodeBin === undefined ? {} : { nodeBin: request.nodeBin }),
    ...(request.installTimeoutMs === undefined ? {} : { timeoutMs: request.installTimeoutMs }),
    ...(request.env === undefined ? {} : { env: request.env }),
    ...(request.strictAllowScripts === undefined ? {} : { strictAllowScripts: request.strictAllowScripts }),
    log,
  })
  steps.push({
    id: 'install',
    state: 'done',
    detail: install.reused ? `reused ${install.prefix}` : `${install.prefix} (${install.durationMs} ms)`,
  })

  const active: LauncherEntry = { version, prefix: install.prefix, bin: install.bin }
  const patchBackup = request.patchBackup ?? existing?.patchBackup
  const next: CurrentState = {
    active,
    ...(previous === undefined ? {} : { previous }),
    symlink: symlinkPath,
    ...(patchBackup === undefined ? {} : { patchBackup }),
    updatedAt: (request.now ?? ((): Date => new Date()))().toISOString(),
  }

  // I4: the record naming the old generation as `previous` must be durable
  // before the symlink moves, so a crash in between is recoverable from disk.
  log(`installer: current.json write begin path=${currentPath} active=${version} previous=${previous?.version ?? '(none)'}`)
  await writeCurrentAtomic(currentPath, next)
  steps.push({ id: 'current', state: 'done', detail: `${currentPath} active=${version} previous=${previous?.version ?? '(none)'}` })

  log(`installer: switch begin ${symlinkPath} -> ${active.bin}`)
  let switched: SwitchResult
  try {
    switched = await switchSymlink({ symlinkPath, target: active.bin })
  } catch (error) {
    await restoreCurrent(currentPath, existing)
    steps.push({ id: 'switch', state: 'failed', detail: error instanceof Error ? error.message : String(error) })
    throw error
  }
  steps.push({ id: 'switch', state: 'done', detail: `${switched.command}${switched.changed ? '' : ' (already current)'}` })

  let farm: FarmCleanupResult | undefined
  if (request.cleanFarm !== false) {
    log(`installer: farm scan begin dir=${farmDir}`)
    farm = await cleanFarmPollution(farmDir)
    steps.push({
      id: 'farm',
      state: 'done',
      detail: farm.selfHeal
        ? `no pollution (${farm.total} farm entries); boot self-heal owns the generation change`
        : `removed ${farm.removed.length} non-symlink farm entr${farm.removed.length === 1 ? 'y' : 'ies'}`,
    })
  }

  log(`installer: done version=${version}`)
  return {
    phase: 'switched',
    version,
    prefix: install.prefix,
    bin: install.bin,
    current: next,
    ...(previous === undefined ? {} : { previous }),
    install,
    switch: switched,
    ...(farm === undefined ? {} : { farm }),
    steps,
  }
}

/** Assert the version is exact SemVer and present in the candidate whitelist. */
function assertCandidate(version: unknown, allowed: readonly string[]): string {
  if (typeof version !== 'string' || version === '' || parseVersion(version) === undefined) {
    throw new InstallerError('bad-request', 'validate', `not an exact SemVer version: ${JSON.stringify(version)}`)
  }
  if (!Array.isArray(allowed) || allowed.length === 0) {
    throw new InstallerError('bad-request', 'validate', 'candidate whitelist is empty')
  }
  if (!allowed.includes(version)) {
    throw new InstallerError('bad-request', 'validate', `${version} is not in the candidate whitelist`)
  }
  return version
}

/**
 * Pick the generation a rollback should return to.
 *
 * Precedence: the recorded `active` (the only authority once the file exists),
 * then the caller's `previous` (M-2 zero-copy registration), then the generation
 * the launcher symlink currently points at. A predecessor equal to the version
 * being installed is dropped — rolling back onto itself is not a rollback.
 */
function choosePrevious(
  existing: CurrentState | undefined,
  requested: LauncherEntry | undefined,
  symlinkPath: string,
  version: string,
): LauncherEntry | undefined {
  const candidates = [
    existing?.active,
    existing === undefined ? requested : existing.previous,
    existing === undefined ? entryFromSymlink(symlinkPath) : undefined,
  ]
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.version !== version) return candidate
  }
  return undefined
}

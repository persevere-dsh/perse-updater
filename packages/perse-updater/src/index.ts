/**
 * `updateCenter` — the host half of the DSH version-update plugin.
 *
 * This module is a Loader entry plugin. It owns one Cordis Service registered
 * under the key `updateCenter`, which is also the Remote namespace, and it
 * exposes that service to the API Gateway's strict descriptors through the
 * generated `./typert` artifact (`dsh-typert-loader` discovers the export and
 * registers it — R1 §3.4).
 *
 * WP1 implemented `versions`, WP3 `preflight`, WP6 the versioned installer. WP7
 * turns `apply` into a **job**: the host claims the on-disk lock (I1), binds the
 * request to a completed report (I2), writes `jobs/<id>/request.json`, spawns the
 * detached helper, and returns the `jobId` immediately. The helper then runs
 * `install → shadow boot → isolate → switch` (C-11: install before verify, and no
 * switch unless the shadow boot passed) and stops at `switched`, waiting for the
 * user's explicit restart (I5).
 *
 * `status()` stays a rebuild from disk plus live probes, and `rollback()` starts
 * a rollback helper. Crash recovery for whatever the last process left behind
 * lives in `helper/recover.ts` and runs before any new write job.
 *
 * WP8 completes the loop: `restart()` and `restorePatch()` are `@Remote` wire
 * methods, activation runs the host-start takeover best-effort, and the client
 * half drives the progress view, the user-confirmed restart, rollback, and the
 * isolated-plugin restore.
 *
 * @module perse-updater
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { buildVersionsResult } from './candidates.ts'
import { readRunningInstall } from './install.ts'
import { fetchRegistrySnapshot, RegistryUnreachableError, resolveDshHome } from './registry.ts'
import { scanContractTree, scanLocalEnvironment, type CandidateContract } from './contract-scan.ts'
import { CandidateUnavailableError, resolveCandidateTree } from './candidate/tree.ts'
import { runPreflight } from './preflight/index.ts'
import { ReportStore } from './preflight/store.ts'
import { verifyInStaging, type StagingResult } from './staging/verify.ts'
import { resolveInstallerPaths, type InstallerOptions } from './installer/index.ts'
import { readCurrent } from './installer/current.ts'
import { restorePatchBackup } from './isolate/index.ts'
import { spawnHelper, recoverOnStart, type HelperBudgets, type RecoveryDeps, type RecoveryOutcome } from './helper/index.ts'
import { StateError, StateStore, createProbes, rebuildStatus, resolveStatePaths, type JobRequest, type StateDocument } from './state/index.ts'
import { compareVersions, parseVersion } from './semver.ts'
import type {
  ApplyInput,
  JobHandle,
  PreflightInput,
  PreflightReport,
  UpdateStatus,
  VersionsInput,
  VersionsResult,
} from './types.ts'

export type * from './types.ts'
export { buildVersionsResult, type RegistrySnapshot } from './candidates.ts'
export { readRunningInstall } from './install.ts'
export { RegistryUnreachableError } from './registry.ts'
export { VERSION_PATTERN, assertVersion, compareVersions, parseVersion } from './semver.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The request was malformed, unbound to a live report, or racy against a running job. */
    'update/bad-request': { readonly reason: string; readonly method: string; readonly input?: string }
    /** The npm registry could not be reached or answered a non-OK status. */
    'update/registry-unreachable': { readonly reason: string }
    /** The report contains `block` findings and the caller did not agree to isolate them. */
    'update/blocked': { readonly rules: readonly string[] }
    /** The shadow boot of the candidate failed. */
    'update/staging-failed': { readonly logTail: string }
    /** The versioned `npm install -g --prefix` failed. */
    'update/install-failed': { readonly version: string; readonly logTail: string }
    /** The launcher symlink could not be switched (it was restored). */
    'update/switch-failed': { readonly reason: string }
    /** The candidate booted but its self-check failed; an automatic rollback follows. */
    'update/health-check-failed': { readonly stage: string }
    /** The rollback itself failed and needs a human. */
    'update/rollback-failed': { readonly reason: string }
  }
}

/** The slice of the Cordis Context this plugin uses. */
export interface UpdateCenterContext {
  /** Resolve a Cordis service by key. */
  get(name: string): unknown
}

/** The host-side knobs of the WP7 job pipeline. */
export interface HelperOptions {
  /** Package root that owns `apply-helper.mjs`; derived from this module when omitted. */
  readonly pluginRoot?: string
  /** Launcher directory override; defaults to the directory of `installer.symlinkPath`. */
  readonly localBinDir?: string
  /** Port the restarted instance must listen on; defaults to 3080. */
  readonly port?: number
  /** Profile to boot after the restart; defaults to `$DSH_PROFILE` or `web`. */
  readonly profile?: string
  /** Wait budgets handed to the helper. */
  readonly budgets?: Partial<HelperBudgets>
  /** Extra environment for the helper child. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** Deployment policy for the plugin; every field has a safe default. */
export interface UpdateCenterConfig {
  /** Registry origin override; defaults to `https://registry.npmjs.org`. */
  readonly registry?: string
  /** Registry cache freshness in milliseconds; defaults to five minutes. */
  readonly cacheTtlMs?: number
  /** Harness home holding the plugin's own state; defaults to `$DSH_HOME` or `~/.dsh`. */
  readonly dshHome?: string
  /** Installer paths and policy; every field defaults to the production layout. */
  readonly installer?: InstallerOptions
  /** Restart/helper policy. */
  readonly helper?: HelperOptions
  /** Whether to run crash recovery before a write job; defaults to `true`. */
  readonly recover?: boolean
  /** Recovery seams for tests. */
  readonly recovery?: Partial<RecoveryDeps>
}

/** Cordis plugin name. */
export const name = 'perse-updater'

/**
 * Services that must exist before this plugin activates.
 *
 * Deliberately empty. Measured on this machine: an `inject` entry naming a
 * service the profile does not mount leaves the entry `pending (waiting for
 * service: …)`, and app-boot turns that into `plugin tree failed to load: 1
 * entry did not activate` — the whole profile fails to start, not just this
 * plugin. This plugin needs nothing but its own context, so it asks for nothing.
 */
export const inject: string[] = []

/** Host service backing the generated `ctx.remote.updateCenter` namespace. */
export class UpdateCenter extends TypertRemoteService {
  private readonly config: UpdateCenterConfig
  /** Completed reports, bound to their `id` for a later `apply` (WP4/WP6). */
  private readonly preflightReports = new ReportStore()
  /**
   * In-memory single-flight guard (I1). It is set **before the first await** so
   * two concurrent calls cannot both pass it; the durable half of I1 is the
   * on-disk lock, which covers the job's whole lifetime across processes.
   */
  private applying = false
  /** Lazily-run host-start recovery, so it runs at most once per service. */
  private recovery: Promise<RecoveryOutcome> | undefined

  /**
   * @param ctx - owning Cordis context.
   * @param config - registry, cache, home, installer, and helper overrides.
   */
  constructor(ctx: UpdateCenterContext, config: UpdateCenterConfig = {}) {
    super(ctx, 'updateCenter', { namespace: 'updateCenter' })
    this.config = config
  }

  /**
   * List dsh versions strictly newer than the running installation.
   *
   * @param input - `force` bypasses both registry caches.
   * @returns candidates in strict semver descending order plus the current install.
   * @throws {RemoteError} `update/registry-unreachable` when the registry cannot be read.
   */
  @Remote
  async versions(input?: VersionsInput): Promise<VersionsResult> {
    const install = readRunningInstall()
    // `probe` is local diagnostics; the wire shape is exactly the contract's
    // `{ version, prefix, channel }`.
    const current = { version: install.version, prefix: install.prefix, channel: install.channel }
    try {
      const answer = await fetchRegistrySnapshot({
        ...(this.config.registry === undefined ? {} : { registry: this.config.registry }),
        ...(this.config.cacheTtlMs === undefined ? {} : { cacheTtlMs: this.config.cacheTtlMs }),
        ...(this.config.dshHome === undefined ? {} : { dshHome: this.config.dshHome }),
        force: input?.force === true,
      })
      return buildVersionsResult(answer.snapshot, current)
    } catch (error) {
      if (error instanceof RegistryUnreachableError) {
        throw new RemoteError('update/registry-unreachable', error.message, { reason: error.message }, { cause: error })
      }
      throw error
    }
  }

  /**
   * Produce the read-only compatibility report for one candidate.
   *
   * Static scans explain *why*; the shadow boot (WP5's `staging/verify.ts`) is the
   * decisive judgement and, per C-11, runs again inside `apply` once the candidate
   * has a real launcher. This method never installs, never switches, and never
   * writes to the harness home.
   *
   * @param input - candidate version; must be strictly newer than the running one.
   * @returns the preflight report, also bound in memory for `apply`.
   * @throws {RemoteError} `update/bad-request` when the version is malformed or not newer.
   */
  @Remote
  async preflight(input: PreflightInput): Promise<PreflightReport> {
    const install = readRunningInstall()
    const version = assertPreflightVersion(input, install.version)
    const dshHome = this.config.dshHome ?? resolveDshHome()
    const profile = this.helperProfile()

    let candidate: CandidateContract | undefined
    let candidateUnavailable: string | undefined
    try {
      const tree = await resolveCandidateTree({
        version,
        running: { version: install.version, prefix: install.prefix },
        ...(this.config.registry === undefined ? {} : { registry: this.config.registry }),
        dshHome,
      })
      const scanned = scanContractTree(tree.root, version, { source: tree.source })
      candidate = { ...scanned, notes: [...scanned.notes, ...tree.notes] }
    } catch (error) {
      candidateUnavailable = error instanceof CandidateUnavailableError
        ? `${error.message} (tried: ${error.tried.join(' -> ')})`
        : String(error)
    }

    const local = scanLocalEnvironment({ dshHome, profile, installPrefix: install.prefix })
    const staging: StagingResult = await verifyInStaging({
      version,
      dshHome,
      profile,
      installPrefix: install.prefix,
      ...(candidate === undefined ? {} : { candidateRoot: candidate.treeRoot }),
    })

    const report = runPreflight({
      version,
      ...(candidate === undefined ? {} : { candidate }),
      ...(candidateUnavailable === undefined ? {} : { candidateUnavailable }),
      local,
      staging,
    })
    this.preflightReports.put(report)
    return report
  }

  /**
   * Look up a live preflight binding.
   *
   * @param id - report id handed back by {@link UpdateCenter.preflight}.
   * @returns the report while its 30-minute binding is live.
   */
  report(id: string): PreflightReport | undefined {
    return this.preflightReports.find(id)
  }

  /**
   * Start an update job for a previously reported candidate.
   *
   * The host does the cheap, synchronous validations (shape, report binding,
   * isolation consent, single-flight) and then hands the long work to the
   * detached helper: it writes the job request and returns the `jobId` without
   * waiting for the install or the symlink move. The job itself advances
   * `installing → installed → staging → staged → isolating? → switched`; a failed
   * shadow boot stops before the switch (C-11) and leaves the running generation
   * alone.
   *
   * @param input - report handle and the operator's isolation consent.
   * @returns the job handle, immediately.
   * @throws {RemoteError} `update/bad-request` when the input, report binding, candidate set, or a path is invalid; `update/blocked` when blocking findings are not consented to; `update/registry-unreachable` when the candidate whitelist cannot be re-derived.
   */
  @Remote
  async apply(input: ApplyInput): Promise<JobHandle> {
    const request = requireApplyInput(input)
    const report = this.preflightReports.find(request.reportId)
    if (report === undefined) {
      throw applyRefusal(
        'reportId is unknown or has expired; run preflight again before applying',
        'report-not-found',
        request.reportId,
      )
    }
    if (parseVersion(report.version) === undefined) {
      throw applyRefusal(`report version ${JSON.stringify(report.version)} is not exact SemVer`, 'invalid-version', report.version)
    }
    const blocked = blockedTargets(report)
    // I6: disabling blocking plugins needs explicit consent; the server-side gate
    // is here, the backup and the disable happen in the helper after this point.
    if (blocked.rules.length > 0 && request.isolateBlocked !== true) {
      throw new RemoteError(
        'update/blocked',
        `preflight for ${report.version} reports blocking findings: ${blocked.rules.join(', ')}`,
        { rules: blocked.rules },
      )
    }
    throwIfBusy(this.applying, request.reportId)
    // Claim the in-flight slot *before* the first await so two concurrent calls
    // cannot both pass the guard (I1, memory half).
    this.applying = true
    try {
      const installer = this.config.installer ?? {}
      const dshHome = this.config.dshHome ?? resolveDshHome()
      const paths = resolveInstallerPaths(dshHome, installer)
      // Server-side candidate whitelist (remote-contract §5.1); a caller-supplied
      // list is only ever a test seam.
      const allowed = installer.allowedVersions ?? await this.candidateVersions()
      if (!allowed.includes(report.version)) {
        throw applyRefusal(`version ${report.version} is not in the candidate whitelist`, 'not-a-candidate', report.version)
      }
      const store = this.store(dshHome)
      await this.ensureRecovered(store)
      const jobId = makeJobId()
      await store.acquire(jobId, 'apply')
      try {
        const jobRequest = this.buildRequest({
          action: 'apply',
          version: report.version,
          paths,
          dshHome,
          reportId: report.id,
          isolateBlocked: request.isolateBlocked === true,
          isolateTargets: blocked.targets,
          blockedRules: blocked.rules,
          previousBin: undefined,
        })
        await store.writeRequest(jobId, jobRequest)
        await store.writeState({
          schema: 1,
          phase: 'installing',
          jobId,
          action: 'apply',
          version: report.version,
          reportId: report.id,
          steps: [],
          report,
          ownerPid: process.pid,
        }, { pid: process.pid, jobId })
        const spawned = this.spawn(store, jobId, paths)
        await store.appendProgress(jobId, { step: 'spawn', state: 'done', detail: spawned.command, phase: 'installing' })
        this.preflightReports.delete(report.id)
        return { jobId }
      } catch (error) {
        await store.release({ pid: process.pid, jobId }).catch(() => false)
        throw error
      }
    } catch (error) {
      throw mapJobError(error, report.version, 'apply')
    } finally {
      this.applying = false
    }
  }

  /**
   * Rebuild the current status from `state.json`, the job's progress log, and
   * live probes.
   *
   * This method performs no writes and holds no in-memory state: a fresh process
   * that has only the files on disk returns the same answer (U-09).
   *
   * @returns the current status.
   */
  @Remote
  async status(): Promise<UpdateStatus> {
    const dshHome = this.config.dshHome ?? resolveDshHome()
    const store = this.store(dshHome)
    await store.init()
    const state = await store.readState()
    const jobId = state?.jobId
    const progress = jobId === undefined ? [] : await store.readProgress(jobId)
    const current = await readCurrent(store.paths.currentPath)
    const lock = await store.readLock()
    return rebuildStatus({
      ...(state === undefined ? {} : { state }),
      progress,
      ...(current === undefined ? {} : { current }),
      ...(lock === undefined ? {} : { lock }),
      probes: createProbes(),
    })
  }

  /**
   * Start a rollback job to `current.json.previous`.
   *
   * @returns the job handle, immediately.
   * @throws {RemoteError} `update/bad-request` when another job is running or no rollback target is recorded.
   */
  @Remote
  async rollback(): Promise<JobHandle> {
    throwIfBusy(this.applying, 'rollback')
    this.applying = true
    try {
      const dshHome = this.config.dshHome ?? resolveDshHome()
      const installer = this.config.installer ?? {}
      const paths = resolveInstallerPaths(dshHome, installer)
      const store = this.store(dshHome)
      await this.ensureRecovered(store)
      const current = await readCurrent(store.paths.currentPath)
      if (current?.previous === undefined) {
        throw applyRefusal('current.json records no previous generation to roll back to', 'no-previous', 'rollback')
      }
      const jobId = makeJobId()
      await store.acquire(jobId, 'rollback')
      try {
        const active = current.active
        const jobRequest = this.buildRequest({
          action: 'rollback',
          version: active.version,
          paths,
          dshHome,
          reportId: '',
          isolateBlocked: false,
          isolateTargets: [],
          blockedRules: [],
          previousBin: current.previous.bin,
        })
        await store.writeRequest(jobId, jobRequest)
        const prior = await store.readState()
        const document: Omit<StateDocument, 'updatedAt'> = {
          schema: 1,
          phase: 'rolling-back',
          jobId,
          action: 'rollback',
          version: current.previous.version,
          ...(prior?.reportId === undefined ? {} : { reportId: prior.reportId }),
          steps: [],
          ...(prior?.report === undefined ? {} : { report: prior.report }),
          ...(prior?.isolation === undefined ? {} : { isolation: prior.isolation }),
          ...(prior?.patchBackup === undefined ? {} : { patchBackup: prior.patchBackup }),
          ownerPid: process.pid,
        }
        await store.writeState(document, { pid: process.pid, jobId })
        this.spawn(store, jobId, paths)
        return { jobId }
      } catch (error) {
        await store.release({ pid: process.pid, jobId }).catch(() => false)
        throw error
      }
    } catch (error) {
      throw mapJobError(error, undefined, 'rollback')
    } finally {
      this.applying = false
    }
  }

  /**
   * Trigger the explicit "restart and apply" step (I5).
   *
   * Only legal from `switched` (invariant I5): this is the user-confirmed click
   * the UI's 「重启并应用」 maps onto, never an automatic consequence of a
   * finished apply. WP8 promoted it to the wire contract
   * (`design/remote-contract.md` §2).
   *
   * @returns the restart job handle.
   * @throws {RemoteError} `update/bad-request` when the phase is not `switched`.
   */
  @Remote
  async restart(): Promise<JobHandle> {
    throwIfBusy(this.applying, 'restart')
    this.applying = true
    try {
      const dshHome = this.config.dshHome ?? resolveDshHome()
      const installer = this.config.installer ?? {}
      const paths = resolveInstallerPaths(dshHome, installer)
      const store = this.store(dshHome)
      await this.ensureRecovered(store)
      const state = await store.readState()
      if (state?.phase !== 'switched') {
        throw applyRefusal(
          `restart is only allowed from the switched phase (current phase: ${state?.phase ?? 'idle'})`,
          'not-switched',
          state?.jobId ?? 'none',
        )
      }
      const current = await readCurrent(store.paths.currentPath)
      if (current === undefined) {
        throw applyRefusal('current.json is missing; cannot restart', 'no-current', state.jobId ?? 'none')
      }
      const jobId = makeJobId()
      await store.acquire(jobId, 'restart')
      try {
        const jobRequest = this.buildRequest({
          action: 'restart',
          version: current.active.version,
          paths,
          dshHome,
          reportId: state.reportId ?? '',
          isolateBlocked: false,
          isolateTargets: [],
          blockedRules: [],
          previousBin: current.previous?.bin,
        })
        await store.writeRequest(jobId, jobRequest)
        // Carry the preflight report, the isolation record, and the verified
        // backup forward: `status()` after the restart must still be able to show
        // the quarantined-plugin list and the restore affordance (WP8 §7).
        await store.writeState({
          schema: 1,
          phase: 'restarting',
          jobId,
          action: 'restart',
          version: current.active.version,
          ...(state.reportId === undefined ? {} : { reportId: state.reportId }),
          steps: [],
          ...(state.report === undefined ? {} : { report: state.report }),
          ...(state.isolation === undefined ? {} : { isolation: state.isolation }),
          ...(state.patchBackup === undefined ? {} : { patchBackup: state.patchBackup }),
          ownerPid: process.pid,
        }, { pid: process.pid, jobId })
        this.spawn(store, jobId, paths)
        return { jobId }
      } catch (error) {
        await store.release({ pid: process.pid, jobId }).catch(() => false)
        throw error
      }
    } catch (error) {
      throw mapJobError(error, undefined, 'restart')
    } finally {
      this.applying = false
    }
  }

  /**
   * One-click restore of the `cordis.patch.yml` backup an isolation took.
   *
   * WP8 promoted it to the wire contract (`design/remote-contract.md` §2) so the
   * progress view's 「恢复插件配置」 can call it after an update. The exact backup
   * path itself is already on `status().patchBackup`.
   *
   * @returns the backup path that was restored, or `undefined` when none is recorded.
   * @throws {RemoteError} `update/bad-request` when no backup is recorded.
   */
  @Remote
  async restorePatch(): Promise<{ restored?: string }> {
    const dshHome = this.config.dshHome ?? resolveDshHome()
    const store = this.store(dshHome)
    const current = await readCurrent(store.paths.currentPath)
    if (current === undefined || current.patchBackup === undefined) {
      throw applyRefusal('no patch backup is recorded in current.json', 'no-patch-backup', 'restorePatch')
    }
    const backup = current.patchBackup
    // The isolation recorded the exact patch it edited; fall back to the
    // configured profile's file only when no isolation was recorded.
    const state = await store.readState()
    const patchPath = state?.isolation?.patchPath ?? join(dshHome, 'profiles', this.helperProfile(), 'cordis.patch.yml')
    await restorePatchBackup(backup, patchPath)
    await store.appendAudit({
      ts: new Date().toISOString(),
      action: 'restore-patch',
      version: current.active.version,
      result: `restored ${patchPath}`,
      userConfirmed: true,
    })
    return { restored: backup }
  }

  /**
   * Run host-start crash recovery now (helper-protocol §6).
   *
   * Called automatically before any write job; exposed so a host that has just
   * booted can converge without starting a new job.
   *
   * @returns what recovery decided.
   */
  async recover(): Promise<RecoveryOutcome> {
    const dshHome = this.config.dshHome ?? resolveDshHome()
    const store = this.store(dshHome)
    return this.ensureRecovered(store)
  }

  /** Build the store for a harness home. */
  private store(dshHome: string): StateStore {
    return new StateStore(resolveStatePaths(dshHome), {
      log: line => process.stderr.write(`update-center: ${line}\n`),
    })
  }

  /** Run recovery at most once per service instance. */
  private ensureRecovered(store: StateStore): Promise<RecoveryOutcome> {
    if (this.recovery === undefined) {
      if (this.config.recover === false) {
        this.recovery = Promise.resolve({ status: 'none', phase: 'idle', detail: 'recovery disabled by configuration' })
      } else {
        this.recovery = recoverOnStart({
          store,
          pluginRoot: this.pluginRoot(),
          ...(this.config.helper?.localBinDir === undefined ? {} : { localBinDir: this.config.helper.localBinDir }),
          ...(this.config.recovery === undefined ? {} : { deps: this.config.recovery }),
        }).catch(error => {
          process.stderr.write(`update-center: recovery failed: ${String(error)}\n`)
          return { status: 'none' as const, phase: 'idle' as const, detail: `recovery failed: ${String(error)}` }
        })
      }
    }
    return this.recovery
  }

  /** Assemble one helper request. */
  private buildRequest(options: {
    readonly action: 'apply' | 'restart' | 'rollback'
    readonly version: string
    readonly paths: ReturnType<typeof resolveInstallerPaths>
    readonly dshHome: string
    readonly reportId: string
    readonly isolateBlocked: boolean
    readonly isolateTargets: readonly string[]
    readonly blockedRules: readonly string[]
    readonly previousBin: string | undefined
  }): JobRequest {
    const targetPrefix = join(options.paths.runtimeRoot, options.version)
    const newBin = join(targetPrefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const patchPath = join(options.dshHome, 'profiles', this.helperProfile(), 'cordis.patch.yml')
    return {
      schema: 1,
      action: options.action,
      version: options.version,
      targetPrefix,
      ...(options.previousBin === undefined ? {} : { previousBin: options.previousBin }),
      newBin,
      symlink: options.paths.symlinkPath,
      port: this.config.helper?.port ?? 3080,
      profile: this.helperProfile(),
      hostPid: process.pid,
      dshHome: options.dshHome,
      runtimeRoot: options.paths.runtimeRoot,
      patchPath,
      reportId: options.reportId,
      isolateBlocked: options.isolateBlocked,
      isolateTargets: options.isolateTargets,
      blockedRules: options.blockedRules,
      createdAt: new Date().toISOString(),
    }
  }

  /** Spawn the detached helper for one job. */
  private spawn(store: StateStore, jobId: string, paths: ReturnType<typeof resolveInstallerPaths>): { pid?: number; command: string } {
    return spawnHelper({
      pluginRoot: this.pluginRoot(),
      jobId,
      home: store.paths.home,
      logPath: store.logPath(jobId),
      env: {
        // The helper re-derives the launcher directory from its own environment
        // and refuses any other symlink (H2); this is the one place it learns it.
        DSH_UC_LOCAL_BIN_DIR: dirname(paths.symlinkPath),
        ...(this.config.helper?.env ?? {}),
      },
    })
  }

  /** The package root that owns `apply-helper.mjs`. */
  private pluginRoot(): string {
    if (this.config.helper?.pluginRoot !== undefined) return this.config.helper.pluginRoot
    let dir = dirname(fileURLToPath(import.meta.url))
    for (let depth = 0; depth < 5; depth += 1) {
      if (existsSync(join(dir, 'apply-helper.mjs'))) return dir
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return dirname(fileURLToPath(import.meta.url))
  }

  /** The profile the helper boots. */
  private helperProfile(): string {
    return this.config.helper?.profile ?? resolveProfileName()
  }

  /** Re-derive the candidate whitelist from the registry, exactly as `versions()` does. */
  private async candidateVersions(): Promise<readonly string[]> {
    const install = readRunningInstall()
    try {
      const answer = await fetchRegistrySnapshot({
        ...(this.config.registry === undefined ? {} : { registry: this.config.registry }),
        ...(this.config.cacheTtlMs === undefined ? {} : { cacheTtlMs: this.config.cacheTtlMs }),
        ...(this.config.dshHome === undefined ? {} : { dshHome: this.config.dshHome }),
        force: true,
      })
      return buildVersionsResult(answer.snapshot, {
        version: install.version,
        prefix: install.prefix,
        channel: install.channel,
      }).candidates.map(candidate => candidate.version)
    } catch (error) {
      if (error instanceof RegistryUnreachableError) {
        throw new RemoteError('update/registry-unreachable', error.message, { reason: error.message }, { cause: error })
      }
      throw error
    }
  }
}

/** Blocking targets of one report, deduplicated and in report order. */
export function blockedTargets(report: PreflightReport): { targets: string[]; rules: string[] } {
  const targets: string[] = []
  const rules: string[] = []
  for (const item of report.items) {
    if (item.severity !== 'block') continue
    if (!rules.includes(item.rule)) rules.push(item.rule)
    if (!targets.includes(item.target)) targets.push(item.target)
  }
  return { targets, rules }
}

/** One uniform `update/bad-request` refusal for `apply`. */
function applyRefusal(message: string, reason: string, input: unknown): RemoteError<'update/bad-request'> {
  return new RemoteError('update/bad-request', message, { reason, method: 'apply', input: describeInput(input) })
}

/** Refuse a second write job while the in-memory guard is held (I1). */
function throwIfBusy(applying: boolean, reportId: string): void {
  if (applying) {
    throw applyRefusal('another update job is already running (invariant I1)', 'busy', reportId)
  }
}

/** Translate a state-layer or spawn failure into the contract's Remote error. */
function mapJobError(error: unknown, version: string | undefined, method: string): unknown {
  if (error instanceof StateError) {
    if (error.code === 'busy') {
      return new RemoteError('update/bad-request', error.message, { reason: 'busy', method, input: describeInput(version) }, { cause: error })
    }
    return new RemoteError('update/bad-request', error.message, { reason: error.reason, method, input: describeInput(version) }, { cause: error })
  }
  return error
}

/** Render a refusal's input compactly, never letting a hostile payload dominate the message. */
function describeInput(input: unknown): string {
  if (input === undefined) return 'none'
  try {
    const encoded = JSON.stringify(input)
    return encoded === undefined ? String(input) : encoded.slice(0, 512)
  } catch {
    return '<unserializable>'
  }
}

/**
 * Validate a preflight request against the server-side rules (remote-contract §5).
 *
 * Only the version's format and its "strictly newer" relation are enforced here;
 * the candidate whitelist is the registry's job and is re-derived by the tree
 * resolver.
 */
function assertPreflightVersion(input: PreflightInput, currentVersion: string): string {
  const raw = (input as { version?: unknown } | undefined)?.version
  if (typeof raw !== 'string' || raw === '') {
    throw preflightRefusal('updateCenter.preflight requires a version string', 'missing-version', input)
  }
  if (parseVersion(raw) === undefined) {
    throw preflightRefusal(`version ${JSON.stringify(raw)} is not exact SemVer`, 'invalid-version', raw)
  }
  if (compareVersions(raw, currentVersion) <= 0) {
    throw preflightRefusal(
      `version ${raw} is not newer than the running ${currentVersion}`,
      'not-newer',
      raw,
    )
  }
  return raw
}

/** One uniform `update/bad-request` refusal for `preflight`. */
function preflightRefusal(
  message: string,
  reason: string,
  input: unknown,
): RemoteError<'update/bad-request'> {
  return new RemoteError('update/bad-request', message, { reason, method: 'preflight', input: describeInput(input) })
}

/** Validate an `apply` request shape before any report lookup or filesystem access. */
function requireApplyInput(input: ApplyInput): { reportId: string; isolateBlocked: boolean } {
  const reportId = (input as { reportId?: unknown } | undefined)?.reportId
  if (typeof reportId !== 'string' || reportId === '') {
    throw applyRefusal('updateCenter.apply requires a reportId string', 'missing-report-id', input)
  }
  const isolateBlocked = (input as { isolateBlocked?: unknown } | undefined)?.isolateBlocked
  if (typeof isolateBlocked !== 'boolean') {
    throw applyRefusal('updateCenter.apply requires isolateBlocked to be a boolean', 'missing-isolate-consent', input)
  }
  return { reportId, isolateBlocked }
}

/** Job id in the helper protocol's `20260911T095500-<suffix>` shape. */
function makeJobId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '')
  return `${stamp}-${randomUUID().slice(0, 8)}`
}

/** Profile whose local plugins the preflight inspects; the running mode decides it. */
function resolveProfileName(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const configured = env['DSH_PROFILE'] ?? env['DSH_DEFAULT_PROFILE']
  return configured !== undefined && configured !== '' ? configured : 'web'
}

/**
 * Mount the plugin.
 *
 * WP8 adds the host-start takeover (helper-protocol §6): the service kicks off
 * {@link UpdateCenter.recover} so a host that boots after a helper was killed
 * mid-`restarting` converges from disk alone. There is no Loader "activated"
 * hook to hang it on, so this is deliberately best-effort: the call is
 * fire-and-forget, a rejection is logged and swallowed, and nothing here can
 * prevent the plugin from activating.
 *
 * @param ctx - owning Cordis context.
 * @param config - deployment policy.
 */
export function apply(ctx: UpdateCenterContext, config: UpdateCenterConfig = {}): void {
  const service = new UpdateCenter(ctx, config)
  try {
    const recovery = service.recover()
    if (recovery !== undefined && typeof recovery.catch === 'function') {
      recovery.catch(error => {
        process.stderr.write(`update-center: startup recovery failed: ${String(error)}\n`)
      })
    }
  } catch (error) {
    // A synchronous failure (a bad home, a permission problem) must not block
    // activation either; the next write job re-runs recovery anyway.
    process.stderr.write(`update-center: startup recovery could not start: ${String(error)}\n`)
  }
}

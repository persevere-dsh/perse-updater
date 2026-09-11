/**
 * Host-start crash recovery: the §6 matrix of `design/helper-protocol.md`.
 *
 * The host cannot assume it was the last process alive. On every start it reads
 * `state.json` and decides, from disk alone (H3), which of these happened:
 *
 * | residue | decision |
 * |---|---|
 * | a live PID still owns the lock | a helper is running; do nothing |
 * | `restarting`/`health-checking`, symlink already moved | re-run the self-check; pass → `healthy`, fail → spawn a rollback helper |
 * | `restarting`/`health-checking`, symlink not moved | back to `switched`, wait for the user |
 * | `installing`, half-built prefix | `failed(install-failed)` and remove the half-product (never `previous`, H5) |
 * | `staging`/`isolating` interrupted | `failed(staging-failed)` / `failed(isolate-failed)`, symlink untouched |
 * | `rolling-back`, no helper | spawn a rollback helper |
 * | a terminal `result.json` the host never saw | converge onto it |
 * | a lock whose PID is gone | stale takeover (§2 / H4) |
 *
 * @module perse-updater/helper/recover
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runSelfCheck, type HealthReport } from '../health/index.ts'
import { entryFromBin, readCurrent, readSymlinkTarget } from '../installer/current.ts'
import { removeUnder } from '../installer/paths.ts'
import type { LauncherEntry } from '../installer/types.ts'
import { isProcessAlive } from '../state/lock.ts'
import { portListening } from '../state/probes.ts'
import type { StateStore } from '../state/store.ts'
import type { JobAction, JobRequest, ResultDocument, StateDocument, StateFailure } from '../state/types.ts'
import type { UpdatePhase } from '../types.ts'
import { spawnHelper } from './spawn.ts'

/** What recovery assumes about the world; all injectable for tests. */
export interface RecoveryDeps {
  /** Liveness probe. */
  readonly isAlive: (pid: number) => boolean
  /** Port probe. */
  readonly portListening: (port: number, timeoutMs?: number) => Promise<boolean>
  /** Self-check one launcher. */
  readonly health: (request: JobRequest, bin: string) => Promise<HealthReport>
  /** Spawn a detached helper for a follow-up job. */
  readonly spawnHelper: (spec: { jobId: string; action: JobAction; logPath: string }) => Promise<{ pid?: number; command: string }>
  /** Reconstruct a generation from a launcher entry. */
  readonly entryFromBin: (bin: string) => LauncherEntry | undefined
  /** Clock. */
  readonly now: () => Date
  /** Log sink. */
  readonly log: (line: string) => void
}

/** What {@link recoverOnStart} needs. */
export interface RecoveryOptions {
  /** Store for the harness home being recovered. */
  readonly store: StateStore
  /** Package root that owns `apply-helper.mjs`. */
  readonly pluginRoot: string
  /** Launcher directory override for the helper child. */
  readonly localBinDir?: string
  /** Partial dependency overrides. */
  readonly deps?: Partial<RecoveryDeps>
}

/** Machine-readable dispositions recovery can report. */
export type RecoveryStatus =
  | 'none'
  | 'helper-running'
  | 'converged'
  | 'awaiting-user'
  | 'rechecked-healthy'
  | 'recovery-spawned'
  | 'failed-cleaned'
  | 'lock-released'

/** What recovery decided. */
export interface RecoveryOutcome {
  /** Machine-readable disposition. */
  readonly status: RecoveryStatus
  /** Phase now on disk. */
  readonly phase: UpdatePhase
  /** Human-readable detail for logs/evidence. */
  readonly detail: string
}

/** Terminal phases a `result.json` may record. */
const TERMINAL: readonly ResultDocument['phase'][] = ['healthy', 'rolled-back', 'failed', 'rollback-failed', 'switched']

/**
 * Decide and apply the next step for whatever the last process left behind.
 *
 * @param options - store, plugin root, and optional seams.
 * @returns what was decided.
 */
export async function recoverOnStart(options: RecoveryOptions): Promise<RecoveryOutcome> {
  const { store } = options
  const deps: RecoveryDeps = { ...defaultRecoveryDeps(options), ...options.deps }
  await store.init()
  const state = await store.readState()
  if (state === undefined) {
    // H4: a lock left by a dead process must never be a permanent deadlock, even
    // when no job ever managed to write state.
    const released = await store.releaseIfStale()
    return {
      status: released ? 'lock-released' : 'none',
      phase: 'idle',
      detail: released ? 'no state.json; released a stale lock' : 'no state.json; nothing to recover',
    }
  }

  const lock = await store.readLock()
  if (lock !== undefined && lock.pid !== store.pid && deps.isAlive(lock.pid)) {
    return {
      status: 'helper-running',
      phase: state.phase,
      detail: `job ${lock.jobId} is still held by live pid ${lock.pid}; leaving it alone`,
    }
  }

  const jobId = state.jobId ?? lock?.jobId
  if (jobId === undefined) {
    const released = await store.releaseIfStale()
    return { status: released ? 'lock-released' : 'none', phase: state.phase, detail: 'no job id on disk' }
  }
  /** Set when this recovery pass hands the job to a freshly spawned helper. */
  let handedOff = false
  if (!(await ownLock(store, jobId, state.action ?? 'apply', deps))) {
    return { status: 'helper-running', phase: state.phase, detail: `job ${jobId} is held by another live process` }
  }

  try {
    const result = await store.readResult(jobId)
    if (result !== undefined && TERMINAL.includes(result.phase)) {
      await converge(store, state, result, deps)
      return {
        status: 'converged',
        phase: result.phase,
        detail: `adopted terminal result ${result.phase} from jobs/${jobId}/result.json`,
      }
    }
    return await recheck(store, state, jobId, deps, () => { handedOff = true })
  } finally {
    // When recovery hands the job to a fresh helper (rollback spawn), that helper
    // owns the lock now: releasing it here would race the child's `takeOver` and
    // make it fail with "lock disappeared" (WP8 measured).
    if (!handedOff) await store.release({ pid: store.pid, jobId })
  }
}

/** Take ownership of a stale lock, or confirm someone else owns a live one. */
async function ownLock(store: StateStore, jobId: string, action: JobAction, deps: RecoveryDeps): Promise<boolean> {
  const existing = await store.readLock()
  if (existing !== undefined && existing.pid !== store.pid && deps.isAlive(existing.pid)) return false
  if (existing !== undefined) {
    await store.releaseIfStale()
    const after = await store.readLock()
    if (after !== undefined && after.pid !== store.pid && deps.isAlive(after.pid)) return false
  }
  if ((await store.readLock()) === undefined) {
    await store.acquire(jobId, action).catch(() => undefined)
  }
  const held = await store.readLock()
  if (held === undefined) return false
  if (held.pid !== store.pid) {
    await store.takeOver(jobId, action).catch(() => undefined)
  }
  return (await store.readLock())?.pid === store.pid
}

/** Adopt a helper result the host never got to read. */
async function converge(store: StateStore, state: StateDocument, result: ResultDocument, deps: RecoveryDeps): Promise<void> {
  const steps = state.steps.length >= result.steps.length ? state.steps : result.steps
  await store.writeState({
    schema: 1,
    phase: result.phase,
    jobId: result.jobId,
    action: result.action,
    ...(state.version === undefined ? {} : { version: state.version }),
    ...(state.reportId === undefined ? {} : { reportId: state.reportId }),
    steps,
    ...(state.report === undefined ? {} : { report: state.report }),
    ...(state.isolation === undefined ? {} : { isolation: state.isolation }),
    ...(state.patchBackup === undefined ? {} : { patchBackup: state.patchBackup }),
    ...(result.error === undefined ? {} : { error: result.error }),
    ownerPid: store.pid,
  }, { pid: store.pid, jobId: result.jobId })
  await store.appendProgress(result.jobId, {
    step: 'recover',
    state: 'done',
    detail: `host adopted terminal result ${result.phase}`,
    phase: result.phase,
  })
  deps.log(`adopted jobs/${result.jobId}/result.json phase=${result.phase}`)
}

/** Phase-by-phase decision for a job whose helper is gone without a result. */
async function recheck(
  store: StateStore,
  state: StateDocument,
  jobId: string,
  deps: RecoveryDeps,
  onHandoff: () => void,
): Promise<RecoveryOutcome> {
  const request = await store.readRequest(jobId)
  const phase = state.phase

  if (phase === 'restarting' || phase === 'health-checking') {
    if (request === undefined) {
      return failState(store, state, jobId, failure('update/bad-request', 'recover', `jobs/${jobId}/request.json is missing; cannot re-check`), deps)
    }
    const target = readSymlinkTarget(request.symlink)
    const entry = target === undefined || target === '' ? undefined : deps.entryFromBin(target)
    if (entry === undefined || entry.version !== state.version) {
      await store.writeState(document(state, 'switched'), { pid: store.pid, jobId })
      await store.appendProgress(jobId, {
        step: 'recover',
        state: 'done',
        detail: `helper died before switching; symlink still points at ${target ?? '(none)'} — back to switched`,
        phase: 'switched',
      })
      return { status: 'awaiting-user', phase: 'switched', detail: 'helper died before the symlink moved; waiting for the user to restart' }
    }
    const report = await deps.health(request, entry.bin)
    if (report.ok) {
      await store.writeState(document(state, 'healthy'), { pid: store.pid, jobId })
      await store.appendProgress(jobId, { step: 'recover', state: 'done', detail: 're-checked: candidate is healthy', phase: 'healthy' })
      return { status: 'rechecked-healthy', phase: 'healthy', detail: `adopted running ${entry.version} after a health re-check` }
    }
    const reason = report.error?.message ?? 'self-check failed'
    await store.writeState(document(state, 'rolling-back'), { pid: store.pid, jobId })
    await store.appendProgress(jobId, {
      step: 'recover',
      state: 'failed',
      detail: `re-check failed (${report.error?.stage ?? 'health'}): ${reason}; spawning a rollback helper`,
      phase: 'rolling-back',
    })
    await spawnRecoveryHelper(store, request, jobId, deps)
    onHandoff()
    return { status: 'recovery-spawned', phase: 'rolling-back', detail: `re-check failed; rollback helper spawned: ${reason}` }
  }

  if (phase === 'rolling-back') {
    if (request === undefined) {
      return failState(store, state, jobId, failure('update/rollback-failed', 'recover', `jobs/${jobId}/request.json is missing; restore by hand`), deps)
    }
    await spawnRecoveryHelper(store, request, jobId, deps)
    onHandoff()
    return { status: 'recovery-spawned', phase: 'rolling-back', detail: 'helper died mid-rollback; a rollback helper was spawned' }
  }

  if (phase === 'installing' || phase === 'staging' || phase === 'isolating') {
    const code = phase === 'installing' ? 'update/install-failed' : phase === 'staging' ? 'update/staging-failed' : 'update/isolate-failed'
    if (phase === 'installing' && request !== undefined) await cleanHalfInstall(store, request, deps)
    return failState(store, state, jobId, failure(code, phase, `helper died during ${phase}; the launcher symlink was left untouched`), deps)
  }

  return { status: 'none', phase, detail: `phase ${phase} needs no recovery` }
}

/** Remove a half-built prefix, unless it is (or a rollback needs) a recorded generation (H5). */
async function cleanHalfInstall(store: StateStore, request: JobRequest, deps: RecoveryDeps): Promise<void> {
  if (!existsSync(request.targetPrefix)) return
  const current = await readCurrent(store.paths.currentPath)
  if (current?.active.prefix === request.targetPrefix || current?.previous?.prefix === request.targetPrefix) {
    deps.log(`refusing to remove ${request.targetPrefix}: current.json still references it (H5)`)
    return
  }
  try {
    await removeUnder(request.runtimeRoot, request.targetPrefix, 'targetPrefix')
    deps.log(`removed half-built ${request.targetPrefix}`)
  } catch (error) {
    deps.log(`could not remove ${request.targetPrefix}: ${String(error)}`)
  }
}

/** Persist a failure phase and return the outcome. */
async function failState(
  store: StateStore,
  state: StateDocument,
  jobId: string,
  error: StateFailure,
  deps: RecoveryDeps,
): Promise<RecoveryOutcome> {
  const document: Omit<StateDocument, 'updatedAt'> = {
    schema: 1,
    phase: 'failed',
    jobId,
    ...(state.action === undefined ? {} : { action: state.action }),
    ...(state.version === undefined ? {} : { version: state.version }),
    ...(state.reportId === undefined ? {} : { reportId: state.reportId }),
    steps: state.steps,
    ...(state.report === undefined ? {} : { report: state.report }),
    ...(state.isolation === undefined ? {} : { isolation: state.isolation }),
    ...(state.patchBackup === undefined ? {} : { patchBackup: state.patchBackup }),
    error,
  }
  await store.writeState(document, { pid: store.pid, jobId }).catch(() => undefined)
  await store.appendProgress(jobId, { step: 'recover', state: 'failed', detail: error.message, phase: 'failed' }).catch(() => undefined)
  deps.log(`${error.code} at ${error.stage}: ${error.message}`)
  return { status: 'failed-cleaned', phase: 'failed', detail: error.message }
}

/** Rewrite the job's request to a rollback and spawn the helper for it. */
async function spawnRecoveryHelper(store: StateStore, request: JobRequest, jobId: string, deps: RecoveryDeps): Promise<void> {
  const rewritten: JobRequest = { ...request, action: 'rollback' }
  await store.writeRequest(jobId, rewritten)
  const spawned = await deps.spawnHelper({ jobId, action: 'rollback', logPath: store.logPath(jobId) })
  deps.log(`spawned rollback helper pid=${String(spawned.pid)} (${spawned.command})`)
}

/** Build a state document at `phase`, carrying the job identity forward. */
function document(state: StateDocument, phase: UpdatePhase): Omit<StateDocument, 'updatedAt'> {
  return {
    schema: 1,
    phase,
    ...(state.jobId === undefined ? {} : { jobId: state.jobId }),
    ...(state.action === undefined ? {} : { action: state.action }),
    ...(state.version === undefined ? {} : { version: state.version }),
    ...(state.reportId === undefined ? {} : { reportId: state.reportId }),
    steps: state.steps,
    ...(state.report === undefined ? {} : { report: state.report }),
    ...(state.isolation === undefined ? {} : { isolation: state.isolation }),
    ...(state.patchBackup === undefined ? {} : { patchBackup: state.patchBackup }),
  }
}

/** Default recovery dependencies. */
function defaultRecoveryDeps(options: RecoveryOptions): RecoveryDeps {
  const { store, pluginRoot } = options
  return {
    isAlive: isProcessAlive,
    portListening: (port, timeoutMs) => portListening(port, timeoutMs),
    health: async (request, bin) => runSelfCheck({
      port: request.port,
      bin,
      dshHome: request.dshHome,
      profile: request.profile,
      farmDir: join(request.dshHome, 'profiles', 'node_modules'),
      patchPath: request.patchPath,
    }),
    spawnHelper: async spec => spawnHelper({
      pluginRoot,
      jobId: spec.jobId,
      home: store.paths.home,
      logPath: spec.logPath,
      ...(options.localBinDir === undefined ? {} : { env: { DSH_UC_LOCAL_BIN_DIR: options.localBinDir } }),
    }),
    entryFromBin,
    now: () => new Date(),
    log: line => { process.stderr.write(`recover: ${line}\n`) },
  }
}

/** Build one failure record. */
function failure(code: string, stage: string, message: string): StateFailure {
  return { code, stage, message }
}

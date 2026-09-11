/**
 * The three helper jobs: prepare (`apply`), restart, and `rollback`.
 *
 * The split follows `design/helper-protocol.md` §5 and the C-11 correction:
 *
 * - **apply** installs the candidate, then *immediately* shadow-boots it
 *   (`installing → installed → staging → staged`). A failed shadow boot stops
 *   before the symlink moves — the whole point of C-11 is that an unverified
 *   version is never switched to. Only then, and only with recorded consent, are
 *   `block` sections disabled, `current.json` written (I4), and the symlink
 *   moved (`switched`). The helper stops there: restarting is the user's click
 *   (I5).
 * - **restart** waits out the old process and the port (C-4: ≥ 12 s), starts the
 *   new generation, self-checks, and on any failure walks the rollback path
 *   (`rolling-back → rolled-back`, or `rollback-failed` when even that fails).
 * - **rollback** is the same rollback path, triggered directly by the operator.
 *
 * Every phase change is written to `state.json` *and* appended to
 * `progress.jsonl` before the next step begins, which is what makes the matrix
 * in helper-protocol §6 decidable from disk alone (H3).
 *
 * @module perse-updater/helper/jobs
 */

import { readCurrent, readSymlinkTarget, writeCurrentAtomic } from '../installer/current.ts'
import type { CurrentState, LauncherEntry } from '../installer/types.ts'
import type { UpdatePhase, UpdateStep } from '../types.ts'
import type { AuditEntry, IsolationRecord, JobRequest, ResultDocument, StateDocument, StateFailure } from '../state/types.ts'
import { type HelperBudgets, type HelperDeps } from './types.ts'

/** A progress line's step state, narrowed to the wire's `UpdateStep` vocabulary. */
type StepState = 'running' | 'done' | 'failed'

/** Writes the state document and the progress log for one job. */
class JobTracker {
  /** Steps accumulated so far. */
  readonly steps: UpdateStep[] = []
  private isolation: IsolationRecord | undefined
  private patchBackup: string | undefined
  private failure: StateFailure | undefined

  constructor(
    private readonly deps: HelperDeps,
    private readonly request: JobRequest,
    private readonly jobIdValue: string,
    private readonly base: Partial<StateDocument>,
  ) {}

  /** Record one step and persist the state document. */
  async move(phase: UpdatePhase, step: string, state: StepState, detail?: string): Promise<void> {
    const next: UpdateStep = { id: step, state, ...(detail === undefined ? {} : { detail }) }
    const index = this.steps.findIndex(entry => entry.id === step)
    if (index < 0) this.steps.push(next)
    else this.steps[index] = next
    await this.persist(phase)
    await this.deps.store.appendProgress(this.jobIdValue, {
      step,
      state,
      ...(detail === undefined ? {} : { detail }),
      phase,
    })
  }

  /** Record the isolation result for the restore affordance. */
  setIsolation(isolation: IsolationRecord): void {
    this.isolation = isolation
    // Only a verified backup ever reaches this point (I6), so this is the exact
    // file name the UI may render.
    this.patchBackup = isolation.backupPath
  }

  /** The isolation result, when one ran. */
  get isolationValue(): IsolationRecord | undefined {
    return this.isolation
  }

  /** Record a failure so it survives into every later state write. */
  setFailure(failure: StateFailure | undefined): void {
    this.failure = failure
  }

  /** Persist the state document at the current step list. */
  async persist(phase: UpdatePhase): Promise<void> {
    const report = this.base.report
    const document: Omit<StateDocument, 'updatedAt'> = {
      schema: 1,
      phase,
      jobId: this.jobIdValue,
      action: this.request.action,
      version: this.request.version,
      reportId: this.base.reportId ?? this.request.reportId,
      steps: this.steps,
      ...(report === undefined ? {} : { report }),
      ...(this.isolation === undefined ? {} : { isolation: this.isolation }),
      ...(this.patchBackup === undefined ? {} : { patchBackup: this.patchBackup }),
      ...(this.failure === undefined ? {} : { error: this.failure }),
      ownerPid: this.deps.pid,
    }
    await this.deps.store.writeState(document, { pid: this.deps.pid, jobId: this.jobIdValue })
  }

  /** Persist the terminal phase, then build the result document. */
  async finish(phase: ResultDocument['phase'], ok: boolean, failure?: StateFailure): Promise<ResultDocument> {
    this.failure = failure
    await this.persist(phase)
    return {
      schema: 1,
      jobId: this.jobIdValue,
      action: this.request.action,
      phase,
      ok,
      ...(failure === undefined ? {} : { error: failure }),
      steps: this.steps,
      finishedAt: this.deps.now().toISOString(),
    }
  }
}

/** Context shared by the three runners. */
interface RunContext {
  readonly request: JobRequest
  readonly deps: HelperDeps
  readonly jobId: string
  readonly base: Partial<StateDocument>
  readonly budgets: HelperBudgets
}

/**
 * Run the prepare ("apply") job.
 *
 * @param context - request, deps, job id, and host-recorded state fields.
 * @returns the terminal result document.
 */
export async function runApplyJob(context: RunContext): Promise<ResultDocument> {
  const { request, deps } = context
  const tracker = new JobTracker(deps, request, context.jobId, context.base)

  await tracker.move('installing', 'install', 'running', `installing @deepseek-ai/dsh@${request.version}`)
  let installed
  try {
    installed = await deps.ensureInstalled(request)
  } catch (error) {
    return tracker.finish('failed', false, failure('update/install-failed', 'install', describe(error)))
  }
  await tracker.move('installed', 'install', 'done', installed.detail)

  // WP8: the isolation runs BEFORE the shadow boot. The shadow boot is the
  // compatibility gate for "the configuration that will actually start after the
  // switch", so it must see the patch the update is about to land on: a
  // `block` insert that the operator consented to disable would otherwise fail
  // the boot for a reason the operator already resolved. It still happens only
  // after consent, still backs up first, and still stops before the switch when
  // the boot then fails. (design/acceptance-tests.md §7 requires this order;
  // C-11 already moved install ahead of the boot.)
  if (request.isolateBlocked && request.isolateTargets.length > 0) {
    await tracker.move('isolating', 'isolate', 'running', `disabling ${request.isolateTargets.length} blocked section(s) after backup`)
    try {
      const isolated = await deps.isolate(request)
      const backupPath = isolated.backupPath
      const backupSha256 = isolated.backupSha256
      if (backupPath !== undefined && backupSha256 !== undefined) {
        tracker.setIsolation({
          patchPath: request.patchPath,
          backupPath,
          backupSha256,
          disabled: isolated.disabled,
        })
      }
      await tracker.move(
        'installed',
        'isolate',
        'done',
        isolated.changed
          ? `backup ${backupPath} (sha256 ${(backupSha256 ?? '').slice(0, 12)}…); disabled ${isolated.disabled.map(entry => entry.name ?? entry.id).join(', ')}`
          : 'no matching section needed disabling',
      )
    } catch (error) {
      return tracker.finish('failed', false, failure('update/isolate-failed', 'isolate', describe(error)))
    }
  }

  await tracker.move('staging', 'staging', 'running', `shadow-booting ${installed.bin} in a one-shot home`)
  let staging
  try {
    staging = await deps.verify(request)
  } catch (error) {
    return tracker.finish('failed', false, failure('update/staging-failed', 'staging', describe(error)))
  }
  if (!staging.ok) {
    // C-11: without runtime evidence of compatibility the symlink does not move.
    return tracker.finish(
      'failed',
      false,
      failure(
        'update/staging-failed',
        'staging',
        staging.ran
          ? `shadow boot failed; the launcher symlink was left on the previous generation: ${staging.logTail}`
          : `shadow boot could not run; refusing to switch without runtime evidence: ${staging.logTail}`,
      ),
    )
  }
  await tracker.move('staged', 'staging', 'done', staging.logTail)

  const currentPath = deps.store.paths.currentPath
  const current = await readCurrent(currentPath)
  const previous = selectPrevious(current, request, deps)
  const active: LauncherEntry = { version: request.version, prefix: request.targetPrefix, bin: request.newBin }
  const patchBackup = tracker.isolationValue?.backupPath ?? current?.patchBackup
  const next: CurrentState = {
    active,
    ...(previous === undefined ? {} : { previous }),
    symlink: request.symlink,
    ...(patchBackup === undefined ? {} : { patchBackup }),
    updatedAt: deps.now().toISOString(),
  }
  // I4: the record naming the old generation must be durable before the link moves.
  await writeCurrentAtomic(currentPath, next)

  await tracker.move('switched', 'switch', 'running', `${request.symlink} -> ${request.newBin}`)
  try {
    await deps.switchSymlink(request.symlink, request.newBin)
  } catch (error) {
    return tracker.finish('failed', false, failure('update/switch-failed', 'switch', describe(error)))
  }
  await tracker.move('switched', 'switch', 'done', `${request.symlink} -> ${request.newBin}`)
  await audit(deps, {
    ts: deps.now().toISOString(),
    action: 'apply',
    version: request.version,
    reportId: request.reportId,
    result: 'switched',
    ...(previous === undefined ? {} : { prev: previous.version }),
    next: request.version,
    userConfirmed: request.isolateBlocked,
  })
  return tracker.finish('switched', true)
}

/**
 * Run the restart job: wait out the old process, start the new one, self-check,
 * and roll back on any failure (I7).
 *
 * @param context - request, deps, job id, host-recorded fields, and budgets.
 * @returns the terminal result document.
 */
export async function runRestartJob(context: RunContext): Promise<ResultDocument> {
  const { request, deps, budgets } = context
  const tracker = new JobTracker(deps, request, context.jobId, context.base)

  await tracker.move('restarting', 'wait-host', 'running', `waiting for host pid ${request.hostPid} to exit`)
  const exited = await waitForHostExit(deps, request.hostPid, budgets.hostExitMs)
  // WP8 / helper-protocol §5 step 1: if the host was spawned by a test harness
  // (or the operator's instance is otherwise not exiting by itself) but the port
  // is still held, the helper is the process that must stop the old instance —
  // there is no loader hook in the host to do it. The port probe is the gate:
  // a host PID that is not serving the port is left alone.
  if (!exited && request.hostPid > 0 && request.hostPid !== deps.pid && deps.isAlive(request.hostPid)) {
    if (await deps.portListening(request.port, 500)) {
      deps.log(`helper: host pid ${request.hostPid} still holds port ${request.port}; sending SIGTERM (protocol §5 step 1)`)
      deps.stopHost(request.hostPid)
    }
  }
  await tracker.move(
    'restarting',
    'wait-host',
    'done',
    exited ? `host pid ${request.hostPid} is gone` : `host pid ${request.hostPid} did not exit within ${budgets.hostExitMs}ms`,
  )

  await tracker.move('restarting', 'wait-port', 'running', `waiting for port ${request.port} (budget ${budgets.portReleaseMs}ms)`)
  const released = await waitForPortFree(deps, request.port, budgets.portReleaseMs)
  if (!released) {
    const reason = `port ${request.port} still accepts connections after ${budgets.portReleaseMs}ms; `
      + `refusing to start a second instance — inspect with: lsof -nP -iTCP:${request.port} -sTCP:LISTEN`
    return rollback(context, tracker, failure('update/port-in-use', 'port-release', reason))
  }
  await tracker.move('restarting', 'wait-port', 'done', `port ${request.port} is free`)

  await tracker.move('health-checking', 'start', 'running', `starting ${request.newBin}`)
  try {
    await deps.startInstance(request, request.newBin, 'candidate')
  } catch (error) {
    return rollback(context, tracker, failure('update/health-check-failed', 'start', describe(error)))
  }

  await tracker.move('health-checking', 'self-check', 'running', `self-checking port ${request.port}`)
  const report = await deps.health(request, request.newBin)
  if (!report.ok) {
    return rollback(
      context,
      tracker,
      failure('update/health-check-failed', report.error?.stage ?? 'self-check', report.error?.message ?? 'self-check failed'),
    )
  }
  await tracker.move('healthy', 'self-check', 'done', `all ${report.checks.length} self-check probes passed`)
  await audit(deps, {
    ts: deps.now().toISOString(),
    action: 'restart',
    version: request.version,
    reportId: request.reportId,
    result: 'healthy',
    next: request.version,
    userConfirmed: true,
  })
  return tracker.finish('healthy', true)
}

/**
 * Run a direct rollback job (the operator's `rollback()`).
 *
 * @param context - request, deps, job id, host-recorded fields, and budgets.
 * @returns the terminal result document.
 */
export async function runRollbackJob(context: RunContext): Promise<ResultDocument> {
  const { request, deps, budgets } = context
  const tracker = new JobTracker(deps, request, context.jobId, context.base)
  await tracker.move('rolling-back', 'wait-host', 'running', `waiting for host pid ${request.hostPid} to exit`)
  await waitForHostExit(deps, request.hostPid, budgets.hostExitMs)
  await tracker.move('rolling-back', 'wait-port', 'running', `waiting for port ${request.port} to be released`)
  await waitForPortFree(deps, request.port, budgets.portReleaseMs)
  await tracker.move('rolling-back', 'wait-port', 'done', `port ${request.port} is free`)
  return rollback(context, tracker, undefined)
}

/** The rollback path shared by restart failure and direct rollback. */
async function rollback(context: RunContext, tracker: JobTracker, trigger: StateFailure | undefined): Promise<ResultDocument> {
  const { request, deps } = context
  await tracker.move('rolling-back', 'rollback', 'running', trigger === undefined ? 'operator-requested rollback' : trigger.message)
  const currentPath = deps.store.paths.currentPath
  const current = await readCurrent(currentPath)
  const previous = current?.previous
  if (previous === undefined) {
    return tracker.finish('rollback-failed', false, failure(
      'update/rollback-failed',
      'rollback',
      'current.json records no previous generation; restore by hand (design/migration-plan.md §5)',
    ))
  }
  // Keep the original failure visible while the rollback runs.
  if (trigger !== undefined) tracker.setFailure(trigger)

  try {
    await deps.switchSymlink(request.symlink, previous.bin)
  } catch (error) {
    return rollbackFailed(context, tracker, `restoring ${request.symlink} -> ${previous.bin} failed: ${describe(error)}`, trigger)
  }
  await tracker.move('rolling-back', 'rollback-symlink', 'done', `${request.symlink} -> ${previous.bin} (${previous.version})`)

  let restored: string | undefined
  try {
    restored = await deps.restorePatch(request)
  } catch (error) {
    return rollbackFailed(context, tracker, `restoring the patch backup failed: ${describe(error)}`, trigger)
  }
  await tracker.move(
    'rolling-back',
    'rollback-patch',
    'done',
    restored === undefined ? 'no patch backup was recorded; nothing to restore' : `restored ${request.patchPath} from ${restored}`,
  )

  // Re-point the record so a later update can start again from the restored
  // generation (I9) without losing the generation that just failed.
  const restoredState: CurrentState = {
    active: previous,
    previous: current?.active ?? previous,
    symlink: request.symlink,
    ...(current?.patchBackup === undefined ? {} : { patchBackup: current.patchBackup }),
    updatedAt: deps.now().toISOString(),
  }
  await writeCurrentAtomic(currentPath, restoredState)

  const portFree = !(await deps.portListening(request.port, 500))
  if (!portFree) {
    await tracker.move(
      'rolled-back',
      'start-previous',
      'done',
      `port ${request.port} is still held (the old instance appears to still be serving); not starting a second copy`,
    )
  } else {
    await tracker.move('rolling-back', 'start-previous', 'running', `starting ${previous.bin}`)
    try {
      await deps.startInstance(request, previous.bin, 'previous')
    } catch (error) {
      return rollbackFailed(context, tracker, `starting the previous generation failed: ${describe(error)}`, trigger)
    }
    const health = await deps.health(request, previous.bin)
    if (!health.ok) {
      return rollbackFailed(
        context,
        tracker,
        `the previous generation (${previous.version}) did not pass its self-check either: ${health.error?.message ?? 'unknown'}`,
        trigger,
      )
    }
    await tracker.move('rolled-back', 'start-previous', 'done', `${previous.version} is serving on port ${request.port}`)
  }

  await tracker.move('rolled-back', 'rollback', 'done', `rolled back to ${previous.version}`)
  await audit(deps, {
    ts: deps.now().toISOString(),
    action: 'rollback',
    version: previous.version,
    reportId: request.reportId,
    result: 'rolled-back',
    prev: request.version,
    next: previous.version,
    userConfirmed: true,
  })
  return tracker.finish('rolled-back', false, trigger)
}

/** Terminal state when the rollback itself cannot complete: the highest-priority alarm (I7, security §5). */
async function rollbackFailed(
  context: RunContext,
  tracker: JobTracker,
  reason: string,
  trigger: StateFailure | undefined,
): Promise<ResultDocument> {
  const { request, deps } = context
  const resultError = failure('update/rollback-failed', 'rollback', reason)
  const stateError: StateFailure = trigger === undefined
    ? resultError
    : { ...trigger, message: `${trigger.message}; rollback also failed: ${reason}` }
  tracker.setFailure(stateError)
  await tracker.move('rollback-failed', 'rollback', 'failed', reason)
  await audit(deps, {
    ts: deps.now().toISOString(),
    action: 'rollback',
    version: request.version,
    reportId: request.reportId,
    result: 'rollback-failed',
    userConfirmed: true,
  })
  return tracker.finish('rollback-failed', false, stateError)
}

/** Wait for the host process to exit, or for the budget to expire. */
async function waitForHostExit(deps: HelperDeps, hostPid: number, budgetMs: number): Promise<boolean> {
  if (hostPid <= 0 || hostPid === deps.pid || !deps.isAlive(hostPid)) return true
  const until = deps.now().getTime() + budgetMs
  while (deps.now().getTime() < until) {
    if (!deps.isAlive(hostPid)) return true
    await deps.sleep(200)
  }
  return !deps.isAlive(hostPid)
}

/** Wait for the port to stop accepting connections (C-4 budget ≥ 12 s). */
async function waitForPortFree(deps: HelperDeps, port: number, budgetMs: number): Promise<boolean> {
  const until = deps.now().getTime() + budgetMs
  while (deps.now().getTime() < until) {
    if (!(await deps.portListening(port, 500))) return true
    await deps.sleep(250)
  }
  return !(await deps.portListening(port, 500))
}

/** Pick the generation a rollback returns to, mirroring the installer's precedence. */
function selectPrevious(current: CurrentState | undefined, request: JobRequest, deps: HelperDeps): LauncherEntry | undefined {
  const candidates: (LauncherEntry | undefined)[] = [
    current?.active,
    current === undefined ? fromRequest(request, deps) : current.previous,
    current === undefined ? fromSymlink(request, deps) : undefined,
  ]
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.version !== request.version) return candidate
  }
  return undefined
}

/** The caller-declared previous generation, when it can be reconstructed. */
function fromRequest(request: JobRequest, deps: HelperDeps): LauncherEntry | undefined {
  return request.previousBin === undefined ? undefined : deps.entryFromBin(request.previousBin)
}

/** The generation the launcher symlink currently points at. */
function fromSymlink(request: JobRequest, deps: HelperDeps): LauncherEntry | undefined {
  const target = readSymlinkTarget(request.symlink)
  if (target === undefined || target === '') return undefined
  return deps.entryFromBin(target)
}

/** Append one audit row, never failing the job because the audit sink failed. */
async function audit(deps: HelperDeps, entry: AuditEntry): Promise<void> {
  try {
    await deps.store.appendAudit(entry)
  } catch (error) {
    deps.log(`helper: audit append failed: ${describe(error)}`)
  }
}

/** Build one failure record. */
function failure(code: string, stage: string, message: string): StateFailure {
  return { code, stage, message }
}

/** Render an unknown error. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

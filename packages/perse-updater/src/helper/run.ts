/**
 * Helper dispatcher: read the request, take over the lock, run the job, persist
 * the result, release the lock.
 *
 * This is the function `apply-helper.mjs` calls. It owns the parts that must
 * happen no matter which job runs — validation (H2), ownership transfer
 * (helper-protocol §2), and the guarantee that a terminal `result.json` exists
 * even when the job threw unexpectedly (so a host that restarts later can
 * converge instead of hanging in `restarting`, matrix §6).
 *
 * @module perse-updater/helper/run
 */

import { join } from 'node:path'
import { StateStore, resolveStatePaths } from '../state/store.ts'
import { StateError, type JobRequest, type ResultDocument, type StateDocument } from '../state/types.ts'
import { runApplyJob, runRestartJob, runRollbackJob } from './jobs.ts'
import { assertHelperRequest, resolveLocalBinDir } from './request.ts'
import { defaultDeps } from './deps.ts'
import { DEFAULT_HELPER_BUDGETS, type HelperBudgets, type HelperDeps } from './types.ts'

/** What the CLI passes to {@link runHelperJob}. */
export interface RunHelperOptions {
  /** `--job` value. */
  readonly jobId: string
  /** `--home` value. */
  readonly home: string
  /** Package root that owns `apply-helper.mjs`. */
  readonly pluginRoot: string
  /** Launcher directory override (the acceptance harness relocates it). */
  readonly localBinDir?: string
  /** Budget overrides. */
  readonly budgets?: Partial<HelperBudgets>
  /** Dependency injection for tests; defaults to {@link defaultDeps}. */
  readonly deps?: HelperDeps
  /** Logger for messages that must land in `helper.log`. */
  readonly log?: (line: string) => void
}

/** Outcome of one helper process. */
export interface HelperOutcome {
  /** Terminal result document, also written to `jobs/<id>/result.json`. */
  readonly result: ResultDocument
  /** Process exit code: 0 on success, 1 on a handled failure, 2 on an unexpected error. */
  readonly exitCode: number
}

/**
 * Run one helper job.
 *
 * @param options - job id, home, plugin root, and optional seams.
 * @returns the result document and the process exit code.
 */
export async function runHelperJob(options: RunHelperOptions): Promise<HelperOutcome> {
  const log = options.log ?? ((line: string): void => { process.stderr.write(`${line}\n`) })
  const paths = resolveStatePaths(options.home)
  const store = new StateStore(paths, { log })
  await store.init()
  const deps = options.deps ?? defaultDeps(store)
  const budgets: HelperBudgets = { ...DEFAULT_HELPER_BUDGETS, ...options.budgets }

  const request = await loadRequest(store, options)
  log(`helper: job ${request.action} ${options.jobId} version=${request.version} home=${options.home}`)
  // Ownership transfers from the host to this process so a later host restart
  // sees a live owner for the job it spawned (helper-protocol §2). A
  // recovery-spawned helper may find no lock at all (the recovering host already
  // released it), so claim rather than blind-take-over.
  await store.claimJob(options.jobId, request.action)

  const state = await store.readState()
  const base: Partial<StateDocument> = {
    ...(state?.report === undefined ? {} : { report: state.report }),
    ...(state?.reportId === undefined ? {} : { reportId: state.reportId }),
  }
  const context = { request, deps, jobId: options.jobId, base, budgets }

  try {
    const result = request.action === 'apply'
      ? await runApplyJob(context)
      : request.action === 'restart'
        ? await runRestartJob(context)
        : await runRollbackJob(context)
    await store.writeResult(options.jobId, result)
    await store.release({ pid: deps.pid, jobId: options.jobId })
    log(`helper: finished ${result.phase} ok=${String(result.ok)}`)
    return { result, exitCode: result.ok ? 0 : 1 }
  } catch (error) {
    const failure = {
      code: 'update/internal-error',
      stage: 'helper',
      message: error instanceof Error ? error.message : String(error),
    }
    const result: ResultDocument = {
      schema: 1,
      jobId: options.jobId,
      action: request.action,
      phase: 'failed',
      ok: false,
      error: failure,
      steps: [],
      finishedAt: new Date().toISOString(),
    }
    await store.writeResult(options.jobId, result).catch(() => {})
    await store.release({ pid: deps.pid, jobId: options.jobId }).catch(() => {})
    log(`helper: crashed: ${failure.message}`)
    return { result, exitCode: 2 }
  }
}

/** Read and re-validate `jobs/<id>/request.json` (H2). */
async function loadRequest(store: StateStore, options: RunHelperOptions): Promise<JobRequest> {
  const raw = await store.readRequest(options.jobId)
  if (raw === undefined) {
    throw new StateError('bad-request', 'helper', `jobs/${options.jobId}/request.json does not exist`)
  }
  return assertHelperRequest(raw, {
    home: options.home,
    runtimeRoot: join(options.home, 'runtime'),
    localBinDir: options.localBinDir ?? resolveLocalBinDir(),
  })
}

/** Re-exported for the host side and the evidence harness. */
export { runApplyJob, runRestartJob, runRollbackJob }
export { DEFAULT_HELPER_BUDGETS, type HelperBudgets, type HelperDeps }

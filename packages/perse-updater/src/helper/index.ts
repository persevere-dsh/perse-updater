/**
 * Helper process + host-side recovery surface (WP7).
 *
 * @module perse-updater/helper
 */

export { main, parseHelperArgv, budgetOverrides, type HelperArgv, type HelperMainOptions } from './cli.ts'
export { runHelperJob, type HelperOutcome, type RunHelperOptions } from './run.ts'
export { runApplyJob, runRestartJob, runRollbackJob } from './jobs.ts'
export { assertHelperRequest, resolveLocalBinDir, type RequestValidationOptions } from './request.ts'
export { helperArgv, spawnHelper, type SpawnHelperRequest, type SpawnedHelper } from './spawn.ts'
export { recoverOnStart, type RecoveryDeps, type RecoveryOptions, type RecoveryOutcome, type RecoveryStatus } from './recover.ts'
export { defaultDeps } from './deps.ts'
export {
  DEFAULT_HELPER_BUDGETS,
  type EnsureInstalledResult,
  type HelperBudgets,
  type HelperDeps,
  type HelperOptions,
  type StartedInstance,
} from './types.ts'

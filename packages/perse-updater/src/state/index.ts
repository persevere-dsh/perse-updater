/**
 * Update-center state layer: `state.json`, `lock`, job directory, pure `status()`.
 *
 * @module perse-updater/state
 */

export { appendJsonLine, readJsonFile, readJsonFileSync, writeJsonAtomic, writeTextAtomic } from './atomic.ts'
export {
  DEFAULT_STALE_AFTER_MS,
  acquireLock,
  isProcessAlive,
  isStale,
  readLock,
  releaseLock,
  takeOverLock,
  type LockClaim,
  type LockOptions,
} from './lock.ts'
export { StateStore, resolveStatePaths, type StatePaths, type StoreOptions } from './store.ts'
export { createProbes, portListening, type StatusProbes } from './probes.ts'
export { canRollback, mergeSteps, rebuildStatus, type StatusSnapshot } from './status.ts'
export {
  StateError,
  type AuditEntry,
  type IsolationRecord,
  type JobAction,
  type JobFinalPhase,
  type JobRequest,
  type LockRecord,
  type ProgressLine,
  type ResultDocument,
  type StateDocument,
  type StateFailure,
  type StateFailureCode,
} from './types.ts'

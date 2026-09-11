/**
 * Persisted vocabulary of the update-center job state (WP7).
 *
 * Everything in this module is plain JSON data plus one error class: it is the
 * on-disk contract between the host service and the detached helper described by
 * `design/helper-protocol.md`. Keeping it free of Cordis, typert, and installer
 * imports is what lets `apply-helper.mjs` run as a bare `node` process without
 * dragging the host runtime in.
 *
 * @module perse-updater/state/types
 */

import type { PreflightReport, UpdatePhase, UpdateStep } from '../types.ts'

/**
 * Action a job performs; mirrors `state.json.action` (helper-protocol §3).
 *
 * `apply` and `rollback` are the two actions the protocol names; `restart` is the
 * third invocation the host needs (the user's explicit "restart and apply",
 * I5), and it shares the same job directory and lock vocabulary.
 */
export type JobAction = 'apply' | 'restart' | 'rollback'

/** Contents of the `lock` file (helper-protocol §2). */
export interface LockRecord {
  /** PID of the process currently holding the job (host or helper). */
  readonly pid: number
  /** Job the lock belongs to. */
  readonly jobId: string
  /** ISO-8601 acquisition time. */
  readonly startedAt: string
  /** Action the lock was taken for. */
  readonly action: JobAction
}

/** A failure carried by `state.json` / `result.json` / the remote boundary. */
export interface StateFailure {
  /** Stable failure code, e.g. `update/health-check-failed`. */
  readonly code: string
  /** Human-readable cause. */
  readonly message: string
  /** Pipeline stage that failed, e.g. `port-release`. */
  readonly stage: string
}

/** What an isolation pass did, recorded for the "restore" affordance. */
export interface IsolationRecord {
  /** `cordis.patch.yml` that was edited. */
  readonly patchPath: string
  /** Backup taken before the edit (I6). */
  readonly backupPath: string
  /** SHA-256 of the backup, so a restore can be verified. */
  readonly backupSha256: string
  /** Sections that were disabled, in file order. */
  readonly disabled: readonly { readonly id: string; readonly name?: string }[]
}

/**
 * The single source of truth for cross-process, cross-restart progress
 * (`design/helper-protocol.md` §3). Only the lock holder may write it (H1).
 */
export interface StateDocument {
  /** Schema version of this document. */
  readonly schema: 1
  /** State-machine phase (`design/state-machine.md`). */
  readonly phase: UpdatePhase
  /** Job the state describes. */
  readonly jobId?: string
  /** Action the job performs. */
  readonly action?: JobAction
  /** Candidate version the job targets. */
  readonly version?: string
  /** Preflight report the job was confirmed against (I2). */
  readonly reportId?: string
  /** Pipeline steps, in order. */
  readonly steps: readonly UpdateStep[]
  /** Failure detail when the phase is a failed one. */
  readonly error?: StateFailure
  /** Snapshot of the report the job was confirmed against. */
  readonly report?: PreflightReport
  /** Isolation result, when one ran. */
  readonly isolation?: IsolationRecord
  /**
   * Absolute path of the verified `cordis.patch.yml` backup.
   *
   * Set only after {@link IsolationRecord} was produced — that is, only after the
   * backup was written and re-read to match the source (I6). It is the field the
   * UI renders as an exact file name, so a failed isolation must leave it absent.
   */
  readonly patchBackup?: string
  /** Current owner of the job: the host or the helper (helper-protocol §3). */
  readonly ownerPid?: number
  /** ISO-8601 timestamp of the last write. */
  readonly updatedAt: string
}

/** One line of `jobs/<id>/progress.jsonl`. */
export interface ProgressLine {
  /** ISO-8601 timestamp. */
  readonly ts: string
  /** Step identifier, e.g. `install`. */
  readonly step: string
  /** Step state. */
  readonly state: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  /** Optional human-readable detail. */
  readonly detail?: string
  /** Phase the line belongs to. */
  readonly phase?: UpdatePhase
}

/** Terminal phase recorded by the helper in `result.json`. */
export type JobFinalPhase = 'healthy' | 'rolled-back' | 'failed' | 'rollback-failed' | 'switched'

/** Contents of `jobs/<id>/result.json`, written by the helper. */
export interface ResultDocument {
  /** Schema version. */
  readonly schema: 1
  /** Job the result belongs to. */
  readonly jobId: string
  /** Action that finished. */
  readonly action: JobAction
  /** Terminal phase. */
  readonly phase: JobFinalPhase
  /** Whether the job reached a good state. */
  readonly ok: boolean
  /** Failure detail, when it did not. */
  readonly error?: StateFailure
  /** Steps the helper executed. */
  readonly steps: readonly UpdateStep[]
  /** ISO-8601 completion time. */
  readonly finishedAt: string
}

/** One `audit.jsonl` row (`design/security.md` §3). */
export interface AuditEntry {
  /** ISO-8601 timestamp. */
  readonly ts: string
  /** Audited action, e.g. `apply` / `rollback` / `isolate` / `restore-patch`. */
  readonly action: string
  /** Version the action concerned. */
  readonly version?: string
  /** Report handle the action was confirmed against. */
  readonly reportId?: string
  /** Outcome summary. */
  readonly result: string
  /** Version before the action. */
  readonly prev?: string
  /** Version after the action. */
  readonly next?: string
  /** Whether the operator explicitly confirmed the write (security §5). */
  readonly userConfirmed: boolean
}

/** What `jobs/<id>/request.json` carries to the helper (helper-protocol §4). */
export interface JobRequest {
  /** Schema version. */
  readonly schema: 1
  /** Action the helper must perform. */
  readonly action: JobAction
  /** Exact candidate version. */
  readonly version: string
  /** Expanded absolute `~/.dsh/runtime/<version>`. */
  readonly targetPrefix: string
  /** Launcher entry a rollback must return to. */
  readonly previousBin?: string
  /** Launcher entry of the candidate. */
  readonly newBin: string
  /** Launcher symlink that was switched (or must be switched). */
  readonly symlink: string
  /** Port the new instance must listen on. */
  readonly port: number
  /** Profile to boot. */
  readonly profile: string
  /** Host PID the helper must outlive (helper-protocol §4). */
  readonly hostPid: number
  /** Harness home, re-checked against `--home` (H2). */
  readonly dshHome: string
  /** Runtime root, re-checked by the helper (H2). */
  readonly runtimeRoot: string
  /** Profile `cordis.patch.yml` to isolate/restore. */
  readonly patchPath: string
  /** Report handle the host bound the job to (I2). */
  readonly reportId: string
  /** Whether the operator consented to disabling `block` findings (I6). */
  readonly isolateBlocked: boolean
  /** Patch targets (`name` or `id`) to disable when isolating. */
  readonly isolateTargets: readonly string[]
  /** Rules that produced the targets, for the record. */
  readonly blockedRules: readonly string[]
  /** ISO-8601 creation time. */
  readonly createdAt: string
}

/** Classes of failure the state layer reports. */
export type StateFailureCode = 'busy' | 'lock-not-held' | 'bad-request' | 'io'

/**
 * One refused or failed state-layer operation.
 *
 * `busy` maps onto the contract's `update/bad-request` with reason `busy`
 * (invariant I1); the rest are programming/environment errors.
 */
export class StateError extends Error {
  /** Machine-readable class. */
  readonly code: StateFailureCode
  /** Stage that refused. */
  readonly stage: string
  /** Short human-readable cause. */
  readonly reason: string

  /**
   * @param code - failure class.
   * @param stage - module stage, e.g. `lock` / `state`.
   * @param reason - short cause.
   * @param options - underlying error.
   */
  constructor(
    code: StateFailureCode,
    stage: string,
    reason: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(`${code} at ${stage}: ${reason}`, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'StateError'
    this.code = code
    this.stage = stage
    this.reason = reason
  }
}

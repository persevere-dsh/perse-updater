/**
 * `status()` as a pure function of a disk snapshot plus live probes.
 *
 * The wire type does not change with the implementation: `design/remote-contract.md`
 * §2 already specifies that a reconnecting client rebuilds the view from
 * `state.json` and the live probes. This module is that rebuild, and it is
 * deliberately free of module state — the same snapshot always yields the same
 * status, which is what acceptance U-09 asserts.
 *
 * @module perse-updater/state/status
 */

import type { CurrentState } from '../installer/types.ts'
import type { PreflightReport, UpdatePhase, UpdateStatus, UpdateStep } from '../types.ts'
import type { StatusProbes } from './probes.ts'
import type { LockRecord, ProgressLine, StateDocument } from './types.ts'

/** Everything the rebuild may look at. Nothing here is in-memory process state. */
export interface StatusSnapshot {
  /** `state.json`, absent before the first job. */
  readonly state?: StateDocument
  /** `jobs/<id>/progress.jsonl`, in order. */
  readonly progress?: readonly ProgressLine[]
  /** `current.json`, the launcher pointer record. */
  readonly current?: CurrentState
  /** The lock record, when a job is live. */
  readonly lock?: LockRecord
  /** A report snapshot to surface when `state.json` does not carry one. */
  readonly report?: PreflightReport
  /**
   * The running installation's version, read live (see
   * {@link import('./probes.ts').StatusProbes.runningVersion}).
   *
   * A disk snapshot cannot carry this: it describes the process answering, which
   * no file on disk is authoritative about.
   */
  readonly runningVersion?: string
  /** Port and symlink probes. */
  readonly probes: StatusProbes
}

/** Hard cap on the returned log tail, matching the report's `logTail` bound. */
const LOG_TAIL_MAX = 2_000

/**
 * Rebuild the public status.
 *
 * @param snapshot - disk documents plus probes.
 * @returns the wire-shaped status.
 */
export async function rebuildStatus(snapshot: StatusSnapshot): Promise<UpdateStatus> {
  const { state, current, probes } = snapshot
  const progress = snapshot.progress ?? []
  const steps = mergeSteps(state?.steps ?? [], progress)
  const phase: UpdatePhase = state?.phase ?? 'idle'
  const report = state?.report ?? snapshot.report
  const runningVersion = snapshot.runningVersion ?? probes.runningVersion()
  // The verified backup path is disk-derived only: `state.json` records the one
  // this job wrote, and `current.json` records the one a rollback would restore.
  const patchBackup = state?.patchBackup ?? current?.patchBackup

  const status: UpdateStatus = {
    phase,
    steps,
    logTail: renderLogTail(progress, state),
    canRollback: canRollback(current, probes),
    ...(state?.version === undefined ? {} : { version: state.version }),
    ...(state?.jobId === undefined ? {} : { jobId: state.jobId }),
    ...(state?.error === undefined ? {} : { error: { ...state.error } }),
    ...(report === undefined ? {} : { report }),
    ...(runningVersion === undefined ? {} : { runningVersion }),
    ...(patchBackup === undefined ? {} : { patchBackup }),
  }
  return status
}

/**
 * Whether a rollback is available (invariant I9).
 *
 * A rollback needs a recorded `previous` that is a different generation and is
 * still on disk; a dangling entry would only produce a `rollback-failed`.
 *
 * @param current - `current.json`, when present.
 * @param probes - existence and launcher probes.
 * @returns whether `rollback()` has a target.
 */
export function canRollback(current: CurrentState | undefined, probes: StatusProbes): boolean {
  const previous = current?.previous
  if (current === undefined || previous === undefined) return false
  if (previous.version === current.active.version) return false
  if (probes.launcherEntry(previous.bin) !== undefined) return true
  return probes.exists(previous.prefix)
}

/**
 * Fold `state.json`'s step list and the append-only progress log into one view.
 *
 * `state.json` owns the canonical order; progress lines add stages the helper
 * appended after the host last wrote, and override the state of a step with the
 * latest line for it. Steps seen only in the log are appended in log order.
 *
 * @param recorded - steps recorded in `state.json`.
 * @param progress - progress lines, chronological.
 * @returns the merged step list.
 */
export function mergeSteps(
  recorded: readonly UpdateStep[],
  progress: readonly ProgressLine[],
): UpdateStep[] {
  const order: string[] = []
  const seen = new Map<string, UpdateStep>()
  for (const step of recorded) {
    if (!seen.has(step.id)) order.push(step.id)
    seen.set(step.id, step)
  }
  for (const line of progress) {
    if (!seen.has(line.step)) order.push(line.step)
    seen.set(line.step, {
      id: line.step,
      state: line.state === 'skipped' ? 'done' : line.state,
      ...(line.detail === undefined ? {} : { detail: line.detail }),
    })
  }
  return order.flatMap(id => {
    const step = seen.get(id)
    return step === undefined ? [] : [step]
  })
}

/** Render the progress tail the UI's log pane shows. */
function renderLogTail(progress: readonly ProgressLine[], state: StateDocument | undefined): string {
  const lines = progress.map(line =>
    `${line.ts} ${line.phase ?? state?.phase ?? 'idle'} ${line.step}=${line.state}${line.detail === undefined ? '' : ` ${line.detail}`}`,
  )
  if (lines.length === 0 && state?.error !== undefined) {
    return `${state.error.code} at ${state.error.stage}: ${state.error.message}`
  }
  const text = lines.join('\n')
  return text.length > LOG_TAIL_MAX ? text.slice(text.length - LOG_TAIL_MAX) : text
}

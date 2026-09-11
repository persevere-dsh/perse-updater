/**
 * Job lock: `O_EXCL` acquisition, live-PID check, and guaranteed stale takeover.
 *
 * Invariant I1 has to survive two operating systems' worth of failure modes, so
 * the lock is both *exclusive* and *impossible to deadlock* (H4):
 *
 * - acquisition is `open(path, 'wx')`, so the kernel, not a read-then-write race,
 *   decides the winner;
 * - a lock whose PID is gone is stale and is taken over after a warning;
 * - a lock older than {@link DEFAULT_STALE_AFTER_MS} *without progress* is stale
 *   too, so a PID-reused or wedged holder cannot block the plugin forever.
 *
 * The record is never trusted for identity: release only removes a lock whose
 * `jobId` **and** `pid` still match the caller, so a taken-over job can never
 * delete its successor's lock.
 *
 * @module perse-updater/state/lock
 */

import { statSync } from 'node:fs'
import { mkdir, open, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { readJsonFile, writeJsonAtomic } from './atomic.ts'
import { StateError, type JobAction, type LockRecord } from './types.ts'

/** Default "no progress" budget before a live holder is judged wedged (helper-protocol §2). */
export const DEFAULT_STALE_AFTER_MS = 60 * 60 * 1_000

/** What the caller knows about the job it is claiming the lock for. */
export interface LockClaim {
  /** Job identifier. */
  readonly jobId: string
  /** Action the job performs. */
  readonly action: JobAction
  /** PID that owns the lock from here on. */
  readonly pid: number
}

/** Knobs for acquisition; every one is injectable so stale takeover is testable. */
export interface LockOptions {
  /** Clock injection. */
  readonly now?: () => Date
  /** Age after which an unprogressing holder is stale; defaults to one hour. */
  readonly staleAfterMs?: number
  /** Liveness probe; defaults to `process.kill(pid, 0)`. */
  readonly isAlive?: (pid: number) => boolean
  /** `progress.jsonl` of the job, used for the "no progress" half of staleness. */
  readonly progressPath?: string
  /** Warn sink for takeover diagnostics. */
  readonly log?: (line: string) => void
  /** Acquisition retries after a takeover; defaults to three. */
  readonly maxAttempts?: number
}

/**
 * Claim the job lock or refuse with `busy`.
 *
 * @param lockPath - absolute `lock` path.
 * @param claim - job id, action, and owner PID.
 * @param options - clock, staleness, and liveness knobs.
 * @returns the record now on disk.
 * @throws {StateError} `busy` when a live holder owns the lock.
 */
export async function acquireLock(lockPath: string, claim: LockClaim, options: LockOptions = {}): Promise<LockRecord> {
  const now = options.now ?? ((): Date => new Date())
  const maxAttempts = options.maxAttempts ?? 3
  await mkdir(dirname(lockPath), { recursive: true })
  let lastReason = 'lock contention'
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const record: LockRecord = {
      pid: claim.pid,
      jobId: claim.jobId,
      startedAt: now().toISOString(),
      action: claim.action,
    }
    try {
      const handle = await open(lockPath, 'wx')
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      return record
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw new StateError('io', 'lock', `cannot create ${lockPath}: ${String(error)}`, { cause: error })
      }
      const existing = await readLock(lockPath)
      if (existing === undefined) {
        lastReason = 'the holder released the lock while it was being inspected'
        continue
      }
      if (!isStale(existing, options)) {
        throw new StateError(
          'busy',
          'lock',
          `another update job is already running (jobId=${existing.jobId} pid=${existing.pid} action=${existing.action})`,
        )
      }
      options.log?.(`state: taking over stale lock jobId=${existing.jobId} pid=${existing.pid} startedAt=${existing.startedAt}`)
      await rm(lockPath, { force: true })
      lastReason = `the stale holder ${existing.jobId} was removed but the lock was recreated`
    }
  }
  throw new StateError('busy', 'lock', `could not acquire ${lockPath}: ${lastReason}`)
}

/**
 * Re-write an existing lock with a new owner, keeping the same job.
 *
 * The helper uses this to become the owner after the host spawned it (the host
 * cannot hand its PID over), and only ever for the job the lock already names.
 *
 * @param lockPath - absolute `lock` path.
 * @param claim - job id, action, and new owner PID.
 * @returns the rewritten record.
 * @throws {StateError} `busy` when the lock names a different job; `bad-request` when it is absent.
 */
export async function takeOverLock(lockPath: string, claim: LockClaim): Promise<LockRecord> {
  const existing = await readLock(lockPath)
  if (existing === undefined) {
    throw new StateError('bad-request', 'lock', `${lockPath} disappeared before the helper could take it over`)
  }
  if (existing.jobId !== claim.jobId) {
    throw new StateError('busy', 'lock', `${lockPath} belongs to job ${existing.jobId}, not ${claim.jobId}`)
  }
  const record: LockRecord = {
    pid: claim.pid,
    jobId: claim.jobId,
    startedAt: existing.startedAt,
    action: claim.action,
  }
  await writeJsonAtomic(lockPath, record)
  return record
}

/**
 * Read the lock record.
 *
 * @param lockPath - absolute `lock` path.
 * @returns the record, or `undefined` when the lock is free.
 */
export async function readLock(lockPath: string): Promise<LockRecord | undefined> {
  const raw = await readJsonFile<unknown>(lockPath)
  return parseLockRecord(raw)
}

/**
 * Release the lock, but only if this caller still owns it.
 *
 * @param lockPath - absolute `lock` path.
 * @param owner - expected `pid` and `jobId`.
 * @returns whether the lock file was removed.
 */
export async function releaseLock(lockPath: string, owner: { readonly pid: number; readonly jobId: string }): Promise<boolean> {
  const existing = await readLock(lockPath)
  if (existing === undefined) return false
  if (existing.pid !== owner.pid || existing.jobId !== owner.jobId) return false
  await rm(lockPath, { force: true })
  return true
}

/**
 * Liveness probe via signal 0.
 *
 * @param pid - process id.
 * @returns whether the process exists and this user may signal it.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
    return code === 'EPERM'
  }
}

/** Whether an existing lock may be taken over (helper-protocol §2). */
export function isStale(existing: LockRecord, options: LockOptions = {}): boolean {
  const isAlive = options.isAlive ?? isProcessAlive
  if (!isAlive(existing.pid)) return true
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  const now = (options.now ?? ((): Date => new Date()))().getTime()
  const startedAt = Date.parse(existing.startedAt)
  if (!Number.isFinite(startedAt) || now - startedAt <= staleAfterMs) return false
  // Old *and* without progress: a long npm install keeps touching progress.jsonl.
  const progressMtime = options.progressPath === undefined ? undefined : mtimeMs(options.progressPath)
  if (progressMtime === undefined) return true
  return now - progressMtime > staleAfterMs
}

/** Last-modified time of a file, or `undefined` when it does not exist. */
function mtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}

/** Validate a parsed lock document. */
function parseLockRecord(raw: unknown): LockRecord | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const pid = record['pid']
  const jobId = record['jobId']
  const startedAt = record['startedAt']
  const action = record['action']
  if (!Number.isSafeInteger(pid)) return undefined
  if (typeof jobId !== 'string' || jobId === '') return undefined
  if (typeof startedAt !== 'string' || startedAt === '') return undefined
  if (action !== 'apply' && action !== 'restart' && action !== 'rollback') return undefined
  return { pid: pid as number, jobId, startedAt, action }
}

/** Whether an `open` failure is `EEXIST`. */
function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EEXIST'
}

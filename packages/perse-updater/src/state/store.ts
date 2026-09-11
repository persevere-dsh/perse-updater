/**
 * The `~/.dsh/update-center/` store: `state.json`, `lock`, `jobs/<id>/*`, `audit.jsonl`.
 *
 * This module is the only place the host and the helper touch that directory, so
 * the two invariants that matter live here:
 *
 * - **H1** — {@link StateStore.writeState} refuses unless the caller currently
 *   owns the lock for the job it is writing. A process that lost the race (or a
 *   helper that was replaced) cannot clobber the winner's state.
 * - **H3** — every fact needed to decide "what next" is on disk: the state
 *   document, the append-only progress log, the request, and the terminal result.
 *
 * @module perse-updater/state/store
 */

import { readFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { appendJsonLine, readJsonFile, writeJsonAtomic } from './atomic.ts'
import { acquireLock, isStale, readLock, releaseLock, takeOverLock, type LockClaim, type LockOptions } from './lock.ts'
import { resolveCurrentPath } from '../installer/current.ts'
import {
  StateError,
  type AuditEntry,
  type JobAction,
  type JobRequest,
  type LockRecord,
  type ProgressLine,
  type ResultDocument,
  type StateDocument,
} from './types.ts'

/** Absolute paths the state layer writes to; every one is parameterized for /tmp tests. */
export interface StatePaths {
  /** Harness home. */
  readonly home: string
  /** `<home>/update-center`. */
  readonly dir: string
  /** `<dir>/state.json`. */
  readonly statePath: string
  /** `<dir>/lock`. */
  readonly lockPath: string
  /** `<dir>/jobs`. */
  readonly jobsDir: string
  /** `<dir>/audit.jsonl`. */
  readonly auditPath: string
  /** `<dir>/current.json` (owned by the installer, read here). */
  readonly currentPath: string
}

/**
 * Resolve the state paths below a harness home.
 *
 * @param dshHome - harness home (`$DSH_HOME` or `~/.dsh`).
 * @param overrides - per-path overrides used by tests.
 * @returns the absolute paths.
 */
export function resolveStatePaths(dshHome: string, overrides: Partial<StatePaths> = {}): StatePaths {
  const dir = overrides.dir ?? join(dshHome, 'update-center')
  return {
    home: overrides.home ?? dshHome,
    dir,
    statePath: overrides.statePath ?? join(dir, 'state.json'),
    lockPath: overrides.lockPath ?? join(dir, 'lock'),
    jobsDir: overrides.jobsDir ?? join(dir, 'jobs'),
    auditPath: overrides.auditPath ?? join(dir, 'audit.jsonl'),
    currentPath: overrides.currentPath ?? resolveCurrentPath(dshHome),
  }
}

/** Knobs shared by every store instance. */
export interface StoreOptions extends LockOptions {
  /** PID attributed to this process; defaults to the running PID. */
  readonly pid?: number
}

/**
 * Read/write facade over one update-center directory.
 *
 * Every method is safe to call from either process: there is no in-memory cache,
 * so a helper and a freshly restarted host observe the same bytes.
 */
export class StateStore {
  /** Absolute paths this store writes to. */
  readonly paths: StatePaths
  /** PID attributed to writes from this instance. */
  readonly pid: number
  private readonly options: StoreOptions

  /**
   * @param paths - resolved absolute paths.
   * @param options - clock, liveness, and PID overrides.
   */
  constructor(paths: StatePaths, options: StoreOptions = {}) {
    this.paths = paths
    this.pid = options.pid ?? process.pid
    this.options = options
  }

  /** Create the directory skeleton. */
  async init(): Promise<void> {
    await mkdir(this.paths.jobsDir, { recursive: true })
  }

  /** Directory of one job. */
  jobDir(jobId: string): string {
    return join(this.paths.jobsDir, jobId)
  }

  /** `jobs/<id>/request.json`. */
  requestPath(jobId: string): string {
    return join(this.jobDir(jobId), 'request.json')
  }

  /** `jobs/<id>/progress.jsonl`. */
  progressPath(jobId: string): string {
    return join(this.jobDir(jobId), 'progress.jsonl')
  }

  /** `jobs/<id>/result.json`. */
  resultPath(jobId: string): string {
    return join(this.jobDir(jobId), 'result.json')
  }

  /** `jobs/<id>/helper.log`. */
  logPath(jobId: string): string {
    return join(this.jobDir(jobId), 'helper.log')
  }

  /** Read `state.json`. */
  async readState(): Promise<StateDocument | undefined> {
    return readJsonFile<StateDocument>(this.paths.statePath)
  }

  /**
   * Atomically replace `state.json` (H1).
   *
   * @param document - next document, without `updatedAt`.
   * @param owner - the lock the caller must currently hold.
   * @returns the document as written.
   * @throws {StateError} `lock-not-held` when another process owns the lock.
   */
  async writeState(
    document: Omit<StateDocument, 'updatedAt'> & { readonly updatedAt?: string },
    owner: { readonly pid: number; readonly jobId: string },
  ): Promise<StateDocument> {
    const lock = await this.readLock()
    if (lock === undefined) {
      throw new StateError('lock-not-held', 'state', `refusing to write ${this.paths.statePath}: no lock is held`)
    }
    if (lock.jobId !== owner.jobId || lock.pid !== owner.pid) {
      throw new StateError(
        'lock-not-held',
        'state',
        `refusing to write ${this.paths.statePath}: the lock belongs to jobId=${lock.jobId} pid=${lock.pid}`,
      )
    }
    const next: StateDocument = { ...document, updatedAt: this.now().toISOString() }
    await writeJsonAtomic(this.paths.statePath, next)
    return next
  }

  /** Read the lock record. */
  async readLock(): Promise<LockRecord | undefined> {
    return readLock(this.paths.lockPath)
  }

  /** Claim the job lock. */
  async acquire(jobId: string, action: JobAction): Promise<LockRecord> {
    await this.init()
    return acquireLock(this.paths.lockPath, this.claim(jobId, action), this.lockOptions(jobId))
  }

  /** Become the lock owner of an existing job (helper side). */
  async takeOver(jobId: string, action: JobAction): Promise<LockRecord> {
    return takeOverLock(this.paths.lockPath, this.claim(jobId, action))
  }

  /**
   * Claim a job for this process, whether a lock record exists or not.
   *
   * The host normally holds the lock before spawning the helper, so `takeOver` is
   * the right call. A recovery-spawned helper can start after the recovering host
   * already released the lock, though; in that case there is nothing to take over
   * and acquiring it is the correct, still-exclusive move (WP8 measured the race).
   */
  async claimJob(jobId: string, action: JobAction): Promise<LockRecord> {
    await this.init()
    if ((await this.readLock()) === undefined) return this.acquire(jobId, action)
    try {
      return await this.takeOver(jobId, action)
    } catch {
      return this.acquire(jobId, action)
    }
  }

  /** Release the lock when this process still owns it. */
  async release(owner: { readonly pid: number; readonly jobId: string }): Promise<boolean> {
    return releaseLock(this.paths.lockPath, owner)
  }

  /**
   * Force-release a lock whose holder is gone; used by host-start recovery (H4).
   *
   * @returns whether a lock was removed.
   */
  async releaseIfStale(): Promise<boolean> {
    const existing = await this.readLock()
    if (existing === undefined) return false
    if (!isStale(existing, this.lockOptions(existing.jobId))) return false
    this.options.log?.(`state: releasing stale lock jobId=${existing.jobId} pid=${existing.pid}`)
    return releaseLock(this.paths.lockPath, existing)
  }

  /** Write `jobs/<id>/request.json` (host side). */
  async writeRequest(jobId: string, request: JobRequest): Promise<void> {
    await writeJsonAtomic(this.requestPath(jobId), request)
  }

  /** Read `jobs/<id>/request.json`. */
  async readRequest(jobId: string): Promise<JobRequest | undefined> {
    return readJsonFile<JobRequest>(this.requestPath(jobId))
  }

  /** Append one progress line, stamping the time. */
  async appendProgress(
    jobId: string,
    line: Omit<ProgressLine, 'ts'> & { readonly ts?: string },
  ): Promise<ProgressLine> {
    const record: ProgressLine = {
      ts: line.ts ?? this.now().toISOString(),
      step: line.step,
      state: line.state,
      ...(line.detail === undefined ? {} : { detail: line.detail }),
      ...(line.phase === undefined ? {} : { phase: line.phase }),
    }
    await appendJsonLine(this.progressPath(jobId), record)
    return record
  }

  /** Read every progress line, tolerating a truncated final line after a crash. */
  async readProgress(jobId: string): Promise<ProgressLine[]> {
    let raw: string
    try {
      raw = await readFile(this.progressPath(jobId), 'utf8')
    } catch (error) {
      if (isNotFound(error)) return []
      throw new StateError('io', 'state', `cannot read ${this.progressPath(jobId)}: ${String(error)}`, { cause: error })
    }
    return parseProgress(raw)
  }

  /** Synchronous progress read, for the pure status rebuild. */
  readProgressSync(jobId: string): ProgressLine[] {
    try {
      return parseProgress(readFileSync(this.progressPath(jobId), 'utf8'))
    } catch (error) {
      if (isNotFound(error)) return []
      throw new StateError('io', 'state', `cannot read ${this.progressPath(jobId)}: ${String(error)}`, { cause: error })
    }
  }

  /** Write the terminal `result.json` (helper side). */
  async writeResult(jobId: string, result: ResultDocument): Promise<void> {
    await writeJsonAtomic(this.resultPath(jobId), result)
  }

  /** Read the terminal `result.json`. */
  async readResult(jobId: string): Promise<ResultDocument | undefined> {
    return readJsonFile<ResultDocument>(this.resultPath(jobId))
  }

  /** Append one audit row (`design/security.md` §3). */
  async appendAudit(entry: AuditEntry): Promise<void> {
    await appendJsonLine(this.paths.auditPath, entry)
  }

  /** Read the last `max` audit rows. */
  async readAuditTail(max: number): Promise<AuditEntry[]> {
    let raw: string
    try {
      raw = await readFile(this.paths.auditPath, 'utf8')
    } catch (error) {
      if (isNotFound(error)) return []
      throw new StateError('io', 'state', `cannot read ${this.paths.auditPath}: ${String(error)}`, { cause: error })
    }
    return raw
      .split('\n')
      .filter(line => line.trim() !== '')
      .slice(-max)
      .flatMap(line => {
        try {
          return [JSON.parse(line) as AuditEntry]
        } catch {
          return []
        }
      })
  }

  /** The lock claim this instance issues. */
  private claim(jobId: string, action: JobAction): LockClaim {
    return { jobId, action, pid: this.pid }
  }

  /** Lock options, forcing this instance's liveness/clock/progress seams. */
  private lockOptions(jobId?: string): LockOptions {
    return {
      ...this.options,
      now: () => this.now(),
      isAlive: this.options.isAlive ?? defaultIsAlive,
      ...(jobId === undefined ? {} : { progressPath: this.progressPath(jobId) }),
    }
  }

  /** This store's clock. */
  private now(): Date {
    return (this.options.now ?? ((): Date => new Date()))()
  }
}

/** Parse a JSONL progress log, dropping lines a crash left half-written. */
function parseProgress(raw: string): ProgressLine[] {
  const out: ProgressLine[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = JSON.parse(trimmed) as ProgressLine
      if (typeof parsed?.step === 'string' && typeof parsed?.state === 'string') out.push(parsed)
    } catch {
      // A crash between write and fsync can leave a partial final line; the
      // earlier stages are the durable truth, so skip it.
    }
  }
  return out
}

/** Default liveness probe, imported lazily to avoid a hard cycle at module load. */
function defaultIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
    return code === 'EPERM'
  }
}

/** Whether an fs error means "no such file". */
function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

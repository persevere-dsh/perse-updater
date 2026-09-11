/**
 * Vocabulary and failure type of the versioned installer (WP6).
 *
 * The installer owns three things and nothing else: putting an exact version
 * into `<runtimeRoot>/<version>` without ever touching the running install
 * (state-machine I3), recording the switch in `current.json` *before* the
 * launcher symlink moves (I4), and clearing only the one kind of fallback-farm
 * pollution that a boot cannot heal itself (R3 C-5).
 *
 * @module perse-updater/installer/types
 */

/** One recorded launcher generation: what `current.json.active`/`previous` hold. */
export interface LauncherEntry {
  /** Exact SemVer version installed at {@link LauncherEntry.prefix}. */
  readonly version: string
  /** Install prefix the versioned package lives under, e.g. `~/.dsh/runtime/0.1.5-rc.2`. */
  readonly prefix: string
  /** Absolute path of the launcher entry the symlink points at. */
  readonly bin: string
}

/**
 * Persisted pointer file, `~/.dsh/update-center/current.json` (migration-plan §1).
 *
 * `previous` is optional so the zero-copy registration step M-2 can record the
 * running install as `active` without inventing a predecessor.
 */
export interface CurrentState {
  /** The generation the launcher symlink points at after a successful switch. */
  readonly active: LauncherEntry
  /** The generation a rollback returns to; absent when there is none. */
  readonly previous?: LauncherEntry
  /** Absolute path of the launcher symlink that was switched. */
  readonly symlink: string
  /** Backup of `cordis.patch.yml` taken before an isolation (I6); WP7 fills it. */
  readonly patchBackup?: string
  /** ISO-8601 timestamp of the last write. */
  readonly updatedAt: string
}

/** Failure classes the installer reports to `updateCenter.apply`. */
export type InstallerFailureCode =
  | 'bad-request'
  | 'install-failed'
  | 'switch-failed'

/**
 * One refused or failed installer step.
 *
 * The code maps 1:1 onto a Remote error code in `src/index.ts`; the stage names
 * the pipeline step so a failure report can say where it stopped.
 */
export class InstallerError extends Error {
  /** Machine-readable class of the failure. */
  readonly code: InstallerFailureCode
  /** Pipeline stage that failed: `validate`, `install`, `current`, `switch`, `farm`. */
  readonly stage: string
  /** Short human-readable cause, stable enough to assert on. */
  readonly reason: string
  /** Tail of the failing command's output, when there was one. */
  readonly logTail: string

  /**
   * @param code - failure class.
   * @param stage - pipeline stage.
   * @param reason - short human-readable cause.
   * @param options - captured output tail and the underlying error.
   */
  constructor(
    code: InstallerFailureCode,
    stage: string,
    reason: string,
    options: { readonly logTail?: string; readonly cause?: unknown } = {},
  ) {
    super(`${code} at ${stage}: ${reason}`, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'InstallerError'
    this.code = code
    this.stage = stage
    this.reason = reason
    this.logTail = options.logTail ?? ''
  }
}

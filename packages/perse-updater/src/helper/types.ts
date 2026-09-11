/**
 * Helper-side types: the dependency seam that keeps `apply-helper.mjs` testable.
 *
 * The helper is a separate OS process, so its heavy steps (npm install, shadow
 * boot, symlink switch, health check, process spawn) are injected rather than
 * hard-wired. Production uses {@link import('./deps.ts').defaultDeps}; the /tmp
 * acceptance harness can drive the real CLI with fake generations while every
 * stage boundary stays observable.
 *
 * @module perse-updater/helper/types
 */

import type { SwitchResult } from '../installer/symlink.ts'
import type { LauncherEntry } from '../installer/types.ts'
import type { HealthReport } from '../health/index.ts'
import type { IsolateResult } from '../isolate/index.ts'
import type { StagingResult } from '../staging/verify.ts'
import type { JobRequest } from '../state/types.ts'

/** What a versioned install or an existing-prefix check produced. */
export interface EnsureInstalledResult {
  /** Installed prefix. */
  readonly prefix: string
  /** Launcher entry inside the prefix. */
  readonly bin: string
  /** Whether a matching install already existed. */
  readonly reused: boolean
  /** Short human-readable detail for the step list. */
  readonly detail: string
}

/** What was started, and where its output goes. */
export interface StartedInstance {
  /** PID when the spawn reported one. */
  readonly pid?: number
  /** Log file the instance's stdout/stderr were redirected to. */
  readonly logPath: string
}

/** Every side effect the helper performs, behind one injectable interface. */
export interface HelperDeps {
  /** State store for the harness home the helper was pointed at. */
  readonly store: import('../state/store.ts').StateStore
  /** PID the helper records as owner. */
  readonly pid: number
  /** Clock. */
  readonly now: () => Date
  /** Sleep. */
  readonly sleep: (ms: number) => Promise<void>
  /** Liveness probe. */
  readonly isAlive: (pid: number) => boolean
  /** Port probe. */
  readonly portListening: (port: number, timeoutMs?: number) => Promise<boolean>
  /** Ensure the exact version is installed at `request.targetPrefix` (helper-protocol §5 step 2). */
  readonly ensureInstalled: (request: JobRequest) => Promise<EnsureInstalledResult>
  /** Shadow-boot the installed candidate (C-11 / WP5). */
  readonly verify: (request: JobRequest) => Promise<StagingResult>
  /** Disable the consented blocked sections (I6). */
  readonly isolate: (request: JobRequest) => Promise<IsolateResult>
  /** Move the launcher symlink. */
  readonly switchSymlink: (symlinkPath: string, target: string) => Promise<SwitchResult>
  /** Self-check one launcher on the live port (S7). */
  readonly health: (request: JobRequest, bin: string) => Promise<HealthReport>
  /**
   * Stop the old host instance that still holds the port (helper-protocol §5
   * step 1: "等 hostPid 退出（或发 SIGTERM 后等端口释放）").
   */
  readonly stopHost: (pid: number) => void
  /** Start one generation detached on the target port. */
  readonly startInstance: (request: JobRequest, bin: string, tag: string) => Promise<StartedInstance>
  /** Restore the patch backup recorded in `current.json`, when there is one. */
  readonly restorePatch: (request: JobRequest) => Promise<string | undefined>
  /** Reconstruct a generation from a launcher entry. */
  readonly entryFromBin: (bin: string) => LauncherEntry | undefined
  /** Free-form log sink (lands in `jobs/<id>/helper.log`). */
  readonly log: (line: string) => void
}

/** Time budgets of one helper run; all overridable from the environment. */
export interface HelperBudgets {
  /** How long the old host process may take to exit. */
  readonly hostExitMs: number
  /** How long the old instance may take to release the port (C-4: ≥ 12 000). */
  readonly portReleaseMs: number
  /** How long the symlink move may take (delegated to `ln`). */
  readonly switchTimeoutMs: number
}

/** Resolved budgets, plus the allow-listed launcher directory (H2 seam). */
export interface HelperOptions {
  /** `--job` value. */
  readonly jobId: string
  /** `--home` value. */
  readonly home: string
  /** Package root that owns `apply-helper.mjs`. */
  readonly pluginRoot: string
  /** Directory the launcher symlink must live in; defaults to `~/.local/bin`. */
  readonly localBinDir?: string
  /** Budget overrides. */
  readonly budgets?: Partial<HelperBudgets>
}

/** Default budgets, with the C-4 correction baked in. */
export const DEFAULT_HELPER_BUDGETS: HelperBudgets = {
  hostExitMs: 60_000,
  portReleaseMs: 12_000,
  switchTimeoutMs: 30_000,
}

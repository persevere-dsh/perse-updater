/**
 * Wire vocabulary of the `updateCenter` Remote namespace.
 *
 * These declarations are the interface contract (`design/remote-contract.md`)
 * and are exported through the package's `./types` subpath on purpose: the
 * Typert analyzer refuses to put a Remote boundary type on the wire unless it is
 * exported from a *non-root* public subpath (`analyzer.ts#publicRemoteType`).
 *
 * @module perse-updater/types
 */

/** Version-component distance between a candidate and the installed version. */
export interface VersionDistance {
  /** Candidate major minus installed major. */
  readonly major: number
  /** Candidate minor minus installed minor. */
  readonly minor: number
  /** Candidate patch minus installed patch. */
  readonly patch: number
  /** 1 when the candidate is a prerelease the installed version is not, -1 for the reverse, 0 otherwise. */
  readonly prerelease: number
}

/** One candidate dsh release, as the plugin lists it. */
export interface VersionInfo {
  /** Exact version, e.g. `0.1.5-rc.2`. */
  readonly version: string
  /** dist-tags that point at this exact version, sorted; empty when none does. */
  readonly tags: readonly string[]
  /** Publish time in ISO-8601 form. */
  readonly publishedAt: string
  /** Whether the version carries a prerelease component. */
  readonly prerelease: boolean
  /** Distance from the installed version. */
  readonly distance: VersionDistance
  /** Whether this is the version the running installation reports. */
  readonly isCurrent: boolean
}

/** The installation the running harness was booted from. */
export interface CurrentInstall {
  /** Exact installed version, e.g. `0.1.5-rc.1`. */
  readonly version: string
  /** Install prefix, e.g. `/Users/me/.local`; empty when it could not be derived. */
  readonly prefix: string
  /** Release channel of the installed version: its prerelease identifier, else `latest`. */
  readonly channel: string
}

/** Result of `updateCenter.versions`. */
export interface VersionsResult {
  /** The running installation this list was computed against. */
  readonly current: CurrentInstall
  /** Candidates strictly newer than `current`, in strict semver descending order. */
  readonly candidates: readonly VersionInfo[]
  /** Registry dist-tags exactly as published. */
  readonly distTags: Record<string, string>
  /** When the registry document behind this answer was fetched (ISO-8601). */
  readonly fetchedAt: string
}

/** Input of `updateCenter.versions`. */
export interface VersionsInput {
  /** Bypass both the in-memory and the on-disk registry cache. */
  readonly force?: boolean
}

/** Severity of one preflight finding. */
export type Severity = 'ok' | 'warn' | 'block'

/** Aggregate verdict of a preflight report. */
export type Verdict = 'ok' | 'warn' | 'blocked'

/** One preflight finding. */
export interface PreflightItem {
  /** Rule identifier, e.g. `R-03`. */
  readonly rule: string
  /** How much this finding should hold the update back. */
  readonly severity: Severity
  /** Plugin name, package name, or `node`. */
  readonly target: string
  /** Human-readable reason. */
  readonly detail: string
  /** Whether the plugin can act on this finding. */
  readonly fixable: boolean
  /** Action description when {@link PreflightItem.fixable}. */
  readonly fix?: string
}

/** Compatibility report for one candidate version; `apply` must quote its `id`. */
export interface PreflightReport {
  /** Opaque handle `apply` must present back. */
  readonly id: string
  /** The candidate this report was produced for. */
  readonly version: string
  /** Aggregate verdict. */
  readonly verdict: Verdict
  /** Findings, in rule order. */
  readonly items: readonly PreflightItem[]
  /** Outcome of the shadow boot (S3). */
  readonly staging: { readonly ran: boolean; readonly ok: boolean; readonly logTail: string }
  /** When the report was produced (ISO-8601). */
  readonly createdAt: string
}

/** Input of `updateCenter.preflight`. */
export interface PreflightInput {
  /** Candidate version; must be one of `versions().candidates`. */
  readonly version: string
}

/** Phase of the update state machine (`design/state-machine.md`). */
export type UpdatePhase =
  | 'idle'
  | 'fetching'
  | 'ready'
  | 'preflight'
  | 'blocked'
  | 'staging'
  | 'staged'
  | 'installing'
  | 'installed'
  | 'isolating'
  | 'switched'
  | 'restarting'
  | 'health-checking'
  | 'healthy'
  | 'failed'
  | 'rolling-back'
  | 'rolled-back'
  | 'rollback-failed'

/** State of one step of the update pipeline. */
export interface UpdateStep {
  /** Stable step identifier. */
  readonly id: string
  /** Step state. */
  readonly state: 'pending' | 'running' | 'done' | 'failed'
  /** Optional human-readable detail. */
  readonly detail?: string
}

/** Point-in-time status of the plugin. */
export interface UpdateStatus {
  /** Current phase. */
  readonly phase: UpdatePhase
  /** Version the current job targets, when one is known. */
  readonly version?: string
  /** Identifier of the running job, when one is running. */
  readonly jobId?: string
  /** Pipeline steps. */
  readonly steps: readonly UpdateStep[]
  /** Tail of the job log. */
  readonly logTail: string
  /** Whether a rollback is currently possible. */
  readonly canRollback: boolean
  /** Failure detail when the phase is a failed one. */
  readonly error?: { readonly code: string; readonly message: string; readonly stage: string }
  /** The preflight report the current job was confirmed against. */
  readonly report?: PreflightReport
  /**
   * Absolute path of the `cordis.patch.yml` backup a verified isolation wrote.
   *
   * Present only once the backup has been written **and** re-read to match the
   * source (I6); absent while nothing has been isolated, and on failure. The UI
   * uses it to show the exact file name instead of a `<timestamp>` template.
   */
  readonly patchBackup?: string
}

/** Handle of a long-running update job. */
export interface JobHandle {
  /** Identifier usable with `status()`. */
  readonly jobId: string
}

/** Input of `updateCenter.apply`. */
export interface ApplyInput {
  /** `id` of a completed preflight report for the same version. */
  readonly reportId: string
  /** Whether the operator agreed to isolate `block` findings. */
  readonly isolateBlocked: boolean
}

/** Payload of the `updateCenter/progress` event. */
export interface ProgressEvent {
  /** Job the progress belongs to. */
  readonly jobId: string
  /** Phase the job entered. */
  readonly phase: UpdatePhase
  /** Step identifier within the phase. */
  readonly step: string
  /** Optional human-readable detail. */
  readonly detail?: string
}

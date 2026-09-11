/**
 * In-memory binding between a preflight report and a later `apply`.
 *
 * `design/remote-contract.md` §5.3 requires `apply` to reject a `reportId` that
 * does not exist or has expired (TTL 30 min). WP3 keeps that binding in memory
 * on purpose: preflight is specified as **read-only**, and the running harness
 * home is `~/.dsh`, which a preflight must not write to. A host restart drops the
 * bindings, which is the correct failure mode — the operator re-runs preflight.
 *
 * WP4/WP6 consume {@link ReportStore.find}; they must not re-derive a report.
 *
 * @module perse-updater/preflight/store
 */

import type { PreflightReport } from '../types.ts'

/** Default binding lifetime, matching the contract's suggested 30 minutes. */
export const DEFAULT_REPORT_TTL_MS = 30 * 60 * 1000

/** One stored report plus its expiry. */
interface Entry {
  /** The report itself. */
  readonly report: PreflightReport
  /** Epoch milliseconds after which the binding is dead. */
  readonly expiresAt: number
}

/** Bounded, expiring store of completed preflight reports. */
export class ReportStore {
  private readonly entries = new Map<string, Entry>()
  private readonly ttlMs: number
  private readonly maxEntries: number

  /**
   * @param options - lifetime and capacity.
   */
  constructor(options: { ttlMs?: number; maxEntries?: number } = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_REPORT_TTL_MS
    this.maxEntries = options.maxEntries ?? 32
  }

  /** Bind one report to its `id`. */
  put(report: PreflightReport, now: number = Date.now()): void {
    this.sweep(now)
    this.entries.set(report.id, { report, expiresAt: now + this.ttlMs })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
    }
  }

  /** Whether one report id is live. */
  has(id: string, now: number = Date.now()): boolean {
    return this.find(id, now) !== undefined
  }

  /** Look up a live report, dropping it when it has expired. */
  find(id: string, now: number = Date.now()): PreflightReport | undefined {
    const entry = this.entries.get(id)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= now) {
      this.entries.delete(id)
      return undefined
    }
    return entry.report
  }

  /** Forget one report (after a successful `apply`, or on user cancellation). */
  delete(id: string): void {
    this.entries.delete(id)
  }

  /** Live report count; diagnostics only. */
  get size(): number {
    return this.entries.size
  }

  /** Drop expired bindings. */
  private sweep(now: number): void {
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id)
    }
  }
}

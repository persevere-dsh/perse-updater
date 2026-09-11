/**
 * Live probes the pure `status()` rebuild is allowed to consult.
 *
 * `status()` must be rebuildable from disk plus "what is true right now", never
 * from memory (`design/state-machine.md` §5). The two halves are kept apart: the
 * disk snapshot is assembled by the caller, and the live facts come through this
 * interface, so a test can supply a fully fabricated snapshot and still exercise
 * the real rebuild logic (U-09).
 *
 * @module perse-updater/state/probes
 */

import { existsSync } from 'node:fs'
import { createConnection } from 'node:net'
import { entryFromBin, readSymlinkTarget } from '../installer/current.ts'
import type { LauncherEntry } from '../installer/types.ts'

/** The live observations `status()` may make. */
export interface StatusProbes {
  /** Raw symlink target of the launcher, or `undefined` when absent. */
  symlinkTarget(path: string): string | undefined
  /** Reconstruct the generation a launcher entry belongs to. */
  launcherEntry(bin: string): LauncherEntry | undefined
  /** Whether a path exists. */
  exists(path: string): boolean
  /** Whether something accepts TCP connections on `127.0.0.1:<port>`. */
  portListening(port: number, timeoutMs?: number): Promise<boolean>
  /** Current time. */
  now(): Date
}

/**
 * Build the production probe set, allowing individual overrides for tests.
 *
 * @param overrides - probe replacements.
 * @returns the probes.
 */
export function createProbes(overrides: Partial<StatusProbes> = {}): StatusProbes {
  return {
    symlinkTarget: overrides.symlinkTarget ?? readSymlinkTarget,
    launcherEntry: overrides.launcherEntry ?? entryFromBin,
    exists: overrides.exists ?? existsSync,
    portListening: overrides.portListening ?? portListening,
    now: overrides.now ?? ((): Date => new Date()),
  }
}

/**
 * Whether a TCP listener answers on a loopback port.
 *
 * @param port - port to probe.
 * @param timeoutMs - connect budget; defaults to one second.
 * @returns whether the connect succeeded.
 */
export function portListening(port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let settled = false
    const done = (value: boolean): void => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

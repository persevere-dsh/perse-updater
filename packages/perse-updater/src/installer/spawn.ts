/**
 * One bounded subprocess helper for the installer.
 *
 * `npm install -g` and `ln -sfn` are both run as real child processes on
 * purpose: the acceptance evidence must quote the command that actually ran, and
 * a shell-free `spawn` keeps the version string and paths out of any quoting
 * layer.
 *
 * @module perse-updater/installer/spawn
 */

import { spawn } from 'node:child_process'

/** Outcome of one bounded command. */
export interface CommandResult {
  /** Command line as executed, for evidence. */
  readonly command: string
  /** Exit code, or `null` when the process died from a signal. */
  readonly code: number | null
  /** Terminating signal, when there was one. */
  readonly signal: NodeJS.Signals | null
  /** Whether the harness killed the process for exceeding its budget. */
  readonly timedOut: boolean
  /** Combined stdout+stderr, truncated to the tail. */
  readonly output: string
  /** Bytes discarded from the head by the tail bound. */
  readonly truncatedBytes: number
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number
}

/** Options accepted by {@link runCommand}. */
export interface RunOptions {
  /** Working directory; defaults to the process's own. */
  readonly cwd?: string
  /** Extra environment entries; merged over `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Kill budget in milliseconds. */
  readonly timeoutMs?: number
  /** Bytes of combined output to keep; the tail is kept. */
  readonly maxOutputBytes?: number
}

/** Default kill budget for a command. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 20 * 60 * 1000

/** Default output tail retained for evidence. */
export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024

/** Render an argv as a copy-pasteable shell line (informational; never executed). */
export function renderCommand(file: string, args: readonly string[]): string {
  return [file, ...args].map(quoteArgument).join(' ')
}

/**
 * Run one command to completion under a kill budget.
 *
 * @param file - executable to spawn.
 * @param args - argv, passed verbatim.
 * @param options - cwd, env, and budgets.
 * @returns the exit facts plus the tail of the combined output.
 */
export async function runCommand(file: string, args: readonly string[], options: RunOptions = {}): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const startedAt = Date.now()
  const child = spawn(file, [...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const chunks: Buffer[] = []
  const collect = (chunk: Buffer): void => {
    chunks.push(chunk)
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)

  let timedOut = false
  let killTimer: NodeJS.Timeout | undefined
  let hardKillTimer: NodeJS.Timeout | undefined
  if (timeoutMs > 0) {
    killTimer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      hardKillTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
    }, timeoutMs)
  }

  const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.on('error', () => resolve({ code: null, signal: null }))
    child.on('close', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }))
  })
  if (killTimer !== undefined) clearTimeout(killTimer)
  if (hardKillTimer !== undefined) clearTimeout(hardKillTimer)

  let combined = Buffer.concat(chunks).toString('utf8')
  let truncatedBytes = 0
  if (combined.length > maxOutputBytes) {
    truncatedBytes = combined.length - maxOutputBytes
    combined = combined.slice(truncatedBytes)
  }
  return {
    command: renderCommand(file, args),
    code,
    signal,
    timedOut,
    output: combined,
    truncatedBytes,
    durationMs: Date.now() - startedAt,
  }
}

/** Quote one argv entry for display only. */
function quoteArgument(value: string): string {
  return /^[A-Za-z0-9_@./:+,=-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * `apply-helper.mjs` command line.
 *
 * ```
 * node <plugin>/apply-helper.mjs --job <jobId> --home <DSH_HOME>
 * ```
 *
 * Exactly these two arguments exist (`helper-protocol.md` §4); everything else
 * the helper needs is read from `jobs/<jobId>/request.json` and re-validated (H2).
 * Environment overrides exist only for the acceptance harness: the launcher
 * directory (`DSH_UC_LOCAL_BIN_DIR`) and the two wait budgets.
 *
 * @module perse-updater/helper/cli
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runHelperJob, type HelperOutcome } from './run.ts'
import type { HelperBudgets } from './types.ts'

/** Parsed command line. */
export interface HelperArgv {
  /** `--job` value. */
  readonly jobId: string
  /** `--home` value. */
  readonly home: string
}

/** Options `main` accepts; the root shim supplies the plugin root. */
export interface HelperMainOptions {
  /** Package root; defaults to three levels above the compiled module. */
  readonly pluginRoot?: string
  /** Environment to read overrides from; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/**
 * Parse `--job` and `--home`.
 *
 * @param argv - arguments after the script path.
 * @returns the parsed pair.
 * @throws {Error} when either flag is missing or empty.
 */
export function parseHelperArgv(argv: readonly string[]): HelperArgv {
  let jobId: string | undefined
  let home: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--job') {
      if (value === undefined || value === '') throw new Error('apply-helper: --job requires a value')
      jobId = value
      index += 1
      continue
    }
    if (flag === '--home') {
      if (value === undefined || value === '') throw new Error('apply-helper: --home requires a value')
      home = value
      index += 1
      continue
    }
    throw new Error(`apply-helper: unknown argument ${JSON.stringify(flag)}`)
  }
  if (jobId === undefined) throw new Error('apply-helper: --job <jobId> is required')
  if (home === undefined) throw new Error('apply-helper: --home <DSH_HOME> is required')
  return { jobId, home }
}

/**
 * Run the helper once.
 *
 * @param argv - arguments after the script path.
 * @param options - plugin root and environment overrides.
 * @returns the process exit code (0 success, 1 handled failure, 2 usage/crash).
 */
export async function main(argv: readonly string[], options: HelperMainOptions = {}): Promise<number> {
  const env = options.env ?? process.env
  let parsed: HelperArgv
  try {
    parsed = parseHelperArgv(argv)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  const pluginRoot = options.pluginRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  try {
    const outcome: HelperOutcome = await runHelperJob({
      jobId: parsed.jobId,
      home: parsed.home,
      pluginRoot,
      ...(env['DSH_UC_LOCAL_BIN_DIR'] === undefined ? {} : { localBinDir: env['DSH_UC_LOCAL_BIN_DIR'] }),
      budgets: budgetOverrides(env),
    })
    return outcome.exitCode
  } catch (error) {
    process.stderr.write(`apply-helper: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    return 2
  }
}

/** Read the two wait budgets from the environment, when present and sane. */
export function budgetOverrides(env: Readonly<Record<string, string | undefined>>): Partial<HelperBudgets> {
  const hostExit = positive(env['DSH_UC_HOST_EXIT_MS'])
  const portRelease = positive(env['DSH_UC_PORT_RELEASE_MS'])
  return {
    ...(hostExit === undefined ? {} : { hostExitMs: hostExit }),
    ...(portRelease === undefined ? {} : { portReleaseMs: portRelease }),
  }
}

/** Parse a positive number, or `undefined`. */
function positive(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

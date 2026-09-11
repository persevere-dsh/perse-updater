/**
 * Post-restart self-check (S7): does the generation now on disk actually work?
 *
 * The check is deliberately the same shape as the shadow boot (`staging/verify.ts`)
 * but runs against the *live* launcher and the *real* harness home, in the order
 * the helper protocol lists them (`design/helper-protocol.md` §5 step 6):
 *
 * 1. the port is listening again;
 * 2. `--dump-config` still renders the profile (the cheap bundle-layer screen);
 * 3. every plugin the profile patch inserts is resolvable;
 * 4. the module farm has no entry that would make the next boot exit 1;
 * 5. the HTTP endpoint answers — and a token-less **401 is the healthy auth
 *    fence** (R3 C-7), not a failure.
 *
 * A failure here is what sends the helper down `rolling-back` (I7), so each probe
 * reports a stage and a human-readable detail instead of a bare boolean.
 *
 * @module perse-updater/health
 */

import { spawn } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { parsePatchDocument } from '../contract-scan.ts'
import { listPackageEntries, scanFarmPollution } from '../installer/farm.ts'
import { portListening } from '../state/probes.ts'

/** One named probe outcome. */
export interface HealthCheck {
  /** Stable probe id, used as the failure stage. */
  readonly id: string
  /** Whether the expectation held. */
  readonly ok: boolean
  /** What was checked and what was found. */
  readonly detail: string
}

/** Outcome of one self-check. */
export interface HealthReport {
  /** Whether every probe passed. */
  readonly ok: boolean
  /** Every probe, in execution order. */
  readonly checks: readonly HealthCheck[]
  /** Tail of the boot log, for the failure report. */
  readonly logTail: string
  /** The first failure, shaped for `state.json.error`. */
  readonly error?: { readonly stage: string; readonly message: string }
}

/** Time budgets; every one is overridable for evidence runs. */
export interface HealthBudgets {
  /** How long the port may take to start listening. */
  readonly listenMs: number
  /** Kill budget for the `--dump-config` probe. */
  readonly dumpConfigMs: number
  /** HTTP probe budget. */
  readonly httpMs: number
  /** Hard cap on `logTail`. */
  readonly logTailMax: number
}

/** Everything one self-check needs. */
export interface HealthRequest {
  /** Port the new instance was told to listen on. */
  readonly port: number
  /** Candidate launcher (`…/dsh/lib/bin.js`) or the prefix shim. */
  readonly bin: string
  /** Harness home the instance runs with. */
  readonly dshHome: string
  /** Profile the instance was booted with. */
  readonly profile: string
  /** `$DSH_HOME/profiles/node_modules`. */
  readonly farmDir: string
  /** Profile `cordis.patch.yml`; plugin resolvability is checked against it. */
  readonly patchPath: string
  /** Node executable used to run the launcher; defaults to the running node. */
  readonly nodeBin?: string
  /** Budget overrides. */
  readonly budgets?: Partial<HealthBudgets>
  /** `fetch` replacement, for tests. */
  readonly fetchImpl?: typeof fetch
  /** Progress sink. */
  readonly log?: (line: string) => void
}

/** Fatal boot signatures, mirroring the shadow verifier's judgement (C-1). */
const FATAL_PATTERNS: readonly RegExp[] = [
  /plugin tree failed to load/i,
  /failed to import loader entry/i,
  /ERR_MODULE_NOT_FOUND/,
  /Cannot find package/i,
  /duplicate loader entry id/i,
  /exists and is not a symlink/i,
]

/** Default budgets (the port budget is a start-up wait, not the C-4 release wait). */
const DEFAULT_BUDGETS: HealthBudgets = {
  listenMs: 20_000,
  dumpConfigMs: 20_000,
  // Total retry window for the token-less HTTP probe: a real instance answers
  // 404 until its auth middleware mounts, then 401.
  httpMs: 15_000,
  logTailMax: 2_000,
}

/** Environment overrides, so the acceptance harness can force a fast failure. */
function envBudgets(env: Readonly<Record<string, string | undefined>>): Partial<HealthBudgets> {
  const listen = positive(env['DSH_UC_HEALTH_LISTEN_MS'])
  const dump = positive(env['DSH_UC_HEALTH_DUMP_MS'])
  const http = positive(env['DSH_UC_HEALTH_HTTP_MS'])
  return {
    ...(listen === undefined ? {} : { listenMs: listen }),
    ...(dump === undefined ? {} : { dumpConfigMs: dump }),
    ...(http === undefined ? {} : { httpMs: http }),
  }
}

/** Parse a positive number, or `undefined`. */
function positive(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Run every self-check probe.
 *
 * @param request - port, launcher, home, profile, and budgets.
 * @returns the aggregate report; `error.stage` names the first failed probe.
 */
export async function runSelfCheck(request: HealthRequest): Promise<HealthReport> {
  const budgets: HealthBudgets = { ...DEFAULT_BUDGETS, ...envBudgets(process.env), ...request.budgets }
  const log = request.log ?? ((): void => {})
  const checks: HealthCheck[] = []

  const portOk = await waitForListening(request.port, budgets.listenMs)
  checks.push({
    id: 'port',
    ok: portOk,
    detail: portOk
      ? `127.0.0.1:${request.port} is listening`
      : `nothing answered on 127.0.0.1:${request.port} within ${budgets.listenMs}ms`
        + ` (a concurrent process may still hold it; inspect with: lsof -nP -iTCP:${request.port} -sTCP:LISTEN)`,
  })
  log(`health: port ${request.port} listening=${String(portOk)}`)

  const dump = await runDumpConfig(request, budgets)
  checks.push(dump)
  log(`health: --dump-config ${dump.ok ? 'ok' : 'failed'}`)

  const plugins = checkProfilePlugins(request)
  checks.push(plugins)
  log(`health: profile plugins ${plugins.ok ? 'ok' : 'failed'}`)

  const farm = checkFarm(request.farmDir)
  checks.push(farm)
  log(`health: farm ${farm.ok ? 'ok' : 'failed'}`)

  const http = await checkHttp(request, budgets)
  checks.push(http)
  log(`health: http ${http.detail}`)

  const failed = checks.find(check => !check.ok)
  return {
    ok: failed === undefined,
    checks,
    logTail: clip(
      `port=${checks[0]?.detail ?? ''}\n${dump.detail}\n${plugins.detail}\n${farm.detail}\n${http.detail}`,
      budgets.logTailMax,
    ),
    ...(failed === undefined ? {} : { error: { stage: failed.id, message: failed.detail } }),
  }
}

/**
 * Wait until the port answers.
 *
 * @param port - port to poll.
 * @param budgetMs - total budget.
 * @returns whether a listener appeared.
 */
export async function waitForListening(port: number, budgetMs: number): Promise<boolean> {
  const until = Date.now() + budgetMs
  while (Date.now() < until) {
    if (await portListening(port, 1_000)) return true
    await delay(200)
  }
  return portListening(port, 1_000)
}

/** `--dump-config` must exit 0 and must not print a fatal signature (C-1: it is a screen, not a verdict). */
async function runDumpConfig(request: HealthRequest, budgets: HealthBudgets): Promise<HealthCheck> {
  const nodeBin = request.nodeBin ?? process.execPath
  const outcome = await runCommand(nodeBin, [request.bin, '--profile', request.profile, '--dump-config'], {
    env: { ...process.env, DSH_HOME: request.dshHome },
    timeoutMs: budgets.dumpConfigMs,
  })
  if (outcome.timedOut) {
    return { id: 'dump-config', ok: false, detail: `--dump-config timed out after ${budgets.dumpConfigMs}ms` }
  }
  if (outcome.code !== 0) {
    return {
      id: 'dump-config',
      ok: false,
      detail: `--dump-config exited ${outcome.code ?? 'on a signal'}: ${clip(outcome.output.trim(), 600)}`,
    }
  }
  const fatal = FATAL_PATTERNS.find(pattern => pattern.test(outcome.output))
  if (fatal !== undefined) {
    return { id: 'dump-config', ok: false, detail: `--dump-config printed a fatal signature ${String(fatal)}: ${clip(outcome.output.trim(), 600)}` }
  }
  return { id: 'dump-config', ok: true, detail: `--dump-config exit 0 for profile ${request.profile}` }
}

/** Every enabled `insert` name in the profile patch must resolve from the profile or the farm. */
function checkProfilePlugins(request: HealthRequest): HealthCheck {
  if (!existsSync(request.patchPath)) {
    return { id: 'profile-plugins', ok: true, detail: `no ${request.patchPath}; nothing to resolve` }
  }
  let parsed
  try {
    parsed = parsePatchDocument(readFileSync(request.patchPath, 'utf8'))
  } catch (error) {
    return { id: 'profile-plugins', ok: false, detail: `cannot parse ${request.patchPath}: ${String(error)}` }
  }
  const profileModules = join(request.dshHome, 'profiles', request.profile, 'node_modules')
  const enabled = parsed.entries.filter(entry => entry.insert && entry.name !== undefined && entry.disabled !== true)
  const unresolved: string[] = []
  for (const entry of enabled) {
    const name = entry.name ?? ''
    if (name === '') continue
    if (resolvePlugin(name, [profileModules, request.farmDir]) === undefined) unresolved.push(name)
  }
  if (unresolved.length > 0) {
    return {
      id: 'profile-plugins',
      ok: false,
      detail: `profile patch inserts unresolvable plugin(s): ${unresolved.join(', ')} (looked in ${profileModules} and ${request.farmDir})`,
    }
  }
  return {
    id: 'profile-plugins',
    ok: true,
    detail: `${enabled.length} enabled patch insert(s) resolve (${parsed.entries.length - enabled.length} disabled)`,
  }
}

/** Resolve a package name from candidate module roots (a directory with a manifest is enough). */
function resolvePlugin(name: string, roots: readonly string[]): string | undefined {
  for (const root of roots) {
    const candidate = join(root, name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/** No real package directory in a managed link slot (fatal) and no dangling link (warn-worthy). */
function checkFarm(farmDir: string): HealthCheck {
  if (!existsSync(farmDir)) {
    return { id: 'farm', ok: true, detail: `${farmDir} does not exist; boot would create it` }
  }
  // Judge the farm with the very scanner the S4b cleanup uses: it knows that an
  // `@scope` directory is a normal container and that a `dsh.moduleFallback`
  // directory is a legitimate module proxy. A hand-rolled second walk treated
  // every real directory — including every `@scope` container — as boot-fatal
  // pollution and rolled back healthy instances.
  const scan = scanFarmPollution(farmDir)
  if (scan.pollution.length > 0) {
    return {
      id: 'farm',
      ok: false,
      detail: `farm contains real ${scan.pollution.length === 1 ? 'entry' : 'entries'} where a symlink is required (boot exits 1): ${scan.pollution.map(entry => entry.name).join(', ')}`,
    }
  }
  const dangling: string[] = []
  for (const entry of listPackageEntries(farmDir)) {
    let stats
    try {
      stats = lstatSync(entry.path)
    } catch {
      continue
    }
    if (!stats.isSymbolicLink()) continue
    try {
      const target = readlinkSync(entry.path)
      const absolute = target.startsWith('/') ? target : join(farmDir, target)
      if (!existsSync(absolute)) dangling.push(`${entry.name} -> ${target}`)
    } catch {
      dangling.push(entry.name)
    }
  }
  if (dangling.length > 0) {
    return {
      id: 'farm',
      ok: false,
      detail: `farm has dangling link(s): ${dangling.join(', ')} (the boot heals these on the next generation change; a restart should have healed them)`,
    }
  }
  return {
    id: 'farm',
    ok: true,
    detail: `${scan.total} farm entr${scan.total === 1 ? 'y' : 'ies'} healthy${scan.managedProxies.length === 0 ? '' : ` (${scan.managedProxies.length} managed prox${scan.managedProxies.length === 1 ? 'y' : 'ies'})`}`,
  }
}

/** The auth fence answers 401 without a token; that is a pass (C-7). */
async function checkHttp(request: HealthRequest, budgets: HealthBudgets): Promise<HealthCheck> {
  const fetchImpl = request.fetchImpl ?? fetch
  // A real instance accepts TCP connections before its auth/route middleware is
  // mounted, so a token-less probe can briefly answer 404. The endpoint being
  // *up* is the point of this probe, so retry inside the budget instead of
  // failing (and rolling back) on the first pre-mount 404.
  const deadline = Date.now() + budgets.httpMs
  let last = 'no attempt'
  for (;;) {
    const remaining = deadline - Date.now()
    try {
      const response = await fetchImpl(`http://127.0.0.1:${request.port}/`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.max(500, Math.min(remaining, 3_000))),
      })
      await response.body?.cancel()
      const status = response.status
      if (status === 401) return { id: 'http', ok: true, detail: 'token-less HTTP probe -> 401 (auth fence, expected)' }
      if (status >= 200 && status < 400) return { id: 'http', ok: true, detail: `token-less HTTP probe -> ${status}` }
      last = `token-less HTTP probe -> ${status}, expected 401 or 2xx/3xx`
    } catch (error) {
      last = `token-less HTTP probe failed: ${String(error)}`
    }
    if (Date.now() >= deadline) return { id: 'http', ok: false, detail: last }
    await delay(250)
  }
}

/** Run one short-lived command, capturing both streams. */
function runCommand(
  bin: string,
  args: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number },
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise(resolve => {
    const child = spawn(bin, args, { env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let timedOut = false
    let settled = false
    child.stdout.on('data', (chunk: Buffer) => { output += String(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { output += String(chunk) })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)
    const settle = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, output, timedOut })
    }
    child.on('error', error => {
      output += String(error)
      settle(127)
    })
    child.on('close', code => settle(code))
  })
}

/** Keep both ends of an over-long string. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.6)
  const tail = Math.max(0, max - head - 3)
  return `${text.slice(0, head)}\n…\n${text.slice(text.length - tail)}`
}

/** Sleep. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

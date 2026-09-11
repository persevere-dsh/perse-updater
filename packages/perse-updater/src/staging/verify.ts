/**
 * Shadow-boot verification (S3): runtime evidence for one candidate version.
 *
 * The rule engine calls {@link verifyInStaging} and folds the result into the
 * report; this file is the *only* place the plugin runs a candidate
 * binary. It follows `design/recon-corrections.md` C-1/C-3/C-7 and
 * `design/preflight-rules.md` §5:
 *
 * 1. a **one-shot** `DSH_HOME` under the OS temp directory (never `~/.dsh`, so a
 *    concurrent real instance never shares the `profiles/node_modules` farm lock);
 * 2. a **read-only** copy of the target profile, local plugins included (C-3:
 *    local plugins live in `profiles/<p>/node_modules`; the farm itself is left
 *    out and healed by the boot);
 * 3. a **cheap `--dump-config` pre-screen** — it only catches bundle-layer gaps
 *    (C-1: a ghost plugin inserted by a user patch exits 0 there);
 * 4. the **decisive real boot** `--profile <p> --port 0 --no-open` (the `--port 0`
 *    kernel-assigned port cannot collide with the running 3080/3081 instance);
 *    `plugin tree failed to load` / `ERR_MODULE_NOT_FOUND` mean `ok: false`,
 *    while the token-less HTTP probe answering **401 is the healthy auth fence**
 *    (C-7), not a failure.
 *
 * `ran: false` means "no runtime evidence was gathered" (no bootable candidate
 * launcher, or the profile could not be reproduced); the engine reports that as
 * `[unknown]` rather than as a pass or a failure. `logTail` is redacted of any
 * session token before it reaches the report (`design/security.md`).
 *
 * @module perse-updater/staging/verify
 */

import { spawn } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** What the shadow boot needs in order to run. */
export interface StagingRequest {
  /** Candidate version to boot. */
  readonly version: string
  /** Tree root the candidate would boot from, when the resolver produced one. */
  readonly candidateRoot?: string
  /** Harness home of the *running* instance; the real implementation must NOT reuse it. */
  readonly dshHome: string
  /** Profile to reproduce in the throwaway home. */
  readonly profile: string
  /** Install prefix of the running instance. */
  readonly installPrefix: string
}

/** Outcome of one shadow-boot attempt. */
export interface StagingResult {
  /** Whether the shadow boot actually ran. */
  readonly ran: boolean
  /** Whether it booted cleanly. Meaningless unless {@link StagingResult.ran}. */
  readonly ok: boolean
  /** Tail of the shadow-boot log, for the report. */
  readonly logTail: string
}

/** The `@deepseek-ai/dsh` package whose `lib/bin.js` is the candidate launcher. */
const DSH_PACKAGE_SEGMENTS = ['@deepseek-ai', 'dsh'] as const

/** Runtime failure signatures. A line carrying any of these means the candidate is unusable. */
const FAILURE_PATTERNS: readonly RegExp[] = [
  /waiting for service/i,
  /plugin tree failed to load/i,
  /failed to import loader entry/i,
  /ERR_MODULE_NOT_FOUND/,
  /Cannot find package/i,
  /duplicate loader entry id/i,
  /exists and is not a symlink/i,
  /cannot resolve profile bundle/i,
  /EADDRINUSE/,
]

/** A candidate launcher that is known to be the requested version. */
interface CandidateLauncher {
  /** Absolute real path of the package's ESM entry (`…/dsh/lib/bin.js`). */
  readonly bin: string
  /** Version read from the launcher's own manifest. */
  readonly version: string
}

/** Resolved time budgets and caps for one call. */
interface Budgets {
  /** Time allowance for the `--dump-config` pre-screen. */
  readonly preScreenMs: number
  /** Time allowance for the real boot to print its URL. */
  readonly bootMs: number
  /** Time allowance for SIGTERM to be honoured. */
  readonly shutdownMs: number
  /** Time allowance for the OS to release the shadow port. */
  readonly portReleaseMs: number
  /** Hard cap on `logTail`. */
  readonly logTailMax: number
  /** Keep the one-shot home instead of deleting it. */
  readonly keepHome: boolean
}

/** A port the boot announced, plus the URL it came from. */
interface AnnouncedUrl {
  /** Full advertised URL (carries the session token). */
  readonly href: string
  /** Kernel-assigned port. */
  readonly port: number
}

/** How a child process ended. */
interface ExitInfo {
  /** Exit code, or `null` when the process died from a signal. */
  readonly code: number | null
  /** Terminating signal, or `null` on a normal exit. */
  readonly signal: string | null
}

/** Result of one captured child process. */
interface CommandOutcome {
  /** Exit code, or `null` when killed by a signal. */
  readonly code: number | null
  /** Terminating signal, or `null`. */
  readonly signal: string | null
  /** Interleaved stdout (stdout and stderr are kept separately for error extraction). */
  readonly output: string
  /** stderr alone, which is where fatal diagnostics land. */
  readonly stderr: string
  /** Whether the budget expired and the child was killed. */
  readonly timedOut: boolean
}

/** Everything one real boot observed. */
interface BootOutcome {
  /** The advertised URL, when the boot got far enough to listen. */
  readonly url: AnnouncedUrl | undefined
  /** Interleaved stdout+stderr. */
  readonly log: string
  /** How the child had ended when we decided to stop waiting (before SIGTERM). */
  readonly exitAtStop: ExitInfo | undefined
  /** Whether no URL appeared within the boot budget. */
  readonly timedOut: boolean
  /** HTTP status of the token-less probe, when one was answered. */
  readonly httpStatus: number | undefined
  /** Why the probe failed to connect, when it did. */
  readonly httpError: string | undefined
  /** Whether the port was free again after shutdown; `undefined` when no port was announced. */
  readonly portReleased: boolean | undefined
}

/**
 * Verify a candidate by booting it in a throwaway home.
 *
 * Never writes to `request.dshHome`: that home is opened read-only as the copy
 * source for the target profile, and every write lands in a fresh
 * `mkdtemp` directory under the OS temp directory.
 *
 * @param request - what to boot and where the running home is.
 * @returns `{ ran, ok, logTail }`; `ran: false` when no runtime evidence could be gathered.
 */
export async function verifyInStaging(request: StagingRequest): Promise<StagingResult> {
  const budget = budgets(process.env)
  const home = mkdtempSync(join(tmpdir(), 'dsh-uc-staging-'))
  const keep = budget.keepHome
  try {
    const profileSrc = join(request.dshHome, 'profiles', request.profile)
    if (!existsSync(profileSrc)) {
      return skipped(`shadow boot skipped: the source profile ${profileSrc} does not exist`)
    }
    let realProfile: string
    try {
      realProfile = realpathSync(profileSrc)
      if (!lstatSync(realProfile).isDirectory()) {
        return skipped(`shadow boot skipped: the source profile ${profileSrc} is not a directory`)
      }
    } catch (error) {
      return skipped(`shadow boot skipped: the source profile ${profileSrc} is unreadable: ${String(error)}`)
    }

    const profileDest = join(home, 'profiles', request.profile)
    try {
      mkdirSync(dirname(profileDest), { recursive: true })
      // Read-only copy of the real profile. The top level is a real directory
      // (realpath above), local plugins travel with it, and the module farm is
      // deliberately absent: the boot heals it against the candidate launcher
      // (C-5), which is exactly the generation switch we want to observe.
      cpSync(realProfile, profileDest, { recursive: true, dereference: false, force: true })
    } catch (error) {
      return skipped(`shadow boot skipped: copying ${realProfile} into the throwaway home failed: ${String(error)}`)
    }

    const resolved = resolveCandidateLauncher(request)
    if (resolved.launcher === undefined) {
      return skipped(resolved.reason)
    }
    const launcher = resolved.launcher

    // --- pre-screen: cheap, no credentials, only the bundle layer (C-1) --------
    const preScreen = await runCommand(
      launcher.bin,
      ['--profile', request.profile, '--dump-config'],
      home,
      budget.preScreenMs,
    )
    if (preScreen.timedOut) {
      return finished(true, false, `--dump-config pre-screen timed out after ${budget.preScreenMs}ms`)
    }
    if (preScreen.code !== 0) {
      const evidence = failureFragment(preScreen.stderr.trim() === '' ? preScreen.output : preScreen.stderr, budget.logTailMax)
      const why = preScreen.code === null ? `killed by ${preScreen.signal ?? 'a signal'}` : `exit ${preScreen.code}`
      return finished(true, false, `--dump-config pre-screen failed (${why}): ${evidence}`)
    }

    // --- judgement: one real headless boot on a kernel-assigned port (C-7) -----
    const boot = await bootOnce(launcher.bin, request.profile, home, budget)

    if (failureLines(boot.log).length > 0) {
      return finished(true, false, failureFragment(boot.log, budget.logTailMax))
    }
    if (boot.timedOut) {
      return finished(true, false,
        `shadow boot printed no URL within ${budget.bootMs}ms: ${failureFragment(boot.log, budget.logTailMax)}`)
    }
    if (boot.url === undefined) {
      const ended = boot.exitAtStop === undefined ? 'without exiting' : describeExit(boot.exitAtStop)
      return finished(true, false,
        `shadow boot ended ${ended} before printing a URL: ${failureFragment(boot.log, budget.logTailMax)}`)
    }
    if (boot.exitAtStop !== undefined && boot.exitAtStop.code !== null && boot.exitAtStop.code !== 0) {
      return finished(true, false,
        `shadow boot exited ${describeExit(boot.exitAtStop)} after listening: ${failureFragment(boot.log, budget.logTailMax)}`)
    }

    const probe = boot.httpStatus !== undefined
      ? `token-less HTTP probe -> ${boot.httpStatus}${boot.httpStatus === 401 ? ' (auth fence, expected)' : ''}`
      : `token-less HTTP probe failed: ${boot.httpError ?? 'no answer'}`
    const port = boot.portReleased === undefined
      ? 'no port announced'
      : boot.portReleased ? `port ${boot.url.port} released after SIGTERM` : `WARNING: port ${boot.url.port} still listening after shutdown`
    const kept = keep ? `; staging home kept at ${home}` : ''
    return finished(true, true,
      `shadow boot ok: ${launcher.bin}@${launcher.version} printed ${redact(boot.url.href)}; `
      + `--dump-config pre-screen exit 0; ${probe}; ${port}${kept}`)
  } finally {
    if (!keep) rmSync(home, { recursive: true, force: true })
  }
}

/** Build a `ran: false` result (no runtime evidence gathered). */
function skipped(reason: string): StagingResult {
  return { ran: false, ok: false, logTail: reason }
}

/** Build one outcome. */
function finished(ran: boolean, ok: boolean, logTail: string): StagingResult {
  return { ran, ok, logTail }
}

/**
 * Locate the launcher of the requested candidate version.
 *
 * The candidate tree is an install root (`<prefix>` for `live`/`versioned-runtime`,
 * `<tmp>/dsh-uc-candidates/<version>` for the flat materialization). Only an
 * install root that carries a real `@deepseek-ai/dsh` launcher can be booted; a
 * flat materialization has no `bin.js`, so the honest answer is `ran: false`
 * rather than booting the wrong version.
 *
 * @param request - candidate root, running prefix and requested version.
 * @returns the launcher, or a human-readable reason why none is bootable.
 */
function resolveCandidateLauncher(request: StagingRequest): { launcher: CandidateLauncher | undefined; reason: string } {
  const roots: string[] = []
  for (const root of [request.candidateRoot, request.installPrefix]) {
    if (root !== undefined && root !== '' && !roots.includes(root)) roots.push(root)
  }
  const mismatches: string[] = []
  for (const root of roots) {
    for (const bin of [
      join(root, 'bin', 'dsh'),
      join(root, 'lib', 'node_modules', ...DSH_PACKAGE_SEGMENTS, 'lib', 'bin.js'),
    ]) {
      if (!existsSync(bin)) continue
      let realBin: string
      try {
        realBin = realpathSync(bin)
      } catch {
        continue
      }
      const version = launcherVersion(realBin)
      if (version === undefined) continue
      if (version === request.version) return { launcher: { bin: realBin, version }, reason: '' }
      mismatches.push(`${bin} is @deepseek-ai/dsh@${version}`)
    }
  }
  const detail = mismatches.length > 0 ? ` (found: ${mismatches.join(', ')})` : ''
  return {
    launcher: undefined,
    reason: `shadow boot skipped: no bootable @deepseek-ai/dsh@${request.version} launcher under `
      + `${roots.join(' or ') || '(no candidate root)'}${detail}`,
  }
}

/** Read `version` from the manifest two levels above a `…/dsh/lib/bin.js` entry. */
function launcherVersion(realBin: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(dirname(realBin)), 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/** Resolve the budget knobs, all env-overridable for evidence runs. */
function budgets(env: Readonly<Record<string, string | undefined>>): Budgets {
  return {
    preScreenMs: envNumber(env, 'DSH_UC_STAGING_PRESCREEN_TIMEOUT_MS', 10_000),
    bootMs: envNumber(env, 'DSH_UC_STAGING_BOOT_TIMEOUT_MS', 20_000),
    shutdownMs: envNumber(env, 'DSH_UC_STAGING_SHUTDOWN_TIMEOUT_MS', 8_000),
    portReleaseMs: envNumber(env, 'DSH_UC_STAGING_PORT_RELEASE_TIMEOUT_MS', 8_000),
    logTailMax: envNumber(env, 'DSH_UC_STAGING_LOG_TAIL_MAX', 2_000),
    keepHome: env['DSH_UC_STAGING_KEEP'] === '1',
  }
}

/** Parse one positive numeric env override. */
function envNumber(env: Readonly<Record<string, string | undefined>>, key: string, fallback: number): number {
  const raw = env[key]
  if (raw === undefined) return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/** Run one short-lived candidate command, capturing both streams. */
function runCommand(bin: string, args: readonly string[], home: string, budgetMs: number): Promise<CommandOutcome> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: { ...process.env, DSH_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    child.stdout.on('data', (chunk: Buffer) => { output += String(chunk) })
    child.stderr.on('data', (chunk: Buffer) => {
      const text = String(chunk)
      output += text
      stderr += text
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, budgetMs)
    const settle = (code: number | null, signal: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, signal, output, stderr, timedOut })
    }
    child.on('error', error => {
      stderr += String(error)
      output += String(error)
      settle(127, null)
    })
    child.on('close', (code, signal) => settle(code, signal))
  })
}

/** Boot the candidate for real, probe its auth fence, then stop it and confirm the port is free. */
async function bootOnce(bin: string, profile: string, home: string, budget: Budgets): Promise<BootOutcome> {
  const child = spawn(process.execPath, [bin, '--profile', profile, '--port', '0', '--no-open'], {
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  let exited: ExitInfo | undefined
  let closed = false
  child.stdout.on('data', (chunk: Buffer) => { log += String(chunk) })
  child.stderr.on('data', (chunk: Buffer) => { log += String(chunk) })
  child.on('error', error => { log += `${String(error)}\n` })
  child.on('exit', (code, signal) => { exited = { code, signal } })
  child.on('close', () => { closed = true })

  const started = Date.now()
  const deadline = started + budget.bootMs
  let url: AnnouncedUrl | undefined
  let timedOut = false
  while (true) {
    if (exited !== undefined) break
    const announced = matchUrl(log)
    if (announced !== undefined) { url = announced; break }
    if (failureLines(log).length > 0) break
    if (Date.now() >= deadline) { timedOut = true; break }
    await delay(150)
  }
  // A process that exited early may still have stream data in flight; let `close`
  // land so the failure fragment is complete.
  if (exited !== undefined && !closed) await waitUntil(() => closed, 500)
  const exitAtStop = exited

  let httpStatus: number | undefined
  let httpError: string | undefined
  if (url !== undefined) {
    try {
      // The advertised URL carries the session token; probing the origin without
      // it exercises the auth fence, whose 401 is the healthy answer (C-7).
      const response = await fetch(`http://127.0.0.1:${url.port}/`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(5_000),
      })
      httpStatus = response.status
      await response.body?.cancel()
    } catch (error) {
      httpError = String(error)
    }
  }

  child.kill('SIGTERM')
  const stopped = await waitUntil(() => exited !== undefined, budget.shutdownMs)
  if (!stopped) {
    child.kill('SIGKILL')
    await waitUntil(() => exited !== undefined, 2_000)
  }
  const portReleased = url === undefined ? undefined : await waitForPortRelease(url.port, budget.portReleaseMs)
  return { url, log, exitAtStop, timedOut, httpStatus, httpError, portReleased }
}

/** Match the first advertised loopback URL in a boot log. */
function matchUrl(log: string): AnnouncedUrl | undefined {
  const match = /https?:\/\/127\.0\.0\.1:(\d+)[^\s]*/.exec(log)
  if (match === null) return undefined
  const port = Number(match[1])
  if (!Number.isSafeInteger(port) || port <= 0) return undefined
  return { href: match[0], port }
}

/** Indices of the log lines that prove the candidate is unusable. */
function failureLines(log: string): readonly number[] {
  const lines = log.split(/\r?\n/)
  const hits: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (FAILURE_PATTERNS.some(pattern => pattern.test(line))) hits.push(index)
  }
  return hits
}

/**
 * Extract the most informative slice of a boot log.
 *
 * Anchored on the first failure line so the plugin name and the awaited service
 * (`<plugin>: pending (waiting for service: <service>)`) stay in the fragment,
 * with the trailing cause (`ERR_MODULE_NOT_FOUND` and friends) folded in when it
 * sits further down the stack.
 */
function failureFragment(log: string, max: number): string {
  const lines = log.split(/\r?\n/)
  const hits = failureLines(log)
  if (hits.length === 0) return clipMiddle(log.trim(), max)
  const first = hits[0] ?? 0
  const last = hits[hits.length - 1] ?? first
  // Keep a little leading context only when the anchor is not itself the error
  // header (e.g. a bare `<plugin>: pending (waiting for service: <svc>)` line,
  // whose `Error: … plugin tree failed to load` header sits just above it).
  const low = /\bError\b/.test(lines[first] ?? '') ? first : Math.max(0, first - 4)
  const high = Math.min(lines.length, last + 6)
  const slice = high - low > 80
    ? [...lines.slice(low, low + 40), '…', ...lines.slice(Math.max(low + 40, high - 40), high)]
    : lines.slice(low, high)
  return clipMiddle(slice.join('\n').trim(), max)
}

/** Keep both ends of an over-long fragment, since the head names the failure and the tail names the cause. */
function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.6)
  const tail = Math.max(0, max - head - 3)
  return `${text.slice(0, head)}\n…\n${text.slice(text.length - tail)}`
}

/** Remove any session token from a URL before it reaches the report (`design/security.md`). */
function redact(text: string): string {
  return text.replace(/([?&]token=)[^&\s]+/gi, '$1<redacted>')
}

/** Render an exit compactly. */
function describeExit(exit: ExitInfo): string {
  return exit.code === null ? `on ${exit.signal ?? 'a signal'}` : `with code ${exit.code}`
}

/** Sleep for `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Wait until `predicate` holds or the budget expires. */
async function waitUntil(predicate: () => boolean, budgetMs: number): Promise<boolean> {
  const until = Date.now() + budgetMs
  while (Date.now() < until) {
    if (predicate()) return true
    await delay(100)
  }
  return predicate()
}

/** Wait until nothing accepts TCP connections on `port`. */
async function waitForPortRelease(port: number, budgetMs: number): Promise<boolean> {
  const until = Date.now() + budgetMs
  while (Date.now() < until) {
    if (!(await listening(port))) return true
    await delay(150)
  }
  return !(await listening(port))
}

/** Whether something currently accepts a TCP connection on `port`. */
function listening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const done = (value: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(1_000, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

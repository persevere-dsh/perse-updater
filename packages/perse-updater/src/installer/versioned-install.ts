/**
 * Versioned install: `npm install -g --prefix <runtimeRoot>/<version>` (R3 C-8).
 *
 * The install never touches the running installation (I3): the prefix is a fresh
 * directory under the runtime root, and a failure deletes exactly that directory.
 * The exit status is not the verdict (C-2): after npm returns 0 the installer
 * asserts the **native products** — the dsh manifest version, the launcher, an
 * executable `spawn-helper`, and a child process that really `require`s
 * `node-pty` and `koffi`. Any failed assertion is an install failure and the
 * half-product is removed.
 *
 * @module perse-updater/installer/versioned-install
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DSH_PACKAGE } from '../install.ts'
import { parseVersion } from '../semver.ts'
import { assertUnder, binPathOf, packageDirOf, prefixLauncherOf, removeUnder } from './paths.ts'
import { DEFAULT_COMMAND_TIMEOUT_MS, runCommand, type RunOptions } from './spawn.ts'
import { InstallerError } from './types.ts'

/**
 * Install-time scripts the dsh closure needs, exactly as R3 C-8 measured.
 * npm only warns when a script is skipped, so this list is not a convenience —
 * omitting an entry silently ships a broken native module.
 */
export const DEFAULT_SCRIPT_ALLOWLIST: readonly string[] = [
  '@deepseek-ai/dsh-subprocess-local',
  'koffi',
  'node-pty',
  '@google/genai',
  'protobufjs',
]

/** One post-install product assertion. */
export interface NativeAssertion {
  /** Stable assertion id, e.g. `spawn-helper`. */
  readonly id: string
  /** Whether the product was found in the state a boot needs. */
  readonly ok: boolean
  /** What was checked and what was found. */
  readonly detail: string
}

/** What {@link installVersioned} needs. */
export interface VersionedInstallRequest {
  /** Exact SemVer version to install. */
  readonly version: string
  /** Runtime root; the install lands in `<runtimeRoot>/<version>`. */
  readonly runtimeRoot: string
  /** npm cache directory (kept out of the versioned prefix). */
  readonly cacheDir: string
  /** Script allowlist; defaults to {@link DEFAULT_SCRIPT_ALLOWLIST}. */
  readonly allowlist?: readonly string[]
  /** npm executable; defaults to `npm` on `PATH`. */
  readonly npmBin?: string
  /**
   * Whether to add `--strict-allow-scripts` (C-2). `auto` probes the installed
   * npm; the product assertions run regardless, so `auto` is the safe default.
   */
  readonly strictAllowScripts?: boolean | 'auto'
  /** Node executable used for the `require` assertion; defaults to the running node. */
  readonly nodeBin?: string
  /** Kill budget for the npm command. */
  readonly timeoutMs?: number
  /** Extra environment for npm. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Reinstall even when a passing install is already present. */
  readonly forceReinstall?: boolean
  /** Progress sink, for logs. */
  readonly log?: (line: string) => void
}

/** What {@link installVersioned} produced. */
export interface VersionedInstallResult {
  /** Installed version. */
  readonly version: string
  /** Versioned prefix, `<runtimeRoot>/<version>`. */
  readonly prefix: string
  /** Package directory inside the prefix. */
  readonly packageDir: string
  /** Absolute launcher entry the symlink must point at. */
  readonly bin: string
  /** npm's own `<prefix>/bin/dsh` shim. */
  readonly prefixLauncher: string
  /** Command line as executed (empty when an existing install was reused). */
  readonly command: string
  /** Whether an existing install was reused instead of reinstalled. */
  readonly reused: boolean
  /** Wall-clock duration of the npm command. */
  readonly durationMs: number
  /** Tail of npm's output. */
  readonly logTail: string
  /** Post-install product assertions; all must be `ok`. */
  readonly assertions: readonly NativeAssertion[]
}

/** Assemble the npm argv, exported so evidence can quote the exact contract. */
export function buildNpmArgs(version: string, prefix: string, cacheDir: string, allowlist: readonly string[], strict: boolean): string[] {
  return [
    'install',
    '-g',
    '--prefix',
    prefix,
    '--cache',
    cacheDir,
    `--allow-scripts=${allowlist.join(',')}`,
    ...(strict ? ['--strict-allow-scripts'] : []),
    `${DSH_PACKAGE}@${version}`,
  ]
}

/**
 * Install one exact version into `<runtimeRoot>/<version>`, asserting the native products.
 *
 * @param request - version, runtime root, cache, and optional policy.
 * @returns the installed layout and the assertion results.
 * @throws {InstallerError} `bad-request` on a malformed version or an escaping path; `install-failed` when npm or an assertion fails (the half-product is removed first).
 */
export async function installVersioned(request: VersionedInstallRequest): Promise<VersionedInstallResult> {
  const version = assertExactVersion(request.version)
  const runtimeRoot = request.runtimeRoot
  const prefix = assertUnder(runtimeRoot, join(runtimeRoot, version), 'targetPrefix')
  const allowlist = request.allowlist ?? DEFAULT_SCRIPT_ALLOWLIST
  const npmBin = request.npmBin ?? 'npm'
  const nodeBin = request.nodeBin ?? process.execPath
  const log = request.log ?? ((): void => {})
  const packageDir = packageDirOf(prefix)
  const bin = binPathOf(prefix)
  const prefixLauncher = prefixLauncherOf(prefix)

  const described = {
    version,
    prefix,
    packageDir,
    bin,
    prefixLauncher,
  }
  const assertionOptions = {
    version,
    prefix,
    nodeBin,
    ...(request.env === undefined ? {} : { env: request.env }),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
  }

  if (request.forceReinstall !== true && existsSync(join(packageDir, 'package.json'))) {
    const assertions = await collectAssertions(assertionOptions)
    if (assertions.every(assertion => assertion.ok)) {
      log(`installer: reusing existing ${version} at ${prefix}`)
      return {
        ...described,
        command: '',
        reused: true,
        durationMs: 0,
        logTail: '(reused existing install)',
        assertions,
      }
    }
    log(`installer: existing ${prefix} failed its product assertions; reinstalling`)
    await removeUnder(runtimeRoot, prefix, 'targetPrefix')
  }

  await mkdir(runtimeRoot, { recursive: true })
  await mkdir(request.cacheDir, { recursive: true })
  // npm 11 `lstat`s the global root's `lib` directory during the
  // `--strict-allow-scripts` preflight (arborist `#rootNodeFromPackage`), and
  // the plain-install path wants the --prefix target to exist too, so lay down
  // npm's own POSIX global layout before invoking it.
  await mkdir(join(prefix, 'lib', 'node_modules'), { recursive: true })
  const strict = request.strictAllowScripts === 'auto' || request.strictAllowScripts === undefined
    ? await supportsStrictAllowScripts(npmBin, request.env)
    : request.strictAllowScripts
  const args = buildNpmArgs(version, prefix, request.cacheDir, allowlist, strict)
  const runOptions: RunOptions = {
    cwd: runtimeRoot,
    timeoutMs: request.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    ...(request.env === undefined ? {} : { env: request.env }),
  }
  log(`installer: running npm install for ${version} (strict-allow-scripts=${String(strict)})`)
  const result = await runCommand(npmBin, args, runOptions)

  if (result.timedOut || result.code !== 0) {
    await removeUnder(runtimeRoot, prefix, 'targetPrefix')
    throw new InstallerError(
      'install-failed',
      'install',
      result.timedOut
        ? `${result.command} exceeded ${request.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS} ms`
        : `${result.command} exited ${result.code ?? `signal ${result.signal ?? 'unknown'}`}`,
      { logTail: result.output },
    )
  }

  const assertions = await collectAssertions(assertionOptions)
  const failed = assertions.filter(assertion => !assertion.ok)
  if (failed.length > 0) {
    await removeUnder(runtimeRoot, prefix, 'targetPrefix')
    throw new InstallerError(
      'install-failed',
      'install',
      `npm exited 0 but ${failed.length} native assertion(s) failed: ${failed.map(entry => `${entry.id} (${entry.detail})`).join('; ')}`,
      { logTail: result.output },
    )
  }

  return {
    ...described,
    command: result.command,
    reused: false,
    durationMs: result.durationMs,
    logTail: result.output,
    assertions,
  }
}

/**
 * Run the C-2 product assertions for one installed prefix.
 *
 * @param options - prefix, expected version, node binary.
 * @returns every assertion, passed and failed, in a stable order.
 */
export async function collectAssertions(options: {
  readonly version: string
  readonly prefix: string
  readonly nodeBin: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly timeoutMs?: number
}): Promise<NativeAssertion[]> {
  const { version, prefix } = options
  const packageDir = packageDirOf(prefix)
  const assertions: NativeAssertion[] = []

  const manifest = readJson(join(packageDir, 'package.json'))
  assertions.push({
    id: 'manifest-version',
    ok: manifest?.version === version,
    detail: `${join(packageDir, 'package.json')} version=${String(manifest?.version ?? '(absent)')} expected=${version}`,
  })

  const bin = binPathOf(prefix)
  assertions.push({
    id: 'launcher-bin',
    ok: existsSync(bin),
    detail: `${bin} ${existsSync(bin) ? 'exists' : 'is missing'}`,
  })

  const prefixLauncher = prefixLauncherOf(prefix)
  assertions.push({
    id: 'prefix-launcher',
    ok: existsSync(prefixLauncher),
    detail: `${prefixLauncher} ${existsSync(prefixLauncher) ? 'exists' : 'is missing'}`,
  })

  assertions.push(spawnHelperAssertion(packageDir))

  const required = await requireNativeAssertion(packageDir, options.nodeBin, options.env, options.timeoutMs)
  assertions.push(required)
  return assertions
}

/** `spawn-helper` must exist for this platform and carry an executable bit. */
function spawnHelperAssertion(packageDir: string): NativeAssertion {
  const prebuilds = join(packageDir, 'node_modules', 'node-pty', 'prebuilds')
  const preferred = join(prebuilds, `${process.platform}-${process.arch}`, 'spawn-helper')
  const found = listSpawnHelpers(prebuilds)
  const mode = executableMode(preferred)
  if (existsSync(preferred) && mode) {
    return { id: 'spawn-helper', ok: true, detail: `${preferred} executable (mode ${mode})` }
  }
  return {
    id: 'spawn-helper',
    ok: false,
    detail: `missing or not executable: ${preferred}; prebuilds found: ${found.length === 0 ? '(none)' : found.join(', ')}`,
  }
}

/** The native modules must actually load, in a child of the target prefix. */
async function requireNativeAssertion(
  packageDir: string,
  nodeBin: string,
  env: Readonly<Record<string, string | undefined>> | undefined,
  timeoutMs: number | undefined,
): Promise<NativeAssertion> {
  const script = "require('node-pty'); require('koffi'); process.stdout.write('native-require-ok')"
  const result = await runCommand(
    nodeBin,
    ['--input-type=commonjs', '--eval', script],
    {
      cwd: packageDir,
      timeoutMs: Math.min(timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, 60_000),
      ...(env === undefined ? {} : { env }),
    },
  )
  const ok = result.code === 0 && result.output.includes('native-require-ok')
  return {
    id: 'require-native',
    ok,
    detail: ok
      ? 'node-pty and koffi required successfully'
      : `require failed (exit=${String(result.code)}): ${tail(result.output)}`,
  }
}

/** Whether the installed npm advertises `--strict-allow-scripts` (probed once per binary). */
async function supportsStrictAllowScripts(npmBin: string, env: Readonly<Record<string, string | undefined>> | undefined): Promise<boolean> {
  const cached = strictSupport.get(npmBin)
  if (cached !== undefined) return cached
  const result = await runCommand(npmBin, ['install', '--help'], {
    timeoutMs: 30_000,
    ...(env === undefined ? {} : { env }),
  })
  const supported = result.output.includes('--strict-allow-scripts')
  strictSupport.set(npmBin, supported)
  return supported
}

/** Per-binary cache of the `--strict-allow-scripts` probe. */
const strictSupport = new Map<string, boolean>()

/** Refuse anything that is not exact SemVer, before it can reach a path join. */
function assertExactVersion(value: unknown): string {
  if (typeof value !== 'string' || value === '' || parseVersion(value) === undefined) {
    throw new InstallerError('bad-request', 'validate', `not an exact SemVer version: ${JSON.stringify(value)}`)
  }
  return value
}

/** Every per-platform `spawn-helper` below the node-pty prebuilds directory. */
function listSpawnHelpers(prebuilds: string): string[] {
  const out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(prebuilds)
  } catch {
    return out
  }
  for (const entry of entries) {
    const candidate = join(prebuilds, entry, 'spawn-helper')
    if (existsSync(candidate)) out.push(candidate)
  }
  return out
}

/** The octal permission bits of an executable file, or `undefined` when it is missing or not executable. */
function executableMode(path: string): string | undefined {
  try {
    const mode = statSync(path).mode
    if ((mode & 0o111) === 0) return undefined
    return (mode & 0o777).toString(8).padStart(3, '0')
  } catch {
    return undefined
  }
}

/** Parse a JSON object, tolerating absence and malformation. */
function readJson(path: string): { version?: unknown } | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
  } catch {
    return undefined
  }
}

/** Last few lines of a failure's output, for one-line assertion details. */
function tail(value: string, max = 400): string {
  const trimmed = value.trim()
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(trimmed.length - max)}`
}

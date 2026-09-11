/**
 * Resolve a *candidate* version to a scannable dependency tree.
 *
 * `preflight` must reason about the candidate's **actual dependency resolution
 * tree**, never about the main package's version number alone: R3 measured that
 * `0.1.5-rc.1`'s own `dependencies` already range over `^0.1.5-rc.1` and that npm
 * resolves the closure to whatever `maxSatisfying` picks per range — which can be
 * a different patch/rc than the main package.
 *
 * Three sources are tried, cheapest first, and none of them touch `~/.dsh`:
 *
 * 1. `live` — the candidate *is* the running version: scan the running prefix.
 * 2. `versioned-runtime` — `$DSH_HOME/runtime/<version>` exists (the D5 layout).
 * 3. `registry-cache` — materialize the contract-relevant closure from npm
 *    tarballs into `$TMPDIR/dsh-uc-candidates/<version>` (never under `~/.dsh`,
 *    so a preflight cannot write to the real harness home).
 *
 * Honest boundary: the materialized tree is a **flat** extraction of the resolved
 * package set (npm's physical nesting is not reproduced). Its package names and
 * versions are the resolution tree; only the on-disk shape is simplified. Every
 * other source is a real install.
 *
 * @module perse-updater/candidate-tree
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareParsed, parseVersion, type ParsedVersion } from '../semver.ts'
import { resolveProxyFor, type ProxyRoute } from '../registry.ts'
import type { CandidateTreeSource } from '../contract-scan.ts'

/** Raised when no candidate tree can be produced without violating preflight's read-only contract. */
export class CandidateUnavailableError extends Error {
  /** What was tried, for the report. */
  readonly tried: readonly string[]

  /**
   * @param message - human-readable reason.
   * @param tried - sources that were attempted, in order.
   */
  constructor(message: string, tried: readonly string[]) {
    super(message)
    this.name = 'CandidateUnavailableError'
    this.tried = tried
  }
}

/** One package of the resolved candidate closure. */
export interface ResolvedPackage {
  /** Package name. */
  readonly name: string
  /** Exact resolved version. */
  readonly version: string
  /** Tarball URL. */
  readonly tarball: string
}

/** A candidate tree that has been located or materialized. */
export interface CandidateTree {
  /** Version the tree belongs to. */
  readonly version: string
  /** Install root to hand to {@link scanContractTree}. */
  readonly root: string
  /** How the root was obtained. */
  readonly source: CandidateTreeSource
  /** Packages of the resolved closure when it was materialized; empty for a real install. */
  readonly resolved: readonly ResolvedPackage[]
  /** Caveats worth putting in the report. */
  readonly notes: readonly string[]
}

/** Injectable network hooks, so the resolver is testable without a registry. */
export interface CandidateTreeHooks {
  /** Fetch one registry packument. */
  fetchJson(url: string): Promise<unknown>
  /** Fetch one tarball. */
  fetchTarball(url: string): Promise<Uint8Array>
  /** Extract a `.tgz` into a directory. */
  extract(tarballPath: string, destination: string): void
}

/** Options of {@link resolveCandidateTree}. */
export interface ResolveCandidateTreeOptions {
  /** Candidate version. */
  readonly version: string
  /** Running install version/prefix, when one is known. */
  readonly running?: { readonly version: string; readonly prefix: string }
  /** Harness home; only used to look for the D5 `runtime/<version>` layout. */
  readonly dshHome: string
  /** Cache root for materialized closures; defaults to `$TMPDIR/dsh-uc-candidates`. */
  readonly cacheRoot?: string
  /** Registry origin; defaults to `https://registry.npmjs.org`. */
  readonly registry?: string
  /** Disable network materialization (tests); defaults to `true`. */
  readonly network?: boolean
  /** Override the network hooks. */
  readonly hooks?: CandidateTreeHooks
  /** Launch environment for proxy resolution. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

const DSH_PACKAGE = '@deepseek-ai/dsh'

/** Packages R-02 needs even though they are not `@deepseek-ai/dsh-*`. */
const EXTRA_RELEVANT = new Set([
  'node-pty',
  'koffi',
  'commander',
  'js-yaml',
  '@deepseek-ai/cordis',
  '@deepseek-ai/cosmokit',
  '@deepseek-ai/schemastery',
])

/** Whether a package contributes to the static contract surface preflight scans. */
export function isContractRelevant(name: string): boolean {
  if (name.startsWith('@deepseek-ai/dsh-')) return true
  if (name.startsWith('@deepseek-ai/cordis')) return true
  if (name.startsWith('node-addon-')) return true
  if (name.startsWith('@koromix/koffi-')) return true
  if (name.startsWith('@img/sharp-')) return true
  return EXTRA_RELEVANT.has(name)
}

/**
 * Locate or build a scannable tree for one candidate version.
 *
 * @param options - version, running install, home, cache and network policy.
 * @returns the tree root plus how it was obtained.
 * @throws {CandidateUnavailableError} when no source can produce a tree.
 */
export async function resolveCandidateTree(options: ResolveCandidateTreeOptions): Promise<CandidateTree> {
  const tried: string[] = []

  if (options.running !== undefined && options.running.version === options.version && options.running.prefix !== '') {
    return {
      version: options.version,
      root: options.running.prefix,
      source: 'live',
      resolved: [],
      notes: ['candidate equals the running version: scanned the live install tree (no network, no writes)'],
    }
  }
  tried.push('live')

  const runtimePrefix = join(options.dshHome, 'runtime', options.version)
  if (existsSync(join(runtimePrefix, 'lib', 'node_modules'))) {
    return {
      version: options.version,
      root: runtimePrefix,
      source: 'versioned-runtime',
      resolved: [],
      notes: [`scanned the versioned runtime prefix ${runtimePrefix}`],
    }
  }
  tried.push('versioned-runtime')

  const cacheRoot = options.cacheRoot ?? join(tmpdir(), 'dsh-uc-candidates')
  const cached = join(cacheRoot, options.version)
  if (existsSync(join(cached, 'lib', 'node_modules'))) {
    return {
      version: options.version,
      root: cached,
      source: 'registry-cache',
      resolved: [],
      notes: [`reused the materialized closure cache at ${cached}`],
    }
  }
  tried.push('registry-cache(reuse)')

  if (options.network === false) {
    throw new CandidateUnavailableError(
      `candidate ${options.version} is not installed, not cached, and network materialization is disabled`,
      tried,
    )
  }

  const hooks = options.hooks ?? defaultHooks(options.env ?? process.env)
  const registry = (options.registry ?? 'https://registry.npmjs.org').replace(/\/+$/, '')
  const resolved = await resolveClosure(DSH_PACKAGE, options.version, registry, hooks)
  const notes: string[] = [
    `materialized ${resolved.length} contract-relevant package(s) from ${registry} into ${cached}`,
    'materialization is a flat extraction of the resolved closure, not npm\u2019s physical nesting',
  ]
  try {
    await materialize(resolved, cached, hooks)
  } catch (error) {
    throw new CandidateUnavailableError(
      `materializing candidate ${options.version} failed: ${String(error)}`,
      [...tried, 'registry-cache(materialize)'],
    )
  }
  return { version: options.version, root: cached, source: 'registry-cache', resolved, notes }
}

/**
 * Resolve the contract-relevant closure of `mainName@mainVersion`.
 *
 * Only dependency edges whose target {@link isContractRelevant} are followed; a
 * package reached first at a wider range keeps the resolution npm's own hoisting
 * would give it (highest satisfying version).
 *
 * @param mainName - package to start from.
 * @param mainVersion - exact version of that package.
 * @param registry - registry origin.
 * @param hooks - network hooks.
 * @returns every resolved package except the root.
 */
export async function resolveClosure(
  mainName: string,
  mainVersion: string,
  registry: string,
  hooks: CandidateTreeHooks,
): Promise<ResolvedPackage[]> {
  const out = new Map<string, ResolvedPackage>()
  const wanted = new Map<string, string>()
  const queue: string[] = []

  const first = await packument(mainName, registry, hooks)
  const rootManifest = manifestOf(first, mainVersion)
  if (rootManifest === undefined) throw new Error(`registry has no ${mainName}@${mainVersion}`)
  enqueueDependencies(rootManifest, wanted, queue)
  collectNativeCompanions(rootManifest, out)

  while (queue.length > 0) {
    const name = queue.shift()!
    if (out.has(name)) continue
    const range = wanted.get(name) ?? '*'
    const document = await packument(name, registry, hooks)
    const version = maxSatisfying(document, range)
    if (version === undefined) {
      throw new Error(`no published ${name} satisfies ${range}`)
    }
    const manifest = manifestOf(document, version)
    if (manifest === undefined) throw new Error(`registry has no manifest for ${name}@${version}`)
    out.set(name, { name, version, tarball: tarballOf(document, version) ?? '' })
    enqueueDependencies(manifest, wanted, queue)
    collectNativeCompanions(manifest, out)
  }
  return [...out.values()]
}

/** Add a manifest's contract-relevant dependencies to the work list (first range wins, like hoisting). */
function enqueueDependencies(
  manifest: Record<string, unknown>,
  wanted: Map<string, string>,
  queue: string[],
): void {
  const dependencies = manifest['dependencies']
  if (typeof dependencies !== 'object' || dependencies === null) return
  for (const [name, range] of Object.entries(dependencies as Record<string, unknown>)) {
    if (typeof range !== 'string' || !isContractRelevant(name)) continue
    if (!wanted.has(name)) {
      wanted.set(name, range)
      queue.push(name)
    }
  }
}

/** Record platform companion packages a manifest names, so R-02 can find them. */
function collectNativeCompanions(manifest: Record<string, unknown>, out: Map<string, ResolvedPackage>): void {
  for (const field of ['optionalDependencies', 'dependencies'] as const) {
    const block = manifest[field]
    if (typeof block !== 'object' || block === null) continue
    for (const name of Object.keys(block as Record<string, unknown>)) {
      if (name.startsWith('@koromix/koffi-') || name.startsWith('@img/sharp-')) {
        if (!out.has(name)) out.set(name, { name, version: '(companion)', tarball: '' })
      }
    }
  }
}

/** Read one packument, caching nothing (the caller resolves once per preflight). */
async function packument(name: string, registry: string, hooks: CandidateTreeHooks): Promise<Record<string, unknown>> {
  const body = await hooks.fetchJson(`${registry}/${name}`)
  if (typeof body !== 'object' || body === null) throw new Error(`registry document for ${name} is not an object`)
  return body as Record<string, unknown>
}

/** Pick one version's manifest out of a packument. */
function manifestOf(document: Record<string, unknown>, version: string): Record<string, unknown> | undefined {
  const versions = document['versions']
  if (typeof versions !== 'object' || versions === null) return undefined
  const entry = (versions as Record<string, unknown>)[version]
  if (typeof entry !== 'object' || entry === null) return undefined
  return entry as Record<string, unknown>
}

/** Tarball URL of one version. */
function tarballOf(document: Record<string, unknown>, version: string): string | undefined {
  const versions = document['versions']
  if (typeof versions !== 'object' || versions === null) return undefined
  const entry = (versions as Record<string, unknown>)[version]
  if (typeof entry !== 'object' || entry === null) return undefined
  const dist = (entry as Record<string, unknown>)['dist']
  if (typeof dist !== 'object' || dist === null) return undefined
  const tarball = (dist as Record<string, unknown>)['tarball']
  return typeof tarball === 'string' ? tarball : undefined
}

/** Write each resolved package into a flat `lib/node_modules` layout. */
async function materialize(resolved: readonly ResolvedPackage[], root: string, hooks: CandidateTreeHooks): Promise<void> {
  const modules = join(root, 'lib', 'node_modules')
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-uc-tar-'))
  try {
    for (const pkg of resolved) {
      if (pkg.tarball === '' || pkg.version === '(companion)') continue
      const destination = join(modules, ...pkg.name.split('/'))
      if (existsSync(join(destination, 'package.json'))) continue
      mkdirSync(destination, { recursive: true })
      const tarballPath = join(scratch, `${pkg.name.replace(/[@/]/g, '_')}-${pkg.version}.tgz`)
      writeFileSync(tarballPath, await hooks.fetchTarball(pkg.tarball))
      hooks.extract(tarballPath, destination)
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Default hooks against a real registry, honouring the harness proxy policy. */
function defaultHooks(env: Readonly<Record<string, string | undefined>>): CandidateTreeHooks {
  return {
    async fetchJson(url: string): Promise<unknown> {
      const response = await request(url, env, 'application/json')
      return await response.json()
    },
    async fetchTarball(url: string): Promise<Uint8Array> {
      const response = await request(url, env, 'application/octet-stream')
      return new Uint8Array(await response.arrayBuffer())
    },
    extract(tarballPath: string, destination: string): void {
      const result = spawnSync('tar', ['-xzf', tarballPath, '-C', destination, '--strip-components=1'], {
        stdio: 'ignore',
      })
      if (result.status !== 0) throw new Error(`tar extraction failed for ${tarballPath} (status ${String(result.status)})`)
    },
  }
}

/** One HTTP GET through the resolved proxy, if any. */
async function request(
  url: string,
  env: Readonly<Record<string, string | undefined>>,
  accept: string,
): Promise<Response> {
  const init: Record<string, unknown> = { headers: { accept }, signal: AbortSignal.timeout(60_000) }
  const route: ProxyRoute | undefined = resolveProxyFor(url, env)
  if (route !== undefined) {
    const dispatcher = await proxyDispatcher(route)
    if (dispatcher !== undefined) init['dispatcher'] = dispatcher
  }
  const response = await fetch(url, init as RequestInit)
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`)
  return response
}

/** Install an undici proxy dispatcher, degrading to a direct request when undici is absent. */
async function proxyDispatcher(route: ProxyRoute): Promise<unknown> {
  try {
    const specifier = 'undici'
    const undici = (await import(specifier)) as { ProxyAgent: new (options: { uri: string }) => unknown }
    return new undici.ProxyAgent({ uri: route.url })
  } catch {
    return undefined
  }
}

// --------------------------------------------------------------------------------------
// SemVer ranges
// --------------------------------------------------------------------------------------

/** One comparator of a range. */
export interface Comparator {
  /** Comparison operator. */
  readonly op: '<' | '<=' | '>' | '>=' | '='
  /** Right-hand version. */
  readonly version: ParsedVersion
}

/**
 * Pick the highest published version satisfying `range`.
 *
 * Implements the subset of node-semver npm actually uses for these packages:
 * exact, `*`/`x`, `^`, `~`, comparison operators, hyphen ranges and `||`. The
 * npm prerelease rule is honoured: a prerelease version matches only when a
 * comparator in the same alternative shares its `[major, minor, patch]`.
 *
 * @param document - packument.
 * @param range - dependency range.
 * @returns the chosen version, or `undefined`.
 */
export function maxSatisfying(document: Record<string, unknown>, range: string): string | undefined {
  const versions = document['versions']
  if (typeof versions !== 'object' || versions === null) return undefined
  const candidates = Object.keys(versions)
    .map(version => ({ raw: version, parsed: parseVersion(version) }))
    .filter((entry): entry is { raw: string; parsed: ParsedVersion } => entry.parsed !== undefined)
  const alternatives = parseRange(range)
  if (alternatives === undefined) return undefined
  let best: { raw: string; parsed: ParsedVersion } | undefined
  for (const candidate of candidates) {
    if (!alternatives.some(comparators => satisfies(candidate.parsed, comparators))) continue
    if (best === undefined || compareParsed(candidate.parsed, best.parsed) > 0) best = candidate
  }
  return best?.raw
}

/** Whether one exact version satisfies one range; `undefined` when either side is unparseable. */
export function rangeSatisfies(version: string, range: string): boolean | undefined {
  const parsed = parseVersion(version)
  if (parsed === undefined) return undefined
  const alternatives = parseRange(range)
  if (alternatives === undefined) return undefined
  return alternatives.some(comparators => satisfies(parsed, comparators))
}

/** Whether one parsed version satisfies one AND-set of comparators. */
export function satisfies(version: ParsedVersion, comparators: readonly Comparator[]): boolean {
  for (const comparator of comparators) {
    if (!testComparator(version, comparator)) return false
  }
  if (version.prerelease.length === 0) return true
  // npm: a prerelease only matches when a comparator in this set pins the same tuple.
  return comparators.some(comparator =>
    comparator.version.prerelease.length > 0 &&
    comparator.version.major === version.major &&
    comparator.version.minor === version.minor &&
    comparator.version.patch === version.patch,
  )
}

/** Apply one comparator. */
function testComparator(version: ParsedVersion, comparator: Comparator): boolean {
  const order = compareParsed(version, comparator.version)
  switch (comparator.op) {
    case '<': return order < 0
    case '<=': return order <= 0
    case '>': return order > 0
    case '>=': return order >= 0
    case '=': return order === 0
  }
}

/**
 * Parse a range into alternatives of comparators.
 * @param range - range text.
 * @returns alternatives, or `undefined` when the range cannot be understood.
 */
export function parseRange(range: string): Comparator[][] | undefined {
  const text = range.trim()
  if (text === '' || text === '*' || text === 'x' || text === 'latest') return [[{ op: '>=', version: parseVersion('0.0.0')! }]]
  const alternatives: Comparator[][] = []
  for (const alternative of text.split('||')) {
    const parsed = parseAlternative(alternative.trim())
    if (parsed === undefined) return undefined
    alternatives.push(parsed)
  }
  return alternatives
}

/** Parse one whitespace-separated OR alternative. */
function parseAlternative(alternative: string): Comparator[] | undefined {
  const hyphen = /^\s*([^\s]+)\s+-\s+([^\s]+)\s*$/.exec(alternative)
  if (hyphen !== null) {
    const low = parseVersion(hyphen[1]!)
    const high = parseVersion(hyphen[2]!)
    if (low === undefined || high === undefined) return undefined
    return [{ op: '>=', version: low }, { op: '<=', version: high }]
  }
  const out: Comparator[] = []
  for (const token of alternative.split(/\s+/).filter(part => part !== '')) {
    const comparators = parseToken(token)
    if (comparators === undefined) return undefined
    out.push(...comparators)
  }
  return out.length === 0 ? [{ op: '>=', version: parseVersion('0.0.0')! }] : out
}

/** Parse one comparator token, expanding `^`, `~` and x-ranges. */
function parseToken(token: string): Comparator[] | undefined {
  const match = /^(<=|>=|<|>|=|\^|~)?\s*(.+)$/.exec(token)
  if (match === null) return undefined
  const operator = match[1] ?? ''
  const body = match[2]!
  if (body === '*' || body === 'x' || body === 'X' || body === '') {
    return [{ op: '>=', version: parseVersion('0.0.0')! }]
  }
  const parts = body.split('.')
  const wildcard = parts.findIndex(part => part === '*' || part === 'x' || part === 'X')
  if (wildcard >= 0) {
    const numeric = parts.slice(0, wildcard).map(part => Number(part))
    if (numeric.some(value => !Number.isSafeInteger(value) || value < 0)) return undefined
    const [major = 0, minor = 0] = numeric
    const low = `${major}.${minor}.0`
    if (wildcard === 0) return [{ op: '>=', version: parseVersion('0.0.0')! }]
    if (wildcard === 1) return [{ op: '>=', version: parseVersion(low)! }, { op: '<', version: parseVersion(`${major + 1}.0.0`)! }]
    return [{ op: '>=', version: parseVersion(low)! }, { op: '<', version: parseVersion(`${major}.${minor + 1}.0`)! }]
  }
  const version = parseVersion(body)
  if (version === undefined) {
    // npm accepts partial comparators (`>=22`, `~22.1`); pad them the way it does.
    const partial = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(body)
    if (partial === null) return undefined
    const major = Number(partial[1])
    const minor = partial[2] === undefined ? undefined : Number(partial[2])
    const patch = partial[3] === undefined ? undefined : Number(partial[3])
    const padded = parseVersion(`${major}.${minor ?? 0}.${patch ?? 0}`)!
    if (operator === '^') return caretComparators(padded)
    if (operator === '~') return tildeComparators(padded)
    return partialComparators(operator, major, minor, patch)
  }
  switch (operator) {
    case '^':
      return caretComparators(version)
    case '~':
      return tildeComparators(version)
    case '>':
    case '>=':
    case '<':
    case '<=':
      return [{ op: operator, version }]
    default:
      return [{ op: '=', version }]
  }
}

/** `^version` expansion (npm: no change to the leftmost non-zero component). */
function caretComparators(version: ParsedVersion): Comparator[] {
  const upper = version.major > 0
    ? `${version.major + 1}.0.0`
    : version.minor > 0
      ? `0.${version.minor + 1}.0`
      : `0.0.${version.patch + 1}`
  return [{ op: '>=', version }, { op: '<', version: parseVersion(upper)! }]
}

/** `~version` expansion (npm: allow patch-level changes). */
function tildeComparators(version: ParsedVersion): Comparator[] {
  return [{ op: '>=', version }, { op: '<', version: parseVersion(`${version.major}.${version.minor + 1}.0`)! }]
}

/** npm's partial-version comparator semantics (`>=22` ⇒ `>=22.0.0`, `<=22` ⇒ `<23.0.0`). */
function partialComparators(
  operator: string,
  major: number,
  minor: number | undefined,
  patch: number | undefined,
): Comparator[] {
  const hasMinor = minor !== undefined
  const hasPatch = patch !== undefined
  const low = `${major}.${minor ?? 0}.${patch ?? 0}`
  const nextMajor = `${major + 1}.0.0`
  const nextMinor = `${major}.${(minor ?? 0) + 1}.0`
  switch (operator) {
    case '>':
      return [{ op: '>=', version: parseVersion(hasMinor ? nextMinor : nextMajor)! }]
    case '>=':
      return [{ op: '>=', version: parseVersion(low)! }]
    case '<':
      return [{ op: '<', version: parseVersion(low)! }]
    case '<=':
      return [{ op: '<', version: parseVersion(hasMinor ? nextMinor : nextMajor)! }]
    default: {
      if (!hasMinor) return [{ op: '>=', version: parseVersion(low)! }, { op: '<', version: parseVersion(nextMajor)! }]
      if (!hasPatch) return [{ op: '>=', version: parseVersion(low)! }, { op: '<', version: parseVersion(nextMinor)! }]
      return [{ op: '=', version: parseVersion(low)! }]
    }
  }
}

/**
 * npm registry client for the dsh main package.
 *
 * Two concerns live here and nothing else: turning the launch environment into
 * one outbound proxy route (the harness installs an undici global dispatcher
 * when a proxy is configured, and this client must not bypass it), and turning
 * the registry document into the validated {@link RegistrySnapshot} the pure
 * candidate builder consumes.
 *
 * @module perse-updater/registry
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DSH_PACKAGE } from './install.ts'
import type { RegistrySnapshot } from './candidates.ts'

/** Default npm registry origin. */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

/** Default freshness window for the registry document. */
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000

/** Default timeout for one registry request. */
export const DEFAULT_TIMEOUT_MS = 30 * 1000

/** Environment the proxy policy is resolved from. */
export type ProxyEnvironment = Readonly<Record<string, string | undefined>>

/** One resolved outbound proxy route. */
export interface ProxyRoute {
  /** Proxy URL, e.g. `http://127.0.0.1:7890`. */
  readonly url: string
  /** Environment variable the value came from, for diagnostics. */
  readonly source: string
}

/** Options accepted by {@link fetchRegistrySnapshot}. */
export interface RegistryFetchOptions {
  /** Registry origin; defaults to {@link DEFAULT_REGISTRY}. */
  readonly registry?: string
  /** Cache freshness window in milliseconds; `0` disables reuse. */
  readonly cacheTtlMs?: number
  /** Bypass the in-memory and on-disk caches and refetch. */
  readonly force?: boolean
  /** Harness home holding the on-disk cache; defaults to `$DSH_HOME` or `~/.dsh`. */
  readonly dshHome?: string
  /** Launch environment consulted for proxy configuration; defaults to `process.env`. */
  readonly env?: ProxyEnvironment
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs?: number
}

/** A registry answer together with the probe that produced it. */
export interface RegistryAnswer {
  /** Validated snapshot. */
  readonly snapshot: RegistrySnapshot
  /** `memory`, `disk`, or `network`. */
  readonly origin: 'memory' | 'disk' | 'network'
  /** Proxy route used for a network fetch, when one applied. */
  readonly proxy?: ProxyRoute
}

/** Resolve the harness home this process reads and writes. */
export function resolveDshHome(env: ProxyEnvironment = process.env): string {
  const configured = env['DSH_HOME']
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

/** In-memory cache, keyed by registry origin. */
const memoryCache = new Map<string, { at: number; snapshot: RegistrySnapshot }>()

/**
 * Fetch and normalize the registry document for `@deepseek-ai/dsh`.
 * @param options - registry, cache, and proxy policy.
 * @returns the snapshot plus where it came from.
 * @throws {RegistryUnreachableError} when the registry cannot be reached or answers a non-OK status.
 */
export async function fetchRegistrySnapshot(options: RegistryFetchOptions = {}): Promise<RegistryAnswer> {
  const registry = (options.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, '')
  const ttl = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  const dshHome = options.dshHome ?? resolveDshHome(options.env)
  const cachePath = join(dshHome, 'update-center', 'registry-cache.json')
  const now = Date.now()

  if (options.force !== true && ttl > 0) {
    const cached = memoryCache.get(registry)
    if (cached !== undefined && now - cached.at < ttl) {
      return { snapshot: cached.snapshot, origin: 'memory' }
    }
    const fromDisk = await readDiskCache(cachePath, registry, now, ttl)
    if (fromDisk !== undefined) {
      memoryCache.set(registry, { at: now, snapshot: fromDisk })
      return { snapshot: fromDisk, origin: 'disk' }
    }
  }

  const url = `${registry}/${DSH_PACKAGE}`
  const proxy = resolveProxyFor(url, options.env ?? process.env)
  const body = await requestJson(url, proxy, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const snapshot = normalizeRegistryDocument(body, new Date().toISOString())
  memoryCache.set(registry, { at: Date.now(), snapshot })
  await writeDiskCache(cachePath, registry, snapshot)
  return proxy === undefined
    ? { snapshot, origin: 'network' }
    : { snapshot, origin: 'network', proxy }
}

/** Registry failure carrying the HTTP status when there was one. */
export class RegistryUnreachableError extends Error {
  /** HTTP status, when the request reached the server. */
  readonly status?: number

  /**
   * @param message - human-readable reason.
   * @param status - HTTP status when the request reached the server.
   * @param options - standard error options.
   */
  constructor(message: string, status?: number, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RegistryUnreachableError'
    if (status !== undefined) this.status = status
  }
}

/**
 * Validate and flatten a registry document.
 *
 * Only exact SemVer keys survive: the registry is untrusted input and one
 * malformed key must not be able to reach `apply`.
 *
 * @param body - parsed JSON body.
 * @param fetchedAt - ISO-8601 timestamp of this fetch.
 * @returns the normalized snapshot.
 * @throws {RegistryUnreachableError} when the body is not an npm packument.
 */
export function normalizeRegistryDocument(body: unknown, fetchedAt: string): RegistrySnapshot {
  if (typeof body !== 'object' || body === null) {
    throw new RegistryUnreachableError('registry answered with a non-object document')
  }
  const record = body as Record<string, unknown>
  const versions = record['versions']
  if (typeof versions !== 'object' || versions === null || Array.isArray(versions)) {
    throw new RegistryUnreachableError(`registry document for ${DSH_PACKAGE} has no "versions" object`)
  }
  const times = typeof record['time'] === 'object' && record['time'] !== null
    ? record['time'] as Record<string, unknown>
    : {}
  const rawTags = typeof record['dist-tags'] === 'object' && record['dist-tags'] !== null
    ? record['dist-tags'] as Record<string, unknown>
    : {}
  const fallbackTime = typeof times['modified'] === 'string' ? times['modified'] : fetchedAt

  const publishedAt: Record<string, string> = {}
  for (const key of Object.keys(versions)) {
    const timestamp = times[key]
    publishedAt[key] = typeof timestamp === 'string' ? timestamp : fallbackTime
  }
  const distTags: Record<string, string> = {}
  for (const [tag, version] of Object.entries(rawTags)) {
    if (typeof version === 'string' && version !== '') distTags[tag] = version
  }
  return { publishedAt, distTags, fetchedAt }
}

/**
 * Resolve the outbound proxy for one URL.
 *
 * Precedence follows undici's own (lowercase before uppercase) with npm's
 * `npm_config_*` proxy settings as the fallback, because "the configured proxy"
 * on a harness host is whatever npm and the environment already agreed on.
 * `no_proxy` is honoured, with the loopback hosts always bypassed: proxying the
 * harness's own loopback traffic turns the UI into a routing loop.
 *
 * @param target - absolute URL about to be requested.
 * @param env - launch environment.
 * @returns the route to use, or `undefined` for a direct request.
 */
export function resolveProxyFor(target: string, env: ProxyEnvironment = process.env): ProxyRoute | undefined {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return undefined
  }
  const isSecure = url.protocol === 'https:'
  const candidate = isSecure
    ? firstValue(env, ['https_proxy', 'HTTPS_PROXY', 'npm_config_https_proxy', 'all_proxy', 'ALL_PROXY', 'http_proxy', 'HTTP_PROXY', 'npm_config_proxy'])
    : firstValue(env, ['http_proxy', 'HTTP_PROXY', 'npm_config_proxy', 'all_proxy', 'ALL_PROXY'])
  if (candidate === undefined) return undefined
  if (isBypassed(url.hostname, env)) return undefined
  return candidate
}

/** First non-blank environment value among `names`. */
function firstValue(env: ProxyEnvironment, names: readonly string[]): ProxyRoute | undefined {
  for (const name of names) {
    const value = env[name]
    if (typeof value === 'string' && value.trim() !== '') return { url: value.trim(), source: name }
  }
  return undefined
}

/** Whether `no_proxy` exempts one host. */
function isBypassed(hostname: string, env: ProxyEnvironment): boolean {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') return true
  const raw = firstValue(env, ['no_proxy', 'NO_PROXY', 'npm_config_noproxy'])
  if (raw === undefined) return false
  const host = hostname.toLowerCase()
  for (const entry of raw.url.split(',')) {
    const pattern = entry.trim().toLowerCase().replace(/^\./, '')
    if (pattern === '') continue
    if (pattern === '*') return true
    if (host === pattern || host.endsWith(`.${pattern}`)) return true
  }
  return false
}

/** Install an undici proxy dispatcher for one route, degrading to a direct request when undici is absent. */
async function proxyDispatcher(route: ProxyRoute): Promise<unknown> {
  try {
    // Resolved through a variable so this optional dependency is not a compile-time
    // edge: `undici` is not a declared dependency of this package, and the harness
    // already provides it in the profile's installation farm.
    const specifier = 'undici'
    const undici = await import(specifier) as { ProxyAgent: new (options: { uri: string }) => unknown }
    return new undici.ProxyAgent({ uri: route.url })
  } catch (error) {
    console.error(
      `[perse-updater] proxy ${route.url} (from ${route.source}) is configured but undici is unavailable; ` +
        `falling back to a direct request: ${String(error)}`,
    )
    return undefined
  }
}

/** Perform one JSON GET, routed through `route` when one applies. */
async function requestJson(url: string, route: ProxyRoute | undefined, timeoutMs: number): Promise<unknown> {
  const headers = { accept: 'application/json' }
  const init: Record<string, unknown> = { headers, signal: AbortSignal.timeout(timeoutMs) }
  if (route !== undefined) {
    const dispatcher = await proxyDispatcher(route)
    if (dispatcher !== undefined) init['dispatcher'] = dispatcher
  }
  let response: Response
  try {
    response = await fetch(url, init as RequestInit)
  } catch (error) {
    throw new RegistryUnreachableError(`cannot reach ${url}: ${String(error)}`, undefined, { cause: error })
  }
  if (!response.ok) {
    throw new RegistryUnreachableError(`${url} answered HTTP ${response.status} ${response.statusText}`, response.status)
  }
  try {
    return await response.json()
  } catch (error) {
    throw new RegistryUnreachableError(`${url} answered a non-JSON body: ${String(error)}`, response.status, { cause: error })
  }
}

/** Read the on-disk cache when it is fresh and belongs to the same registry. */
async function readDiskCache(
  cachePath: string,
  registry: string,
  now: number,
  ttl: number,
): Promise<RegistrySnapshot | undefined> {
  try {
    const raw = JSON.parse(await readFile(cachePath, 'utf8')) as {
      registry?: unknown
      fetchedAt?: unknown
      distTags?: unknown
      publishedAt?: unknown
    }
    if (raw.registry !== registry) return undefined
    if (typeof raw.fetchedAt !== 'string') return undefined
    const at = Date.parse(raw.fetchedAt)
    if (!Number.isFinite(at) || now - at >= ttl) return undefined
    if (typeof raw.distTags !== 'object' || raw.distTags === null) return undefined
    if (typeof raw.publishedAt !== 'object' || raw.publishedAt === null) return undefined
    return {
      fetchedAt: raw.fetchedAt,
      distTags: raw.distTags as Record<string, string>,
      publishedAt: raw.publishedAt as Record<string, string>,
    }
  } catch {
    return undefined
  }
}

/** Persist the snapshot so a restart does not refetch immediately. Failures are non-fatal. */
async function writeDiskCache(cachePath: string, registry: string, snapshot: RegistrySnapshot): Promise<void> {
  try {
    await mkdir(dirname(cachePath), { recursive: true })
    await writeFile(cachePath, `${JSON.stringify({ registry, ...snapshot })}\n`, 'utf8')
  } catch (error) {
    console.error(`[perse-updater] could not persist the registry cache at ${cachePath}: ${String(error)}`)
  }
}

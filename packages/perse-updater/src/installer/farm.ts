/**
 * S4b — fallback-farm cleanup, scoped down per R3 C-5.
 *
 * Measured on this machine: after the launcher moves to a new generation, the
 * next boot heals the farm itself (186 links re-pointed, ~5.2 s), so a normal
 * generation change needs **no** cleanup at all. The one case boot cannot heal
 * is a real directory sitting where a managed symlink belongs: `ensureSymlink`
 * refuses it and the whole profile exits 1 with `exists and is not a symlink or
 * dsh-managed module proxy`. This module therefore removes exactly those
 * entries — never a symlink (dangling or not), and never a dsh-managed module
 * proxy, which is a real directory *by design* in a packaged executable.
 *
 * @module perse-updater/installer/farm
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

/** One farm entry considered for cleanup. */
export interface FarmCandidate {
  /** Absolute entry path. */
  readonly path: string
  /** Package name the entry is mounted under, `@scope/name` form. */
  readonly name: string
  /** What the entry is on disk. */
  readonly kind: 'directory' | 'file' | 'other'
  /** Whether a real directory carries a dsh module-proxy record (allowed, never removed). */
  readonly managedProxy: boolean
}

/** Result of inspecting the farm without changing it. */
export interface FarmPollutionScan {
  /** Directory scanned, or `(absent)`. */
  readonly dir: string
  /** Package entries inspected, counting scoped children. */
  readonly total: number
  /** Real directories/files occupying a managed link slot — the boot-fatal set. */
  readonly pollution: readonly FarmCandidate[]
  /** Real directories that are legitimate dsh module proxies. */
  readonly managedProxies: readonly FarmCandidate[]
}

/** Result of one cleanup pass. */
export interface FarmCleanupResult extends FarmPollutionScan {
  /** Package entries removed, in scan order. */
  readonly removed: readonly string[]
  /** Pollution remaining after the pass (must be 0). */
  readonly pollutionAfter: number
  /** Whether no cleanup was needed, so boot self-heal owns the generation change (C-5). */
  readonly selfHeal: boolean
}

/**
 * Inspect the farm for boot-fatal pollution.
 *
 * @param farmDir - `$DSH_HOME/profiles/node_modules`.
 * @returns every entry, split into pollution and legitimate managed proxies.
 */
export function scanFarmPollution(farmDir: string): FarmPollutionScan {
  if (!existsSync(farmDir)) {
    return { dir: '(absent)', total: 0, pollution: [], managedProxies: [] }
  }
  const pollution: FarmCandidate[] = []
  const managedProxies: FarmCandidate[] = []
  let total = 0
  for (const entry of listPackageEntries(farmDir)) {
    total += 1
    let stat: ReturnType<typeof lstatSync>
    try {
      stat = lstatSync(entry.path)
    } catch {
      continue
    }
    if (stat.isSymbolicLink()) continue
    const kind: FarmCandidate['kind'] = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other'
    const managedProxy = stat.isDirectory() && hasModuleProxyRecord(entry.path)
    const candidate: FarmCandidate = { path: entry.path, name: entry.name, kind, managedProxy }
    if (managedProxy) managedProxies.push(candidate)
    else pollution.push(candidate)
  }
  return { dir: farmDir, total, pollution, managedProxies }
}

/**
 * Remove boot-fatal farm pollution, and only that.
 *
 * @param farmDir - `$DSH_HOME/profiles/node_modules`.
 * @returns the before/after counts and the removed paths.
 */
export async function cleanFarmPollution(farmDir: string): Promise<FarmCleanupResult> {
  const before = scanFarmPollution(farmDir)
  const removed: string[] = []
  for (const candidate of before.pollution) {
    // Re-check immediately before deleting: a heal that ran concurrently may
    // already have replaced the directory with the symlink boot wants.
    let stat: ReturnType<typeof lstatSync>
    try {
      stat = lstatSync(candidate.path)
    } catch {
      continue
    }
    if (stat.isSymbolicLink()) continue
    await rm(candidate.path, { recursive: true, force: true })
    removed.push(candidate.path)
  }
  const after = removed.length === 0 ? before : scanFarmPollution(farmDir)
  return {
    ...after,
    removed,
    pollutionAfter: after.pollution.length,
    selfHeal: before.pollution.length === 0,
  }
}

/**
 * List package entries under a farm directory, mirroring the scanner's view.
 * Scoped packages are reported as their children, never as the `@scope` directory
 * itself (that directory is a normal container, not a link slot).
 *
 * Exported so the post-restart self-check (`health/index.ts`) judges the farm
 * exactly the way the cleanup pass does — a second, weaker re-implementation is
 * how an `@scope` container became a false "real directory" failure.
 */
export function listPackageEntries(nodeModulesDir: string): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = []
  let entries: string[]
  try {
    entries = readdirSync(nodeModulesDir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    const path = join(nodeModulesDir, entry)
    if (entry.startsWith('@')) {
      let inner: string[]
      try {
        inner = readdirSync(path)
      } catch {
        continue
      }
      for (const child of inner) {
        if (child.startsWith('.')) continue
        out.push({ name: `${entry}/${child}`, path: join(path, child) })
      }
      continue
    }
    out.push({ name: entry, path })
  }
  return out
}

/** Whether a real directory carries the dsh module-proxy record `ensureModuleProxy` writes. */
function hasModuleProxyRecord(dir: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dsh?: { moduleFallback?: { targets?: unknown } }
    }
    return manifest.dsh?.moduleFallback?.targets !== undefined
  } catch {
    return false
  }
}

/**
 * Locate the installation the harness is currently running from.
 *
 * the plugin must describe the *running* version, not whatever a lockfile
 * says: `versions()` filters candidates against it and `current.prefix` is the
 * directory a later switch would rewrite. The dependency farm a profile is
 * booted with supplies `@deepseek-ai/dsh` from the launcher's own installation
 * closure, so resolving it from here lands on the live install.
 *
 * @module perse-updater/install
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, sep } from 'node:path'
import { channelOf } from './semver.ts'
import type { CurrentInstall } from './types.ts'

/** The package whose installed instance is the update target (D2: main package only). */
export const DSH_PACKAGE = '@deepseek-ai/dsh'

/** How the running install was found; recorded for evidence, not part of the wire contract. */
export type InstallProbe = 'resolve' | 'argv' | 'none'

/** One located installation plus the probe that found it. */
export interface RunningInstall extends CurrentInstall {
  /** Which probe produced this result. */
  readonly probe: InstallProbe
}

/** A located package manifest. */
interface LocatedManifest {
  /** Absolute path of `@deepseek-ai/dsh/package.json`. */
  readonly path: string
  /** Which probe found it. */
  readonly probe: InstallProbe
}

/**
 * Read the running installation.
 * @returns the version, install prefix, and release channel.
 * @throws when no installed `@deepseek-ai/dsh` manifest can be found.
 */
export function readRunningInstall(): RunningInstall {
  const located = locateManifest()
  if (located === undefined) {
    throw new Error(
      `cannot locate the running ${DSH_PACKAGE} installation: it is neither resolvable from this plugin nor derivable from the launcher argv`,
    )
  }
  const version = readVersion(located.path)
  return {
    version,
    prefix: prefixOfPackageDir(dirname(located.path)),
    channel: channelOf(version),
    probe: located.probe,
  }
}

/**
 * Find the installed `@deepseek-ai/dsh/package.json`.
 *
 * Order matters: the resolver is the normal path (this plugin always runs inside
 * the harness process); the launcher argv is the fallback for a composition whose
 * module farm does not project the main package.
 */
function locateManifest(): LocatedManifest | undefined {
  const require = createRequire(import.meta.url)
  try {
    const resolved = require.resolve(`${DSH_PACKAGE}/package.json`)
    return { path: canonical(resolved), probe: 'resolve' }
  } catch {
    /* fall through to the remaining probe */
  }
  return locateFromArgv()
}

/** Canonicalize a path, preferring the real path so a profile farm link does not define the prefix. */
function canonical(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * Derive the manifest from the launcher argv.
 *
 * `<prefix>/lib/node_modules/@deepseek-ai/dsh/lib/bin.js` is the published bin
 * layout; walking to the `node_modules` segment recovers the package root even
 * when the module resolver is unavailable.
 */
function locateFromArgv(): LocatedManifest | undefined {
  const entry = process.argv[1]
  if (entry === undefined) return undefined
  const parts = canonical(entry).split(sep)
  const marker = parts.lastIndexOf('node_modules')
  if (marker < 0) return undefined
  const root = parts.slice(0, marker + 1).join(sep) || sep
  const candidate = join(root, ...DSH_PACKAGE.split('/'), 'package.json')
  return existsSync(candidate) ? { path: candidate, probe: 'argv' } : undefined
}

/** Read `version` out of one manifest. */
function readVersion(manifestPath: string): string {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    throw new Error(`installed manifest ${manifestPath} has no version`)
  }
  return manifest.version
}

/**
 * Derive the install prefix from a package directory.
 *
 * npm's POSIX global layout puts `node_modules` under `<prefix>/lib`, so the
 * prefix is two levels above `node_modules` there and one level above it
 * otherwise (a plain `<dir>/node_modules` install). The versioned runtime layout
 * `~/.dsh/runtime/<version>/lib/node_modules/...` is a `<prefix>/lib` layout, so
 * it lands on the version directory (D5).
 *
 * @param packageDir - absolute directory holding the package manifest.
 * @returns the install prefix, or an empty string when the layout is not recognized.
 */
export function prefixOfPackageDir(packageDir: string): string {
  const parts = packageDir.split(sep)
  const marker = parts.lastIndexOf('node_modules')
  if (marker < 0) return ''
  const nodeModulesDir = parts.slice(0, marker + 1).join(sep) || sep
  const parent = dirname(nodeModulesDir)
  return basename(parent) === 'lib' ? dirname(parent) : parent
}

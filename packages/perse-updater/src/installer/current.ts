/**
 * `current.json` — the launcher pointer record (migration-plan §1).
 *
 * Invariant I4 makes the write order load-bearing: the record naming the *old*
 * generation as `previous` must be durable on disk **before** the symlink
 * moves, so a crash between the two steps is always recoverable from the file
 * alone. {@link writeCurrentAtomic} therefore writes a sibling temporary file
 * and `rename`s it into place, and the orchestrator calls it before
 * {@link import('./symlink.ts').switchSymlink}.
 *
 * @module perse-updater/installer/current
 */

import { existsSync, readFileSync, readlinkSync } from 'node:fs'
import { open, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { DSH_PACKAGE, prefixOfPackageDir } from '../install.ts'
import { InstallerError, type CurrentState, type LauncherEntry } from './types.ts'

/** Default location of the pointer file below a harness home. */
export function resolveCurrentPath(dshHome: string): string {
  return join(dshHome, 'update-center', 'current.json')
}

/** Read the pointer file. Absent is `undefined`; malformed is a refusal (never a silent reset). */
export async function readCurrent(path: string): Promise<CurrentState | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw new InstallerError('bad-request', 'current', `cannot read ${path}: ${String(error)}`, { cause: error })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new InstallerError('bad-request', 'current', `${path} is not valid JSON: ${String(error)}`, { cause: error })
  }
  return parseCurrentState(parsed, path)
}

/**
 * Atomically replace the pointer file with `state`.
 *
 * The temporary file is a sibling so the `rename` stays within one filesystem,
 * and it is `fsync`ed before the rename so a crash cannot leave a zero-length
 * `current.json` — the one file a rollback cannot be reconstructed without (I8).
 *
 * @param path - destination, e.g. `~/.dsh/update-center/current.json`.
 * @param state - record to persist.
 */
export async function writeCurrentAtomic(path: string, state: CurrentState): Promise<void> {
  const body = `${JSON.stringify(state, null, 2)}\n`
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`
  const handle = await open(temp, 'w')
  try {
    await handle.writeFile(body, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw new InstallerError('bad-request', 'current', `cannot replace ${path}: ${String(error)}`, { cause: error })
  }
}

/**
 * Restore the pre-switch pointer record after a failed switch.
 *
 * A missing pre-state means the installer created the file this call, so
 * removing it restores the previous on-disk truth exactly.
 *
 * @param path - pointer file.
 * @param previous - the record read before the switch, or `undefined`.
 */
export async function restoreCurrent(path: string, previous: CurrentState | undefined): Promise<void> {
  if (previous === undefined) {
    await rm(path, { force: true })
    return
  }
  await writeCurrentAtomic(path, previous)
}

/** Raw symlink target (verbatim, possibly relative), or `undefined` when absent or not a link. */
export function readSymlinkTarget(symlinkPath: string): string | undefined {
  try {
    return readlinkSync(symlinkPath)
  } catch {
    return undefined
  }
}

/**
 * Reconstruct a launcher entry from a bin path.
 *
 * Walks up to the first `package.json` naming {@link DSH_PACKAGE} and derives
 * the prefix from the package directory, which is exactly what
 * `install.ts#prefixOfPackageDir` does for the running install — so a pointer
 * read from disk describes the same shape as a pointer the installer writes.
 *
 * @param binPath - absolute path of a launcher entry.
 * @returns the entry, or `undefined` when no dsh manifest is above the path.
 */
export function entryFromBin(binPath: string): LauncherEntry | undefined {
  const resolved = resolve(binPath)
  let dir = dirname(resolved)
  for (let depth = 0; depth < 16; depth += 1) {
    const manifestPath = join(dir, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = readManifest(manifestPath)
      if (manifest?.name === DSH_PACKAGE && typeof manifest.version === 'string' && manifest.version !== '') {
        return { version: manifest.version, prefix: prefixOfPackageDir(dir), bin: resolved }
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * Reconstruct the generation a launcher symlink currently points at.
 * @param symlinkPath - absolute path of the launcher symlink.
 * @returns the entry, or `undefined` when the link is absent, dangling, or does not resolve to a dsh manifest.
 */
export function entryFromSymlink(symlinkPath: string): LauncherEntry | undefined {
  const target = readSymlinkTarget(symlinkPath)
  if (target === undefined || target === '') return undefined
  const absolute = isAbsolute(target) ? target : resolve(dirname(symlinkPath), target)
  return entryFromBin(absolute)
}

/** Validate one parsed pointer document. */
function parseCurrentState(raw: unknown, path: string): CurrentState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InstallerError('bad-request', 'current', `${path} is not a JSON object`)
  }
  const record = raw as Record<string, unknown>
  const active = parseEntry(record['active'])
  if (active === undefined) {
    throw new InstallerError('bad-request', 'current', `${path} has no valid "active" entry`)
  }
  const symlink = record['symlink']
  if (typeof symlink !== 'string' || symlink === '') {
    throw new InstallerError('bad-request', 'current', `${path} has no "symlink" path`)
  }
  const previous = record['previous'] === undefined || record['previous'] === null
    ? undefined
    : parseEntry(record['previous'])
  const patchBackup = typeof record['patchBackup'] === 'string' ? record['patchBackup'] : undefined
  const updatedAt = typeof record['updatedAt'] === 'string' && record['updatedAt'] !== ''
    ? record['updatedAt']
    : new Date(0).toISOString()
  return {
    active,
    ...(previous === undefined ? {} : { previous }),
    symlink,
    ...(patchBackup === undefined ? {} : { patchBackup }),
    updatedAt,
  }
}

/** Validate one `active`/`previous` entry. */
function parseEntry(raw: unknown): LauncherEntry | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const version = record['version']
  const prefix = record['prefix']
  const bin = record['bin']
  if (typeof version !== 'string' || version === '') return undefined
  if (typeof prefix !== 'string' || typeof bin !== 'string' || bin === '') return undefined
  return { version, prefix, bin }
}

/** Read a package manifest's `name`/`version`, tolerating any malformed file. */
function readManifest(path: string): { name?: unknown; version?: unknown } | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown; version?: unknown }
  } catch {
    return undefined
  }
}

/** Whether an fs error means "no such file", across the error's `code` and `errno` shapes. */
function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

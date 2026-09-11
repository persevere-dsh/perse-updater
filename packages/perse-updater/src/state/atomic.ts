/**
 * Atomic JSON persistence for the update-center state directory (H1).
 *
 * `state.json` must never be readable as half a document: the host writes it
 * while the helper may be reading it, and a crash between two writes must leave
 * the previous document intact. Every write therefore goes through a sibling
 * temporary file that is `fsync`ed and then `rename`d into place, plus an
 * `fsync` of the directory so the rename itself survives a power loss.
 *
 * @module perse-updater/state/atomic
 */

import { readFileSync } from 'node:fs'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { StateError } from './types.ts'

/** Monotonic suffix so two writes in the same millisecond cannot share a temp name. */
let sequence = 0

/**
 * Atomically replace a JSON file with `value`.
 *
 * @param path - destination path.
 * @param value - JSON-serializable document.
 * @throws {StateError} `io` when the temp file cannot be written or renamed.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const body = `${JSON.stringify(value, null, 2)}\n`
  await writeTextAtomic(path, body)
}

/**
 * Atomically replace a text file.
 *
 * @param path - destination path.
 * @param body - full file body.
 * @throws {StateError} `io` when the write or rename fails.
 */
export async function writeTextAtomic(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  sequence += 1
  const temp = `${path}.tmp-${process.pid}-${sequence.toString(36)}`
  try {
    const handle = await open(temp, 'w')
    try {
      await handle.writeFile(body, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw new StateError('io', 'state', `cannot atomically write ${path}: ${String(error)}`, { cause: error })
  }
}

/**
 * Append one JSON line, durably.
 *
 * `progress.jsonl` is append-only so a crash can never truncate earlier stages;
 * the synchronous `fsync` keeps the line visible to the peer process that reads
 * the tail right after a phase change.
 *
 * @param path - JSONL destination.
 * @param value - JSON-serializable line.
 * @throws {StateError} `io` when the append fails.
 */
export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  try {
    const handle = await open(path, 'a')
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    throw new StateError('io', 'state', `cannot append to ${path}: ${String(error)}`, { cause: error })
  }
}

/**
 * Read one JSON document.
 *
 * @param path - source path.
 * @returns the parsed value, or `undefined` when the file is absent.
 * @throws {StateError} `bad-request` when the file exists but is not valid JSON.
 */
export async function readJsonFile<T>(path: string): Promise<T | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw new StateError('io', 'state', `cannot read ${path}: ${String(error)}`, { cause: error })
  }
  return parseJson<T>(raw, path)
}

/** Synchronous sibling of {@link readJsonFile}, for pure status rebuilds. */
export function readJsonFileSync<T>(path: string): T | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw new StateError('io', 'state', `cannot read ${path}: ${String(error)}`, { cause: error })
  }
  return parseJson<T>(raw, path)
}

/** Parse a JSON string, refusing malformed content instead of silently resetting state. */
function parseJson<T>(raw: string, path: string): T {
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    throw new StateError('bad-request', 'state', `${path} is not valid JSON: ${String(error)}`, { cause: error })
  }
}

/** Whether an fs error means "no such file". */
function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

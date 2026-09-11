/**
 * G5 / D3 isolation: disable the `cordis.patch.yml` sections a blocked report
 * names — but only after a verified backup exists.
 *
 * Invariant I6 has two halves and this module enforces both:
 *
 * 1. **The backup happens first, and is verified.** The backup is written, then
 *    its SHA-256 is compared against the source. If the bytes do not match, the
 *    isolation aborts before touching the live file — a "backup" that cannot
 *    restore is worse than no isolation at all (I8).
 * 2. **The disable is a real loader-level disable.** A patch row carrying
 *    `disabled: true` is skipped by the Cordis loader before its module name is
 *    resolved (`cordis-plugin-loader` `refresh()` returns early), so a ghost
 *    insert can be neutralized without deleting the user's configuration.
 *
 * Restoration is the exact inverse: the recorded backup is copied back
 * atomically, so the "one-click restore" affordance in the UI starts from bytes
 * the isolation itself verified.
 *
 * @module perse-updater/isolate
 */

import { createHash } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { copyFile, readFile, rm } from 'node:fs/promises'
import { StateError } from '../state/types.ts'
import { writeTextAtomic } from '../state/atomic.ts'

/** One `insert` section that was disabled. */
export interface DisabledSection {
  /** Loader row id. */
  readonly id: string
  /** Inserted package name, when the section declares one. */
  readonly name?: string
}

/** What {@link isolateBlockedTargets} needs. */
export interface IsolateRequest {
  /** Absolute path of the profile `cordis.patch.yml`. */
  readonly patchPath: string
  /** Report targets (insert `name` or loader `id`) that must be disabled. */
  readonly targets: readonly string[]
  /** Explicit backup path; defaults to `<patch>.bak.<compact-ts>`. */
  readonly backupPath?: string
  /** Clock injection for the default backup name. */
  readonly now?: () => Date
  /** Progress sink. */
  readonly log?: (line: string) => void
}

/** What an isolation pass did. */
export interface IsolateResult {
  /** Patch file that was (or, for a no-op, would have been) edited. */
  readonly patchPath: string
  /** Verified backup path; `undefined` when nothing needed disabling. */
  readonly backupPath?: string
  /** SHA-256 of the verified backup. */
  readonly backupSha256?: string
  /** Sections that are now disabled. */
  readonly disabled: readonly DisabledSection[]
  /** Whether the file was rewritten. */
  readonly changed: boolean
}

/**
 * Back up and disable every matching insert section.
 *
 * @param request - patch path, targets, and options.
 * @returns what was disabled and where the backup is.
 * @throws {StateError} `bad-request` when the patch is absent; `io` when the backup cannot be verified.
 */
export async function isolateBlockedTargets(request: IsolateRequest): Promise<IsolateResult> {
  const log = request.log ?? ((): void => {})
  if (!existsSync(request.patchPath)) {
    throw new StateError(
      'bad-request',
      'isolate',
      `${request.patchPath} does not exist; refusing to isolate with nothing to back up (I6)`,
    )
  }
  const original = await readFile(request.patchPath, 'utf8')
  const { text, disabled } = disablePatchTargets(original, request.targets)
  if (disabled.length === 0) {
    log(`isolate: none of ${request.targets.length} target(s) appear in ${request.patchPath}; nothing to disable`)
    return { patchPath: request.patchPath, disabled: [], changed: false }
  }

  const backupPath = request.backupPath ?? defaultBackupPath(request.patchPath, (request.now ?? ((): Date => new Date()))())
  const sourceSha = sha256(original)
  await copyBackup(request.patchPath, backupPath)
  const backupSha = await sha256File(backupPath)
  if (!existsSync(backupPath) || backupSha !== sourceSha) {
    await rm(backupPath, { force: true })
    throw new StateError(
      'io',
      'isolate',
      `backup ${backupPath} does not reproduce ${request.patchPath} (expected ${sourceSha}, got ${backupSha}); aborting isolation (I6)`,
    )
  }
  log(`isolate: backup verified ${backupPath} sha256=${backupSha.slice(0, 16)}…; disabling ${disabled.length} section(s)`)

  await writeTextAtomic(request.patchPath, text)
  const afterSha = await sha256File(request.patchPath)
  if (afterSha === sourceSha) {
    throw new StateError('io', 'isolate', `${request.patchPath} was not modified by the isolation write`)
  }
  return {
    patchPath: request.patchPath,
    backupPath,
    backupSha256: backupSha,
    disabled,
    changed: true,
  }
}

/**
 * Copy a verified backup back over the live patch (the UI's "restore" affordance).
 *
 * @param backupPath - backup taken by {@link isolateBlockedTargets}.
 * @param patchPath - live patch to restore.
 * @throws {StateError} `bad-request` when the backup is missing; `io` on a failed restore.
 */
export async function restorePatchBackup(backupPath: string, patchPath: string): Promise<void> {
  if (!existsSync(backupPath)) {
    throw new StateError('bad-request', 'restore-patch', `backup ${backupPath} does not exist; cannot restore ${patchPath}`)
  }
  const text = await readFile(backupPath, 'utf8')
  await writeTextAtomic(patchPath, text)
  const restored = await sha256File(patchPath)
  const expected = await sha256File(backupPath)
  if (restored !== expected) {
    throw new StateError('io', 'restore-patch', `restored ${patchPath} (${restored}) does not match ${backupPath} (${expected})`)
  }
}

/**
 * Disable matching insert sections in a patch document, textually.
 *
 * The transform is line-based on purpose: a YAML round-trip would reflow the
 * user's file (comments, quoting, key order) and make the backup diff
 * unreadable. Only two edits are ever made — replacing an existing
 * `disabled: false` with `disabled: true`, or inserting a `disabled: true` key
 * directly below the section's `- id:` line at the section's own key indent.
 *
 * @param text - patch document.
 * @param targets - insert `name`s or loader `id`s to disable.
 * @returns the rewritten document and what was disabled.
 */
export function disablePatchTargets(text: string, targets: readonly string[]): { text: string; disabled: DisabledSection[] } {
  const targetSet = new Set(targets.filter(target => target !== ''))
  if (targetSet.size === 0) return { text, disabled: [] }
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const hadFinalNewline = text.endsWith('\n')
  const lines = text.split(/\r?\n/)
  if (hadFinalNewline) lines.pop()

  const entries = scanInsertEntries(lines)
  const insertAfter = new Map<number, string[]>()
  const replaceLine = new Map<number, string>()
  const disabled: DisabledSection[] = []

  for (const entry of entries) {
    const matches = (entry.name !== undefined && targetSet.has(entry.name)) || (entry.id !== '' && targetSet.has(entry.id))
    if (!matches) continue
    disabled.push({ id: entry.id, ...(entry.name === undefined ? {} : { name: entry.name }) })
    if (entry.disabled === true) continue
    const pad = ' '.repeat(entry.keyIndent)
    if (entry.disabledLine !== undefined) {
      replaceLine.set(entry.disabledLine, `${pad}disabled: true`)
    } else {
      insertAfter.set(entry.startLine, [...(insertAfter.get(entry.startLine) ?? []), `${pad}disabled: true`])
    }
  }

  if (disabled.length === 0) return { text, disabled }

  const out: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    out.push(replaceLine.get(index) ?? lines[index] ?? '')
    const additions = insertAfter.get(index)
    if (additions !== undefined) out.push(...additions)
  }
  const body = out.join(eol) + (hadFinalNewline ? eol : '')
  return { text: body, disabled }
}

/** One insert section found by the line scanner. */
interface InsertEntry {
  /** Line index of the `- id:` item. */
  readonly startLine: number
  /** Indent of the `- ` item. */
  readonly itemIndent: number
  /** Indent the section's keys align at (`itemIndent + 2`). */
  readonly keyIndent: number
  /** Loader row id, or `''` when the section declares none. */
  readonly id: string
  /** Inserted package name, when declared. */
  readonly name?: string
  /** Value of a `disabled:` key, when declared. */
  readonly disabled?: boolean
  /** Line index of the `disabled:` key, when declared at the section's key indent. */
  readonly disabledLine?: number
}

/**
 * Find every `- id: …` item inside an `insert:` list.
 *
 * Mirrors the (independent) reader in `contract-scan.ts#parsePatchDocument`:
 * a section is a list item deeper than the most recent unclosed `insert:` key,
 * and its keys sit two columns to the right of the `-`.
 *
 * @param lines - patch lines without the trailing empty element.
 * @returns the insert sections in file order.
 */
export function scanInsertEntries(lines: readonly string[]): InsertEntry[] {
  const entries: InsertEntry[] = []
  let insertIndent = -1
  let current:
    | {
      startLine: number
      itemIndent: number
      keyIndent: number
      id: string
      name?: string
      disabled?: boolean
      disabledLine?: number
    }
    | undefined

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = leadingSpaces(line)

    if (/^(?:-\s*)?insert\s*:\s*$/.test(trimmed)) {
      insertIndent = indent
      current = undefined
      continue
    }
    if (insertIndent < 0) continue

    const isItem = trimmed.startsWith('- ') || trimmed === '-'
    if (isItem && indent > insertIndent) {
      if (current !== undefined) entries.push(current)
      const body = trimmed.replace(/^-\s*/, '')
      const keyIndent = indent + 2
      const record: {
        startLine: number
        itemIndent: number
        keyIndent: number
        id: string
        name?: string
        disabled?: boolean
        disabledLine?: number
      } = { startLine: index, itemIndent: indent, keyIndent, id: '' }
      current = record
      const pair = splitKey(body)
      if (pair !== undefined) applyKey(record, pair.key, pair.value, index)
      continue
    }
    if (indent <= insertIndent) {
      if (current !== undefined) {
        entries.push(current)
        current = undefined
      }
      insertIndent = -1
      continue
    }
    if (current !== undefined) {
      const pair = splitKey(trimmed)
      if (pair !== undefined && indent === current.keyIndent) applyKey(current, pair.key, pair.value, index)
    }
  }
  if (current !== undefined) entries.push(current)
  return entries
}

/** Apply one `key: value` pair to the section being scanned. */
function applyKey(
  record: { id: string; name?: string; disabled?: boolean; disabledLine?: number },
  key: string,
  rawValue: string,
  lineIndex: number,
): void {
  const value = unquote(rawValue)
  if (key === 'id' && record.id === '') record.id = value
  else if (key === 'name' && record.name === undefined) record.name = value
  else if (key === 'disabled') {
    record.disabled = value === 'true'
    record.disabledLine = lineIndex
  }
}

/** Split `key: value` from a trimmed YAML line. */
function splitKey(text: string): { key: string; value: string } | undefined {
  const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(text)
  if (match === null) return undefined
  return { key: match[1] ?? '', value: match[2] ?? '' }
}

/** Strip one layer of matching quotes. */
function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1)
  }
  return trimmed
}

/** Number of leading spaces. */
function leadingSpaces(line: string): number {
  const match = /^ */.exec(line)
  return match === null ? 0 : match[0].length
}

/** `<patch>.bak.<compact-utc>` (migration-plan §1 / security §2). */
export function defaultBackupPath(patchPath: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return `${patchPath}.bak.${stamp}`
}

/** Copy the patch to a fresh backup path; a same-second rerun gets a numeric suffix. */
async function copyBackup(source: string, backupPath: string): Promise<void> {
  let target = backupPath
  for (let attempt = 1; attempt < 100; attempt += 1) {
    try {
      await copyFile(source, target, constants.COPYFILE_EXCL)
      return
    } catch (error) {
      const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
      if (code !== 'EEXIST') {
        throw new StateError('io', 'isolate', `cannot write backup ${target}: ${String(error)}`, { cause: error })
      }
      target = `${backupPath}.${attempt}`
    }
  }
  throw new StateError('io', 'isolate', `cannot find a free backup name below ${backupPath}`)
}

/** SHA-256 of a string, hex. */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * SHA-256 of a file, hex.
 *
 * @param path - file to hash.
 * @returns the hex digest.
 * @throws {StateError} `io` when the file cannot be read.
 */
export async function sha256File(path: string): Promise<string> {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex')
  } catch (error) {
    throw new StateError('io', 'isolate', `cannot hash ${path}: ${String(error)}`, { cause: error })
  }
}

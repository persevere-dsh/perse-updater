/**
 * Pure transformation from a registry document to the `versions()` payload.
 *
 * Split out of the network client so U-01 (strict semver ordering + dist-tag
 * labelling) and U-02 (drop everything not strictly newer than the installed
 * version) can be exercised without touching the network.
 *
 * @module perse-updater/candidates
 */

import { compareParsed, isPrerelease, parseVersion, type ParsedVersion } from './semver.ts'
import type { CurrentInstall, VersionInfo, VersionsResult } from './types.ts'

/** The facts `versions()` needs out of one registry document, already validated. */
export interface RegistrySnapshot {
  /** Every published version with its publish time in ISO-8601 form. */
  readonly publishedAt: Record<string, string>
  /** Registry dist-tags, exactly as published. */
  readonly distTags: Record<string, string>
  /** When the document was fetched (ISO-8601). */
  readonly fetchedAt: string
}

/**
 * Build the `versions()` payload.
 *
 * Ordering is strict semver descending, never lexicographic and never "latest
 * dist-tag first": R3 C-6 measured `latest = 0.1.5-rc.1` while `next =
 * 0.1.5-rc.2` on the real registry, so a dist-tag must be *reported*, never used
 * to reorder.
 *
 * @param snapshot - validated registry facts.
 * @param current - the running installation.
 * @returns candidates strictly newer than `current`, newest first.
 */
export function buildVersionsResult(snapshot: RegistrySnapshot, current: CurrentInstall): VersionsResult {
  const currentParsed = parseVersion(current.version)
  if (currentParsed === undefined) {
    throw new TypeError(`installed version is not exact SemVer: ${JSON.stringify(current.version)}`)
  }
  const tagsByVersion = new Map<string, string[]>()
  for (const [tag, version] of Object.entries(snapshot.distTags)) {
    const list = tagsByVersion.get(version)
    if (list === undefined) tagsByVersion.set(version, [tag])
    else list.push(tag)
  }

  const candidates: Array<{ parsed: ParsedVersion; info: VersionInfo }> = []
  for (const [version, publishedAt] of Object.entries(snapshot.publishedAt)) {
    const parsed = parseVersion(version)
    // U-02: only strictly newer versions are candidates.
    if (parsed === undefined || compareParsed(parsed, currentParsed) <= 0) continue
    candidates.push({
      parsed,
      info: {
        version,
        tags: (tagsByVersion.get(version) ?? []).slice().sort(),
        publishedAt,
        prerelease: isPrerelease(version),
        distance: {
          major: parsed.major - currentParsed.major,
          minor: parsed.minor - currentParsed.minor,
          patch: parsed.patch - currentParsed.patch,
          prerelease: prereleaseDelta(parsed, currentParsed),
        },
        isCurrent: version === current.version,
      },
    })
  }
  candidates.sort((left, right) => compareParsed(right.parsed, left.parsed))
  return {
    current,
    candidates: candidates.map(candidate => candidate.info),
    distTags: { ...snapshot.distTags },
    fetchedAt: snapshot.fetchedAt,
  }
}

/** `1` when the candidate is a prerelease and the installed version is not, `-1` for the reverse, else `0`. */
function prereleaseDelta(candidate: ParsedVersion, current: ParsedVersion): number {
  const left = candidate.prerelease
  const right = current.prerelease
  if (left.length === 0 && right.length === 0) return 0
  // Graduating onto, or stepping off, the final-release track.
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  // Same channel (rc -> rc, alpha -> alpha): the movement along that channel is
  // what a reader means by "one prerelease further" (rc.1 -> rc.2 == 1).
  if (left[0] !== right[0]) return 0
  const leftTail = lastNumeric(left)
  const rightTail = lastNumeric(right)
  if (leftTail === undefined || rightTail === undefined) return 0
  return leftTail - rightTail
}

/** The last purely numeric prerelease identifier, e.g. `2` for `rc.2`. */
function lastNumeric(parts: readonly (string | number)[]): number | undefined {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index] as string | number
    if (typeof part === 'number') return part
  }
  return undefined
}

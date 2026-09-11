/**
 * Strict SemVer 2.0.0 parsing and ordering.
 *
 * The plugin refuses any version string that is not exact SemVer, matching
 * the desktop project manager's `assertVersion` posture: a registry answer is
 * untrusted input and a version that reaches `apply` must be one the server
 * itself produced.
 *
 * @module perse-updater/semver
 */

/**
 * The canonical SemVer 2.0.0 pattern (semver.org §9), without free-form
 * prefixes such as `v`, ranges, or whitespace.
 */
export const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

/** One parsed SemVer version. */
export interface ParsedVersion {
  /** The version exactly as written. */
  readonly raw: string
  /** Major component. */
  readonly major: number
  /** Minor component. */
  readonly minor: number
  /** Patch component. */
  readonly patch: number
  /** Dot-separated prerelease identifiers, empty for a final release. */
  readonly prerelease: readonly (string | number)[]
  /** Dot-separated build metadata identifiers; never affects ordering. */
  readonly build: readonly string[]
}

/**
 * Parse an exact SemVer version.
 * @param value - candidate version string.
 * @returns the parsed version, or `undefined` when the string is not exact SemVer.
 */
export function parseVersion(value: string): ParsedVersion | undefined {
  const match = VERSION_PATTERN.exec(value)
  if (match === null) return undefined
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return undefined
  const prerelease = (match[4] ?? '').split('.').filter(part => part !== '').map(identifier)
  const build = (match[5] ?? '').split('.').filter(part => part !== '')
  return { raw: value, major, minor, patch, prerelease, build }
}

/**
 * Assert that a string is exact SemVer.
 * @param value - candidate version string.
 * @returns the string, unchanged, when it is exact SemVer.
 * @throws when the string is not exact SemVer.
 */
export function assertVersion(value: string): string {
  if (typeof value !== 'string' || parseVersion(value) === undefined) {
    throw new TypeError(`not an exact SemVer version: ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Compare two parsed versions per SemVer §11.
 * @param left - left version.
 * @param right - right version.
 * @returns a negative number, zero, or a positive number.
 */
export function compareParsed(left: ParsedVersion, right: ParsedVersion): number {
  if (left.major !== right.major) return left.major - right.major
  if (left.minor !== right.minor) return left.minor - right.minor
  if (left.patch !== right.patch) return left.patch - right.patch
  // A version with a prerelease has lower precedence than one without.
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  const shared = Math.min(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < shared; index += 1) {
    const a = left.prerelease[index] as string | number
    const b = right.prerelease[index] as string | number
    if (a === b) continue
    const aNumeric = typeof a === 'number'
    const bNumeric = typeof b === 'number'
    if (aNumeric && bNumeric) return (a as number) - (b as number)
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (aNumeric) return -1
    if (bNumeric) return 1
    return (a as string) < (b as string) ? -1 : 1
  }
  return left.prerelease.length - right.prerelease.length
}

/**
 * Compare two exact SemVer strings.
 * @param left - left version string.
 * @param right - right version string.
 * @returns a negative number, zero, or a positive number.
 * @throws when either string is not exact SemVer.
 */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === undefined) throw new TypeError(`not an exact SemVer version: ${JSON.stringify(left)}`)
  if (b === undefined) throw new TypeError(`not an exact SemVer version: ${JSON.stringify(right)}`)
  return compareParsed(a, b)
}

/**
 * Whether a version carries a prerelease component.
 * @param value - exact SemVer version string.
 * @returns whether `value` is a prerelease.
 */
export function isPrerelease(value: string): boolean {
  return (parseVersion(value)?.prerelease.length ?? 0) > 0
}

/**
 * Release channel of a version: its prerelease identifier, else `latest`.
 * @param value - exact SemVer version string.
 * @returns the channel name, or `unknown` when the string is not exact SemVer.
 */
export function channelOf(value: string): string {
  const parsed = parseVersion(value)
  if (parsed === undefined) return 'unknown'
  if (parsed.prerelease.length === 0) return 'latest'
  return typeof parsed.prerelease[0] === 'number' ? 'prerelease' : String(parsed.prerelease[0])
}

/** Convert one prerelease identifier to its numeric form when it is purely numeric. */
function identifier(part: string): string | number {
  return /^\d+$/.test(part) ? Number(part) : part
}

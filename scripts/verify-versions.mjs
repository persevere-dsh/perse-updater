/**
 * U-01 / U-02 self-check over the compiled pure candidate builder.
 *
 * Runs against `packages/perse-updater/lib/types/` (the tsc output that the
 * plugin actually loads), never against source, so a green run means the shipped
 * ordering and filtering logic is the one under test.
 *
 * The fixture deliberately reproduces the real registry quirk R3 C-6 measured:
 * `latest` points at 0.1.5-rc.1 while `next` points at 0.1.5-rc.2, i.e. the
 * dist-tag order contradicts semver order. A dist-tag must therefore be
 * *reported*, never used to sort.
 *
 * Usage: node scripts/verify-versions.mjs   (after `npm run build`)
 */

import { buildVersionsResult } from '../packages/perse-updater/lib/types/candidates.js'
import { resolveProxyFor } from '../packages/perse-updater/lib/types/registry.js'
import { compareVersions, isPrerelease, parseVersion } from '../packages/perse-updater/lib/types/semver.js'

let failures = 0
let checks = 0

/** Assert one condition and record the outcome. */
function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/** Assert deep equality on JSON-serializable values. */
function checkEqual(label, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  check(label, a === b, `expected ${b}, got ${a}`)
}

// A registry shape that mirrors registry.npmjs.org, including the real dist-tag
// inversion and a non-semver key that must be ignored.
const PUBLISHED_AT = {
  '0.1.4': '2026-09-01T00:00:00.000Z',
  '0.1.5-alpha.1': '2026-09-08T15:59:26.974Z',
  '0.1.5-alpha.2': '2026-09-09T14:43:49.472Z',
  '0.1.5-rc.1': '2026-09-10T03:15:06.841Z',
  '0.1.5-rc.2': '2026-09-10T14:59:35.327Z',
  '0.1.5-rc.9': '2026-09-10T15:10:00.000Z',
  '0.1.5-rc.10': '2026-09-10T15:20:00.000Z',
  '0.2.0-rc.1': '2026-09-11T01:00:00.000Z',
  '0.2.0': '2026-09-11T02:00:00.000Z',
  'not-a-version': '2026-09-11T03:00:00.000Z',
}
const DIST_TAGS = {
  latest: '0.1.5-rc.1',
  next: '0.1.5-rc.2',
  alpha: '0.1.5-alpha.1',
}
const SNAPSHOT = { publishedAt: PUBLISHED_AT, distTags: DIST_TAGS, fetchedAt: '2026-09-11T04:00:00.000Z' }

console.log('\nU-01 strict semver ordering and dist-tag labelling')
console.log('  registry: latest=0.1.5-rc.1, next=0.1.5-rc.2 (dist-tag order contradicts semver order)')

const fromOlder = buildVersionsResult(SNAPSHOT, {
  version: '0.1.4',
  prefix: '/tmp/prefix',
  channel: 'latest',
})
const orderedVersions = fromOlder.candidates.map(candidate => candidate.version)
console.log(`  candidates (current 0.1.4): ${orderedVersions.join(' > ')}`)
checkEqual('strict semver descending order', orderedVersions, [
  '0.2.0',
  '0.2.0-rc.1',
  '0.1.5-rc.10',
  '0.1.5-rc.9',
  '0.1.5-rc.2',
  '0.1.5-rc.1',
  '0.1.5-alpha.2',
  '0.1.5-alpha.1',
])
check(
  'numeric prerelease identifiers compare numerically (rc.10 > rc.9)',
  orderedVersions.indexOf('0.1.5-rc.10') < orderedVersions.indexOf('0.1.5-rc.9'),
)
check('non-semver registry key is dropped', !orderedVersions.includes('not-a-version'), orderedVersions.join(','))
checkEqual(
  'tags follow the version, not the order',
  fromOlder.candidates.map(candidate => candidate.tags),
  [[], [], [], [], ['next'], ['latest'], [], ['alpha']],
)
checkEqual(
  'prerelease flags',
  fromOlder.candidates.filter(candidate => candidate.prerelease).map(candidate => candidate.version),
  ['0.2.0-rc.1', '0.1.5-rc.10', '0.1.5-rc.9', '0.1.5-rc.2', '0.1.5-rc.1', '0.1.5-alpha.2', '0.1.5-alpha.1'],
)
checkEqual('dist-tags echoed verbatim', fromOlder.distTags, DIST_TAGS)
checkEqual('fetchedAt echoed', fromOlder.fetchedAt, SNAPSHOT.fetchedAt)
checkEqual('publishedAt comes from the registry time map', fromOlder.candidates[0].publishedAt, '2026-09-11T02:00:00.000Z')
checkEqual('distance is the component delta from the installed version', fromOlder.candidates[0].distance, {
  major: 0,
  minor: 1,
  patch: -4,
  prerelease: 0,
})
checkEqual('distance.prerelease is -1 when a final install moves onto a prerelease track', fromOlder.candidates.find(c => c.version === '0.2.0-rc.1').distance, {
  major: 0,
  minor: 1,
  patch: -4,
  prerelease: -1,
})

console.log('\nU-02 only versions strictly newer than the installed one survive')

const fromCurrent = buildVersionsResult(SNAPSHOT, {
  version: '0.1.5-rc.1',
  prefix: '/Users/me/.local',
  channel: 'rc',
})
const aboveCurrent = fromCurrent.candidates.map(candidate => candidate.version)
console.log(`  candidates (current 0.1.5-rc.1): ${aboveCurrent.join(' > ') || '(none)'}`)
checkEqual('drops <= current', aboveCurrent, ['0.2.0', '0.2.0-rc.1', '0.1.5-rc.10', '0.1.5-rc.9', '0.1.5-rc.2'])
check(
  'current itself is never a candidate',
  fromCurrent.candidates.every(candidate => candidate.isCurrent === false && candidate.version !== '0.1.5-rc.1'),
)
check(
  'no candidate sorts above the list head',
  aboveCurrent.every((version, index) => index === 0 || compareVersions(aboveCurrent[index - 1], version) > 0),
)

const atHead = buildVersionsResult(SNAPSHOT, { version: '0.2.0', prefix: '/tmp/prefix', channel: 'latest' })
checkEqual('newest installed version yields no candidates', atHead.candidates, [])

const rcSteps = fromCurrent.candidates
  .map(candidate => [candidate.version, candidate.distance.prerelease])
  .sort((left, right) => left[0].localeCompare(right[0]))
checkEqual('distance.prerelease counts steps along the same channel', rcSteps, [
  ['0.1.5-rc.10', 9],
  ['0.1.5-rc.2', 1],
  ['0.1.5-rc.9', 8],
  ['0.2.0', 1],
  ['0.2.0-rc.1', 0],
])

console.log('\nSemVer guard rails')
check('isPrerelease(0.1.5-rc.2)', isPrerelease('0.1.5-rc.2') === true)
check('isPrerelease(0.2.0)', isPrerelease('0.2.0') === false)
check('parseVersion rejects range syntax', parseVersion('^0.1.5') === undefined)
check('parseVersion rejects a leading v', parseVersion('v0.1.5') === undefined)
check('parseVersion rejects partial versions', parseVersion('0.1') === undefined)
let threw = false
try {
  compareVersions('0.1.5', 'garbage')
} catch {
  threw = true
}
check('compareVersions throws on a non-semver operand', threw)

console.log('\nProxy policy (a configured proxy must be respected, loopback never proxied)')
const REGISTRY_URL = 'https://registry.npmjs.org/@deepseek-ai/dsh'
check(
  'HTTPS_PROXY is honoured',
  resolveProxyFor(REGISTRY_URL, { HTTPS_PROXY: 'http://127.0.0.1:7890' })?.url === 'http://127.0.0.1:7890',
)
check(
  'lowercase https_proxy wins over uppercase (undici precedence)',
  resolveProxyFor(REGISTRY_URL, { https_proxy: 'http://lower:1', HTTPS_PROXY: 'http://upper:2' })?.url === 'http://lower:1',
)
check(
  'npm_config_https_proxy is the fallback',
  resolveProxyFor(REGISTRY_URL, { npm_config_https_proxy: 'http://npm:3' })?.url === 'http://npm:3',
)
check(
  'no_proxy bypasses a matching host',
  resolveProxyFor(REGISTRY_URL, { HTTPS_PROXY: 'http://p:1', NO_PROXY: 'registry.npmjs.org' }) === undefined,
)
check(
  'no_proxy honours a suffix entry',
  resolveProxyFor('https://registry.npmjs.org/x', { HTTPS_PROXY: 'http://p:1', no_proxy: '.npmjs.org' }) === undefined,
)
check(
  'loopback is always bypassed, even with a proxy configured',
  resolveProxyFor('http://127.0.0.1:3080/api', { HTTP_PROXY: 'http://p:1' }) === undefined,
)
check('a direct request stays direct', resolveProxyFor(REGISTRY_URL, {}) === undefined)

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)

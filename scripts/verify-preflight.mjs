/**
 * WP3 acceptance: U-04 (R-01…R-09, each with a positive and a negative case)
 * and U-05 (verdict aggregation), plus the scanner/parser units they rest on.
 *
 * Everything runs against a **fixture** harness home and candidate prefix built
 * under `os.tmpdir()`. The one case that must be end-to-end is the real blood
 * case: a local plugin exporting `inject = ['config']` must be read by
 * `scanLocalEnvironment` from disk and must make R-03 a `block`.
 *
 * Usage: node scripts/verify-preflight.mjs   (after `npm run typecheck`)
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { scanContractTree, scanLocalEnvironment, parsePatchDocument } from '../packages/perse-updater/lib/types/contract-scan.js'
import { maxSatisfying, rangeSatisfies } from '../packages/perse-updater/lib/types/candidate/tree.js'
import {
  runPreflight,
  verdictOf,
} from '../packages/perse-updater/lib/types/preflight/index.js'

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

/** Assert deep JSON equality. */
function checkEqual(label, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  check(label, a === b, `expected ${b}, got ${a}`)
}

/** Write a file, creating parents. */
function put(path, body) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body, 'utf8')
}

/** Write a package manifest and one host source file. */
function putPackage(dir, name, version, source = '', extra = {}) {
  put(join(dir, 'package.json'), JSON.stringify({ name, version, type: 'module', main: 'lib/index.js', ...extra }, null, 2))
  if (source !== '') put(join(dir, 'lib', 'index.js'), source)
}

// --------------------------------------------------------------------------------------
// fixture
// --------------------------------------------------------------------------------------

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-uc-wp3-'))
const CANDIDATE = join(ROOT, 'candidate')
const HOME = join(ROOT, 'home')
const VERSION = '0.1.5-rc.2'

function buildCandidate() {
  const nm = join(CANDIDATE, 'lib', 'node_modules')
  const nested = join(nm, '@deepseek-ai', 'dsh', 'node_modules')

  // Main package: the only thing the prefix top level holds (R3 C-3).
  putPackage(join(nm, '@deepseek-ai', 'dsh'), '@deepseek-ai/dsh', VERSION, '', {
    engines: { node: '>=22' },
    dependencies: { '@deepseek-ai/dsh-base': '^0.1.5-rc.1' },
  })

  // The real closure is nested, never at the prefix top level.
  putPackage(
    join(nested, '@deepseek-ai', 'dsh-base'),
    '@deepseek-ai/dsh-base',
    VERSION,
    [
      "export const inject = ['tools']",
      "class WebService { constructor(ctx) { super(ctx, 'webServer') } }",
      "class Sessions { constructor(ctx) { super(ctx, 'sessions') } }",
    ].join('\n'),
    { dependencies: { '@deepseek-ai/dsh-app-boot': '^0.1.5-rc.1' } },
  )
  put(join(nested, '@deepseek-ai', 'dsh-base', 'cordis.patch.yml'), [
    '- insert:',
    '    - id: tools',
    "      name: '@deepseek-ai/dsh-tool-bash'",
    '    - id: webserver',
    "      name: '@deepseek-ai/dsh-host-webserver'",
    '',
  ].join('\n'))

  putPackage(
    join(nested, '@deepseek-ai', 'dsh-app-boot'),
    '@deepseek-ai/dsh-app-boot',
    VERSION,
    'function init(patchReload) { if (!["live", "startup"].includes(patchReload)) throw new Error(\'patchReload must be "live" or "startup"\') }',
  )

  // Client side: SlotMap declarations carry the slot names and their kind.
  put(join(nested, '@deepseek-ai', 'dsh-client-ui-sidebar', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-client-ui-sidebar', version: VERSION, type: 'module',
  }, null, 2))
  put(
    join(nested, '@deepseek-ai', 'dsh-client-ui-sidebar', 'lib', 'types', 'client', 'contract', 'slots.d.ts'),
    [
      "declare module '@deepseek-ai/dsh-client-ui-slots' {",
      '    interface SlotMap {',
      "        'sidebar': {",
      "            kind: 'single';",
      "            scope: 'root';",
      '        };',
      "        'main': {",
      "            kind: 'keyed';",
      "            scope: 'root';",
      '        };',
      '    }',
      '}',
      '',
    ].join('\n'),
  )
  put(join(nested, '@deepseek-ai', 'dsh-client-ui-conversation', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-client-ui-conversation', version: VERSION, type: 'module',
  }, null, 2))
  put(
    join(nested, '@deepseek-ai', 'dsh-client-ui-conversation', 'lib', 'types', 'client', 'contract', 'slots.d.ts'),
    [
      "declare module '@deepseek-ai/dsh-client-ui-slots' {",
      '    interface SlotMap {',
      "        'conversation.session.header.actions': {",
      "            kind: 'list';",
      "            scope: 'session';",
      '        };',
      "        'conversation.hero.workspace': {",
      "            kind: 'single';",
      "            scope: 'root';",
      '        };',
      '    }',
      '}',
      '',
    ].join('\n'),
  )

  // A native module with a real darwin-arm64 prebuild, and one whose artifact
  // lives in a platform companion package (koffi → @koromix/koffi-<platform>).
  putPackage(join(nested, 'node-pty'), 'node-pty', '1.2.0-beta.15', '')
  put(join(nested, 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`, 'pty.node'), 'binary')
  putPackage(join(nested, 'koffi'), 'koffi', '3.2.1', '')
  put(join(nested, 'koffi', 'cnoke.cjs'), '// source build fallback')
  putPackage(join(nested, '@koromix', `koffi-${process.platform}-${process.arch}`), `@koromix/koffi-${process.platform}-${process.arch}`, '3.2.1', '')
  put(join(nested, '@koromix', `koffi-${process.platform}-${process.arch}`, `${process.platform}_${process.arch}`, 'koffi.node'), 'binary')

  // A package the farm links to (must exist in the candidate closure).
  putPackage(join(nested, 'commander'), 'commander', '15.0.0', '')
}

function buildHome() {
  const profileDir = join(HOME, 'profiles', 'web')
  put(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'], patchReload: 'live' } },
  }, null, 2))
  put(join(profileDir, 'cordis.patch.yml'), [
    '# user patch',
    '- insert:',
    '    - id: local-good',
    '      name: local-good',
    '      description: a well-behaved local plugin',
    '- insert:',
    '    - id: local-config',
    '      name: local-config',
    '      description: the blood case',
    '- id: hmr',
    '  disabled: false',
    '  config:',
    '    root:',
    '      - node_modules/local-good',
    '',
  ].join('\n'))

  // The blood case, read from disk: a local plugin that injects a service this
  // harness profile context does not provide. On 2026-09-10 this left the entry
  // `pending (waiting for service: config)` and app-boot failed the whole tree.
  putPackage(
    join(profileDir, 'node_modules', 'local-config'),
    'local-config',
    '1.0.0',
    "export const inject = ['config']\nexport function apply(ctx) { ctx.get('config') }\n",
  )
  putPackage(
    join(profileDir, 'node_modules', 'local-good'),
    'local-good',
    '1.0.0',
    "export const inject = ['tools']\nexport function apply(ctx) { void ctx }\n",
  )

  // Farm: one healthy link into the candidate closure.
  const farm = join(HOME, 'profiles', 'node_modules')
  mkdirSync(farm, { recursive: true })
  symlinkSync(join(CANDIDATE, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'commander'), join(farm, 'commander'), 'dir')
}

buildCandidate()
buildHome()

const candidate = scanContractTree(CANDIDATE, VERSION, { source: 'explicit' })
const local = scanLocalEnvironment({ dshHome: HOME, profile: 'web', installPrefix: CANDIDATE })
const NOW = new Date('2026-09-11T12:00:00.000Z')
const STAGING_OK = { ran: true, ok: true, logTail: 'booted' }
const STAGING_PLACEHOLDER = { ran: false, ok: false, logTail: 'not-implemented' }

/** Build a candidate variant from the scanned fixture. */
function candidateWith(patch) {
  return { ...candidate, ...patch }
}

/** Build a local variant from the scanned fixture. */
function localWith(patch) {
  return { ...local, ...patch }
}

/** Items for one rule. */
function itemsFor(report, rule) {
  return report.items.filter(entry => entry.rule === rule)
}

/** Run the engine over variants. */
function run(overrides = {}) {
  return runPreflight({
    version: VERSION,
    candidate,
    local,
    staging: STAGING_OK,
    now: NOW,
    id: 'pf-test',
    ...overrides,
  })
}

console.log(`\nFixture: ${ROOT}`)
console.log('\nScanner shape (candidate closure must come from the nested path, R3 C-3)')

check('candidate main package found', candidate.packages.some(pkg => pkg.name === '@deepseek-ai/dsh'))
check('nested dsh-base found (C-3)', candidate.packages.some(pkg => pkg.name === '@deepseek-ai/dsh-base'))
check('nested node-pty found', candidate.packages.some(pkg => pkg.name === 'node-pty'))
check('commander found (nested)', candidate.packages.some(pkg => pkg.name === 'commander'))
{
  const base = candidate.packages.find(pkg => pkg.name === '@deepseek-ai/dsh-base')
  check(
    'closure package came from the nested anchor, not the prefix top level (R3 C-3)',
    base !== undefined && base.dir.includes(`/@deepseek-ai/dsh/node_modules/`),
    base?.dir,
  )
  const topLevel = candidate.packages.filter(pkg => pkg.dir.includes('/lib/node_modules/') && !pkg.dir.includes('/@deepseek-ai/dsh/node_modules/'))
  check('prefix top level holds only the main package', topLevel.map(pkg => pkg.name).sort().join(',') === '@deepseek-ai/dsh', topLevel.map(pkg => pkg.name).join(','))
}
check('provided services read from super(ctx, name)', candidate.providedServices.has('webServer') && candidate.providedServices.has('sessions'))
check('required services read from inject arrays', candidate.requiredServices.has('tools'))
check('service `config` is NOT provided by the candidate', !candidate.services.has('config'))
checkEqual('main engines.node', candidate.enginesNode, '>=22')
check('slots read from SlotMap', candidate.slots.has('sidebar') && candidate.slots.has('conversation.session.header.actions'))
check('single slots read from kind: single', candidate.singleSlots.has('sidebar') && candidate.singleSlots.has('conversation.hero.workspace'))
check('connected client slot is not single', !candidate.singleSlots.has('conversation.session.header.actions'))
checkEqual('patchReload guard read from app-boot', candidate.supportedPatchReload, ['live', 'startup'])
checkEqual('candidate loader row ids come from bundle patches', [...candidate.loaderIds].sort(), ['tools', 'webserver'])

console.log('\nLocal scan')
checkEqual('local plugins found', local.plugins.map(plugin => plugin.name).sort(), ['local-config', 'local-good'])
checkEqual('blood-case plugin inject read from disk', local.plugins.find(plugin => plugin.name === 'local-config').inject, ['config'])
checkEqual('well-behaved plugin inject read from disk', local.plugins.find(plugin => plugin.name === 'local-good').inject, ['tools'])
checkEqual('patch insert names', [...(local.patch?.insertNames ?? [])].sort(), ['local-config', 'local-good'])
checkEqual('patch insert ids exclude the targeted override', [...(local.patch?.insertIds ?? [])].sort(), ['local-config', 'local-good'])
check('targeted override `hmr` is not an insert', (local.patch?.entries ?? []).some(entry => entry.id === 'hmr' && entry.insert === false))
checkEqual('profile manifest', local.manifest, { bundles: ['@deepseek-ai/dsh-base'], patchReload: 'live' })
checkEqual('farm has one healthy link', local.farm.crossGeneration.length, 1)
checkEqual('farm link target package', local.farm.crossGeneration[0]?.targetPackage, 'commander')

// --------------------------------------------------------------------------------------
// U-04 · R-01 … R-09
// --------------------------------------------------------------------------------------

console.log('\nU-04 R-01 Node engines')
{
  const ok = run()
  checkEqual('R-01 negative: >=22 on ' + process.version + ' is ok', itemsFor(ok, 'R-01').map(entry => entry.severity), ['ok'])
  const bad = run({ candidate: candidateWith({ enginesNode: '>=99' }) })
  const block = itemsFor(bad, 'R-01')
  checkEqual('R-01 positive: >=99 blocks', block.map(entry => entry.severity), ['block'])
  check('R-01 positive detail names both versions', block[0].detail.includes('>=99') && block[0].detail.includes(process.version.replace(/^v/, '')))
  const unknown = run({ candidate: candidateWith({ enginesNode: undefined }) })
  check('R-01 unknown: no declaration is ok + [unknown]', itemsFor(unknown, 'R-01')[0].detail.includes('[unknown]'))
}

console.log('\nU-04 R-02 native prebuild / ABI')
{
  const platform = `${process.platform}-${process.arch}`
  const ok = run()
  checkEqual('R-02 negative: node-pty has this platform prebuild', itemsFor(ok, 'R-02').filter(entry => entry.target === 'node-pty').map(entry => entry.severity), ['ok'])
  const warn = run({
    candidate: candidateWith({
      native: [{ name: 'node-pty', version: '1.2.0', prebuilds: [], sourceFallback: true, platformPackages: [] }],
    }),
  })
  checkEqual('R-02 positive: missing prebuild with source fallback warns', itemsFor(warn, 'R-02').map(entry => entry.severity), ['warn'])
  const blocked = run({
    candidate: candidateWith({
      native: [{ name: 'node-pty', version: '1.2.0', prebuilds: [], sourceFallback: false, platformPackages: [] }],
    }),
  })
  checkEqual('R-02 positive: missing prebuild with no fallback blocks', itemsFor(blocked, 'R-02').map(entry => entry.severity), ['block'])
  check('R-02 detail names the platform', itemsFor(blocked, 'R-02')[0].detail.includes(platform))
}

console.log('\nU-04 R-03 local host plugin inject — the real blood case')
{
  const report = run()
  const hits = itemsFor(report, 'R-03')
  const blood = hits.filter(entry => entry.target === 'local-config' && entry.severity === 'block')
  check('R-03 positive: local plugin injecting `config` blocks', blood.length === 1)
  check('R-03 detail names the missing service', blood[0]?.detail.includes('config'))
  check('R-03 detail quotes the real boot failure', blood[0]?.detail.includes('plugin tree failed to load'))
  check('R-03 block is fixable', blood[0]?.fixable === true && typeof blood[0]?.fix === 'string')
  check('R-03 does not blame the well-behaved plugin', !hits.some(entry => entry.target === 'local-good' && entry.severity === 'block'))
  checkEqual('R-03 positive verdict is blocked', report.verdict, 'blocked')

  const clean = run({ local: localWith({ plugins: local.plugins.filter(plugin => plugin.name !== 'local-config') }) })
  checkEqual('R-03 negative: only resolvable services is ok', itemsFor(clean, 'R-03').map(entry => entry.severity), ['ok'])
}

console.log('\nU-04 R-04 local client plugin package edges')
{
  const plugin = {
    name: 'local-ui', dir: '/tmp/local-ui', kind: 'directory', inject: [], injectDynamic: false,
    hasClient: true, clientInject: ['@deepseek-ai/dsh-client-ui-sidebar'], slots: [],
    singleSlotRegistrations: [], dependencies: {}, notes: [],
  }
  const ok = run({ local: localWith({ plugins: [plugin] }) })
  checkEqual('R-04 negative: resolvable client edge is ok', itemsFor(ok, 'R-04').map(entry => entry.severity), ['ok'])

  const missing = run({ local: localWith({ plugins: [{ ...plugin, clientInject: ['@deepseek-ai/dsh-client-ui-gone'] }] }) })
  checkEqual('R-04 positive: vanished package blocks', itemsFor(missing, 'R-04').map(entry => entry.severity), ['block'])

  const drift = run({
    local: localWith({
      plugins: [{ ...plugin, dependencies: { '@deepseek-ai/dsh-client-ui-sidebar': '^9.0.0' } }],
    }),
  })
  checkEqual('R-04 positive: unsatisfied range warns', itemsFor(drift, 'R-04').map(entry => entry.severity), ['warn'])
}

console.log('\nU-04 R-05 local client plugin slots')
{
  const plugin = {
    name: 'local-ui', dir: '/tmp/local-ui', kind: 'directory', inject: [], injectDynamic: false,
    hasClient: true, clientInject: [], slots: ['sidebar'], singleSlotRegistrations: [], dependencies: {}, notes: [],
  }
  const ok = run({ local: localWith({ plugins: [plugin] }) })
  checkEqual('R-05 negative: existing slot is ok', itemsFor(ok, 'R-05').map(entry => entry.severity), ['ok'])

  const removed = run({ local: localWith({ plugins: [{ ...plugin, slots: ['conversation.hero.workspace.gone'] }] }) })
  checkEqual('R-05 positive: removed slot warns', itemsFor(removed, 'R-05').map(entry => entry.severity), ['warn'])

  const shadow = run({ local: localWith({ plugins: [{ ...plugin, singleSlotRegistrations: ['sidebar'] }] }) })
  check(
    'R-05 positive: shadowing a single slot warns about the built-in occupant',
    itemsFor(shadow, 'R-05').some(entry => entry.severity === 'warn' && entry.detail.includes('替换内置占用者')),
  )
}

console.log('\nU-04 R-06 patch insert resolvability')
{
  const ok = run()
  checkEqual('R-06 negative: local insert names resolve', itemsFor(ok, 'R-06').map(entry => entry.severity), ['ok'])
  const blocked = run({ local: localWith({ patch: { ...local.patch, insertNames: ['@deepseek-ai/definitely-missing'] } }) })
  const hit = itemsFor(blocked, 'R-06')
  checkEqual('R-06 positive: unresolvable insert blocks', hit.map(entry => entry.severity), ['block'])
  check('R-06 block is fixable', hit[0].fixable === true && typeof hit[0].fix === 'string')
}

console.log('\nU-04 R-07 duplicate loader ids')
{
  const ok = run()
  checkEqual('R-07 negative: no collision', itemsFor(ok, 'R-07').map(entry => entry.severity), ['ok'])
  const blocked = run({ local: localWith({ patch: { ...local.patch, insertIds: ['tools'] } }) })
  checkEqual('R-07 positive: insert id colliding with a bundle row blocks', itemsFor(blocked, 'R-07').map(entry => entry.severity), ['block'])
  const dup = run({ local: localWith({ patch: { ...local.patch, insertIds: ['dup', 'dup'] } }) })
  checkEqual('R-07 positive: duplicate insert ids block', itemsFor(dup, 'R-07').map(entry => entry.severity), ['block'])
}

console.log('\nU-04 R-08 fallback farm generation')
{
  const ok = run()
  checkEqual('R-08 negative: healthy farm is ok', itemsFor(ok, 'R-08').map(entry => entry.severity), ['ok'])
  const cross = run({
    local: localWith({
      farm: { dir: '/tmp/farm', total: 1, crossGeneration: [{ path: '/tmp/farm/gone', name: 'gone', target: '/old/node_modules/gone', targetPackage: 'gone' }], dangling: [], pollution: [] },
    }),
  })
  checkEqual('R-08 positive: cross-generation link warns', itemsFor(cross, 'R-08').map(entry => entry.severity), ['warn'])
  const polluted = run({
    local: localWith({
      farm: { dir: '/tmp/farm', total: 1, crossGeneration: [], dangling: [], pollution: [{ path: '/tmp/farm/commander', name: 'commander', target: '(not-a-symlink)' }] },
    }),
  })
  const hit = itemsFor(polluted, 'R-08')
  checkEqual('R-08 positive: real directory in the farm blocks (R3 C-5)', hit.map(entry => entry.severity), ['block'])
  check('R-08 pollution detail cites the measured boot failure', hit[0].detail.includes('exists and is not a symlink'))
}

console.log('\nU-04 R-09 profile / manifest semantics')
{
  const ok = run()
  checkEqual('R-09 negative: live + known bundle is ok', itemsFor(ok, 'R-09').map(entry => entry.severity), ['ok'])
  const badReload = run({ local: localWith({ manifest: { bundles: ['@deepseek-ai/dsh-base'], patchReload: 'watch' } }) })
  checkEqual('R-09 positive: unsupported patchReload blocks', itemsFor(badReload, 'R-09').map(entry => entry.severity), ['block'])
  const badBundle = run({ local: localWith({ manifest: { bundles: ['@deepseek-ai/dsh-gone'], patchReload: 'live' } }) })
  checkEqual('R-09 positive: bundle absent from the candidate blocks', itemsFor(badBundle, 'R-09').map(entry => entry.severity), ['block'])
  const unknown = run({ candidate: candidateWith({ supportedPatchReload: undefined }) })
  check('R-09 unknown: unreadable guard warns with [unknown]', itemsFor(unknown, 'R-09')[0].detail.includes('[unknown]'))
}

// --------------------------------------------------------------------------------------
// U-05 · verdict aggregation
// --------------------------------------------------------------------------------------

console.log('\nU-05 verdict aggregation')
{
  const clean = run({
    local: localWith({
      plugins: local.plugins.filter(plugin => plugin.name !== 'local-config'),
      patch: { ...local.patch, insertNames: ['local-good'], insertIds: ['local-good'] },
    }),
    staging: STAGING_OK,
  })
  checkEqual('U-05 all-ok verdict', clean.verdict, 'ok')
  checkEqual('U-05 all-ok severities', [...new Set(clean.items.map(entry => entry.severity))], ['ok'])

  const warnOnly = run({
    local: localWith({
      plugins: local.plugins.filter(plugin => plugin.name !== 'local-config'),
      patch: { ...local.patch, insertNames: ['local-good'], insertIds: ['local-good'] },
    }),
    staging: STAGING_PLACEHOLDER,
  })
  checkEqual('U-05 warn-only verdict (shadow boot not run)', warnOnly.verdict, 'warn')

  const blocked = run()
  checkEqual('U-05 block wins', blocked.verdict, 'blocked')
  checkEqual('U-05 verdictOf is the pure aggregator', verdictOf(blocked.items), 'blocked')

  const staged = run({ staging: { ran: true, ok: false, logTail: 'ERR_MODULE_NOT_FOUND' } })
  checkEqual('U-05 failed shadow boot blocks', staged.verdict, 'blocked')
  check('U-05 staging block carries the log tail', itemsFor(staged, 'R-STAGING')[0].detail.includes('ERR_MODULE_NOT_FOUND'))
}

console.log('\nReport shape (remote-contract §1, verbatim)')
{
  const report = run()
  checkEqual('report keys', Object.keys(report).sort(), ['createdAt', 'id', 'items', 'staging', 'verdict', 'version'])
  checkEqual('staging keys', Object.keys(report.staging).sort(), ['logTail', 'ok', 'ran'])
  const itemKeys = [...new Set(report.items.flatMap(entry => Object.keys(entry)))].sort()
  checkEqual('item keys', itemKeys, ['detail', 'fix', 'fixable', 'rule', 'severity', 'target'])
  checkEqual('id echoed', report.id, 'pf-test')
  checkEqual('version echoed', report.version, VERSION)
  checkEqual('createdAt echoed', report.createdAt, NOW.toISOString())
  check('staging placeholder is honest', STAGING_PLACEHOLDER.ran === false && STAGING_PLACEHOLDER.logTail === 'not-implemented')
}

console.log('\nPatch parser and SemVer-range units')
{
  const parsed = parsePatchDocument([
    '- insert:',
    '    - id: a',
    '      name: pkg-a',
    '- id: override',
    '  disabled: true',
    '  config:',
    '    x: 1',
    '',
  ].join('\n'))
  checkEqual('parser: insert name', parsed.insertNames, ['pkg-a'])
  checkEqual('parser: insert id', parsed.insertIds, ['a'])
  check('parser: targeted override is not insert', parsed.entries.some(entry => entry.id === 'override' && entry.insert === false))
  check('parser: disabled flag', parsed.entries.find(entry => entry.id === 'override')?.disabled === true)

  const packument = { versions: { '0.1.5-rc.1': {}, '0.1.5-rc.2': {}, '0.2.0': {}, '0.1.4': {} } }
  checkEqual('range: caret prerelease picks the newest rc', maxSatisfying(packument, '^0.1.5-rc.1'), '0.1.5-rc.2')
  checkEqual('range: a prerelease does not leak into a release-only range (^0.1.4)', maxSatisfying(packument, '^0.1.4'), '0.1.4')
  checkEqual('range: tilde pins the minor (release-only)', maxSatisfying(packument, '~0.1.4'), '0.1.4')
  checkEqual('range: a release-only caret excludes prereleases', maxSatisfying(packument, '^0.1.5'), undefined)
  checkEqual('range: exact', maxSatisfying(packument, '0.2.0'), '0.2.0')
  check('range: prerelease does not leak across tuples', rangeSatisfies('0.1.6-rc.1', '^0.1.5-rc.1') === false)
  check('range: partial >= matches', rangeSatisfies('24.21.0', '>=22') === true)
  check('range: partial >= unsatisfied', rangeSatisfies('24.21.0', '>=99') === false)
  check('range: partial caret', rangeSatisfies('22.3.1', '^22') === true && rangeSatisfies('23.0.0', '^22') === false)
  check('range: partial <=', rangeSatisfies('22.9.0', '<=22') === true && rangeSatisfies('23.0.0', '<=22') === false)
}

console.log('\nService wiring: updateCenter.preflight is the real implementation (no network, cache hit)')
{
  // A fake "running" install (0.0.1) and a pre-populated candidate cache (9.9.9),
  // so the service resolves everything locally. `TMPDIR` is redirected into the
  // fixture so the default candidate cache cannot touch the shared temp dir.
  const runningPrefix = join(ROOT, 'running')
  putPackage(join(runningPrefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh'), '@deepseek-ai/dsh', '0.0.1', '', {
    engines: { node: '>=22' },
  })
  const svcTmp = join(ROOT, 'tmp')
  mkdirSync(svcTmp, { recursive: true })
  const cached = join(svcTmp, 'dsh-uc-candidates', '9.9.9', 'lib', 'node_modules')
  putPackage(join(cached, '@deepseek-ai', 'dsh'), '@deepseek-ai/dsh', '9.9.9', '', { engines: { node: '>=22' } })
  put(join(cached, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-base', version: '9.9.9', type: 'module',
  }, null, 2))
  put(join(cached, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-base', 'lib', 'index.js'),
    "export const inject = ['tools']\nclass W { constructor(ctx) { super(ctx, 'webServer') } }\n")

  const svcHome = join(ROOT, 'svc-home')
  put(join(svcHome, 'profiles', 'web', 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', dsh: { profile: { bundles: [], patchReload: 'live' } },
  }))
  put(join(svcHome, 'profiles', 'web', 'cordis.patch.yml'), '- insert:\n    - id: local-good\n      name: local-good\n')
  putPackage(join(svcHome, 'profiles', 'web', 'node_modules', 'local-good'), 'local-good', '1.0.0',
    "export const inject = ['tools']\n")

  const savedArgv1 = process.argv[1]
  const savedTmpdir = process.env.TMPDIR
  process.argv[1] = join(runningPrefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  process.env.TMPDIR = svcTmp
  try {
    // The real peer protocol extends Cordis' `Service`, so the service needs a
    // real Context (a `{ get() {} }` stub fails inside `Service`'s constructor).
    const { createRequire } = await import('node:module')
    const { pathToFileURL } = await import('node:url')
    const peerRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-typert-protocol'))
    const cordis = await import(pathToFileURL(peerRequire.resolve('@deepseek-ai/cordis')).href)
    const { UpdateCenter } = await import('../packages/perse-updater/lib/types/index.js')
    const service = new UpdateCenter(new cordis.Context(), { dshHome: svcHome })
    const report = await service.preflight({ version: '9.9.9' })
    checkEqual('service preflight returns the candidate version', report.version, '9.9.9')
    check('service preflight verdict is honest (staging not run -> warn)', report.verdict === 'warn', report.verdict)
    checkEqual('service preflight R-06 ok', report.items.filter(entry => entry.rule === 'R-06').map(entry => entry.severity), ['ok'])
    check('service preflight binds the report id', service.report(report.id)?.id === report.id)
    check('service report() returns undefined for an unknown id', service.report('nope') === undefined)

    for (const [label, version, reason] of [
      ['missing version', undefined, 'missing-version'],
      ['non-semver version', 'nope', 'invalid-version'],
      ['not-newer version', '0.0.1', 'not-newer'],
    ]) {
      let caught
      try {
        await service.preflight(version === undefined ? {} : { version })
      } catch (error) {
        caught = error
      }
      check(`service preflight refuses ${label} with update/bad-request`,
        caught !== undefined && caught.code === 'update/bad-request' && caught.details?.reason === reason,
        caught === undefined ? 'did not throw' : `${caught.code}/${caught.details?.reason}`)
    }
  } finally {
    process.argv[1] = savedArgv1
    if (savedTmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = savedTmpdir
  }
}

rmSync(ROOT, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)

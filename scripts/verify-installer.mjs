/**
 * WP6 acceptance: I-05 (versioned install), I-06 (symlink switch + `current.json`),
 * I-07 (farm cleanup), plus installer input validation and `apply` wiring.
 *
 * Everything lives under a sandbox root (`/tmp/dsh-uc-wp6` by default): a fake
 * runtime root, fake launcher symlinks, fake `current.json` paths, and fake
 * harness homes. The only real-environment access is **read-only** (the installed
 * `@deepseek-ai/dsh` is fetched from the registry into the sandbox, and the two
 * boot probes in I-07 run with `DSH_HOME` redirected into the sandbox). Neither
 * `~/.local/bin/dsh` nor `~/.dsh/runtime` is ever written.
 *
 * Usage:
 *   node scripts/verify-installer.mjs                # after `npm run build`
 *   UC_FRESH_INSTALL=1 node scripts/verify-installer.mjs   # force a fresh npm install
 *   UC_INSTALL_VERSION=0.1.5-rc.2 …                  # install a different exact version
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, lstatSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  assertUnder,
  binPathOf,
  cleanFarmPollution,
  collectAssertions,
  entryFromSymlink,
  installAndSwitch,
  installVersioned,
  readCurrent,
  scanFarmPollution,
  switchSymlink,
  writeCurrentAtomic,
  InstallerError,
} from '../packages/perse-updater/lib/types/installer/index.js'

const SANDBOX = process.env.UC_SANDBOX ?? '/tmp/dsh-uc-wp6'
const CACHE = join(SANDBOX, 'npm-cache')
const RUNTIME = join(SANDBOX, 'runtime')
const VERSION = process.env.UC_INSTALL_VERSION ?? '0.1.5-rc.1'
const OLD_VERSION = '0.1.4-rc.1'
const dshBin = process.env.UC_DSH_BIN ?? 'dsh'

// Keep the npm cache and the installed version between runs (they are the slow
// part); every scratch home/link is rebuilt under a fresh `work-*` directory.
mkdirSync(SANDBOX, { recursive: true })
for (const entry of readdirSync(SANDBOX)) {
  if (entry.startsWith('work-')) rmSync(join(SANDBOX, entry), { recursive: true, force: true })
}
// WP7's `apply` is a job: it writes state/jobs/current below `<dshHome>`. This
// script uses the sandbox root as that home so `join(home, 'runtime')` is the
// same runtime root the installer tests already use, so reset its state dir.
rmSync(join(SANDBOX, 'update-center'), { recursive: true, force: true })
const WORK = mkdtempSync(join(SANDBOX, 'work-'))

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

/** Assert JSON equality. */
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

/** Run an async fn and return either `{ value }` or `{ error }`. */
async function capture(fn) {
  try {
    return { value: await fn() }
  } catch (error) {
    return { error }
  }
}

/** Build a fake installed generation (manifest + launcher) under `root`. */
function fakeGeneration(root, version) {
  const pkgDir = join(root, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
  put(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version, type: 'module', main: 'lib/bin.js' }, null, 2) + '\n')
  put(join(pkgDir, 'lib', 'bin.js'), '// fake launcher\n')
  return { version, prefix: root, bin: join(pkgDir, 'lib', 'bin.js') }
}

/** Boot `dsh` with a redirected DSH_HOME and resolve when it exits. */
function bootProbe(home, budgetMs = 120000) {
  return new Promise(resolve => {
    const child = spawn(dshBin, ['--profile', 'web', '--port', '0', '--no-open'], {
      env: { ...process.env, DSH_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let sawUrl = false
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      resolve({ sawUrl, timedOut: true, code: null, out })
    }, budgetMs)
    const onData = chunk => {
      out += chunk
      if (!sawUrl && out.includes('http://127.0.0.1:')) {
        sawUrl = true
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 5000)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ sawUrl, timedOut: false, code, out })
    })
  })
}

/** The first `http://127.0.0.1:<port>` URL in a boot log. */
function firstUrl(text) {
  const match = /http:\/\/127\.0\.0\.1:\d+/.exec(text)
  return match === null ? '(none)' : match[0]
}

// ======================================================================================
// A. Validation — malformed version, empty/foreign whitelist, path escape
// ======================================================================================
console.log('\n# A. installer input validation')

const badVersion = await capture(() => installVersioned({ version: 'not-semver', runtimeRoot: RUNTIME, cacheDir: CACHE }))
check('non-semver version is refused with bad-request',
  badVersion.error instanceof InstallerError && badVersion.error.code === 'bad-request',
  badVersion.error === undefined ? 'did not throw' : `${badVersion.error.code}/${badVersion.error.reason}`)
check('refused install created no prefix', !existsSync(join(RUNTIME, 'not-semver')))

let pathEscape
try {
  assertUnder('/tmp/uc/runtime', '/tmp/uc/runtime-evil/x', 'targetPrefix')
} catch (error) {
  pathEscape = error
}
check('assertUnder rejects a sibling sharing the name prefix',
  pathEscape instanceof InstallerError && pathEscape.code === 'bad-request')
check('assertUnder accepts a real child', assertUnder('/tmp/uc/runtime', '/tmp/uc/runtime/1.2.3', 't') === '/tmp/uc/runtime/1.2.3')

const validationHome = join(WORK, 'validation-home')
const validationCurrent = join(validationHome, 'update-center', 'current.json')
const whitelistRefusal = await capture(() => installAndSwitch({
  version: VERSION,
  allowedVersions: ['9.9.9'],
  runtimeRoot: join(validationHome, 'runtime'),
  currentPath: validationCurrent,
  symlinkPath: join(validationHome, 'bin', 'dsh'),
  cacheDir: CACHE,
  farmDir: join(validationHome, 'profiles', 'node_modules'),
}))
check('a version outside the candidate whitelist is refused with bad-request',
  whitelistRefusal.error instanceof InstallerError && whitelistRefusal.error.code === 'bad-request',
  whitelistRefusal.error === undefined ? 'did not throw' : `${whitelistRefusal.error.code}/${whitelistRefusal.error.reason}`)
check('refused whitelist call created no current.json', !existsSync(validationCurrent))
check('refused whitelist call created no runtime prefix', !existsSync(join(validationHome, 'runtime', VERSION)))

// ======================================================================================
// B. I-05 — versioned install into a fake runtime root
// ======================================================================================
console.log(`\n# B. I-05 versioned install (@deepseek-ai/dsh@${VERSION} -> ${join(RUNTIME, VERSION)})`)

const installLog = []
const installStarted = Date.now()
const install = await installVersioned({
  version: VERSION,
  runtimeRoot: RUNTIME,
  cacheDir: CACHE,
  ...(process.env.UC_FRESH_INSTALL === '1' ? { forceReinstall: true } : {}),
  log: line => {
    installLog.push(line)
    console.log(`  · ${line}`)
  },
})
const installElapsed = Date.now() - installStarted
console.log(`  · npm command: ${install.command === '' ? '(reused existing install)' : install.command}`)
console.log(`  · prefix     : ${install.prefix}`)
console.log(`  · duration   : ${installElapsed} ms (npm: ${install.durationMs} ms, reused=${install.reused})`)
for (const assertion of install.assertions) {
  console.log(`  · assertion [${assertion.ok ? 'ok' : 'FAIL'}] ${assertion.id}: ${assertion.detail}`)
}

check('I-05 install landed in <runtimeRoot>/<version>', install.prefix === join(RUNTIME, VERSION), install.prefix)
checkEqual('I-05 installed manifest version', JSON.parse(readFileSync(join(install.packageDir, 'package.json'), 'utf8')).version, VERSION)
check('I-05 launcher entry exists', existsSync(install.bin), install.bin)
check('I-05 all native product assertions pass', install.assertions.every(entry => entry.ok),
  install.assertions.filter(entry => !entry.ok).map(entry => entry.id).join(', '))
check('I-05 spawn-helper is executable', install.assertions.find(entry => entry.id === 'spawn-helper')?.ok === true)
check('I-05 node-pty and koffi really require', install.assertions.find(entry => entry.id === 'require-native')?.ok === true)
if (!install.reused) {
  const command = install.command
  check('I-05 npm command uses --prefix <runtimeRoot>/<version>', command.includes(`--prefix ${install.prefix}`), command)
  check('I-05 npm command uses a sandbox --cache', command.includes(`--cache ${CACHE}`), command)
  check('I-05 npm command carries the C-8 allow-list',
    command.includes('--allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs'), command)
  check('I-05 npm command pins the exact version', command.includes(`@deepseek-ai/dsh@${VERSION}`), command)
}

// A second call must reuse, not reinstall (helper-protocol step 2 "若尚未安装").
const secondInstall = await installVersioned({ version: VERSION, runtimeRoot: RUNTIME, cacheDir: CACHE })
check('I-05 re-install of the same version is idempotent (reused)', secondInstall.reused === true)
check('I-05 reuse re-runs the product assertions', secondInstall.assertions.every(entry => entry.ok))

const again = await collectAssertions({ version: VERSION, prefix: install.prefix, nodeBin: process.execPath })
check('I-05 collectAssertions is exported and green', again.every(entry => entry.ok))

// ======================================================================================
// C. I-06 — symlink switch + current.json (previous before switch, I4)
// ======================================================================================
console.log('\n# C. I-06 symlink switch + current.json')

const switchHome = join(WORK, 'switch-home')
const switchCurrent = join(switchHome, 'update-center', 'current.json')
const fakeLocal = join(WORK, 'fake-local')
const switchLink = join(fakeLocal, 'bin', 'dsh')
const oldGeneration = fakeGeneration(join(WORK, 'old-generation'), OLD_VERSION)
mkdirSync(dirname(switchLink), { recursive: true })
symlinkSync(oldGeneration.bin, switchLink)

const preState = {
  active: oldGeneration,
  symlink: switchLink,
  patchBackup: join(switchHome, 'profiles', 'web', 'cordis.patch.yml.bak.20260911'),
  updatedAt: '2026-09-11T00:00:00.000Z',
}
await writeCurrentAtomic(switchCurrent, preState)

const orderLog = []
const switchFarm = join(switchHome, 'profiles', 'node_modules')
mkdirSync(switchFarm, { recursive: true })
symlinkSync(oldGeneration.prefix, join(switchFarm, 'koffi'))

const outcome = await installAndSwitch({
  version: VERSION,
  allowedVersions: [VERSION],
  runtimeRoot: RUNTIME,
  currentPath: switchCurrent,
  symlinkPath: switchLink,
  cacheDir: CACHE,
  farmDir: switchFarm,
  now: () => new Date('2026-09-11T10:00:00.000Z'),
  log: line => orderLog.push(line),
})
const record = await readCurrent(switchCurrent)

console.log(`  · readlink ${switchLink} -> ${readlinkSync(switchLink)}`)
console.log(`  · current.json:\n${JSON.stringify(record, null, 2).split('\n').map(line => `      ${line}`).join('\n')}`)

check('I-06 symlink points at the new absolute bin', readlinkSync(switchLink) === binPathOf(outcome.prefix), readlinkSync(switchLink))
check('I-06 symlink is a symlink', lstatSync(switchLink).isSymbolicLink())
checkEqual('I-06 current.json.active.version', record.active.version, VERSION)
checkEqual('I-06 current.json.active.bin', record.active.bin, binPathOf(outcome.prefix))
checkEqual('I-06 current.json.previous.version', record.previous?.version, OLD_VERSION)
checkEqual('I-06 current.json.symlink', record.symlink, switchLink)
checkEqual('I-06 patchBackup survives the switch', record.patchBackup, preState.patchBackup)
checkEqual('I-06 updatedAt is the injected clock', record.updatedAt, '2026-09-11T10:00:00.000Z')
checkEqual('I-06 entryFromSymlink reconstructs the new generation', entryFromSymlink(switchLink)?.version, VERSION)

const currentWriteIndex = orderLog.findIndex(line => line.includes('current.json write begin'))
const switchIndex = orderLog.findIndex(line => line.includes('switch begin'))
check('I-04 current.json is written before the symlink moves', currentWriteIndex >= 0 && switchIndex > currentWriteIndex,
  `current@${currentWriteIndex} switch@${switchIndex}`)
check('I-06 steps recorded install/current/switch/farm', JSON.stringify(outcome.steps.map(step => step.id)) === JSON.stringify(['install', 'current', 'switch', 'farm']))
check('I-06 S4b did not delete a normal symlink farm entry', existsSync(join(switchFarm, 'koffi')))
check('I-06 no-pollution farm reports self-heal', outcome.farm?.selfHeal === true)

// M-2 path: no current.json, previous is reconstructed from the live symlink.
const orphanLink = join(WORK, 'orphan-local', 'bin', 'dsh')
mkdirSync(dirname(orphanLink), { recursive: true })
symlinkSync(oldGeneration.bin, orphanLink)
const orphanCurrent = join(WORK, 'orphan-home', 'update-center', 'current.json')
const orphaned = await installAndSwitch({
  version: VERSION,
  allowedVersions: [VERSION],
  runtimeRoot: RUNTIME,
  currentPath: orphanCurrent,
  symlinkPath: orphanLink,
  cacheDir: CACHE,
  farmDir: join(WORK, 'orphan-home', 'profiles', 'node_modules'),
})
checkEqual('I-06 previous falls back to the live symlink when current.json is absent',
  (await readCurrent(orphanCurrent))?.previous?.version, OLD_VERSION)
checkEqual('I-06 orphan switch moved the symlink', readlinkSync(orphanLink), orphaned.bin)

// I8: a failed switch restores the record and leaves the running generation alone.
const blockedLink = join(WORK, 'blocked-local', 'bin', 'dsh')
mkdirSync(blockedLink, { recursive: true })
put(join(blockedLink, 'keep.txt'), 'not a symlink\n')
const blockedCurrent = join(WORK, 'blocked-home', 'update-center', 'current.json')
await writeCurrentAtomic(blockedCurrent, { active: oldGeneration, symlink: blockedLink, updatedAt: preState.updatedAt })
const blockedOutcome = await capture(() => installAndSwitch({
  version: VERSION,
  allowedVersions: [VERSION],
  runtimeRoot: RUNTIME,
  currentPath: blockedCurrent,
  symlinkPath: blockedLink,
  cacheDir: CACHE,
  farmDir: join(WORK, 'blocked-home', 'profiles', 'node_modules'),
}))
check('I-08 a non-symlink launcher path is refused with switch-failed',
  blockedOutcome.error instanceof InstallerError && blockedOutcome.error.code === 'switch-failed',
  blockedOutcome.error === undefined ? 'did not throw' : `${blockedOutcome.error.code}/${blockedOutcome.error.reason}`)
checkEqual('I-08 failed switch restores current.json.active', (await readCurrent(blockedCurrent))?.active.version, OLD_VERSION)
check('I-08 failed switch does not touch the occupying directory', existsSync(join(blockedLink, 'keep.txt')))

// switchSymlink direct contract.
const directLink = join(WORK, 'direct-local', 'bin', 'dsh')
const direct = await switchSymlink({ symlinkPath: directLink, target: binPathOf(outcome.prefix) })
check('I-06 switchSymlink creates the link and reports the command', direct.changed === true && direct.command.startsWith('ln -sfn '), direct.command)
check('I-06 switchSymlink is idempotent', (await switchSymlink({ symlinkPath: directLink, target: binPathOf(outcome.prefix) })).changed === false)

// ======================================================================================
// D. I-07 — farm pollution: detection, selective cleanup, real boot
// ======================================================================================
console.log('\n# D. I-07 farm cleanup (R3 C-5)')

const fixtureFarm = join(WORK, 'fixture-home', 'profiles', 'node_modules')
const realTarget = join(WORK, 'fixture-target')
mkdirSync(realTarget, { recursive: true })
mkdirSync(join(fixtureFarm, 'node-pty'), { recursive: true })
put(join(fixtureFarm, 'node-pty', 'package.json'), JSON.stringify({ name: 'node-pty', version: '0.0.0-fake' }) + '\n')
mkdirSync(join(fixtureFarm, '@deepseek-ai', 'dsh-app-boot'), { recursive: true })
put(join(fixtureFarm, '@deepseek-ai', 'dsh-app-boot', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-app-boot', version: '0.0.0-fake' }) + '\n')
put(join(fixtureFarm, 'stray-file'), 'not a package\n')
mkdirSync(join(fixtureFarm, 'dsh-managed-proxy'), { recursive: true })
put(join(fixtureFarm, 'dsh-managed-proxy', 'package.json'),
  JSON.stringify({ name: 'dsh-managed-proxy', version: '1.0.0', dsh: { moduleFallback: { targets: { '.': 'file:///x.js' } } } }) + '\n')
mkdirSync(join(fixtureFarm, '@deepseek-ai', 'dsh-base'), { recursive: true })
rmSync(join(fixtureFarm, '@deepseek-ai', 'dsh-base'), { recursive: true, force: true })
symlinkSync(join(realTarget, 'dsh-base'), join(fixtureFarm, '@deepseek-ai', 'dsh-base'))
symlinkSync(join(realTarget, 'koffi'), join(fixtureFarm, 'koffi'))

const fixtureScan = scanFarmPollution(fixtureFarm)
check('I-07 fixture: pollution is exactly the 3 non-symlink entries', fixtureScan.pollution.length === 3,
  fixtureScan.pollution.map(entry => entry.name).join(', '))
check('I-07 fixture: the dsh-managed module proxy is not pollution',
  fixtureScan.managedProxies.length === 1 && fixtureScan.managedProxies[0].name === 'dsh-managed-proxy')
check('I-07 fixture: both real symlinks are ignored', fixtureScan.total === 6, `total=${fixtureScan.total}`)

const fixtureCleanup = await cleanFarmPollution(fixtureFarm)
console.log(`  · cleanup removed: ${JSON.stringify(fixtureCleanup.removed.map(path => path.slice(fixtureFarm.length + 1)))}`)
check('I-07 cleanup removed exactly the 3 polluting entries', fixtureCleanup.removed.length === 3, String(fixtureCleanup.removed.length))
check('I-07 cleanup leaves 0 pollution', fixtureCleanup.pollutionAfter === 0)
check('I-07 cleanup kept the normal symlinks', lstatSync(join(fixtureFarm, 'koffi')).isSymbolicLink() &&
  lstatSync(join(fixtureFarm, '@deepseek-ai', 'dsh-base')).isSymbolicLink())
check('I-07 cleanup kept the dsh-managed module proxy', existsSync(join(fixtureFarm, 'dsh-managed-proxy', 'package.json')))

// A clean farm must be a no-op (C-5: normal generation change relies on boot self-heal).
const cleanFarmDir = join(WORK, 'clean-home', 'profiles', 'node_modules')
mkdirSync(cleanFarmDir, { recursive: true })
symlinkSync(join(realTarget, 'koffi'), join(cleanFarmDir, 'koffi'))
const cleanResult = await cleanFarmPollution(cleanFarmDir)
check('I-07 a normal farm is not touched', cleanResult.removed.length === 0 && cleanResult.selfHeal === true)
check('I-07 normal farm symlink survives', lstatSync(join(cleanFarmDir, 'koffi')).isSymbolicLink())

// Real boot: pollution makes boot exit 1; after cleanup it boots.
const bootHome = join(WORK, 'boot-home')
const bootFarm = join(bootHome, 'profiles', 'node_modules')
mkdirSync(join(bootFarm, 'node-pty'), { recursive: true })
put(join(bootFarm, 'node-pty', 'package.json'), JSON.stringify({ name: 'node-pty', version: '0.0.0-fake' }) + '\n')

console.log('  · booting a polluted farm (expect exit 1)...')
const pollutedBoot = await bootProbe(bootHome)
console.log(`  · polluted boot: exit=${pollutedBoot.code} sawUrl=${pollutedBoot.sawUrl}`)
console.log(pollutedBoot.out.split('\n').filter(line => line.includes('exists and is not a symlink')).map(line => `      ${line.trim()}`).join('\n'))
check('I-07 a polluting real directory makes a real boot fail',
  pollutedBoot.sawUrl === false && pollutedBoot.code === 1 && pollutedBoot.out.includes('exists and is not a symlink or dsh-managed module proxy'),
  `exit=${pollutedBoot.code} sawUrl=${pollutedBoot.sawUrl}`)

const bootCleanup = await cleanFarmPollution(bootFarm)
check('I-07 cleanup removed the boot-fatal directory', bootCleanup.removed.length === 1, String(bootCleanup.removed.length))

console.log('  · booting the cleaned farm (expect a reachable URL)...')
const cleanBoot = await bootProbe(bootHome)
console.log(`  · cleaned boot: exit=${cleanBoot.code} sawUrl=${cleanBoot.sawUrl} url=${firstUrl(cleanBoot.out)}`)
check('I-07 boot passes after cleanup', cleanBoot.sawUrl === true,
  cleanBoot.timedOut ? 'timed out' : `exit=${cleanBoot.code}`)

// ======================================================================================
// E. apply wiring through the real service (WP7 job semantics; all paths inside the sandbox)
// ======================================================================================
console.log('\n# E. updateCenter.apply wiring (WP7 job semantics)')

// WP7 made `apply` a job: the host validates and spawns a detached helper, then
// returns immediately; the helper runs install -> shadow boot -> switch. The
// helper re-derives the runtime root from `--home`, so this home must be the
// sandbox root (whose `runtime/` is the installer RUNTIME), and the launcher
// directory is passed through DSH_UC_LOCAL_BIN_DIR, derived from symlinkPath.
const serviceLink = join(WORK, 'service-local', 'bin', 'dsh')
mkdirSync(dirname(serviceLink), { recursive: true })
symlinkSync(oldGeneration.bin, serviceLink)

const { createRequire } = await import('node:module')
const { pathToFileURL } = await import('node:url')
const peerRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-typert-protocol'))
const cordis = await import(pathToFileURL(peerRequire.resolve('@deepseek-ai/cordis')).href)
const { UpdateCenter } = await import('../packages/perse-updater/lib/types/index.js')
const stateApi = await import('../packages/perse-updater/lib/types/state/index.js')
const servicePaths = stateApi.resolveStatePaths(SANDBOX)
const serviceCurrent = servicePaths.currentPath
const service = new UpdateCenter(new cordis.Context(), {
  dshHome: SANDBOX,
  installer: {
    runtimeRoot: RUNTIME,
    symlinkPath: serviceLink,
    cacheDir: CACHE,
    allowedVersions: [VERSION],
    cleanFarm: false,
    previous: oldGeneration,
  },
  helper: { port: 3080, profile: 'web' },
  recover: false,
})

/** Seed one already-completed preflight report, as `preflight` would. */
function seedReport(report) {
  service.preflightReports.put({
    id: report.id,
    version: report.version ?? VERSION,
    verdict: report.verdict ?? 'ok',
    items: report.items ?? [],
    staging: { ran: false, ok: false, logTail: 'seed' },
    createdAt: new Date('2026-09-11T09:00:00.000Z').toISOString(),
  })
}

/** Poll until the detached helper has driven the job to a terminal phase. */
async function waitForServicePhase(phases, budgetMs = 90000) {
  const until = Date.now() + budgetMs
  let last
  while (Date.now() < until) {
    last = await service.status()
    if (phases.includes(last.phase)) return last
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return last
}

seedReport({ id: 'report-ok' })
const appliedResult = await capture(() => service.apply({ reportId: 'report-ok', isolateBlocked: false }))
if (appliedResult.error !== undefined) console.log(`  · apply threw: ${appliedResult.error.code}/${appliedResult.error.details?.reason} ${appliedResult.error.message}`)
const applied = appliedResult.value
check('apply returns a job handle immediately', typeof applied?.jobId === 'string' && applied.jobId.length > 8, JSON.stringify(applied))
const jobRequest = applied === undefined ? undefined : JSON.parse(readFileSync(join(servicePaths.jobsDir, applied.jobId, 'request.json'), 'utf8'))
check('apply wrote request.json + state.json before returning',
  jobRequest?.action === 'apply' && jobRequest?.version === VERSION && existsSync(servicePaths.statePath),
  JSON.stringify(jobRequest))
const settled = await waitForServicePhase(['failed', 'switched', 'healthy', 'rolled-back', 'rollback-failed'])
check('the detached helper ran the job to a terminal phase', settled?.phase === 'failed', String(settled?.phase))
// C-11 is the hard requirement: the sandbox home has no profile, so the shadow
// boot cannot gather runtime evidence, and the symlink must not move.
check('C-11: an unverifiable shadow boot never moves the symlink', readlinkSync(serviceLink) === oldGeneration.bin, readlinkSync(serviceLink))
check('state.json settles at failed with the staging code',
  settled?.phase === 'failed' && settled?.error?.code === 'update/staging-failed', JSON.stringify(settled?.error))
const resultAfter = JSON.parse(readFileSync(join(servicePaths.jobsDir, applied.jobId, 'result.json'), 'utf8'))
check('result.json records the failed staging stage', resultAfter.error?.stage === 'staging', JSON.stringify(resultAfter.error))
check('apply consumes the report binding', service.report('report-ok') === undefined)

const unknownReport = await capture(() => service.apply({ reportId: 'nope', isolateBlocked: false }))
check('apply refuses an unknown reportId with update/bad-request',
  unknownReport.error?.code === 'update/bad-request' && unknownReport.error?.details?.reason === 'report-not-found',
  unknownReport.error === undefined ? 'did not throw' : `${unknownReport.error.code}/${unknownReport.error.details?.reason}`)

const missingReportId = await capture(() => service.apply({ isolateBlocked: false }))
check('apply refuses a missing reportId',
  missingReportId.error?.code === 'update/bad-request' && missingReportId.error?.details?.reason === 'missing-report-id')

seedReport({ id: 'report-blocked', version: VERSION, verdict: 'blocked', items: [{ rule: 'R-03', severity: 'block', target: 'x', detail: 'd', fixable: true }] })
const blockedApply = await capture(() => service.apply({ reportId: 'report-blocked', isolateBlocked: false }))
check('apply refuses un-consented block findings with update/blocked',
  blockedApply.error?.code === 'update/blocked' && JSON.stringify(blockedApply.error?.details?.rules) === JSON.stringify(['R-03']),
  blockedApply.error === undefined ? 'did not throw' : `${blockedApply.error.code}`)

seedReport({ id: 'report-foreign', version: '9.9.9' })
const foreignApply = await capture(() => service.apply({ reportId: 'report-foreign', isolateBlocked: true }))
check('apply refuses a version outside the candidate whitelist',
  foreignApply.error?.code === 'update/bad-request' && foreignApply.error?.details?.reason === 'not-a-candidate',
  foreignApply.error === undefined ? 'did not throw' : `${foreignApply.error.code}/${foreignApply.error.details?.reason}`)

// I1 has a durable half now: a live on-disk lock refuses a new job even when the
// in-memory guard is free (the helper is still running).
writeFileSync(servicePaths.lockPath, `${JSON.stringify({ pid: process.pid, jobId: 'lock-holder', startedAt: new Date().toISOString(), action: 'apply' })}\n`)
seedReport({ id: 'report-busy' })
const busyApply = await capture(() => service.apply({ reportId: 'report-busy', isolateBlocked: false }))
rmSync(servicePaths.lockPath, { force: true })
check('apply enforces single-flight (I1) through the on-disk lock',
  busyApply.error?.code === 'update/bad-request' && busyApply.error?.details?.reason === 'busy',
  busyApply.error === undefined ? 'did not throw' : `${busyApply.error.code}/${busyApply.error.details?.reason}`)

const statusAfter = await service.status()
const rollbackAfter = await capture(() => service.rollback())
check('status() rebuilds the failed job and rollback() refuses with no previous',
  statusAfter.phase === 'failed' && statusAfter.jobId === applied.jobId && rollbackAfter.error?.details?.reason === 'no-previous',
  JSON.stringify({ phase: statusAfter.phase, rollback: rollbackAfter.error?.details?.reason }))

// ======================================================================================
// summary
// ======================================================================================
const summary = {
  version: VERSION,
  prefix: install.prefix,
  npmCommand: install.command,
  reusedInstall: install.reused,
  installMs: install.durationMs,
  assertions: install.assertions,
  currentJson: await readCurrent(switchCurrent),
  symlink: { path: switchLink, target: readlinkSync(switchLink) },
  farm: { fixtureScan, fixtureCleanup: { removed: fixtureCleanup.removed, pollutionAfter: fixtureCleanup.pollutionAfter }, cleanResult },
  boot: { pollutedExit: pollutedBoot.code, pollutedSawUrl: pollutedBoot.sawUrl, cleanSawUrl: cleanBoot.sawUrl, cleanUrl: firstUrl(cleanBoot.out) },
  service: { current: await readCurrent(serviceCurrent), target: readlinkSync(serviceLink) },
}
put(join(SANDBOX, 'wp6-summary.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(`\nSUMMARY_JSON:${JSON.stringify(summary)}`)
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)

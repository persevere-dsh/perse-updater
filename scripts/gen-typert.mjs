/**
 * Reproducible Typert codegen (R1 §4.2 path A1 / Q2 ③-b).
 *
 * Calls the PUBLISHED `@deepseek-ai/dsh-typert-generator` directly instead of
 * the repo's tsdown plugin, so the build is self-contained and never touches the
 * harness checkout. The generator's own `validateExport()` runs on every pass:
 * it refuses to emit unless `exports["./typert"]` / `exports["./remote"]` and
 * `files[]` already match the exact paths it writes.
 *
 * Artifacts, exactly as `<repo>/packages/typert/generator/src/tsdown-plugin.ts#emitArtifacts`
 * names them, and only ever under `<pkg>/lib/` (never `src/`):
 *
 *   lib/typert.host.js
 *   lib/typert.host.d.ts
 *   lib/typert.remote-client.js
 *   lib/typert.remote-client.d.ts
 *   lib/typert.remote-client.d.ts.map
 *
 * Usage: node scripts/gen-typert.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FACES = ['host']
const EXPECTED_PACKAGES = ['perse-updater']

const generator = new WorkspaceTypertGenerator(root, {
  // `npm run build` runs `tsc -b tsconfig.host.json` first, which is exactly the
  // precondition the generator documents for checkDiagnostics: false. Keeping it
  // false here makes codegen independent of tsc's project-reference ordering.
  checkDiagnostics: false,
})

const discovered = generator.discover(FACES)
console.log('discovered:', JSON.stringify(discovered, null, 2))
const names = discovered.map(entry => entry.package)
for (const expected of EXPECTED_PACKAGES) {
  if (!names.includes(expected)) {
    throw new Error(`generator did not discover ${expected}; found ${JSON.stringify(names)}`)
  }
}
for (const extra of names) {
  if (!EXPECTED_PACKAGES.includes(extra)) {
    throw new Error(`generator discovered an unexpected package ${extra} in this workspace`)
  }
}

const artifacts = generator.generate(EXPECTED_PACKAGES, FACES)
const written = []
for (const artifact of artifacts) {
  const packageRoot = join(root, artifact.packageRoot)
  written.push(emit(packageRoot, `lib/typert.${artifact.face}.js`, artifact.js))
  written.push(emit(packageRoot, `lib/typert.${artifact.face}.d.ts`, artifact.dts))
  if (artifact.remote === undefined) {
    console.log(`note: ${artifact.package} emitted no Remote artifact (no @Remote methods?)`)
    continue
  }
  written.push(emit(packageRoot, 'lib/typert.remote-client.js', artifact.remote.js))
  written.push(emit(packageRoot, 'lib/typert.remote-client.d.ts', artifact.remote.dts))
  written.push(emit(packageRoot, 'lib/typert.remote-client.d.ts.map', artifact.remote.dtsMap))
}

console.log(`\nwrote ${written.length} artifact(s):`)
for (const file of written) console.log(`  ${relative(root, file)}`)

/** Write one artifact under the package root, creating `lib/` when it is absent. */
function emit(packageRoot, relativePath, content) {
  const target = join(packageRoot, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
  return target
}

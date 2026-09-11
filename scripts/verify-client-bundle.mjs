/**
 * WP2 unit-level verification of the hand-written client bundle.
 *
 * What this proves without a browser:
 *   1. `packages/perse-updater/client.js` is a `window.__ModuleLoader__.load`
 *      closure factory that registers the package id.
 *   2. Its `inject` names real client service names and does NOT name the
 *      namespace it mounts itself (`remote.updateCenter`) — the self-dependency
 *      that would park the plugin and fail the whole page's boot audit.
 *   3. `apply` mounts the typed-remote contribution synchronously
 *      (fire-and-forget) and registers exactly one `sidebar.footer.action` cell.
 *   4. The hand-written contribution is field-for-field equivalent to the
 *      generated `lib/typert.remote-client.js` on every runtime-relevant field,
 *      so the two faces cannot drift silently.
 *   5. The dictionaries are bilingual-balanced and cover every key named by
 *      `design/ux-spec.md`.
 *
 * Usage: node scripts/verify-client-bundle.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const clientPath = join(root, 'packages/perse-updater/client.js')
const generatedPath = join(root, 'packages/perse-updater/lib/typert.remote-client.js')

const results = []
/** Record one assertion outcome. */
function check(label, condition, detail = '') {
  results.push({ label, ok: Boolean(condition) })
  console.log(`${condition ? '  ok  ' : '  FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

// --- load the generated artifact (the wire truth) ----------------------------
const generated = await import(pathToFileURL(generatedPath).href)
const expected = generated.TYPERT_REMOTE

// --- load the hand-written bundle through the module-loader facade -----------
let registration
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      registration = value
    },
  },
}
const source = readFileSync(clientPath, 'utf8')
await import(`${pathToFileURL(clientPath).href}?cachebust=${Date.now()}`)

check('client bundle calls window.__ModuleLoader__.load', registration !== undefined)
check('bundle registers the package id', registration?.id === 'perse-updater', String(registration?.id))
check('bundle uses the closure-factory form', typeof registration?.factory === 'function')

const reactStub = {
  createElement: () => ({ type: 'stub' }),
  useState: (value) => [value, () => {}],
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
}
const primitivesStub = {
  Button: () => null,
  Modal: () => null,
  Tag: () => null,
  Tooltip: () => null,
  relativeTime: () => ({ unit: 'now', n: 0 }),
  IconRefreshOutline16: () => null,
  IconWarningOutline16: () => null,
}
const exportsObject = registration.factory((specifier) => (specifier === 'react' ? reactStub : primitivesStub))

check('bundle exports apply', typeof exportsObject.apply === 'function')
check('bundle exports inject', Array.isArray(exportsObject.inject), JSON.stringify(exportsObject.inject))
check(
  'inject uses the service names slots/locale/remote',
  JSON.stringify(exportsObject.inject) === JSON.stringify(['slots', 'locale', 'remote']),
  JSON.stringify(exportsObject.inject),
)
check(
  'inject does NOT declare the self-mounted remote.updateCenter namespace',
  !exportsObject.inject.includes('remote.updateCenter'),
  JSON.stringify(exportsObject.inject),
)

// --- drive apply against a recording fake context ----------------------------
const recorded = { mounts: [], registrations: [], dictionaries: [], effects: [] }
const fakeCtx = {
  get: () => undefined,
  effect(callback, label) {
    recorded.effects.push(label)
    return callback()
  },
  locale: {
    register(ns, dicts) {
      recorded.dictionaries.push({ ns, dicts })
      return () => {}
    },
  },
  slots: {
    inject(name, callback) {
      recorded.registrations.push({ slot: name, result: callback() })
      return () => {}
    },
    register(options, component) {
      return { options, component }
    },
  },
  remote: {
    $mount(contribution) {
      recorded.mounts.push(contribution)
      return Promise.resolve(() => {})
    },
  },
}

const applyReturn = exportsObject.apply(fakeCtx)
check('apply returns synchronously (never awaits $mount)', !(applyReturn instanceof Promise), typeof applyReturn)
check('apply mounts exactly one Remote contribution', recorded.mounts.length === 1, String(recorded.mounts.length))

const mounted = recorded.mounts[0]
check('mounted contribution names this package', mounted?.package === 'perse-updater', String(mounted?.package))

// --- drift check against the generated artifact ------------------------------
/** Project one descriptor onto its runtime-relevant fields. */
function runtimeFields(descriptor) {
  return {
    id: descriptor.id,
    service: descriptor.service,
    namespace: descriptor.namespace,
    method: descriptor.method,
    invocation: descriptor.invocation.kind,
    parameters: descriptor.parameters.map((parameter) => ({
      name: parameter.name,
      wire: parameter.wire,
      source: parameter.source,
      acceptsUndefined: parameter.acceptsUndefined === true,
      codecMode: parameter.codec.mode,
      typeSymbol: parameter.codec.typeSymbol,
    })),
    resultMode: descriptor.result.mode,
    resultTypeSymbol: descriptor.result.typeSymbol,
  }
}

const generatedFields = expected.descriptors.map(runtimeFields)
const mountedFields = (mounted?.descriptors ?? []).map(runtimeFields)
check(
  'hand-written descriptors equal the generated ones on every runtime field',
  JSON.stringify(mountedFields) === JSON.stringify(generatedFields),
  `mounted=${JSON.stringify(mountedFields)}\nexpected=${JSON.stringify(generatedFields)}`,
)
for (const descriptor of mounted?.descriptors ?? []) {
  check(
    `codec stub for ${descriptor.id} is mode-strict input-identity`,
    descriptor.parameters.every((parameter) => parameter.codec.mode === 'strict'
      && typeof parameter.codec.schema?.parse === 'function'
      && parameter.codec.schema.parse({ probe: true }).probe === true)
      && descriptor.result.mode === 'strict'
      && typeof descriptor.result.schema?.parse === 'function',
  )
}

// --- slot registration -------------------------------------------------------
check('apply registers into sidebar.footer.action', recorded.registrations.length === 1 && recorded.registrations[0].slot === 'sidebar.footer.action', JSON.stringify(recorded.registrations.map((row) => row.slot)))
const options = recorded.registrations[0]?.result?.options
check('slot id is update-center', options?.id === 'update-center', String(options?.id))
check('slot order is 0', options?.order === 0, String(options?.order))
check('slot declares the update-center locale namespace', options?.locale === 'update-center', String(options?.locale))
check('slot publishes a component function', typeof recorded.registrations[0]?.result?.component === 'function')
check(
  'slot inject face hands the component its ctx',
  options?.inject?.().ctx === fakeCtx,
  typeof options?.inject,
)

// --- dictionaries ------------------------------------------------------------
check('apply registers exactly one locale namespace', recorded.dictionaries.length === 1 && recorded.dictionaries[0].ns === 'update-center', JSON.stringify(recorded.dictionaries.map((row) => row.ns)))
const dicts = recorded.dictionaries[0]?.dicts ?? {}
const zhKeys = Object.keys(dicts.zh ?? {}).sort()
const enKeys = Object.keys(dicts.en ?? {}).sort()
check('dictionaries carry zh + en', zhKeys.length > 0 && enKeys.length > 0, `zh=${zhKeys.length} en=${enKeys.length}`)
check('zh and en key sets are identical (bilingual balance)', JSON.stringify(zhKeys) === JSON.stringify(enKeys))
const REQUIRED_KEYS = [
  'update.button.label',
  'update.button.tooltip',
  'update.button.dot',
  'update.list.title',
  'update.list.empty',
  'update.item.current',
  'update.item.prerelease',
  'update.action.check',
  'update.action.preflight',
  'update.warn.prerelease',
]
check(
  'dictionaries carry every ux-spec key prefix (update.button.tooltip.* counts as update.button.tooltip)',
  REQUIRED_KEYS.every((key) => (key === 'update.button.tooltip'
    ? Object.keys(dicts.zh).some((candidate) => candidate.startsWith('update.button.tooltip'))
    : key in dicts.zh && key in dicts.en)),
  JSON.stringify(REQUIRED_KEYS.filter((key) => !(key in dicts.zh))),
)

// --- source hygiene ----------------------------------------------------------
check('bundle never ESM-imports (classic-script safe)', !/^\s*import\s/m.test(source))
check('bundle only requires seed-table modules', [...source.matchAll(/require\((?:"|')([^"']+)/g)].every((match) => ['react', '@deepseek-ai/dsh-client-ui-primitives'].includes(match[1])), JSON.stringify([...source.matchAll(/require\((?:"|')([^"']+)/g)].map((match) => match[1])))
check('$mount is not awaited', !/await\s+ctx\.remote\.\$mount/.test(source))

const failed = results.filter((result) => !result.ok)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)

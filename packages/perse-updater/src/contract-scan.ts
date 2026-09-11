/**
 * Static contract surface scan for compatibility preflight (`design/preflight-rules.md` §2).
 *
 * Two scans live here and they are deliberately separate:
 *
 * 1. {@link scanContractTree} — the **candidate** version's *actual dependency
 *    resolution tree*. R3 C-3 measured that a `--prefix` install is nested:
 *    `<prefix>/lib/node_modules/@deepseek-ai/dsh/node_modules` holds the ~188
 *    dependency packages while the prefix top level holds only `dsh` itself.
 *    Reading the top level (or trusting the main package's own version number)
 *    would therefore miss the real contract surface, so this scanner walks every
 *    reachable `node_modules` below the anchors and records, per package, which
 *    Cordis services it provides/requires, which UI slots it declares, and which
 *    loader row ids its bundle patch creates.
 *
 * 2. {@link scanLocalEnvironment} — the **local** side: packages the profile's
 *    own `node_modules` holds that are not part of the running install tree, the
 *    names the user's `cordis.patch.yml` inserts, and the state of the
 *    `profiles/node_modules` fallback farm.
 *
 * Honest boundary (must stay visible in the report): this is a *textual* scan.
 * A service injected through a computed array, a slot name assembled at runtime,
 * or a service reached with `ctx.get('x')` without declaring `inject` is
 * invisible here. {@link CandidateContract.dynamicInject} and
 * {@link CandidateContract.dynamicSlots} mark the cases the scanner could see
 * were computed, and the rule engine turns a clean static scan into "may miss"
 * wording rather than a guarantee.
 *
 * @module perse-updater/contract-scan
 */

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { basename, join, sep } from 'node:path'

/** How a candidate tree root was obtained; recorded so the report can explain itself. */
export type CandidateTreeSource = 'live' | 'versioned-runtime' | 'registry-cache' | 'explicit'

/** One package found inside a candidate closure. */
export interface ScannedPackage {
  /** Package name from its manifest. */
  readonly name: string
  /** Installed version. */
  readonly version: string
  /** Absolute package directory. */
  readonly dir: string
  /** How many `node_modules` hops below the closure root the package sat; lower wins on a name clash. */
  readonly depth: number
}

/** Platform availability of one native module in the candidate closure. */
export interface NativeModuleReport {
  /** Package name, e.g. `node-pty`. */
  readonly name: string
  /** Installed version, or `(absent)` when the package is not in the tree at all. */
  readonly version: string
  /** Prebuild directories present for the running platform-arch, if any. */
  readonly prebuilds: readonly string[]
  /** Whether a source-build fallback (binding.gyp / cnoke) is present. */
  readonly sourceFallback: boolean
  /** Platform-specific companion package names that were found (koffi / sharp style). */
  readonly platformPackages: readonly string[]
}

/** The candidate version's contract surface, as far as static scanning can see it. */
export interface CandidateContract {
  /** Candidate version this scan describes. */
  readonly version: string
  /** Directory the scan started from. */
  readonly treeRoot: string
  /** How the root was obtained. */
  readonly source: CandidateTreeSource
  /** Every package reached, deduplicated by name (shallowest wins). */
  readonly packages: readonly ScannedPackage[]
  /** Package names, for O(1) resolvability checks. */
  readonly packageNames: ReadonlySet<string>
  /** Services the candidate itself registers (`super(ctx,'x')` / `.provide('x')`). */
  readonly providedServices: ReadonlySet<string>
  /** Services the candidate's own packages require via `inject = [...]`. */
  readonly requiredServices: ReadonlySet<string>
  /** {@link providedServices} ∪ {@link requiredServices}: the best static proxy for "exists at boot". */
  readonly services: ReadonlySet<string>
  /** UI slot names declared in `interface SlotMap` blocks. */
  readonly slots: ReadonlySet<string>
  /** Slots declared `kind: 'single'` — registering into one replaces its occupant. */
  readonly singleSlots: ReadonlySet<string>
  /** Loader row ids present in the candidate's bundle patches (insert rows and targets). */
  readonly loaderIds: ReadonlySet<string>
  /** Ids of rows the candidate's bundle patches **insert** (create). */
  readonly insertedLoaderIds: ReadonlySet<string>
  /** `engines.node` of the candidate main package, when declared. */
  readonly enginesNode?: string
  /** `engines.node` of each package, keyed by name, when declared. */
  readonly engines: ReadonlyMap<string, string>
  /** True when an `inject` expression was not a literal string array. */
  readonly dynamicInject: boolean
  /** True when a `SlotMap` member used a computed key. */
  readonly dynamicSlots: boolean
  /** `patchReload` values the candidate's app-boot accepts, when the guard could be read. */
  readonly supportedPatchReload?: readonly string[]
  /** Native modules relevant to R-02. */
  readonly native: readonly NativeModuleReport[]
  /** Human-readable scan caveats, always surfaced in the report. */
  readonly notes: readonly string[]
}

/** One local plugin the profile would still load after the update. */
export interface LocalPlugin {
  /** Package name (manifest `name`, else the directory name). */
  readonly name: string
  /** Absolute package directory. */
  readonly dir: string
  /** How the plugin sits in the profile: a real directory, or a link out of the install tree. */
  readonly kind: 'directory' | 'external-link'
  /** `inject` service names declared by the host half. */
  readonly inject: readonly string[]
  /** True when the host half's `inject` was not a literal string array. */
  readonly injectDynamic: boolean
  /** Whether the package exposes a browser half (`exports["./client"]`). */
  readonly hasClient: boolean
  /** `dsh.client.inject` package-name edges, when declared. */
  readonly clientInject: readonly string[]
  /** Slot names referenced by the browser half's source. */
  readonly slots: readonly string[]
  /** Slot names the browser half registers into a single occupant slot, if it can be told. */
  readonly singleSlotRegistrations: readonly string[]
  /** Declared dependency ranges, for R-04's "present but semantically changed" check. */
  readonly dependencies: Readonly<Record<string, string>>
  /** Scan caveats specific to this plugin. */
  readonly notes: readonly string[]
}

/** One entry in the user's `cordis.patch.yml`. */
export interface PatchEntry {
  /** Loader row id. */
  readonly id: string
  /** Package name when this entry inserts a new row. */
  readonly name?: string
  /** Whether the entry is inside an `insert:` list. */
  readonly insert: boolean
  /** Whether the entry declares `disabled:`. */
  readonly disabled?: boolean
}

/** A parsed `cordis.patch.yml` at the depth this preflight needs. */
export interface ParsedPatch {
  /** Every `- id:` entry, in file order. */
  readonly entries: readonly PatchEntry[]
  /** Names of inserted packages, in file order. */
  readonly insertNames: readonly string[]
  /** Ids of inserted rows, in file order. */
  readonly insertIds: readonly string[]
  /** Parse caveats (a line-driven parser cannot match a full YAML load). */
  readonly notes: readonly string[]
}

/** State of `$DSH_HOME/profiles/node_modules` (the module fallback farm). */
export interface FarmReport {
  /** Directory that was scanned, or `(absent)`. */
  readonly dir: string
  /** Total entries inspected, counting scoped children. */
  readonly total: number
  /** Links whose target package will not exist in the candidate install (R-08 warn). */
  readonly crossGeneration: readonly FarmLink[]
  /** Links whose target is already missing (R-08 warn). */
  readonly dangling: readonly FarmLink[]
  /** Entries that are not symlinks at all — boot exits 1 on these (R3 §6.2 / C-5). */
  readonly pollution: readonly FarmLink[]
}

/** One farm entry relevant to R-08. */
export interface FarmLink {
  /** Entry path. */
  readonly path: string
  /** Name the entry is mounted under. */
  readonly name: string
  /** Link target, or `(not-a-symlink)`. */
  readonly target: string
  /** Package name parsed out of the target, when possible. */
  readonly targetPackage?: string
}

/** The profile's `dsh.profile` block. */
export interface ProfileManifest {
  /** Bundle package names the profile composes, in order. */
  readonly bundles: readonly string[]
  /** `patchReload` value, when declared. */
  readonly patchReload?: string
}

/** Everything the rule engine needs to know about the machine being updated. */
export interface LocalEnvironment {
  /** Harness home (`$DSH_HOME` or `~/.dsh`). */
  readonly dshHome: string
  /** Profile name. */
  readonly profile: string
  /** Profile directory. */
  readonly profileDir: string
  /** Install prefix of the running harness. */
  readonly installPrefix: string
  /** Local plugins found in the profile's `node_modules`. */
  readonly plugins: readonly LocalPlugin[]
  /** Parsed user patch, or `undefined` when the file does not exist. */
  readonly patch?: ParsedPatch
  /** Absolute path of the user patch, when present. */
  readonly patchPath?: string
  /** The profile manifest. */
  readonly manifest: ProfileManifest
  /** Fallback-farm state. */
  readonly farm: FarmReport
  /** Scan caveats. */
  readonly notes: readonly string[]
}

/** Options of {@link scanContractTree}. */
export interface CandidateScanOptions {
  /** How the root was obtained. */
  readonly source?: CandidateTreeSource
  /** Safety cap on packages visited; default 900. */
  readonly maxPackages?: number
  /** Safety cap on one file read in bytes; default 1.5 MiB. */
  readonly maxFileBytes?: number
}

/** Options of {@link scanLocalEnvironment}. */
export interface LocalScanOptions {
  /** Harness home. */
  readonly dshHome: string
  /** Profile name. */
  readonly profile: string
  /** Running install prefix, used to tell a local plugin from a farm projection. */
  readonly installPrefix: string
  /** Safety cap on one file read in bytes; default 1.5 MiB. */
  readonly maxFileBytes?: number
}

/** Native packages R-02 cares about, by exact name. */
const NATIVE_EXACT = new Set([
  'node-pty',
  'koffi',
  'node-addon-landlock-run',
  'node-addon-system',
  'node-addon-require-builtin',
  'node-addon-native-custom-loader',
])

/** `package@version` of the main package, whose nested `node_modules` is the closure anchor (C-3). */
const DSH_PACKAGE = '@deepseek-ai/dsh'

/** One `inject` occurrence found in a host source file. */
interface InjectScan {
  /** Literal service names found. */
  readonly names: readonly string[]
  /** Whether a non-literal token appeared inside an array literal. */
  readonly dynamic: boolean
}

/**
 * Scan one candidate install tree.
 *
 * @param installRoot - a prefix (`…/runtime/<v>`, `…/.local`) or a bare `node_modules` directory.
 * @param version - candidate version, used for the report only.
 * @param options - caps and provenance.
 * @returns the statically visible contract surface.
 */
export function scanContractTree(
  installRoot: string,
  version: string,
  options: CandidateScanOptions = {},
): CandidateContract {
  const maxPackages = options.maxPackages ?? 900
  const maxFileBytes = options.maxFileBytes ?? 1_536_000
  const notes: string[] = []
  const packages = collectPackages(installRoot, maxPackages)
  if (packages.length === 0) {
    notes.push(`no packages found below ${installRoot}: the candidate closure is missing or unreadable`)
  }
  if (packages.length >= maxPackages) {
    notes.push(`package walk stopped at the ${maxPackages}-package cap; the surface may be incomplete`)
  }

  const providedServices = new Set<string>()
  const requiredServices = new Set<string>()
  const slots = new Set<string>()
  const singleSlots = new Set<string>()
  const loaderIds = new Set<string>()
  const insertedLoaderIds = new Set<string>()
  const engines = new Map<string, string>()
  let dynamicInject = false
  let dynamicSlots = false
  let filesRead = 0
  let filesSkipped = 0

  for (const pkg of packages) {
    const manifest = readJsonObject(join(pkg.dir, 'package.json'))
    const engine = typeof manifest?.['engines'] === 'object' && manifest['engines'] !== null
      ? (manifest['engines'] as Record<string, unknown>)['node']
      : undefined
    if (typeof engine === 'string' && engine !== '') engines.set(pkg.name, engine)

    // Bundle patch: every id a profile insert could collide with, plus the bundle's own insert names.
    const patchPath = join(pkg.dir, 'cordis.patch.yml')
    if (existsSync(patchPath)) {
      const parsed = parsePatchDocument(readTextFile(patchPath, maxFileBytes) ?? '')
      for (const entry of parsed.entries) loaderIds.add(entry.id)
      for (const id of parsed.insertIds) insertedLoaderIds.add(id)
      notes.push(...parsed.notes.map(note => `${pkg.name}: ${note}`))
    }

    for (const file of collectFiles(pkg.dir, { maxDepth: 5, extensions: ['.js'], skipSegments: ['node_modules', 'client'] })) {
      const text = readTextFile(file, maxFileBytes)
      if (text === undefined) {
        filesSkipped += 1
        continue
      }
      filesRead += 1
      // A bundle's bundled host code is one file; do not re-walk an enormous client payload.
      const scan = scanInjectOccurrences(text)
      for (const name of scan.names) requiredServices.add(name)
      if (scan.dynamic) dynamicInject = true
      for (const name of scanProvideOccurrences(text)) providedServices.add(name)
    }

    for (const file of collectFiles(pkg.dir, { maxDepth: 6, extensions: ['.d.ts'], skipSegments: ['node_modules'] })) {
      const text = readTextFile(file, maxFileBytes)
      if (text === undefined) continue
      const found = scanSlotMap(text)
      for (const name of found.slots) slots.add(name)
      for (const name of found.single) singleSlots.add(name)
      if (found.dynamic) dynamicSlots = true
    }
  }

  const services = new Set<string>([...providedServices, ...requiredServices])
  const main = packages.find(pkg => pkg.name === DSH_PACKAGE)
  const enginesNode = main === undefined ? undefined : engines.get(DSH_PACKAGE)
  const supportedPatchReload = scanSupportedPatchReload(packages, maxFileBytes)
  if (supportedPatchReload === undefined) {
    notes.push('could not read the candidate app-boot `patchReload` guard: manifest semantics are [unknown]')
  }
  if (filesSkipped > 0) notes.push(`${filesSkipped} file(s) exceeded the read cap and were skipped`)
  if (dynamicInject) {
    notes.push('a computed `inject` expression was seen: the required-service set may be incomplete')
  }
  if (dynamicSlots) notes.push('a computed SlotMap key was seen: the slot set may be incomplete')

  return {
    version,
    treeRoot: installRoot,
    source: options.source ?? 'explicit',
    packages,
    packageNames: new Set(packages.map(pkg => pkg.name)),
    providedServices,
    requiredServices,
    services,
    slots,
    singleSlots,
    loaderIds,
    insertedLoaderIds,
    ...(enginesNode === undefined ? {} : { enginesNode }),
    engines,
    dynamicInject,
    dynamicSlots,
    ...(supportedPatchReload === undefined ? {} : { supportedPatchReload }),
    native: scanNativeModules(packages),
    notes,
  }
}

/** Scan the machine's local side: local plugins, the user patch, the profile manifest, the farm. */
export function scanLocalEnvironment(options: LocalScanOptions): LocalEnvironment {
  const maxFileBytes = options.maxFileBytes ?? 1_536_000
  const profileDir = join(options.dshHome, 'profiles', options.profile)
  const notes: string[] = []
  const plugins: LocalPlugin[] = []
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const patch = existsSync(patchPath) ? parsePatchDocument(readTextFile(patchPath, maxFileBytes) ?? '') : undefined

  const profileModules = join(profileDir, 'node_modules')
  if (existsSync(profileModules)) {
    for (const entry of listPackageEntries(profileModules)) {
      const classification = classifyLocalEntry(entry.path, options.installPrefix)
      if (classification === 'system') continue
      plugins.push(scanLocalPlugin(entry.path, entry.name, classification, maxFileBytes))
    }
  } else {
    notes.push(`profile ${options.profile} has no node_modules directory`)
  }

  const manifest = readProfileManifest(join(profileDir, 'package.json'))

  return {
    dshHome: options.dshHome,
    profile: options.profile,
    profileDir,
    installPrefix: options.installPrefix,
    plugins,
    ...(patch === undefined ? {} : { patch }),
    ...(existsSync(patchPath) ? { patchPath } : {}),
    manifest,
    farm: scanFarm(join(options.dshHome, 'profiles', 'node_modules')),
    notes,
  }
}

/** Parse a `cordis.patch.yml` for the `id` / insert `name` structure preflight reasons about. */
export function parsePatchDocument(text: string): ParsedPatch {
  const notes: string[] = []
  const entries: PatchEntry[] = []
  const lines = text.split(/\r?\n/)
  /** Indent of the most recent `insert:` key that has not been closed by a sibling key. */
  let insertIndent = -1
  let current: { id: string; indent: number; inInsert: boolean; disabled?: boolean } | undefined

  const flush = (): void => {
    if (current === undefined) return
    entries.push({
      id: current.id,
      insert: current.inInsert,
      ...(current.disabled === undefined ? {} : { disabled: current.disabled }),
    })
    current = undefined
  }

  for (const raw of lines) {
    const withoutComment = stripYamlComment(raw)
    const trimmed = withoutComment.trim()
    if (trimmed === '') continue
    const indent = withoutComment.length - withoutComment.trimStart().length

    const insertMatch = /^(?:-\s*)?insert\s*:\s*$/.exec(trimmed)
    if (insertMatch !== null) {
      insertIndent = indent
      continue
    }

    const idMatch = /^-\s*id\s*:\s*(.+)$/.exec(trimmed)
    if (idMatch !== null) {
      flush()
      const id = unquote(idMatch[1] ?? '')
      current = { id, indent, inInsert: insertIndent >= 0 && indent > insertIndent }
      continue
    }
    const nameMatch = /^(?:-\s*)?name\s*:\s*(.+)$/.exec(trimmed)
    if (nameMatch !== null && current !== undefined) {
      const name = unquote(nameMatch[1] ?? '')
      entries.push({
        id: current.id,
        name,
        insert: current.inInsert,
        ...(current.disabled === undefined ? {} : { disabled: current.disabled }),
      })
      current = undefined
      continue
    }
    const disabledMatch = /^disabled\s*:\s*(true|false)\s*$/.exec(trimmed)
    if (disabledMatch !== null && current !== undefined) {
      current.disabled = disabledMatch[1] === 'true'
      continue
    }

    if (/^[A-Za-z_][\w-]*\s*:/.test(trimmed)) {
      // A sibling mapping key ends any open insert list at the same or lower indent.
      if (insertIndent >= 0 && indent <= insertIndent) insertIndent = -1
      continue
    }
  }
  flush()

  if (/!!js\b/.test(text)) {
    notes.push('patch contains `!!js` expressions, which this line-driven parser does not evaluate')
  }
  for (const entry of entries) {
    if (entry.insert && entry.name !== undefined && /[{}[\]*?]/.test(entry.name)) {
      notes.push(`insert name ${JSON.stringify(entry.name)} is not a plain package name`)
    }
  }
  const insertNames = entries.flatMap(entry => (entry.insert && entry.name !== undefined ? [entry.name] : []))
  const insertIds = entries.filter(entry => entry.insert).map(entry => entry.id)
  return { entries, insertNames, insertIds, notes }
}

// --------------------------------------------------------------------------------------
// candidate closure walk
// --------------------------------------------------------------------------------------

/**
 * Walk every reachable package of a prefix-installed closure.
 *
 * Anchors follow R3 C-3: `<root>/lib/node_modules` (the prefix top level) **and**
 * the nested `<root>/lib/node_modules/@deepseek-ai/dsh/node_modules` (the real
 * closure). Any `node_modules` below a discovered package is followed too, so a
 * transitive dependency that npm hoisted into a nested directory is not missed.
 */
function collectPackages(installRoot: string, maxPackages: number): ScannedPackage[] {
  const anchors = closureAnchors(installRoot)
  const byName = new Map<string, ScannedPackage>()
  const stack: Array<{ dir: string; depth: number }> = anchors.map(dir => ({ dir, depth: 0 }))
  const visited = new Set<string>()

  while (stack.length > 0 && byName.size < maxPackages) {
    const next = stack.pop()
    if (next === undefined) break
    if (visited.has(next.dir)) continue
    visited.add(next.dir)
    for (const entry of listPackageEntries(next.dir)) {
      const manifestPath = join(entry.path, 'package.json')
      const manifest = readJsonObject(manifestPath)
      const name = typeof manifest?.['name'] === 'string' ? (manifest['name'] as string) : entry.name
      const version = typeof manifest?.['version'] === 'string' ? (manifest['version'] as string) : '(unknown)'
      const existing = byName.get(name)
      if (existing === undefined || next.depth < existing.depth) {
        byName.set(name, { name, version, dir: entry.path, depth: next.depth })
      }
      const nested = join(entry.path, 'node_modules')
      if (existsSync(nested)) stack.push({ dir: nested, depth: next.depth + 1 })
    }
  }
  return [...byName.values()]
}

/** The `node_modules` directories a prefix install exposes, per R3 C-3. */
function closureAnchors(installRoot: string): string[] {
  const anchors: string[] = []
  if (basename(installRoot) === 'node_modules') {
    anchors.push(installRoot)
  } else {
    const lib = join(installRoot, 'lib', 'node_modules')
    const plain = join(installRoot, 'node_modules')
    if (existsSync(lib)) anchors.push(lib)
    else if (existsSync(plain)) anchors.push(plain)
    else anchors.push(lib)
  }
  for (const anchor of [...anchors]) {
    const nested = join(anchor, ...DSH_PACKAGE.split('/'), 'node_modules')
    if (existsSync(nested) && !anchors.includes(nested)) anchors.push(nested)
  }
  return anchors
}

/** One package directory entry (`a`, `b`, or `@scope/c`). */
interface PackageEntry {
  /** Directory name as mounted, e.g. `@scope/c`. */
  readonly name: string
  /** Absolute path. */
  readonly path: string
}

/** List package directories in one `node_modules`, expanding scopes one level. */
function listPackageEntries(nodeModulesDir: string): PackageEntry[] {
  const out: PackageEntry[] = []
  let entries: string[]
  try {
    entries = readdirSync(nodeModulesDir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry === '.bin' || entry === '.cache' || entry.startsWith('.')) continue
    const path = join(nodeModulesDir, entry)
    if (entry.startsWith('@')) {
      let inner: string[]
      try {
        inner = readdirSync(path)
      } catch {
        continue
      }
      for (const child of inner) {
        if (child.startsWith('.')) continue
        out.push({ name: `${entry}/${child}`, path: join(path, child) })
      }
      continue
    }
    out.push({ name: entry, path })
  }
  return out
}

// --------------------------------------------------------------------------------------
// textual scanners
// --------------------------------------------------------------------------------------

/** Find every `inject = [...]` / `exports.inject = [...]` occurrence in host source. */
export function scanInjectOccurrences(text: string): InjectScan {
  const names: string[] = []
  let dynamic = false
  const pattern = /(?:^|[^A-Za-z0-9_$])inject\s*[:=]\s*\[([\s\S]{0,4000}?)\]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const body = match[1] ?? ''
    for (const quoted of body.matchAll(/['"]([^'"]+)['"]/g)) {
      if (quoted[1] !== undefined) names.push(quoted[1])
    }
    const residue = body.replace(/['"][^'"]*['"]/g, '').replace(/[\s,]/g, '')
    if (residue !== '') dynamic = true
  }
  return { names, dynamic }
}

/** Find services a package registers: `super(ctx, 'x')` and `.provide('x'`. */
export function scanProvideOccurrences(text: string): string[] {
  const names: string[] = []
  for (const match of text.matchAll(/\bsuper\(\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*,\s*['"]([^'"]+)['"]/g)) {
    if (match[1] !== undefined) names.push(match[1])
  }
  for (const match of text.matchAll(/\.provide\(\s*['"]([^'"]+)['"]/g)) {
    if (match[1] !== undefined) names.push(match[1])
  }
  for (const match of text.matchAll(/\bctx\.set\(\s*['"]([^'"]+)['"]/g)) {
    if (match[1] !== undefined) names.push(match[1])
  }
  return names
}

/** Slots found in one `declare module … { interface SlotMap { … } }` block. */
export interface SlotScan {
  /** Every declared slot name. */
  readonly slots: readonly string[]
  /** Slots declared `kind: 'single'`. */
  readonly single: readonly string[]
  /** Whether a computed key was seen inside a SlotMap. */
  readonly dynamic: boolean
}

/** Extract slot names and their `kind` from a declaration file. */
export function scanSlotMap(text: string): SlotScan {
  const slots: string[] = []
  const single: string[] = []
  let dynamic = false
  const marker = /interface\s+SlotMap\s*\{/g
  let match: RegExpExecArray | null
  while ((match = marker.exec(text)) !== null) {
    const open = match.index + match[0].length - 1
    const close = matchBrace(text, open)
    if (close < 0) continue
    const body = text.slice(open + 1, close)
    // Each member starts with a quoted or bare key followed by `:` and a `{ … }` body.
    const member = /(?:^|\n)\s*(?:['"]([^'"]+)['"]|([A-Za-z_$][\w$]*))\s*:\s*\{/g
    let memberMatch: RegExpExecArray | null
    while ((memberMatch = member.exec(body)) !== null) {
      const name = memberMatch[1] ?? memberMatch[2]
      if (name === undefined) continue
      const memberOpen = memberMatch.index + memberMatch[0].length - 1
      const memberClose = matchBrace(body, memberOpen)
      const memberBody = memberClose < 0 ? body.slice(memberOpen + 1) : body.slice(memberOpen + 1, memberClose)
      slots.push(name)
      if (/kind\s*:\s*['"]single['"]/.test(memberBody)) single.push(name)
    }
    if (/\[\s*[A-Za-z_$][\w$]*\s*\]\s*:/.test(body)) dynamic = true
    marker.lastIndex = close
  }
  return { slots, single, dynamic }
}

/** Read the `patchReload must be "live" or "startup"` guard out of the candidate app-boot. */
function scanSupportedPatchReload(packages: readonly ScannedPackage[], maxFileBytes: number): readonly string[] | undefined {
  const appBoot = packages.find(pkg => pkg.name === '@deepseek-ai/dsh-app-boot')
  if (appBoot === undefined) return undefined
  for (const file of collectFiles(appBoot.dir, { maxDepth: 4, extensions: ['.js'], skipSegments: ['node_modules'] })) {
    const text = readTextFile(file, maxFileBytes)
    if (text === undefined) continue
    const guard = /patchReload\s+must\s+be\s+([^\n;]+)/.exec(text)
    if (guard === null) continue
    const values: string[] = []
    for (const quoted of guard[1]!.matchAll(/['"]([^'"]+)['"]/g)) {
      if (quoted[1] !== undefined) values.push(quoted[1])
    }
    if (values.length > 0) return values
  }
  return undefined
}

/** Measure native-module platform availability for R-02. */
function scanNativeModules(packages: readonly ScannedPackage[]): NativeModuleReport[] {
  const platform = `${process.platform}-${process.arch}`
  const names = new Set(packages.map(pkg => pkg.name))
  const out: NativeModuleReport[] = []
  for (const pkg of packages) {
    if (!isNativeRelevant(pkg.name, platform)) continue
    const prebuilds = listPrebuildDirs(pkg.dir, platform)
    // A platform binary package (koffi/sharp style) ships its `.node` at the
    // package root rather than under `prebuilds/`.
    if (prebuilds.length === 0 && containsNativeArtifact(pkg.dir)) prebuilds.push(`${pkg.dir}/(package root)`)
    const sourceFallback = existsSync(join(pkg.dir, 'binding.gyp')) || existsSync(join(pkg.dir, 'cnoke.cjs'))
    out.push({
      name: pkg.name,
      version: pkg.version,
      prebuilds,
      sourceFallback,
      platformPackages: companionsFor(pkg.name, platform, names),
    })
  }
  return out
}

/** Whether a package name falls into R-02's native set for the running platform. */
function isNativeRelevant(name: string, platform: string): boolean {
  // `node-addon-api` and the bare JS shims carry no artifact of their own.
  if (name === 'node-addon-api') return false
  if (NATIVE_EXACT.has(name)) return true
  if (name.startsWith('@koromix/koffi-') || name.startsWith('@img/sharp-')) return true
  if (name.startsWith('node-addon-') && name.endsWith(`-${platform}`)) return true
  return false
}

/** Platform-specific companion packages that satisfy one native module. */
function companionsFor(name: string, platform: string, names: ReadonlySet<string>): string[] {
  if (name === 'koffi') return [...names].filter(candidate => candidate === `@koromix/koffi-${platform}`)
  if (name === 'node-addon-require-builtin') {
    return [...names].filter(candidate => candidate === `node-addon-require-builtin-${platform}`)
  }
  if (name === 'node-addon-native-custom-loader') {
    return [...names].filter(candidate => candidate.startsWith('node-addon-') && candidate.endsWith(`-${platform}`))
  }
  return []
}

/** Whether a package directory holds a native artifact, at most two levels down. */
function containsNativeArtifact(dir: string, depth = 2): boolean {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return false
  }
  for (const entry of entries) {
    if (/\.(node|dylib|so|dll)$/.test(entry)) return true
    if (depth <= 0) continue
    const child = join(dir, entry)
    if (isDirectory(child) && containsNativeArtifact(child, depth - 1)) return true
  }
  return false
}

/** Prebuild directories under a package that match the running platform-arch. */
function listPrebuildDirs(packageDir: string, platform: string): string[] {
  const out: string[] = []
  const prebuildRoot = join(packageDir, 'prebuilds')
  if (existsSync(prebuildRoot)) {
    let entries: string[] = []
    try {
      entries = readdirSync(prebuildRoot)
    } catch {
      entries = []
    }
    for (const entry of entries) {
      const path = join(prebuildRoot, entry)
      if (!isDirectory(path)) continue
      // Either the directory is named for the platform, or it directly holds an artifact.
      if (entry === platform || entry.includes(platform) || entryHasArtifact(path)) out.push(path)
    }
  }
  const release = join(packageDir, 'build', 'Release')
  if (existsSync(release) && entryHasArtifact(release)) out.push(release)
  return out
}

/** Whether one directory directly contains a native artifact. */
function entryHasArtifact(dir: string): boolean {
  try {
    return readdirSync(dir).some(file => /\.(node|dylib|so|dll|exe)$/.test(file))
  } catch {
    return false
  }
}

// --------------------------------------------------------------------------------------
// local-side scan
// --------------------------------------------------------------------------------------

/** Classify a profile `node_modules` entry as a real local plugin or a system projection. */
function classifyLocalEntry(path: string, installPrefix: string): 'directory' | 'external-link' | 'system' {
  let link = false
  try {
    link = lstatSync(path).isSymbolicLink()
  } catch {
    return 'system'
  }
  if (!link) return 'directory'
  let target: string
  try {
    target = realpathSync.native(path)
  } catch {
    // A dangling link is not a local plugin either; it is farm trouble, reported by R-08.
    return 'system'
  }
  if (installPrefix !== '' && (target === installPrefix || target.startsWith(`${installPrefix}${sep}`))) return 'system'
  return 'external-link'
}

/** Read one local plugin's host and client contract surface. */
function scanLocalPlugin(
  dir: string,
  fallbackName: string,
  kind: 'directory' | 'external-link',
  maxFileBytes: number,
): LocalPlugin {
  const manifest = readJsonObject(join(dir, 'package.json'))
  const name = typeof manifest?.['name'] === 'string' ? (manifest['name'] as string) : fallbackName
  const dependencies: Record<string, string> = {}
  if (typeof manifest?.['dependencies'] === 'object' && manifest['dependencies'] !== null) {
    for (const [key, value] of Object.entries(manifest['dependencies'] as Record<string, unknown>)) {
      if (typeof value === 'string') dependencies[key] = value
    }
  }
  const dsh = typeof manifest?.['dsh'] === 'object' && manifest['dsh'] !== null
    ? (manifest['dsh'] as Record<string, unknown>)
    : undefined
  const client = dsh !== undefined && typeof dsh['client'] === 'object' && dsh['client'] !== null
    ? (dsh['client'] as Record<string, unknown>)
    : undefined
  const clientInject = Array.isArray(client?.['inject'])
    ? (client!['inject'] as unknown[]).filter((entry): entry is string => typeof entry === 'string')
    : []

  const notes: string[] = []
  const inject = new Set<string>()
  let injectDynamic = false
  for (const file of collectFiles(dir, { maxDepth: 4, extensions: ['.js', '.mjs', '.cjs'], skipSegments: ['node_modules', 'client'] })) {
    const text = readTextFile(file, maxFileBytes)
    if (text === undefined) continue
    const scan = scanInjectOccurrences(text)
    for (const service of scan.names) inject.add(service)
    if (scan.dynamic) injectDynamic = true
  }
  if (inject.size === 0 && !injectDynamic) {
    // Absence of an `inject` export is normal (a plugin may need no service), but
    // say so: a computed or re-exported inject is invisible to this scan.
    notes.push('no literal `inject` array found; a re-exported or computed inject would be invisible here')
  }

  const hasClient = exportsClient(manifest)
  const slots = new Set<string>()
  const singleSlotRegistrations = new Set<string>()
  if (hasClient) {
    for (const file of clientFiles(dir, manifest)) {
      const text = readTextFile(file, maxFileBytes)
      if (text === undefined) continue
      for (const slot of scanSlotRegistrations(text)) slots.add(slot)
      for (const slot of scanSingleRegistrations(text)) singleSlotRegistrations.add(slot)
    }
  }

  return {
    name,
    dir,
    kind,
    inject: [...inject],
    injectDynamic,
    hasClient,
    clientInject,
    slots: [...slots],
    singleSlotRegistrations: [...singleSlotRegistrations],
    dependencies,
    notes,
  }
}

/** Whether a manifest advertises a browser half. */
function exportsClient(manifest: Record<string, unknown> | undefined): boolean {
  const dsh = manifest !== undefined && typeof manifest['dsh'] === 'object' && manifest['dsh'] !== null
    ? (manifest['dsh'] as Record<string, unknown>)
    : undefined
  if (dsh !== undefined && typeof dsh['client'] === 'object' && dsh['client'] !== null) return true
  const exportsField = manifest?.['exports']
  if (typeof exportsField === 'object' && exportsField !== null) {
    return Object.prototype.hasOwnProperty.call(exportsField, './client')
  }
  return false
}

/** Candidate browser-half files: the `exports["./client"]` target plus conventional `lib/client.js`. */
function clientFiles(dir: string, manifest: Record<string, unknown> | undefined): string[] {
  const out = new Set<string>()
  const exportsField = manifest?.['exports']
  if (typeof exportsField === 'object' && exportsField !== null) {
    const entry = (exportsField as Record<string, unknown>)['./client']
    const target = typeof entry === 'string'
      ? entry
      : typeof entry === 'object' && entry !== null
        ? (entry as Record<string, unknown>)['default']
        : undefined
    if (typeof target === 'string' && target !== '') {
      const path = join(dir, target)
      if (existsSync(path)) out.add(path)
    }
  }
  for (const conventional of ['lib/client.js', 'client.js', 'dist/client.js']) {
    const path = join(dir, conventional)
    if (existsSync(path)) out.add(path)
  }
  return [...out]
}

/**
 * Slot names a browser half references.
 *
 * The plugin contract uses `ctx.slots.inject(name, …)` and
 * `register({ name, … })`; both are matched textually.
 */
export function scanSlotRegistrations(text: string): string[] {
  const names = new Set<string>()
  for (const match of text.matchAll(/\.slots\.inject\(\s*['"]([^'"]+)['"]/g)) {
    if (match[1] !== undefined && isSlotLike(match[1])) names.add(match[1])
  }
  for (const match of text.matchAll(/\bname\s*:\s*['"]([a-z][\w.]*\.[\w.]+)['"]/g)) {
    if (match[1] !== undefined) names.add(match[1])
  }
  for (const match of text.matchAll(/\brenderSlot(?:s)?\(\s*['"]([^'"]+)['"]/g)) {
    if (match[1] !== undefined && isSlotLike(match[1])) names.add(match[1])
  }
  for (const match of text.matchAll(/\bSLOT_[A-Z0-9_]+\s*=\s*['"]([^'"]+)['"]/g)) {
    if (match[1] !== undefined && isSlotLike(match[1])) names.add(match[1])
  }
  return [...names]
}

/** Slots a browser half replaces rather than appends to (heuristic: a non-positive `priority`). */
export function scanSingleRegistrations(text: string): string[] {
  const names = new Set<string>()
  for (const match of text.matchAll(/\bname\s*:\s*['"]([a-z][\w.]*\.[\w.]+)['"]([^}]{0,200})/g)) {
    const rest = match[2] ?? ''
    if (/priority\s*:\s*-\d/.test(rest)) names.add(match[1]!)
  }
  return [...names]
}

/** Whether a dotted string plausibly names a slot (kept loose on purpose; the caller cross-checks). */
function isSlotLike(value: string): boolean {
  return /^[a-z][\w-]*(\.[\w-]+)+$/.test(value)
}

/** Read `dsh.profile` out of the profile manifest. */
function readProfileManifest(path: string): ProfileManifest {
  const manifest = readJsonObject(path)
  const dsh = manifest !== undefined && typeof manifest['dsh'] === 'object' && manifest['dsh'] !== null
    ? (manifest['dsh'] as Record<string, unknown>)
    : undefined
  const profile = dsh !== undefined && typeof dsh['profile'] === 'object' && dsh['profile'] !== null
    ? (dsh['profile'] as Record<string, unknown>)
    : undefined
  const bundles = Array.isArray(profile?.['bundles'])
    ? (profile!['bundles'] as unknown[]).filter((entry): entry is string => typeof entry === 'string')
    : []
  const patchReload = typeof profile?.['patchReload'] === 'string' ? (profile!['patchReload'] as string) : undefined
  return { bundles, ...(patchReload === undefined ? {} : { patchReload }) }
}

/** Inspect the fallback farm for cross-generation links and pollution. */
function scanFarm(dir: string): FarmReport {
  if (!existsSync(dir)) return { dir: '(absent)', total: 0, crossGeneration: [], dangling: [], pollution: [] }
  const crossGeneration: FarmLink[] = []
  const dangling: FarmLink[] = []
  const pollution: FarmLink[] = []
  let total = 0
  for (const entry of listPackageEntries(dir)) {
    total += 1
    const link = describeFarmEntry(entry.path, entry.name)
    if (link.target === '(not-a-symlink)' || link.target === '(unreadable)') {
      if (link.target === '(not-a-symlink)') pollution.push(link)
      continue
    }
    if (!existsSync(entry.path)) {
      dangling.push(link)
      continue
    }
    // Every resolvable link carries a target generation; R-08 decides whether the
    // candidate still publishes that package.
    crossGeneration.push(link)
  }
  return { dir, total, crossGeneration, dangling, pollution }
}

/** Describe one farm entry without following it. */
function describeFarmEntry(path: string, name: string): FarmLink {
  let isLink = false
  try {
    isLink = lstatSync(path).isSymbolicLink()
  } catch {
    return { path, name, target: '(unreadable)' }
  }
  if (!isLink) return { path, name, target: '(not-a-symlink)' }
  let target = ''
  try {
    target = readlinkSync(path)
  } catch {
    target = ''
  }
  const targetPackage = packageNameFromPath(target)
  return { path, name, target, ...(targetPackage === undefined ? {} : { targetPackage }) }
}

/** Parse the package name out of an install path such as `…/node_modules/@scope/name`. */
export function packageNameFromPath(target: string): string | undefined {
  const parts = target.split(sep).filter(part => part !== '')
  const marker = parts.lastIndexOf('node_modules')
  if (marker < 0 || marker + 1 >= parts.length) return undefined
  const first = parts[marker + 1]!
  if (first.startsWith('@')) {
    const second = parts[marker + 2]
    return second === undefined ? first : `${first}/${second}`
  }
  return first
}

// --------------------------------------------------------------------------------------
// small filesystem helpers
// --------------------------------------------------------------------------------------

/** Recursively collect files with the given extensions below `dir`. */
function collectFiles(
  dir: string,
  options: { maxDepth: number; extensions: readonly string[]; skipSegments: readonly string[] },
): string[] {
  const out: string[] = []
  const stack: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }]
  while (stack.length > 0) {
    const next = stack.pop()!
    let entries: string[]
    try {
      entries = readdirSync(next.dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue
      const path = join(next.dir, entry)
      let isDir = false
      try {
        isDir = statSync(path).isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        if (options.skipSegments.includes(entry)) continue
        if (next.depth < options.maxDepth) stack.push({ dir: path, depth: next.depth + 1 })
        continue
      }
      if (options.extensions.some(extension => entry.endsWith(extension))) out.push(path)
    }
  }
  return out
}

/** Whether a path is a directory, swallowing errors. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Read a small text file, returning `undefined` past the cap or on error. */
function readTextFile(path: string, maxBytes: number): string | undefined {
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > maxBytes) return undefined
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Read a JSON object, returning `undefined` for anything else. */
function readJsonObject(path: string): Record<string, unknown> | undefined {
  const text = readTextFile(path, 4_000_000)
  if (text === undefined) return undefined
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    /* fall through */
  }
  return undefined
}

/** Find the `}` matching the `{` at `open`, or `-1`. */
function matchBrace(text: string, open: number): number {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/** Strip a trailing `#` comment, leaving quoted `#` characters alone. */
function stripYamlComment(line: string): string {
  let quote: string | undefined
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1] ?? ''))) return line.slice(0, index)
  }
  return line
}

/** Remove surrounding quotes from a YAML scalar. */
function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * Compatibility preflight rule engine (R-01 … R-09, `design/preflight-rules.md`).
 *
 * The engine is a pure function of a {@link PreflightInputs} snapshot: it never
 * touches the filesystem, so U-04/U-05 can drive every rule with fixtures. All
 * reading happens in `contract-scan.ts` and `candidate/tree.ts`; all booting
 * happens behind the `staging/verify.ts` seam.
 *
 * Two deliberate deviations from the prose rule table, both grounded in
 * `design/recon-corrections.md` (declared highest priority):
 *
 * - **R-07** compares only ids a profile **inserts** against the candidate's row
 *   ids. A profile entry that *targets* an existing id (e.g. `- id: hmr` with a
 *   new `config`) is the documented override mechanism and must never be called a
 *   duplicate — the naive "union of ids" reading would block every real profile.
 * - **R-08** keeps the design's `warn` for cross-generation and dangling links,
 *   but a fallback-farm entry that is a **real directory instead of a symlink**
 *   becomes `block`: R3 §6.2 measured that boot exits 1 on it (`exists and is not
 *   a symlink or dsh-managed module proxy`) with no self-healing (C-5).
 *
 * @module perse-updater/preflight
 */

import { randomUUID } from 'node:crypto'
import { rangeSatisfies } from '../candidate/tree.ts'
import type { CandidateContract, LocalEnvironment, NativeModuleReport } from '../contract-scan.ts'
import type { PreflightItem, PreflightReport, Severity, Verdict } from '../types.ts'
import type { StagingResult } from '../staging/verify.ts'

/** Everything the engine reasons over, already gathered. */
export interface PreflightInputs {
  /** Candidate version the report is for. */
  readonly version: string
  /** Candidate contract surface, or `undefined` when it could not be obtained. */
  readonly candidate?: CandidateContract
  /** Why the candidate surface is missing, when it is. */
  readonly candidateUnavailable?: string
  /** The machine's local side. */
  readonly local: LocalEnvironment
  /** Shadow-boot outcome (the WP5 seam). */
  readonly staging: StagingResult
  /** Report creation time; defaults to now. */
  readonly now?: Date
  /** Explicit report id; defaults to a random one. */
  readonly id?: string
}

/** Rule order used for the report; anything unknown sorts last. */
const RULE_ORDER = ['R-00', 'R-01', 'R-02', 'R-03', 'R-04', 'R-05', 'R-06', 'R-07', 'R-08', 'R-09', 'R-SCAN', 'R-STAGING']

/** Marker every "cannot be decided statically" detail carries. */
export const UNKNOWN_MARKER = '[unknown]'

/**
 * Run every rule and aggregate the verdict.
 *
 * @param inputs - the gathered snapshot.
 * @returns a contract-shaped report (`design/remote-contract.md` §1).
 */
export function runPreflight(inputs: PreflightInputs): PreflightReport {
  const items: PreflightItem[] = []
  const candidate = inputs.candidate

  if (candidate === undefined) {
    items.push(item('R-00', 'block', inputs.version,
      `${UNKNOWN_MARKER} 无法取得候选版本的依赖解析树，静态预检无法判定：${inputs.candidateUnavailable ?? 'unknown reason'}`,
      false))
  } else {
    items.push(...ruleR01(candidate))
    items.push(...ruleR02(candidate))
    items.push(...ruleR03(candidate, inputs.local))
    items.push(...ruleR04(candidate, inputs.local))
    items.push(...ruleR05(candidate, inputs.local))
    items.push(...ruleR06(candidate, inputs.local))
    items.push(...ruleR07(candidate, inputs.local))
    items.push(...ruleR08(candidate, inputs.local))
    items.push(...ruleR09(candidate, inputs.local))
  }
  items.push(...ruleScanBoundary(candidate, inputs.local))
  items.push(...ruleStaging(inputs.staging))

  items.sort((left, right) => ruleRank(left.rule) - ruleRank(right.rule))
  const createdAt = (inputs.now ?? new Date()).toISOString()
  return {
    id: inputs.id ?? `pf-${inputs.version}-${randomUUID().slice(0, 8)}`,
    version: inputs.version,
    verdict: verdictOf(items),
    items,
    staging: { ran: inputs.staging.ran, ok: inputs.staging.ok, logTail: inputs.staging.logTail },
    createdAt,
  }
}

/** R-01 — candidate `engines.node` versus the running Node. */
export function ruleR01(candidate: CandidateContract): PreflightItem[] {
  const range = candidate.enginesNode
  if (range === undefined) {
    return [item('R-01', 'ok', 'node',
      `${UNKNOWN_MARKER} 候选主包未声明 engines.node —— 无 Node 版本约束；静态扫描无法进一步判定`,
      false)]
  }
  const nodeVersion = process.version.replace(/^v/, '')
  const satisfied = rangeSatisfies(nodeVersion, range)
  if (satisfied === false) {
    return [item('R-01', 'block', 'node',
      `需要 Node ${range}，当前 ${nodeVersion} —— 更新后可能无法启动`,
      false)]
  }
  if (satisfied === undefined) {
    return [item('R-01', 'warn', 'node',
      `${UNKNOWN_MARKER} 无法解析 engines.node=${JSON.stringify(range)} 与当前 ${nodeVersion} 的关系`,
      false)]
  }
  return [item('R-01', 'ok', 'node', `Node ${nodeVersion} 满足 ${range}`, false)]
}

/** R-02 — native-module ABI / prebuild availability for this platform-arch. */
export function ruleR02(candidate: CandidateContract): PreflightItem[] {
  if (candidate.native.length === 0) {
    return [item('R-02', 'ok', 'native',
      `${UNKNOWN_MARKER} 候选闭包中未发现已知原生模块；若某包改为动态加载原生扩展，本规则会漏`,
      false)]
  }
  const platform = `${process.platform}-${process.arch}`
  const items: PreflightItem[] = []
  for (const native of candidate.native) {
    items.push(nativeItem(native, platform))
  }
  return items
}

/** One R-02 finding. */
function nativeItem(native: NativeModuleReport, platform: string): PreflightItem {
  const available = native.prebuilds.length > 0 || native.platformPackages.length > 0
  if (available) {
    const where = native.prebuilds.length > 0 ? native.prebuilds.join(', ') : native.platformPackages.join(', ')
    return item('R-02', 'ok', native.name, `${native.name}@${native.version} 有 ${platform} 预编译：${where}`, false)
  }
  if (native.sourceFallback) {
    return item('R-02', 'warn', native.name,
      `${native.name}@${native.version} 无 ${platform} prebuild，需本地编译（源码构建兜底存在）`,
      false)
  }
  return item('R-02', 'block', native.name,
    `${native.name}@${native.version} 无 ${platform} prebuild，且无源码构建兜底`,
    false)
}

/** R-03 — local host plugin `inject` services must exist in the candidate. */
export function ruleR03(candidate: CandidateContract, local: LocalEnvironment): PreflightItem[] {
  const items: PreflightItem[] = []
  for (const plugin of local.plugins) {
    const missing = plugin.inject.filter(service => !candidate.services.has(service))
    if (missing.length > 0) {
      items.push(item('R-03', 'block', plugin.name,
        `${plugin.name} 依赖服务 ${missing.join(', ')}，候选版本不提供 —— 更新后会导致整树失败（plugin tree failed to load: 1 entry did not activate）`,
        true, '禁用 cordis.patch.yml 中该 insert 段（先备份为 cordis.patch.yml.bak.<ts>）'))
    }
    if (plugin.injectDynamic) {
      items.push(item('R-03', 'warn', plugin.name,
        `${UNKNOWN_MARKER} ${plugin.name} 的 inject 不是字面量数组，静态扫描会漏掉它请求的服务`,
        false))
    }
  }
  if (candidate.dynamicInject) {
    items.push(item('R-03', 'warn', '(candidate)',
      `${UNKNOWN_MARKER} 候选闭包中存在非字面量 inject：候选服务集合可能不完整，R-03 可能出现误报`,
      false))
  }
  if (candidate.services.size === 0) {
    items.push(item('R-03', 'warn', '(candidate)',
      `${UNKNOWN_MARKER} 未能从候选闭包中提取任何服务名，R-03 的服务比对不可靠`,
      false))
  }
  if (items.length === 0) {
    items.push(item('R-03', 'ok', '(local plugins)',
      `本地 host 插件请求的服务均在候选服务集合内（检查 ${local.plugins.length} 个本地包）`, false))
  }
  return items
}

/** R-04 — local client plugin `dsh.client.inject` package edges. */
export function ruleR04(candidate: CandidateContract, local: LocalEnvironment): PreflightItem[] {
  const items: PreflightItem[] = []
  for (const plugin of local.plugins) {
    for (const dependency of plugin.clientInject) {
      if (!candidate.packageNames.has(dependency)) {
        items.push(item('R-04', 'block', plugin.name,
          `${plugin.name} 的客户端依赖 ${dependency} 在候选版本中整体消失 —— bundle 将加载失败`,
          false))
        continue
      }
      const range = plugin.dependencies[dependency]
      const installed = candidate.packages.find(pkg => pkg.name === dependency)?.version
      if (range !== undefined && installed !== undefined) {
        const satisfied = rangeSatisfies(installed, range)
        if (satisfied === false) {
          items.push(item('R-04', 'warn', plugin.name,
            `${plugin.name} 声明 ${dependency}@${range}，候选解析为 ${installed} —— 版本语义变化`,
            false))
        }
      }
    }
  }
  if (items.length === 0) {
    items.push(item('R-04', 'ok', '(local plugins)',
      `本地客户端插件的 dsh.client.inject 包边均可在候选闭包中解析`, false))
  }
  return items
}

/** R-05 — local client plugin slot usage against the candidate SlotMap. */
export function ruleR05(candidate: CandidateContract, local: LocalEnvironment): PreflightItem[] {
  const items: PreflightItem[] = []
  for (const plugin of local.plugins) {
    if (!plugin.hasClient) continue
    const removed = plugin.slots.filter(slot => !candidate.slots.has(slot))
    if (removed.length > 0) {
      items.push(item('R-05', 'warn', plugin.name,
        `${plugin.name} 使用候选版本已移除的 slot：${removed.join(', ')} —— 功能缺失（一般不致命）`,
        false))
    }
    const shadowed = plugin.singleSlotRegistrations.filter(slot => candidate.singleSlots.has(slot))
    if (shadowed.length > 0) {
      items.push(item('R-05', 'warn', plugin.name,
        `${plugin.name} 注册进 single slot：${shadowed.join(', ')} —— 会替换内置占用者，连带影响内置 UI`,
        false))
    }
  }
  if (items.length === 0) {
    items.push(item('R-05', 'ok', '(local plugins)',
      `本地客户端插件使用的 slot 均存在于候选 SlotMap（或本地无客户端插件）`, false))
  }
  return items
}

/** R-06 — every `cordis.patch.yml` insert name must be resolvable. */
export function ruleR06(candidate: CandidateContract, local: LocalEnvironment): PreflightItem[] {
  const names = local.patch?.insertNames ?? []
  if (names.length === 0) {
    return [item('R-06', 'ok', 'cordis.patch.yml', '用户 patch 未 insert 任何包', false)]
  }
  const resolvable = new Set<string>([...candidate.packageNames, ...local.plugins.map(plugin => plugin.name)])
  const items: PreflightItem[] = []
  for (const name of names) {
    if (resolvable.has(name)) continue
    items.push(item('R-06', 'block', name,
      `cordis.patch.yml insert 的 ${name} 在候选闭包与本地插件中都无法解析 —— 模块解析失败会终止整树`,
      true, '禁用 cordis.patch.yml 中该 insert 段（先备份为 cordis.patch.yml.bak.<ts>）'))
  }
  if (items.length === 0) {
    items.push(item('R-06', 'ok', 'cordis.patch.yml',
      `用户 patch 的 ${names.length} 个 insert 包名均可解析`, false))
  }
  return items
}

/** R-07 — profile inserts must not collide with candidate loader row ids. */
export function ruleR07(candidate: CandidateContract, local: LocalEnvironment): PreflightItem[] {
  const inserts = local.patch?.insertIds ?? []
  if (inserts.length === 0) {
    return [item('R-07', 'ok', 'loader ids', '用户 patch 未 insert 任何 loader 行', false)]
  }
  const items: PreflightItem[] = []
  const seen = new Set<string>()
  for (const id of inserts) {
    if (seen.has(id)) {
      items.push(item('R-07', 'block', id,
        `cordis.patch.yml 内重复的 insert id: ${id} —— duplicate loader entry id 会终止整树`,
        true, '删除重复的 insert 段'))
      continue
    }
    seen.add(id)
    if (candidate.loaderIds.has(id)) {
      items.push(item('R-07', 'block', id,
        `insert id ${id} 与候选 bundle 已有 loader 行 id 冲突 —— duplicate loader entry id 会终止整树`,
        true, '重命名该 insert 的 id，或删除该段'))
    }
  }
  if (items.length === 0) {
    items.push(item('R-07', 'ok', 'loader ids',
      `用户 patch 的 ${inserts.length} 个 insert id 与候选 ${candidate.loaderIds.size} 个行 id 无冲突（targeted override 不算重复）`,
      false))
  }
  return items
}

/** R-08 — fallback farm health across the generation switch. */
export function ruleR08(candidate: CandidateContract, local: LocalEnvironment): PreflightItem[] {
  const farm = local.farm
  const items: PreflightItem[] = []
  for (const link of farm.pollution) {
    items.push(item('R-08', 'block', link.name,
      `${link.path} 是真实目录而非软链 —— boot 会 exit 1（exists and is not a symlink or dsh-managed module proxy），需 S4b 清理`,
      true, '删除该目录，让 boot 重建农场软链'))
  }
  for (const link of farm.dangling) {
    items.push(item('R-08', 'warn', link.name,
      `农场链接目标不存在：${link.path} -> ${link.target}（更新后由清理步骤修复）`,
      true, 'S4b 按代清理死链'))
  }
  for (const link of farm.crossGeneration) {
    const target = link.targetPackage ?? link.name
    if (candidate.packageNames.has(target)) continue
    items.push(item('R-08', 'warn', link.name,
      `农场链接目标包 ${target} 在候选安装后不再存在：${link.target}（更新后由清理步骤修复）`,
      true, 'S4b 按代清理死链'))
  }
  if (items.length === 0) {
    items.push(item('R-08', 'ok', 'profiles/node_modules',
      `农场 ${farm.total} 条 entry 均健康，且目标包都在候选闭包内`, false))
  }
  return items
}

/** R-09 — profile manifest semantics against the candidate app-boot. */
export function ruleR09(candidate: CandidateContract, local: LocalEnvironment): PreflightItem[] {
  const items: PreflightItem[] = []
  const supported = candidate.supportedPatchReload
  const patchReload = local.manifest.patchReload
  if (patchReload !== undefined) {
    if (supported === undefined) {
      items.push(item('R-09', 'warn', 'patchReload',
        `${UNKNOWN_MARKER} 无法读取候选 app-boot 支持的 patchReload 取值；profile 使用 ${JSON.stringify(patchReload)}`,
        false))
    } else if (!supported.includes(patchReload)) {
      items.push(item('R-09', 'block', 'patchReload',
        `profile patchReload=${JSON.stringify(patchReload)} 不再受支持（候选仅接受 ${supported.join(' | ')}）`,
        false))
    }
  }
  for (const bundle of local.manifest.bundles) {
    if (candidate.packageNames.has(bundle)) continue
    items.push(item('R-09', 'block', bundle,
      `profile 声明的 bundle ${bundle} 不在候选闭包中 —— profile 无法合成`,
      false))
  }
  if (items.length === 0) {
    items.push(item('R-09', 'ok', 'profile manifest',
      `profile 字段（bundles=${local.manifest.bundles.length}，patchReload=${patchReload ?? '(继承默认)'}）在候选版本中语义不变`,
      false))
  }
  return items
}

/** Surface the static scan's blind spots; a clean scan is not a guarantee. */
export function ruleScanBoundary(candidate: CandidateContract | undefined, local: LocalEnvironment): PreflightItem[] {
  const notes: string[] = []
  if (candidate !== undefined) notes.push(...candidate.notes)
  notes.push(...local.notes)
  notes.push(...(local.patch?.notes ?? []))
  for (const plugin of local.plugins) notes.push(...plugin.notes.map(note => `${plugin.name}: ${note}`))
  const unique = [...new Set(notes)]
  if (unique.length === 0) {
    return [item('R-SCAN', 'ok', '(static scan)', '静态扫描未记录盲点', false)]
  }
  const blind = unique.some(note => /unknown|incomplete|skipped|exceeded|could not|dynamic|non-literal|未执行/i.test(note))
  return [item('R-SCAN', blind ? 'warn' : 'ok', '(static scan)',
    `${UNKNOWN_MARKER} 静态扫描边界：${unique.join(' | ')}`,
    false)]
}

/** Fold the shadow-boot outcome into the report, keeping its absence explicit. */
export function ruleStaging(staging: StagingResult): PreflightItem[] {
  if (staging.ran && !staging.ok) {
    return [item('R-STAGING', 'block', 'candidate',
      `影子启动失败 —— 静态预期的兼容性未被运行时证实：${tail(staging.logTail)}`,
      false)]
  }
  if (staging.ran) {
    return [item('R-STAGING', 'ok', 'candidate', '影子启动通过（运行时判定优先于静态预期）', false)]
  }
  return [item('R-STAGING', 'warn', 'candidate',
    `${UNKNOWN_MARKER} 影子启动未执行（WP5 待实现）：静态扫描会漏动态 inject 与运行时 ctx.get，结论可能偏乐观`,
    false)]
}

/** Aggregate a verdict from item severities. */
export function verdictOf(items: readonly PreflightItem[]): Verdict {
  if (items.some(entry => entry.severity === 'block')) return 'blocked'
  if (items.some(entry => entry.severity === 'warn')) return 'warn'
  return 'ok'
}

/** Build one item, omitting `fix` unless there is one. */
function item(
  rule: string,
  severity: Severity,
  target: string,
  detail: string,
  fixable: boolean,
  fix?: string,
): PreflightItem {
  return fix === undefined
    ? { rule, severity, target, detail, fixable }
    : { rule, severity, target, detail, fixable, fix }
}

/** Rank a rule for stable report ordering. */
function ruleRank(rule: string): number {
  const index = RULE_ORDER.indexOf(rule)
  return index < 0 ? RULE_ORDER.length : index
}

/** Last `max` characters of a log tail. */
function tail(text: string, max = 2000): string {
  return text.length > max ? text.slice(-max) : text
}

export type * from '../types.ts'
export { resolveCandidateTree, CandidateUnavailableError, type CandidateTree } from '../candidate/tree.ts'
export { scanContractTree, scanLocalEnvironment, parsePatchDocument } from '../contract-scan.ts'
export { verifyInStaging } from '../staging/verify.ts'

// perse-updater — the browser half (WP2).
//
// Hand-written client bundle, because the repository's `tsdown.client` preset is
// NOT published (recon/R1 §4.2) and this package lives outside the harness
// workspace. The format is the closure-factory one every shipped bundle uses:
//
//   window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
//
// Shared dependencies come from the shell's frozen seed table (PLATFORM_MODULES:
// react, react-dom, @deepseek-ai/cordis, @deepseek-ai/dsh-client-store,
// @deepseek-ai/dsh-client-ui-slots, @deepseek-ai/dsh-client-ui-primitives,
// @deepseek-ai/dsh-client-ui-dockkit); nothing else may be required, and no ESM
// `import` is legal here (the bundle is served as a classic script).
//
// Two faces:
//   · `TYPERT_REMOTE` — this package's typed-remote contribution, mounted on the
//     shared client Remote service so `remote.updateCenter.*` starts dispatching
//     `perse-updater#updateCenter/<method>` over `/api`.
//   · `UpdateEntry` — the sidebar footer action (`sidebar.footer.action`) and its
//     version panel (dialog semantics, Esc close, focus return), now with the WP4
//     preflight report face.
//
// WP4 (design/ux-spec.md §3): the version panel's "预检此版本" action calls
// `ctx.get('remote.updateCenter').preflight({version})` — lazy resolution, never an
// injected namespace (C-9) — and renders the `block → warn → ok` groups with the
// rule number, reason, fixability, and fix action per item, plus the shadow-boot
// result and its log entry point. When `verdict=blocked` the primary action becomes
// the two-stage D3 flow: "隔离上述项并更新" opens a SECOND confirmation that lists
// the segments to be disabled and the backup file name; cancelling either stage
// performs zero writes (acceptance UI-03). The second stage calls `apply` with
// `isolateBlocked:true`.
//
// WP8 (design/ux-spec.md §4/§5/§6, design/state-machine.md): both report actions now
// reach the real `apply`, which hands over to the **progress view**; every frame of
// it is rebuilt by polling `status()` (U-09), so a reload mid-job reconnects to the
// same view. `switched` shows the only restart affordance, 「重启并应用」, and it is
// strictly a user click (D4/I5). `failed` renders the §5 code copy plus a retry;
// `canRollback` enables the rollback button (second-stage confirm); a quarantined
// plugin list plus 「恢复插件配置」 calls `restorePatch()` and shows the real
// `status.patchBackup` path. The WP4 `inject` invariant is untouched (C-9).
//
// 实测坑（勿删 / measured, do not "fix"):
//   · `apply` must NOT await `ctx.remote.$mount(...)`. `$mount` completes through
//     the gateway's enqueue queue; awaiting it parks UI registration (R1 §3.2).
//   · `inject` must NOT name `remote.updateCenter`: that namespace is created by
//     THIS plugin's own `$mount`, so declaring it is a self-dependency — the boot
//     audit then reports `pending (waiting for service: remote.updateCenter)` and
//     the whole page shows "Failed to load plugins" (web/src/boot.ts
//     assertEntriesActive). The namespace is resolved at CALL time through
//     `ctx.get('remote.updateCenter')` instead. `remote` itself IS injected,
//     because `ctx.remote.$mount` is reached through it.
//   · Every `require(...)` specifier must be a seed-table word: a bundle is one
//     module node whose edges point only at table leaves (dsh-client-modules
//     "flat module graph by design").
//   · CSS is created in the factory body (materialization), not in `apply`:
//     `ClientModuleSystem.materialize()` calls `claimStyles(id)` immediately
//     after the factory returns, so a style injected later is claimed by the
//     NEXT module and would be removed by that module's HMR/teardown.
//
// The wire shape below mirrors the generated `lib/typert.remote-client.js`
// (WP1). The client never validates schemas — `validateContribution` only checks
// `codec.mode === 'strict'` and `parseInput` calls `codec.schema.parse(value)` —
// so the client codecs are identity stubs and the Host keeps the real zod
// schemas through `lib/typert.host.js`. `scripts/verify-client-bundle.mjs`
// re-derives the runtime descriptor fields from the generated artifact and fails
// on drift.

window.__ModuleLoader__.load({
	id: "perse-updater",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const {
			Button,
			Modal,
			Tag,
			Tooltip,
			relativeTime,
			IconRefreshOutline16,
			IconWarningOutline16,
		} = primitives;

		const LOG = "[perse-updater]";
		/** Dictionary namespace; also the `locale:` seat of the slot registration. */
		const NS = "update-center";
		/** Sidebar footer action slot (list, root scope; renders above `sidebar.settings`). */
		const SLOT = "sidebar.footer.action";
		/** Stable slot cell id — a fresh id adds a cell instead of replacing a shipped one. */
		const ENTRY_ID = "update-center";
		/** Owned style tag id (claimed by this module's client-modules record). */
		const STYLE_ID = "perse-updater-style";
		/** Client-side Cordis key of the namespace this plugin mounts itself. */
		const NAMESPACE_SERVICE = "remote.updateCenter";

		// ---- dictionaries (design/ux-spec.md key naming) -----------------------

		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"update.title": "版本更新",
			"update.current": "当前版本",
			"update.channel": "频道",
			"update.installPrefix": "安装位置",
			"update.fetchedAt": "版本源读取于 {time}",
			"update.button.label": "更新",
			"update.button.tooltip.unknown": "检查 DSH 更新",
			"update.button.tooltip.checking": "正在检查更新…",
			"update.button.tooltip.latest": "已是最新版本 v{version}",
			"update.button.tooltip.available": "有 {count} 个可用更新，最新为 v{version}",
			"update.button.tooltip.failed": "检查更新失败",
			"update.button.tooltip.running": "有更新作业进行中",
			"update.button.dot": "{count} 个可用更新",
			"update.button.dotFailed": "检查更新失败",
			"update.list.title": "可选版本（新 → 旧）",
			"update.list.empty": "没有比当前更新的版本",
			"update.item.current": "= 当前",
			"update.item.prerelease": "预发布",
			"update.item.distance": "较当前 {offset}",
			"update.item.published": "发布于 {time}",
			"update.action.check": "检查更新",
			"update.action.preflight": "预检此版本",
			"update.action.apply": "继续更新",
			"update.action.isolate": "隔离上述项并更新",
			"update.action.rollback": "回滚到上一版本",
			"update.action.rollbackPlaceholder": "回滚将在后续工作包中提供",
			"update.action.retry": "重试",
			"update.action.cancel": "取消",
			"update.action.close": "关闭",
			"update.warn.prerelease": "所选版本是预发布版本，仅建议在了解风险时更新。",
			"update.status.loading": "正在读取版本列表…",
			"update.status.checking": "正在检查更新…",
			"update.status.busy": "正在读取…",
			"update.error.registry-unreachable": "无法连接版本源（可能网络/代理问题）。",
			"update.error.bad-request": "请求无效（版本不在候选列表或预检已过期）。",
			"update.error.blocked": "存在会阻止启动的插件，需要你先确认处理方式。",
			"update.error.staging-failed": "影子验证未通过，已中止，环境未改动。",
			"update.error.install-failed": "新版本安装失败，已清理临时文件。",
			"update.error.switch-failed": "切换失败，已恢复原入口。",
			"update.error.health-check-failed": "新版本自检未通过，已自动回滚。",
			"update.error.rollback-failed": "回滚失败，请按文档手工恢复。",
			"update.error.namespace-missing": "更新服务尚未挂载完成，请稍后重试。",
			"update.error.unknown": "检查失败：{message}",
			"update.relative.now": "刚刚",
			"update.relative.minutes": "{n} 分钟前",
			"update.relative.hours": "{n} 小时前",
			"update.relative.days": "{n} 天前",
			"update.relative.months": "{n} 个月前",
			"update.relative.years": "{n} 年前",
			"update.a11y.panel": "版本更新面板",
			"update.a11y.report": "预检报告",
			"update.a11y.confirm": "隔离确认",
			"update.status.preflighting": "正在预检…",
			// ---- WP4 report / confirm / error actions (ux-spec.md §3 and §5) ----
			"update.report.title": "预检报告 · v{version}",
			"update.report.verdict.ok": "未发现兼容性问题",
			"update.report.verdict.warn": "有 {count} 项需要注意",
			"update.report.verdict.blocked": "有 {count} 项必须先处理",
			"update.report.group.block": "会阻止启动",
			"update.report.group.warn": "会缺失功能或需留意",
			"update.report.group.ok": "兼容",
			"update.report.group.heading": "{title}（{count}）",
			"update.report.fixable": "可自动修复",
			"update.report.unfixable": "需手工处理",
			"update.report.fix": "修复动作：{fix}",
			"update.report.expandOk": "展开全部兼容项",
			"update.report.collapseOk": "收起兼容项",
			"update.report.staging": "影子验证",
			"update.report.staging.passed": "通过",
			"update.report.staging.failed": "未通过",
			"update.report.staging.notRun": "未执行（结论可能偏乐观）",
			"update.report.log": "日志",
			"update.report.logEmpty": "（无日志）",
			"update.report.scrollHint": "↕ 内容较长，滚动查看全部",
			"update.report.back": "返回版本列表",
			"update.report.unfixableNote": "另有 {count} 项无法自动隔离，需先手工处理。",
			"update.report.nothingToIsolate": "没有可自动隔离的段落。",
			"update.report.applyPlaceholderNote": "更新执行、进度与回滚将在后续工作包中提供。",
			"update.report.progressPlaceholder": "作业 {jobId} 已提交；进度与回滚视图将在后续工作包中提供。",
			"update.confirm.title": "确认隔离并更新",
			"update.confirm.body": "更新前会先备份 cordis.patch.yml，然后只禁用下列段落；备份失败则不做任何改动，也不会继续（不变式 I6）。",
			"update.confirm.segments": "将被禁用的段落（{count}）",
			"update.confirm.segment": "{rule} · {target}",
			"update.confirm.backup": "备份文件",
			"update.confirm.backupName": "cordis.patch.yml.bak.<时间戳>",
			"update.confirm.backupNote": "时间戳在真正执行时生成。",
			"update.confirm.proceed": "确认隔离并更新",
			"update.confirm.applying": "正在提交…",
			"update.confirm.cancel": "取消",
			"update.errorAction.registry-unreachable": "重试；检查代理",
			"update.errorAction.bad-request": "重新预检",
			"update.errorAction.blocked": "查看报告",
			"update.errorAction.staging-failed": "查看日志",
			"update.errorAction.install-failed": "重试 / 换版本",
			"update.errorAction.switch-failed": "查看日志",
			"update.errorAction.health-check-failed": "查看日志",
			"update.errorAction.rollback-failed": "按文档手工恢复",
			"update.errorAction.namespace-missing": "稍后重试",
			"update.errorAction.unknown": "重试",
			// ---- WP8 progress view, user-confirmed restart, rollback, restore ----
			"update.progress.title": "更新进度",
			"update.progress.version": "目标版本 v{version}",
			"update.progress.phase": "当前阶段：{phase}",
			"update.progress.phaseText.idle": "待开始",
			"update.progress.phaseText.fetching": "获取版本",
			"update.progress.phaseText.ready": "准备就绪",
			"update.progress.phaseText.preflight": "静态预检",
			"update.progress.phaseText.blocked": "已被阻止",
			"update.progress.phaseText.installing": "安装中",
			"update.progress.phaseText.installed": "已安装",
			"update.progress.phaseText.isolating": "隔离中",
			"update.progress.phaseText.staging": "影子验证中",
			"update.progress.phaseText.staged": "影子验证完成",
			"update.progress.phaseText.switched": "已切换",
			"update.progress.phaseText.restarting": "正在重启",
			"update.progress.phaseText.health-checking": "正在自检",
			"update.progress.phaseText.healthy": "自检通过",
			"update.progress.phaseText.rolling-back": "正在回滚",
			"update.progress.phaseText.rolled-back": "已回滚",
			"update.progress.phaseText.rollback-failed": "回滚失败",
			"update.progress.phaseText.failed": "已失败",
			"update.progress.step.fetch": "获取版本",
			"update.progress.step.preflight": "预检",
			"update.progress.step.install": "安装",
			"update.progress.step.staging": "影子验证",
			"update.progress.step.isolate": "隔离（可选）",
			"update.progress.step.switch": "切换",
			"update.progress.step.restart": "等待你重启",
			"update.progress.step.health": "自检",
			"update.progress.state.pending": "待执行",
			"update.progress.state.running": "进行中",
			"update.progress.state.done": "完成",
			"update.progress.state.failed": "失败",
			"update.progress.waiting": "已切链到 v{version}，等待你点击「重启并应用」。",
			"update.progress.restartNote": "重启会断开当前页面，稍后自动重连；会话已落盘。",
			"update.progress.restarting": "正在重启并自检…",
			"update.progress.rollingBack": "正在回滚到上一版本…",
			"update.progress.healthy": "更新完成，v{version} 已通过自检。",
			"update.progress.rolledBack": "已回滚到上一版本。",
			"update.progress.rollbackFailed": "回滚失败：请按文档手工恢复（migration-plan §5）。",
			"update.progress.log": "作业日志",
			"update.progress.job": "作业 {jobId}",
			"update.progress.isolated": "被隔离的插件（{count}）",
			"update.progress.isolatedEmpty": "本次更新没有隔离任何插件。",
			"update.progress.restoreNote": "如需恢复这些插件，先点「恢复插件配置」还原备份，再重启。",
			"update.progress.patchBackup": "隔离备份文件",
			"update.progress.logEmpty": "（暂无日志）",
			"update.action.restart": "重启并应用",
			"update.action.restorePatch": "恢复插件配置",
			"update.confirm.rollback.title": "确认回滚",
			"update.confirm.rollback.body": "将把启动器切回 current.json 记录的上一版本，并恢复隔离前的插件配置；完成后会重启实例。",
			"update.confirm.restore.title": "确认恢复插件配置",
			"update.confirm.restore.body": "将用备份文件覆盖当前的 cordis.patch.yml，重新启用被隔离的插件。恢复后建议重启。",
			"update.confirm.restore.path": "备份文件",
			"update.confirm.proceed.rollback": "确认回滚",
			"update.confirm.proceed.restore": "确认恢复",
			"update.error.port-in-use": "重启前端口仍被占用，已在未切链的情况下中止。",
			"update.error.port-release": "等待旧进程释放端口超时。",
			"update.errorAction.port-in-use": "检查端口占用",
			"update.errorAction.port-release": "查看日志",
			"update.a11y.progress": "更新进度",
			"update.a11y.progressConfirm": "进度操作确认",
			// ---- T6 offline recovery panel ----
			"update.offline.title": "dsh 没有在预期时间内回来",
			"update.offline.body": "更新已切换，但重启后的实例一直没有应答。这个页面已经加载在你的浏览器里，下面的命令不需要服务器。",
			"update.offline.commandLabel": "在终端里运行",
			"update.offline.copy": "复制命令",
			"update.offline.copied": "已复制",
			"update.offline.versionLabel": "排查版本",
			"update.offline.logs": "日志目录：{path}",
			"update.offline.job": "作业目录：{dir}",
			"update.offline.retry": "重试连接",
			"update.offline.note": "若实例已经起来，点「重试连接」即可恢复，不需要刷新页面。",
		};

		/** English dictionary. */
		const en = {
			"update.title": "Version update",
			"update.current": "Current version",
			"update.channel": "Channel",
			"update.installPrefix": "Install location",
			"update.fetchedAt": "Version source read {time}",
			"update.button.label": "Update",
			"update.button.tooltip.unknown": "Check for DSH updates",
			"update.button.tooltip.checking": "Checking for updates…",
			"update.button.tooltip.latest": "Already on the latest version v{version}",
			"update.button.tooltip.available": "{count} update(s) available; newest is v{version}",
			"update.button.tooltip.failed": "Checking for updates failed",
			"update.button.tooltip.running": "An update job is running",
			"update.button.dot": "{count} updates available",
			"update.button.dotFailed": "Update check failed",
			"update.list.title": "Available versions (newest → oldest)",
			"update.list.empty": "No version newer than the current one",
			"update.item.current": "= current",
			"update.item.prerelease": "prerelease",
			"update.item.distance": "{offset} from current",
			"update.item.published": "published {time}",
			"update.action.check": "Check for updates",
			"update.action.preflight": "Preflight this version",
			"update.action.apply": "Continue update",
			"update.action.isolate": "Isolate the above and update",
			"update.action.rollback": "Roll back to the previous version",
			"update.action.rollbackPlaceholder": "Rollback arrives in a later work package",
			"update.action.retry": "Retry",
			"update.action.cancel": "Cancel",
			"update.action.close": "Close",
			"update.warn.prerelease": "The selected version is a prerelease; update only if you accept the risk.",
			"update.status.loading": "Reading the version list…",
			"update.status.checking": "Checking for updates…",
			"update.status.busy": "Reading…",
			"update.error.registry-unreachable": "Cannot reach the version source (network or proxy problem).",
			"update.error.bad-request": "Invalid request (version not in the candidate list, or the preflight expired).",
			"update.error.blocked": "A plugin would block startup; choose how to handle it first.",
			"update.error.staging-failed": "Shadow verification failed; aborted with no changes.",
			"update.error.install-failed": "Installing the new version failed; temporary files were cleaned up.",
			"update.error.switch-failed": "Switching failed; the previous entry point was restored.",
			"update.error.health-check-failed": "The new version failed its self-check and was rolled back.",
			"update.error.rollback-failed": "Rollback failed; restore manually using the documented procedure.",
			"update.error.namespace-missing": "The update service is not mounted yet; retry shortly.",
			"update.error.unknown": "Check failed: {message}",
			"update.relative.now": "just now",
			"update.relative.minutes": "{n} min ago",
			"update.relative.hours": "{n} h ago",
			"update.relative.days": "{n} d ago",
			"update.relative.months": "{n} mo ago",
			"update.relative.years": "{n} y ago",
			"update.a11y.panel": "Version update panel",
			"update.a11y.report": "Preflight report",
			"update.a11y.confirm": "Isolation confirmation",
			"update.status.preflighting": "Running preflight…",
			// ---- WP4 report / confirm / error actions (ux-spec.md §3 and §5) ----
			"update.report.title": "Preflight report · v{version}",
			"update.report.verdict.ok": "No compatibility problems found",
			"update.report.verdict.warn": "{count} item(s) need attention",
			"update.report.verdict.blocked": "{count} item(s) must be resolved first",
			"update.report.group.block": "Blocks startup",
			"update.report.group.warn": "Missing capability or worth attention",
			"update.report.group.ok": "Compatible",
			"update.report.group.heading": "{title} ({count})",
			"update.report.fixable": "Auto-fixable",
			"update.report.unfixable": "Needs a manual fix",
			"update.report.fix": "Fix: {fix}",
			"update.report.expandOk": "Show all compatible items",
			"update.report.collapseOk": "Hide compatible items",
			"update.report.staging": "Shadow verification",
			"update.report.staging.passed": "passed",
			"update.report.staging.failed": "failed",
			"update.report.staging.notRun": "not run (the verdict may be optimistic)",
			"update.report.log": "Log",
			"update.report.logEmpty": "(no log)",
			"update.report.scrollHint": "↕ More content — scroll to see it all",
			"update.report.back": "Back to versions",
			"update.report.unfixableNote": "{count} more item(s) cannot be isolated automatically and need a manual fix first.",
			"update.report.nothingToIsolate": "There is no segment that can be isolated automatically.",
			"update.report.applyPlaceholderNote": "Executing the update, progress, and rollback arrive in a later work package.",
			"update.report.progressPlaceholder": "Job {jobId} was submitted; the progress and rollback views arrive in a later work package.",
			"update.confirm.title": "Confirm isolation and update",
			"update.confirm.body": "Before updating, cordis.patch.yml is backed up and only the segments below are disabled. If the backup fails, nothing changes and the update does not continue (invariant I6).",
			"update.confirm.segments": "Segments that will be disabled ({count})",
			"update.confirm.segment": "{rule} · {target}",
			"update.confirm.backup": "Backup file",
			"update.confirm.backupName": "cordis.patch.yml.bak.<timestamp>",
			"update.confirm.backupNote": "The timestamp is generated when the update actually runs.",
			"update.confirm.proceed": "Isolate and update",
			"update.confirm.applying": "Submitting…",
			"update.confirm.cancel": "Cancel",
			"update.errorAction.registry-unreachable": "Retry; check the proxy",
			"update.errorAction.bad-request": "Run preflight again",
			"update.errorAction.blocked": "View the report",
			"update.errorAction.staging-failed": "Check the log",
			"update.errorAction.install-failed": "Retry / pick another version",
			"update.errorAction.switch-failed": "Check the log",
			"update.errorAction.health-check-failed": "Check the log",
			"update.errorAction.rollback-failed": "Restore manually using the documented procedure",
			"update.errorAction.namespace-missing": "Retry shortly",
			"update.errorAction.unknown": "Retry",
			// ---- WP8 progress view, user-confirmed restart, rollback, restore ----
			"update.progress.title": "Update progress",
			"update.progress.version": "Target version v{version}",
			"update.progress.phase": "Phase: {phase}",
			"update.progress.phaseText.idle": "Idle",
			"update.progress.phaseText.fetching": "Fetching versions",
			"update.progress.phaseText.ready": "Ready",
			"update.progress.phaseText.preflight": "Static preflight",
			"update.progress.phaseText.blocked": "Blocked",
			"update.progress.phaseText.installing": "Installing",
			"update.progress.phaseText.installed": "Installed",
			"update.progress.phaseText.isolating": "Isolating",
			"update.progress.phaseText.staging": "Shadow verification",
			"update.progress.phaseText.staged": "Shadow verified",
			"update.progress.phaseText.switched": "Switched",
			"update.progress.phaseText.restarting": "Restarting",
			"update.progress.phaseText.health-checking": "Self-checking",
			"update.progress.phaseText.healthy": "Self-check passed",
			"update.progress.phaseText.rolling-back": "Rolling back",
			"update.progress.phaseText.rolled-back": "Rolled back",
			"update.progress.phaseText.rollback-failed": "Rollback failed",
			"update.progress.phaseText.failed": "Failed",
			"update.progress.step.fetch": "Fetch versions",
			"update.progress.step.preflight": "Preflight",
			"update.progress.step.install": "Install",
			"update.progress.step.staging": "Shadow verification",
			"update.progress.step.isolate": "Isolate (optional)",
			"update.progress.step.switch": "Switch",
			"update.progress.step.restart": "Waiting for your restart",
			"update.progress.step.health": "Self-check",
			"update.progress.state.pending": "pending",
			"update.progress.state.running": "running",
			"update.progress.state.done": "done",
			"update.progress.state.failed": "failed",
			"update.progress.waiting": "Switched to v{version}; waiting for you to click “Restart and apply”.",
			"update.progress.restartNote": "Restarting disconnects this page; it reconnects on its own, and sessions are already on disk.",
			"update.progress.restarting": "Restarting and self-checking…",
			"update.progress.rollingBack": "Rolling back to the previous version…",
			"update.progress.healthy": "Update complete; v{version} passed its self-check.",
			"update.progress.rolledBack": "Rolled back to the previous version.",
			"update.progress.rollbackFailed": "Rollback failed: restore by hand (migration-plan §5).",
			"update.progress.log": "Job log",
			"update.progress.job": "Job {jobId}",
			"update.progress.isolated": "Isolated plugins ({count})",
			"update.progress.isolatedEmpty": "This update isolated no plugins.",
			"update.progress.restoreNote": "To bring these plugins back, click “Restore plugin configuration”, then restart.",
			"update.progress.patchBackup": "Isolation backup",
			"update.progress.logEmpty": "(no log yet)",
			"update.action.restart": "Restart and apply",
			"update.action.restorePatch": "Restore plugin configuration",
			"update.confirm.rollback.title": "Confirm rollback",
			"update.confirm.rollback.body": "The launcher returns to the previous version recorded in current.json and the pre-isolation plugin configuration is restored; the instance restarts afterwards.",
			"update.confirm.restore.title": "Confirm restoring the plugin configuration",
			"update.confirm.restore.body": "The backup overwrites the current cordis.patch.yml and re-enables the isolated plugins. A restart is recommended afterwards.",
			"update.confirm.restore.path": "Backup file",
			"update.confirm.proceed.rollback": "Roll back",
			"update.confirm.proceed.restore": "Restore",
			"update.error.port-in-use": "The port was still in use before the restart; the update stopped without switching the launcher.",
			"update.error.port-release": "Timed out waiting for the old process to release the port.",
			"update.errorAction.port-in-use": "Inspect the port",
			"update.errorAction.port-release": "Check the log",
			"update.a11y.progress": "Update progress",
			"update.a11y.progressConfirm": "Progress action confirmation",
			// ---- T6 offline recovery panel ----
			"update.offline.title": "dsh did not come back in time",
			"update.offline.body": "The update switched, but the restarted instance never answered. This page is already loaded in your browser, and the command below needs no server.",
			"update.offline.commandLabel": "Run this in a terminal",
			"update.offline.copy": "Copy command",
			"update.offline.copied": "Copied",
			"update.offline.versionLabel": "Version check",
			"update.offline.logs": "Logs: {path}",
			"update.offline.job": "Job directory: {dir}",
			"update.offline.retry": "Retry connection",
			"update.offline.note": "If the instance is already up, click “Retry connection” — no page reload needed.",
		};

		/** Error-code → dictionary key, exactly the map of design/ux-spec.md §5. */
		const ERROR_KEYS = {
			"update/registry-unreachable": "update.error.registry-unreachable",
			"update/bad-request": "update.error.bad-request",
			"update/blocked": "update.error.blocked",
			"update/staging-failed": "update.error.staging-failed",
			"update/install-failed": "update.error.install-failed",
			"update/switch-failed": "update.error.switch-failed",
			"update/health-check-failed": "update.error.health-check-failed",
			"update/rollback-failed": "update.error.rollback-failed",
			"update/port-in-use": "update.error.port-in-use",
			"update/port-release": "update.error.port-release",
			"update/namespace-missing": "update.error.namespace-missing",
		};

		/** Error-code → suggested-action key, the right column of design/ux-spec.md §5. */
		const ERROR_ACTION_KEYS = {
			"update/registry-unreachable": "update.errorAction.registry-unreachable",
			"update/bad-request": "update.errorAction.bad-request",
			"update/blocked": "update.errorAction.blocked",
			"update/staging-failed": "update.errorAction.staging-failed",
			"update/install-failed": "update.errorAction.install-failed",
			"update/switch-failed": "update.errorAction.switch-failed",
			"update/health-check-failed": "update.errorAction.health-check-failed",
			"update/rollback-failed": "update.errorAction.rollback-failed",
			"update/port-in-use": "update.errorAction.port-in-use",
			"update/port-release": "update.errorAction.port-release",
			"update/namespace-missing": "update.errorAction.namespace-missing",
		};

		// ---- preflight report (design/ux-spec.md §3) ---------------------------

		/** Group order is fixed by ux-spec §3: `block` → `warn` → `ok`. */
		const GROUP_ORDER = ["block", "warn", "ok"];
		/** Severity → group heading key. */
		const GROUP_KEYS = {
			block: "update.report.group.block",
			warn: "update.report.group.warn",
			ok: "update.report.group.ok",
		};
		/** Severity → leading mark (ux-spec §3 shows ✖ / ⚠ / ✔). */
		const GROUP_MARKS = { block: "✖", warn: "⚠", ok: "✔" };
		/** Severity → `Tag` tone. */
		const GROUP_TONES = { block: "danger", warn: "warning", ok: "success" };
		/** Verdict → headline key; a verdict outside the contract degrades to `warn`. */
		const VERDICT_KEYS = {
			ok: "update.report.verdict.ok",
			warn: "update.report.verdict.warn",
			blocked: "update.report.verdict.blocked",
		};

		/** Report items, defensively normalized to objects. */
		function reportItems(report) {
			return (Array.isArray(report?.items) ? report.items : []).filter(
				(item) => item !== null && typeof item === "object",
			);
		}

		/** Bucket items into `block` / `warn` / `ok`; an unknown severity counts as `ok`. */
		function groupItems(report) {
			const groups = { block: [], warn: [], ok: [] };
			for (const item of reportItems(report)) {
				const severity = item.severity === "block" || item.severity === "warn" ? item.severity : "ok";
				groups[severity].push(item);
			}
			return groups;
		}

		/**
		 * The `block` findings a confirmed isolation may disable.
		 *
		 * design/preflight-rules.md §4: only `fixable=true` **and** `severity=block`
		 * items are disabled, and only after the operator's confirmation.
		 */
		function isolatableItems(report) {
			return reportItems(report).filter((item) => item.severity === "block" && item.fixable === true);
		}

		/** `block` findings no automatic isolation can resolve (they need a manual fix). */
		function unisolatableBlocks(report) {
			return reportItems(report).filter((item) => item.severity === "block" && item.fixable !== true);
		}

		/** Shadow-boot state as a stable DOM token: `passed` / `failed` / `not-run`. */
		function stagingState(staging) {
			if (staging?.ran !== true) return "not-run";
			return staging.ok === true ? "passed" : "failed";
		}

		/** Shadow-boot result line (ux-spec §3: "影子验证：✔ 通过（日志）"). */
		function stagingLabel(staging, t) {
			const state = stagingState(staging);
			if (state === "not-run") return t("update.report.staging.notRun");
			return state === "passed" ? t("update.report.staging.passed") : t("update.report.staging.failed");
		}

		/** Compact `target …` preview for a collapsed `ok` group (ux-spec §3). */
		function targetPreview(items, limit) {
			const names = items.map((item) => String(item.target ?? "")).filter((name) => name !== "");
			const head = names.slice(0, limit).join(" · ");
			return names.length > limit ? `${head} …` : head;
		}

		// ---- WP8 progress view (design/ux-spec.md §4 + design/state-machine.md) ----

		/**
		 * The eight-step bar of ux-spec §4. The *order* follows the corrected
		 * state machine (C-11: `installing → … → staging`, because the shadow
		 * boot needs an installed launcher; WP8: the consented isolation runs
		 * before that gate so the boot judges the configuration that will
		 * actually start), which is what "与状态机对齐" asks for; the labels are
		 * ux-spec's.
		 */
		const PROGRESS_STEPS = [
			{ id: "fetch", key: "update.progress.step.fetch" },
			{ id: "preflight", key: "update.progress.step.preflight" },
			{ id: "install", key: "update.progress.step.install" },
			{ id: "isolate", key: "update.progress.step.isolate" },
			{ id: "staging", key: "update.progress.step.staging" },
			{ id: "switch", key: "update.progress.step.switch" },
			{ id: "restart", key: "update.progress.step.restart" },
			{ id: "health", key: "update.progress.step.health" },
		];

		/** Phase → the step bar position the phase belongs to. */
		const PHASE_STEP_INDEX = {
			idle: 0, fetching: 0, ready: 0,
			preflight: 1, blocked: 1,
			installing: 2, installed: 2,
			isolating: 3,
			staging: 4, staged: 4,
			switched: 5,
			restarting: 6,
			"health-checking": 7, healthy: 7,
			"rolling-back": 5, "rolled-back": 5, "rollback-failed": 5,
			failed: 0,
		};

		/** `status().phase` → the localized copy shown as 「当前阶段」 (ux-spec §4, O1). */
		const PHASE_KEYS = {
			idle: "update.progress.phaseText.idle",
			fetching: "update.progress.phaseText.fetching",
			ready: "update.progress.phaseText.ready",
			preflight: "update.progress.phaseText.preflight",
			blocked: "update.progress.phaseText.blocked",
			installing: "update.progress.phaseText.installing",
			installed: "update.progress.phaseText.installed",
			isolating: "update.progress.phaseText.isolating",
			staging: "update.progress.phaseText.staging",
			staged: "update.progress.phaseText.staged",
			switched: "update.progress.phaseText.switched",
			restarting: "update.progress.phaseText.restarting",
			"health-checking": "update.progress.phaseText.health-checking",
			healthy: "update.progress.phaseText.healthy",
			"rolling-back": "update.progress.phaseText.rolling-back",
			"rolled-back": "update.progress.phaseText.rolled-back",
			"rollback-failed": "update.progress.phaseText.rollback-failed",
			failed: "update.progress.phaseText.failed",
		};

		/** Localized phase label; an unknown phase falls back to the raw wire value. */
		function phaseText(phase, t) {
			const key = PHASE_KEYS[String(phase ?? "")];
			return key === undefined ? String(phase ?? "") : t(key);
		}

		/** `status.steps[].id` → the step bar position that owns it. */
		const BAR_FOR_STEP = {
			install: "install",
			staging: "staging",
			isolate: "isolate",
			switch: "switch",
			"wait-host": "restart",
			"wait-port": "restart",
			start: "health",
			"self-check": "health",
			recover: "restart",
		};

		/** Phases whose work is still in flight (they animate the entry button). */
		const ACTIVE_PHASES = [
			"fetching", "preflight", "staging", "installing", "isolating",
			"restarting", "health-checking", "rolling-back",
		];

		/** Phases reached by the rollback path. */
		const ROLLBACK_PHASES = ["rolling-back", "rolled-back", "rollback-failed"];

		/**
		 * Phases that mean "a job exists on disk". Used on reconnect: when the
		 * panel opens and one of these is on disk, the progress view is rebuilt
		 * from `status()` rather than pretending the update never happened.
		 */
		const JOB_PHASES = [
			"preflight", "blocked", "staging", "staged", "installing", "installed",
			"isolating", "switched", "restarting", "health-checking", "healthy",
			"failed", "rolling-back", "rolled-back", "rollback-failed",
		];

		/**
		 * Phases with no step left to run.
		 *
		 * T6 read this as "the poll stops here". T8 keeps the *page* watching at
		 * these phases — it only drops from the 1 s in-flight cadence to the slow
		 * idle cadence (`IDLE_CHECK_MS`), because an idle page must still notice a
		 * server that was replaced under it.
		 */
		const SETTLED_PHASES = ["idle", "switched", "healthy", "failed", "rolled-back", "rollback-failed"];

		/** How often the client polls `status()` while a job is in flight. */
		const STATUS_POLL_MS = 1000;

		/**
		 * T8: how often an IDLE page re-reads `status()`.
		 *
		 * T6's handshake only ever *adopted* a baseline at load, and the poll that
		 * fed it stopped at the first settled phase: a page sitting at `idle` asked
		 * once and never asked again, so a server replaced under an idle page was
		 * never noticed ("new on disk, old in the tab"). The watch therefore keeps
		 * running at this slow cadence instead of stopping.
		 *
		 * 45 s is deliberately an order of magnitude below the 1 s in-flight poll.
		 * `status()` is the only fact that carries `runningVersion`, so one read per
		 * 45 s per idle page is the cheapest cadence that still notices an upgrade
		 * within a minute — and, unlike a second poll, it *replaces* the fast one
		 * rather than running beside it (one chained `setTimeout`, one read in
		 * flight, ever).
		 */
		const IDLE_CHECK_MS = 45000;

		/**
		 * T8: the cadence a hidden tab falls back to. A background tab is doing
		 * nothing for the operator, so it backs off instead of spending a request
		 * every 45 s; becoming visible again asks immediately (see the
		 * `visibilitychange` effect), which is what makes the back-off safe.
		 */
		const IDLE_CHECK_HIDDEN_MS = 90000;

		/** Whether this tab is currently hidden, when the platform says so. */
		function pageHidden() {
			try {
				return document.visibilityState === "hidden";
			} catch (error) {
				return false;
			}
		}

		/**
		 * How many consecutive poll failures are tolerated. The restart replaces
		 * the very process serving this page, so `status()` WILL fail for a few
		 * seconds (ux-spec §4: "重启会断开当前页面，稍后自动重连"); the poll must
		 * ride that out rather than declaring the job lost.
		 */
		const STATUS_RETRY_MAX = 120;

		/** Step state → leading mark. */
		const STEP_MARKS = { pending: "○", running: "◔", done: "✔", failed: "✖" };

		/** The step bar for one `status()` payload, aligned to the phase and the failed step. */
		function progressSteps(status) {
			const phase = String(status?.phase ?? "idle");
			const recorded = Array.isArray(status?.steps) ? status.steps : [];
			const detailFor = (barId) => {
				let detail;
				for (const step of recorded) {
					if (BAR_FOR_STEP[String(step?.id ?? "")] === barId && typeof step?.detail === "string") detail = step.detail;
				}
				return detail;
			};
			let failedIndex = -1;
			if (phase === "failed") {
				const failed = recorded.find((step) => step?.state === "failed");
				const mapped = failed === undefined ? undefined : BAR_FOR_STEP[String(failed.id ?? "")];
				failedIndex = mapped === undefined
					? 0
					: PROGRESS_STEPS.findIndex((step) => step.id === mapped);
			}
			const index = Object.prototype.hasOwnProperty.call(PHASE_STEP_INDEX, phase) ? PHASE_STEP_INDEX[phase] : 0;
			const rollback = ROLLBACK_PHASES.indexOf(phase) >= 0;
			return PROGRESS_STEPS.map((step, position) => {
				let state = "pending";
				if (failedIndex >= 0) {
					state = position < failedIndex ? "done" : position === failedIndex ? "failed" : "pending";
				} else if (rollback) {
					if (position <= 5) state = "done";
					else if (position === 7) state = phase === "rolling-back" ? "running" : "failed";
				} else if (position < index) {
					state = "done";
				} else if (position === index) {
					state = ACTIVE_PHASES.indexOf(phase) >= 0 ? "running" : "done";
				}
				return {
					id: step.id,
					key: step.key,
					state,
					current: phase === "switched" && step.id === "restart",
					detail: detailFor(step.id),
				};
			});
		}

		/** The `block`+`fixable` items a confirmed isolation disabled (design §5.5). */
		function isolatedPlugins(status) {
			return reportItems(status?.report).filter((item) => item.severity === "block" && item.fixable === true);
		}

		/** Copy for the progress view's headline banner, or `undefined`. */
		function progressBanner(status, t) {
			const phase = String(status?.phase ?? "idle");
			const version = String(status?.version ?? "");
			if (phase === "switched") {
				return { kind: "switched", text: `${t("update.progress.waiting", { version })} ${t("update.progress.restartNote")}` };
			}
			if (phase === "healthy") return { kind: "healthy", text: t("update.progress.healthy", { version }) };
			if (phase === "restarting" || phase === "health-checking") return { kind: "running", text: t("update.progress.restarting") };
			if (phase === "rolling-back") return { kind: "running", text: t("update.progress.rollingBack") };
			if (phase === "rolled-back") return { kind: "rolled-back", text: t("update.progress.rolledBack") };
			if (phase === "rollback-failed") return { kind: "rollback-failed", text: t("update.progress.rollbackFailed") };
			return undefined;
		}

		// ---- typed-remote contribution ----------------------------------------

		/** The client-side codec: `strict` because the client only checks that flag. */
		const IDENTITY_CODEC = {
			mode: "strict",
			schema: { parse: (value) => value },
		};

		/** One direct remote descriptor whose client codec is an identity stub. */
		function descriptor(namespace, method, parameters, resultTypeSymbol) {
			return {
				id: `perse-updater#${namespace}/${method}`,
				service: namespace,
				namespace,
				method,
				invocation: { kind: "direct" },
				parameters: parameters.map((parameter) => ({
					name: parameter.name,
					wire: parameter.wire,
					source: "json",
					...(parameter.acceptsUndefined === true ? { acceptsUndefined: true } : {}),
					codec: { ...IDENTITY_CODEC, typeSymbol: parameter.typeSymbol },
				})),
				result: { ...IDENTITY_CODEC, typeSymbol: resultTypeSymbol },
			};
		}

		/**
		 * Mountable contribution for the `updateCenter` namespace. Runtime fields
		 * mirror `lib/typert.remote-client.js` (same descriptors, same order); see
		 * scripts/verify-client-bundle.mjs.
		 */
		const TYPERT_REMOTE = {
			package: "perse-updater",
			descriptors: [
				descriptor(
					"updateCenter",
					"apply",
					[{ name: "input", wire: "input", typeSymbol: "perse-updater/types#ApplyInput" }],
					"perse-updater/types#JobHandle",
				),
				descriptor(
					"updateCenter",
					"preflight",
					[{ name: "input", wire: "input", typeSymbol: "perse-updater/types#PreflightInput" }],
					"perse-updater/types#PreflightReport",
				),
				// WP8: the two methods promoted from plain service calls to the wire
				// contract (`design/remote-contract.md` §2). Order matches the
				// generated artifact (apply → preflight → restart → restorePatch →
				// rollback → status → versions); `restorePatch` returns an inline
				// object type, so its typeSymbol is the generator's synthesized one.
				descriptor("updateCenter", "restart", [], "perse-updater/types#JobHandle"),
				descriptor("updateCenter", "restorePatch", [], "perse-updater#updateCenter/restorePatch:result"),
				descriptor("updateCenter", "rollback", [], "perse-updater/types#JobHandle"),
				descriptor("updateCenter", "status", [], "perse-updater/types#UpdateStatus"),
				descriptor(
					"updateCenter",
					"versions",
					[{ name: "input", wire: "input", acceptsUndefined: true, typeSymbol: "perse-updater/types#VersionsInput" }],
					"perse-updater/types#VersionsResult",
				),
			],
		};

		// ---- semver helpers (display order is ours, not the wire's) -----------

		const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

		/** Parse a version into comparable components; `undefined` when malformed. */
		function parseVersion(text) {
			const match = VERSION_PATTERN.exec(String(text ?? ""));
			if (match === null) return undefined;
			return {
				major: Number(match[1]),
				minor: Number(match[2]),
				patch: Number(match[3]),
				prerelease: match[4] === undefined ? [] : match[4].split("."),
			};
		}

		/** Whether `a` precedes `b` under semver precedence. */
		function lowerPrecedence(a, b) {
			if (a.major !== b.major) return a.major < b.major;
			if (a.minor !== b.minor) return a.minor < b.minor;
			if (a.patch !== b.patch) return a.patch < b.patch;
			if (a.prerelease.length === 0) return false;
			if (b.prerelease.length === 0) return true;
			for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
				const left = a.prerelease[index];
				const right = b.prerelease[index];
				if (left === undefined) return true;
				if (right === undefined) return false;
				if (left === right) continue;
				const leftNumeric = /^\d+$/.test(left);
				const rightNumeric = /^\d+$/.test(right);
				if (leftNumeric && rightNumeric) return Number(left) < Number(right);
				if (leftNumeric !== rightNumeric) return leftNumeric;
				return left < right;
			}
			return false;
		}

		/** Newest-first sort of `{ version }` records; malformed versions sink. */
		function newestFirst(items) {
			return [...items].sort((left, right) => {
				const a = parseVersion(left.version);
				const b = parseVersion(right.version);
				if (a === undefined) return b === undefined ? 0 : 1;
				if (b === undefined) return -1;
				if (lowerPrecedence(a, b)) return 1;
				if (lowerPrecedence(b, a)) return -1;
				return 0;
			});
		}

		/**
		 * Compact distance badge (design/ux-spec.md §2, e.g. `+7 rc` / `+0.0.1`).
		 *
		 * N2: the base components alone are not a distance. `0.1.5-rc.8` and
		 * `0.1.5-rc.2` both sit on `0.1.5`, so major/minor/patch are 0 for every
		 * candidate of the same base — the old formatter printed `+0 rc` for all
		 * seven rows and dropped the host's `distance.prerelease` (the step count
		 * along the channel, WP1 §3). So: same base ⇒ the prerelease step count IS
		 * the distance (`rc.8` off `rc.1` → `+7 rc`); moved base ⇒ name every
		 * component so a patch step reads `+0.0.1`, not a bare `+1` (a mixed move
		 * with a negative component keeps the compact signed form, where a triple
		 * would misread).
		 */
		function distanceLabel(distance) {
			if (distance === undefined || distance === null) return undefined;
			const base = ["major", "minor", "patch"].map((key) =>
				typeof distance[key] === "number" ? distance[key] : 0,
			);
			const prerelease = typeof distance.prerelease === "number" ? distance.prerelease : 0;
			if (!base.some((value) => value !== 0)) {
				if (prerelease === 0) return "+0";
				return `${prerelease > 0 ? "+" : ""}${prerelease} rc`;
			}
			const offset = base.every((value) => value >= 0)
				? `+${base.join(".")}`
				: base
						.filter((value) => value !== 0)
						.map((value) => `${value > 0 ? "+" : ""}${value}`)
						.join(".");
			if (prerelease > 0) return `${offset} rc`;
			if (prerelease < 0) return `${offset} -rc`;
			return offset;
		}

		/** Localized relative publish time for one candidate. */
		function publishedText(iso, t, now) {
			const at = Date.parse(String(iso ?? ""));
			if (Number.isNaN(at)) return undefined;
			const bucket = relativeTime(at, now);
			return t(`update.relative.${bucket.unit}`, { n: bucket.n });
		}

		// ux-spec §2: EVERY candidate row shows its dist-tag(s), its prerelease flag
		// and the distance from the current install. The host already computes all
		// three, but a `versions()` payload that omits them (or a synthesized row)
		// must not degrade to a bare version number — derive them here from the same
		// facts the host uses: the top-level `distTags` map and the version strings.

		/** dist-tag(s) pointing at `version`, from the payload's `distTags` map. */
		function versionTags(version, distTags) {
			const tags = [];
			for (const [tag, target] of Object.entries(distTags ?? {})) {
				if (String(target) === String(version)) tags.push(tag);
			}
			return tags.sort();
		}

		/** Semver distance `current → candidate` (mirrors packages/perse-updater/src/candidates.ts). */
		function versionDistance(candidate, current) {
			if (candidate === undefined || current === undefined) return undefined;
			const left = parseVersion(candidate);
			const right = parseVersion(current);
			if (left === undefined || right === undefined) return undefined;
			return {
				major: left.major - right.major,
				minor: left.minor - right.minor,
				patch: left.patch - right.patch,
				prerelease: prereleaseDelta(left, right),
			};
		}

		/** Last purely numeric prerelease identifier, e.g. `2` for `rc.2`. */
		function lastNumeric(parts) {
			for (let index = parts.length - 1; index >= 0; index -= 1) {
				if (/^\d+$/.test(String(parts[index]))) return Number(parts[index]);
			}
			return undefined;
		}

		/** `+1` when the candidate is a prerelease and the current is not, `-1` for the reverse. */
		function prereleaseDelta(candidate, current) {
			if (candidate.prerelease.length === 0 && current.prerelease.length === 0) return 0;
			if (candidate.prerelease.length === 0) return 1;
			if (current.prerelease.length === 0) return -1;
			if (candidate.prerelease[0] !== current.prerelease[0]) return 0;
			const left = lastNumeric(candidate.prerelease);
			const right = lastNumeric(current.prerelease);
			if (left === undefined || right === undefined) return 0;
			return left - right;
		}

		/** Fill the §2 display facts the wire may have omitted. */
		function normalizeRow(item, currentVersion, distTags) {
			const parsed = parseVersion(item.version);
			const tags = Array.isArray(item.tags) && item.tags.length > 0 ? item.tags : versionTags(item.version, distTags);
			if (item.isCurrent === true) {
				return {
					...item,
					tags,
					prerelease: item.prerelease === true || (parsed !== undefined && parsed.prerelease.length > 0),
					distance: undefined,
				};
			}
			return {
				...item,
				tags,
				prerelease: item.prerelease === true || (parsed !== undefined && parsed.prerelease.length > 0),
				distance: item.distance === undefined ? versionDistance(item.version, currentVersion) : item.distance,
			};
		}

		/** User-visible text for one Remote failure. */
		function failureText(failure, t) {
			const key = ERROR_KEYS[failure?.code] ?? "update.error.unknown";
			return t(key, { message: failure?.message ?? failure?.code ?? "unknown" });
		}

		/** The §5 "建议动作" (suggested action) for one Remote failure. */
		function failureActionText(failure, t) {
			return t(ERROR_ACTION_KEYS[failure?.code] ?? "update.errorAction.unknown");
		}

		/**
		 * Resolve the namespace service at call time.
		 *
		 * `ctx.get` is the inject-free read (the boot audit uses it too). It is
		 * deliberately not `ctx.remote.updateCenter`, which would require injecting
		 * the namespace this plugin mounts itself (see the header).
		 */
		function resolveNamespace(ctx) {
			try {
				const bound = typeof ctx.get === "function" ? ctx.get(NAMESPACE_SERVICE) : undefined;
				if (bound !== undefined && typeof bound.versions === "function") return bound;
			} catch (error) {
				console.error(LOG, `reading ${NAMESPACE_SERVICE} failed`, error);
			}
			return undefined;
		}

		// ---- owned styles (created at materialization, see the header) --------

		const CSS = `
.uc_entry{display:flex;width:100%;min-width:0}
.uc_entryRail{justify-content:center;width:auto}
/* Rail mode (ux-spec §1, 56px): the count badge must not push the icon off
   centre. Take the badge out of the flex flow and pin it to the button corner,
   so the icon is centred exactly like every sibling row and the badge stays
   inside the rail's 56px column. */
.uc_entryRail .uc_button{position:relative}
/* N3: the rail is 28px of button + 14px of gap each side. The icon is 18px
   centred (x18.5–36.5) and the badge pinned to the button corner (right:-3px)
   sat ON the icon's top-right, hiding the glyph. Park it in the free band to
   the RIGHT of the icon instead — right edge 52 stays inside the rail's 54–56px
   boundary — and force a border-box 14px box so a 9+ count cannot grow back
   over the glyph: badge box (x>=38) and icon box (x<=36.5) no longer intersect. */
.uc_entryRail .uc_dot{position:absolute;top:-3px;right:-10px;margin:0}
.uc_entryRail .uc_dotCount{box-sizing:border-box;min-width:14px;height:14px;padding:0 2px;font-size:9px;line-height:14px}
.uc_button{display:flex;align-items:center;gap:8px;width:100%;min-width:0;box-sizing:border-box;
  padding:6px 10px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);
  font:inherit;font-size:13px;line-height:20px;cursor:pointer;text-align:left}
.uc_button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.uc_button:focus-visible{outline:2px solid var(--dsw-alias-state-info-primary,#4c8dff);outline-offset:1px}
.uc_entryRail .uc_button{width:28px;height:28px;justify-content:center;padding:0}
.uc_icon{display:inline-flex;align-items:center;justify-content:center}
.uc_spin{animation:uc-spin 1s linear infinite}
@keyframes uc-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.uc_spin{animation:none}}
.uc_label{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.uc_dot{display:inline-flex;align-items:center;justify-content:center;flex:none}
.uc_dotCount{min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--dsw-alias-state-error-primary,#e5484d);
  color:#fff;font-size:10px;line-height:16px;font-weight:600}
.uc_dotError{color:var(--dsw-alias-label-tertiary,inherit)}
/* D6: never force a min-width the dialog's content box cannot honour — a 360px
   min inside a 332px content box overflowed the panel 28px past the dialog's
   right edge (right inset 0 vs left 24). */
.uc_panel{display:flex;flex-direction:column;gap:10px;min-width:0;max-width:520px}
.uc_errorBar{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;
  background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#e5484d) 10%, transparent);
  color:var(--dsw-alias-label-primary,inherit);font-size:12px;line-height:18px;flex-wrap:wrap}
.uc_facts{display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:18px}
.uc_fact{display:flex;gap:8px;align-items:baseline}
.uc_factKey{flex:none;color:var(--dsw-alias-label-tertiary,inherit)}
.uc_factValue{color:var(--dsw-alias-label-primary,inherit);word-break:break-all}
.uc_listHead{font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}
.uc_list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;max-height:280px;overflow:auto}
.uc_row{display:flex}
.uc_rowButton{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:6px 8px;
  border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;
  font-size:12px;line-height:18px;text-align:left;cursor:pointer}
.uc_rowButton:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.uc_rowButton:focus-visible{outline:2px solid var(--dsw-alias-state-info-primary,#4c8dff);outline-offset:-2px}
.uc_rowButton:disabled{cursor:default;color:var(--dsw-alias-label-tertiary,inherit)}
.uc_row[data-uc-selected="true"] .uc_rowButton{background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.18))}
.uc_radio{flex:none;width:12px;text-align:center}
.uc_rowVersion{flex:none;font-variant-numeric:tabular-nums;font-weight:500}
.uc_rowTags{display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap}
.uc_rowTime{margin-left:auto;flex:none;color:var(--dsw-alias-label-secondary,inherit)}
.uc_empty,.uc_note,.uc_warn{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,inherit)}
.uc_warn{color:var(--dsw-alias-state-warning-primary,#d29922)}
.uc_actions{display:flex;gap:8px;justify-content:flex-end;width:100%}
.uc_actionsSplit{display:flex;gap:8px;justify-content:space-between;align-items:center;width:100%;flex-wrap:wrap}
/* D3: the split footer must render on ONE line inside the 332px panel (S6b only
   stopped the back LABEL from wrapping — the row still broke). Root cause: the
   nested .uc_actions kept its standalone width:100%, so as a flex item it was
   always wider than the space left of the back button, forced a line break, and
   stranded ~240px of dead space after 返回版本列表. Inside the split it must take
   its intrinsic width instead: width:auto + flex:0 0 auto keeps the two click
   targets on one row (back left, actions right, 返回版本列表 92px + gap 8px +
   actions ~168px max ≪ 332px) with no clipping or shrinking. flex-wrap stays as
   the last-resort fallback so a genuinely narrower panel breaks the row rather
   than overflowing the button text. */
.uc_actionsSplit>.uc_actions{width:auto;flex:0 0 auto;min-width:0;justify-content:flex-end}
.uc_actionsSplit>[data-uc-back]{flex:0 0 auto;white-space:nowrap}
.uc_actions button{white-space:nowrap}
/* D8: a disabled action stays clearly muted but must remain readable
   (WCAG AA 4.5:1). The host's own disabled treatment (opacity .4 over the
   primary label colour) measured 2.62:1, so the override is forced. The Modal
   renders the footer OUTSIDE [data-uc-panel], hence the action-class selectors. */
.uc_actions button:disabled,.uc_actionsSplit button:disabled,.uc_panel button:disabled{color:var(--dsw-alias-label-secondary,inherit)!important;opacity:1!important}
.uc_errorAction{color:var(--dsw-alias-label-secondary,inherit)}
.uc_report{display:flex;flex-direction:column;gap:8px}
.uc_reportTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}
.uc_verdict{display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:8px;font-size:12px;line-height:18px;font-weight:500}
/* D5: the verdict line is the panel's conclusion, so it must clear AA. The raw
   state colours (e.g. #d29922 on #faf3e4 = 2.28:1) are darkened 38–42% before
   use on the tinted background. */
.uc_verdict[data-uc-verdict="blocked"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 12%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 58%,#000)}
.uc_verdict[data-uc-verdict="warn"]{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d29922) 12%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d29922) 62%,#000)}
.uc_verdict[data-uc-verdict="ok"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2ea043) 12%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2ea043) 62%,#000)}
.uc_reportScroll{display:flex;flex-direction:column;gap:10px;max-height:320px;overflow:auto;padding-right:2px}
.uc_scrollHint{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,inherit);text-align:center}
.uc_group{display:flex;flex-direction:column;gap:4px}
.uc_groupHead{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;padding:2px 0;border:0;
  background:transparent;font:inherit;font-size:12px;line-height:18px;font-weight:600;
  color:var(--dsw-alias-label-secondary,inherit);text-align:left;cursor:pointer}
.uc_groupHead[data-static="true"]{cursor:default}
.uc_groupHead:focus-visible{outline:2px solid var(--dsw-alias-state-info-primary,#4c8dff);outline-offset:1px}
.uc_groupMark{flex:none}
.uc_group[data-uc-group="block"] .uc_groupMark{color:var(--dsw-alias-state-error-primary,#e5484d)}
.uc_group[data-uc-group="warn"] .uc_groupMark{color:var(--dsw-alias-state-warning-primary,#d29922)}
.uc_group[data-uc-group="ok"] .uc_groupMark{color:var(--dsw-alias-state-success-primary,#2ea043)}
.uc_groupPreview{font-weight:400;color:var(--dsw-alias-label-tertiary,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.uc_chevron{margin-left:auto;flex:none;color:var(--dsw-alias-label-tertiary,inherit)}
.uc_items{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.uc_item{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border-radius:8px;
  background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.06));font-size:12px;line-height:18px}
.uc_itemHead{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.uc_itemTarget{font-weight:600;color:var(--dsw-alias-label-primary,inherit);word-break:break-all}
.uc_itemRule{display:inline-flex;flex:none}
.uc_itemDetail{margin:0;color:var(--dsw-alias-label-secondary,inherit);word-break:break-word}
.uc_itemFix{display:flex;align-items:flex-start;gap:6px;flex-wrap:wrap}
.uc_itemFixText{color:var(--dsw-alias-label-tertiary,inherit)}
.uc_stagingRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;line-height:18px}
.uc_stagingMark{flex:none}
.uc_stagingMark[data-uc-staging="passed"]{color:var(--dsw-alias-state-success-primary,#2ea043)}
.uc_stagingMark[data-uc-staging="failed"]{color:var(--dsw-alias-state-error-primary,#e5484d)}
.uc_stagingMark[data-uc-staging="not-run"]{color:var(--dsw-alias-state-warning-primary,#d29922)}
.uc_log{margin:0;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.08));
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;
  color:var(--dsw-alias-label-secondary,inherit);white-space:pre-wrap;word-break:break-all;max-height:160px;overflow:auto}
.uc_confirm{display:flex;flex-direction:column;gap:8px;font-size:12px;line-height:18px}
.uc_confirmBody{margin:0;color:var(--dsw-alias-label-secondary,inherit)}
.uc_confirmHead{font-weight:600;color:var(--dsw-alias-label-primary,inherit)}
.uc_segments{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.uc_segment{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l4,rgba(127,127,127,.3))}
.uc_segmentRule{font-weight:600;color:var(--dsw-alias-label-primary,inherit);word-break:break-all}
.uc_segmentDetail{color:var(--dsw-alias-label-secondary,inherit);word-break:break-word}
.uc_segmentFix{color:var(--dsw-alias-label-tertiary,inherit)}
.uc_backup{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.uc_backupName{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;padding:1px 6px;border-radius:6px;
  background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.1));color:var(--dsw-alias-label-primary,inherit)}
.uc_footerStack{display:flex;flex-direction:column;gap:6px;width:100%}
.uc_linkButton{border:0;background:transparent;padding:0;font:inherit;font-size:12px;line-height:18px;
  color:var(--dsw-alias-state-info-primary,#4c8dff);text-decoration:underline;cursor:pointer}
.uc_linkButton:focus-visible{outline:2px solid var(--dsw-alias-state-info-primary,#4c8dff);outline-offset:1px}
/* ---- WP8 progress view: step bar aligned to design/state-machine.md ---- */
.uc_progress{display:flex;flex-direction:column;gap:10px}
.uc_progressHead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.uc_phase{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit);font-variant-numeric:tabular-nums}
.uc_steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.uc_step{display:flex;align-items:flex-start;gap:8px;padding:4px 8px;border-radius:8px;font-size:12px;line-height:18px}
.uc_stepMark{flex:none;width:16px;text-align:center;font-weight:600}
.uc_stepBody{display:flex;flex-direction:column;gap:2px;min-width:0}
.uc_stepLabel{color:var(--dsw-alias-label-secondary,inherit)}
.uc_stepText{color:var(--dsw-alias-label-tertiary,inherit);font-size:11px}
.uc_step[data-uc-step-state="pending"] .uc_stepMark{color:var(--dsw-alias-label-tertiary,inherit)}
.uc_step[data-uc-step-state="running"]{background:color-mix(in srgb,var(--dsw-alias-state-info-primary,#4c8dff) 10%,transparent)}
.uc_step[data-uc-step-state="running"] .uc_stepMark{color:var(--dsw-alias-state-info-primary,#4c8dff)}
.uc_step[data-uc-step-state="running"] .uc_stepLabel{color:var(--dsw-alias-label-primary,inherit);font-weight:600}
.uc_step[data-uc-step-state="done"] .uc_stepMark{color:var(--dsw-alias-state-success-primary,#2ea043)}
.uc_step[data-uc-step-state="done"] .uc_stepLabel{color:var(--dsw-alias-label-secondary,inherit)}
.uc_step[data-uc-step-state="failed"] .uc_stepMark{color:var(--dsw-alias-state-error-primary,#e5484d)}
.uc_step[data-uc-step-state="failed"] .uc_stepLabel{color:var(--dsw-alias-state-error-primary,#e5484d);font-weight:600}
.uc_step[data-uc-current="true"]{border:1px dashed var(--dsw-alias-state-info-primary,#4c8dff)}
.uc_banner{margin:0;padding:8px 10px;border-radius:8px;font-size:12px;line-height:18px;
  background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.08));color:var(--dsw-alias-label-primary,inherit)}
.uc_banner[data-uc-banner="switched"]{background:color-mix(in srgb,var(--dsw-alias-state-info-primary,#4c8dff) 12%,transparent)}
.uc_banner[data-uc-banner="healthy"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2ea043) 12%,transparent)}
.uc_banner[data-uc-banner="failed"],.uc_banner[data-uc-banner="rollback-failed"]{
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 12%,transparent);
  color:var(--dsw-alias-state-error-primary,#e5484d)}
.uc_alarm{display:flex;align-items:center;gap:6px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:18px;
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 16%,transparent);
  color:var(--dsw-alias-state-error-primary,#e5484d);font-weight:600}
.uc_path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;
  word-break:break-all;color:var(--dsw-alias-label-primary,inherit)}
.uc_isolated{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:18px}
.uc_isolatedItem{display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:8px;
  background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.06))}
.uc_isolatedName{font-weight:600;color:var(--dsw-alias-label-primary,inherit);word-break:break-all}
.uc_sectionHead{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,inherit)}
`;

		/** Inject the owned stylesheet once per materialization. */
		function ensureStyle() {
			if (typeof document === "undefined") return;
			if (document.getElementById(STYLE_ID) !== null) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = CSS;
			document.head.appendChild(style);
		}

		// ---- components --------------------------------------------------------

		/** One version row: radio mark, version, dist-tags, flags, distance, age. */
		function VersionRow({ item, isCurrent, selected, onSelect, t, now }) {
			const distance = distanceLabel(item.distance);
			const published = publishedText(item.publishedAt, t, now);
			const tags = Array.isArray(item.tags) ? item.tags : [];
			return h(
				"li",
				{
					className: "uc_row",
					"data-uc-row": "",
					"data-uc-version": item.version,
					...(isCurrent ? { "data-uc-current": "true" } : {}),
					...(item.prerelease ? { "data-uc-prerelease": "true" } : {}),
					...(selected ? { "data-uc-selected": "true" } : {}),
				},
				h(
					"button",
					{
						type: "button",
						className: "uc_rowButton",
						disabled: isCurrent,
						onClick: () => onSelect(item.version),
						"aria-pressed": selected ? "true" : "false",
						"aria-disabled": isCurrent ? "true" : undefined,
						title: isCurrent
							? t("update.item.current")
							: published === undefined
								? `v${item.version}`
								: `v${item.version} · ${t("update.item.published", { time: published })}`,
					},
					h("span", { className: "uc_radio", "aria-hidden": "true" }, selected ? "●" : "○"),
					h("span", { className: "uc_rowVersion" }, `v${item.version}`),
					h(
						"span",
						{ className: "uc_rowTags" },
						tags.map((tag) => h("span", { key: `tag:${tag}`, "data-uc-tag": tag }, h(Tag, { tone: "outline" }, tag))),
						item.prerelease
							? h(
								"span",
								{ "data-uc-tag": "prerelease" },
								h(Tag, { tone: "warning" }, t("update.item.prerelease")),
							)
							: null,
						isCurrent
							? h(
								"span",
								{ "data-uc-current-mark": "" },
								h(Tag, { tone: "neutral" }, t("update.item.current")),
							)
							: null,
						distance === undefined
							? null
							: h(
								"span",
								{ "data-uc-distance": distance },
								h(Tag, { tone: "quiet" }, t("update.item.distance", { offset: distance })),
							),
					),
					published === undefined ? null : h("span", { className: "uc_rowTime" }, published),
				),
			);
		}

		/**
		 * One preflight row (ux-spec §3): target, rule number, reason, fixability,
		 * and — when the rule can be repaired automatically — the fix action.
		 */
		function ReportRow({ item, t }) {
			const fixable = item.fixable === true;
			return h(
				"li",
				{
					className: "uc_item",
					"data-uc-item": String(item.severity ?? "ok"),
					"data-uc-rule": String(item.rule ?? ""),
					"data-uc-target": String(item.target ?? ""),
				},
				h(
					"div",
					{ className: "uc_itemHead" },
					h("span", { className: "uc_itemTarget" }, String(item.target ?? "")),
					h(
						"span",
						{ className: "uc_itemRule", "data-uc-rule-badge": String(item.rule ?? "?") },
						h(Tag, { tone: "outline" }, String(item.rule ?? "?")),
					),
				),
				h("p", { className: "uc_itemDetail" }, String(item.detail ?? "")),
				h(
					"div",
					{ className: "uc_itemFix" },
					h(
						Tag,
						{ tone: fixable ? "info" : "quiet" },
						fixable ? t("update.report.fixable") : t("update.report.unfixable"),
					),
					typeof item.fix === "string" && item.fix !== ""
						? h(
							"span",
							{ className: "uc_itemFixText", "data-uc-fix": item.fix },
							t("update.report.fix", { fix: item.fix }),
						)
						: null,
				),
			);
		}

		/**
		 * One severity group. Only the `ok` group is a toggle (ux-spec §3: `ok`
		 * collapses by default), so its heading is a button carrying
		 * `aria-expanded`; the others are plain headings.
		 */
		function GroupSection({ severity, items, t, collapsed, onToggle }) {
			const toggleable = severity === "ok";
			const heading = t("update.report.group.heading", {
				title: t(GROUP_KEYS[severity]),
				count: items.length,
			});
			const head = h(
				toggleable ? "button" : "div",
				{
					className: "uc_groupHead",
					...(toggleable
						? {
							type: "button",
							onClick: onToggle,
							"aria-expanded": collapsed ? "false" : "true",
							"data-uc-toggle-ok": "",
							title: collapsed ? t("update.report.expandOk") : t("update.report.collapseOk"),
						}
						: { "data-static": "true" }),
				},
				h("span", { className: "uc_groupMark", "aria-hidden": "true" }, GROUP_MARKS[severity]),
				h("span", null, heading),
				toggleable && collapsed
					? h("span", { className: "uc_groupPreview", "data-uc-ok-preview": "" }, targetPreview(items, 2))
					: null,
				toggleable
					? h("span", { className: "uc_chevron", "aria-hidden": "true" }, collapsed ? "▸" : "▾")
					: null,
			);
			return h(
				"div",
				{ className: "uc_group", "data-uc-group": severity, "data-uc-count": String(items.length) },
				head,
				toggleable && collapsed
					? null
					: h(
						"ul",
						{ className: "uc_items" },
						items.map((item, index) =>
							h(ReportRow, {
								key: `${severity}:${String(item.rule ?? "?")}:${String(item.target ?? "?")}:${index}`,
								item,
								t,
							}),
						),
					),
			);
		}

		/** Shadow-boot result plus its log entry point (ux-spec §3: "影子验证：✔ 通过（日志）"). */
		function StagingLine({ staging, t, logOpen, onToggleLog }) {
			const state = stagingState(staging);
			const mark = state === "passed" ? "✔" : state === "failed" ? "✖" : "⚠";
			const tail = typeof staging?.logTail === "string" ? staging.logTail : "";
			return h(
				"div",
				{ className: "uc_stagingRow", "data-uc-staging": state },
				h("span", { className: "uc_stagingMark", "data-uc-staging": state, "aria-hidden": "true" }, mark),
				h("span", { "data-uc-staging-text": "" }, `${t("update.report.staging")}：${stagingLabel(staging, t)}`),
				h(
					"button",
					{
						type: "button",
						className: "uc_linkButton",
						onClick: onToggleLog,
						"aria-expanded": logOpen ? "true" : "false",
						"data-uc-log-toggle": "",
					},
					t("update.report.log"),
				),
				logOpen
					? h("pre", { className: "uc_log", "data-uc-log": "" }, tail === "" ? t("update.report.logEmpty") : tail)
					: null,
			);
		}

		/**
		 * The D3 second stage: a genuinely separate dialog that lists the exact
		 * segments an isolation would disable and the backup file it would create.
		 *
		 * `onCancel` closes only this dialog. It never reaches `apply`, so the
		 * cancel path is zero-write by construction (acceptance UI-03).
		 */
		function IsolateConfirm({ open, version, isolatable, unisolatable, applying, t, onCancel, onProceed }) {
			const blocked = applying === true || isolatable.length === 0 || unisolatable.length > 0;
			return h(
				Modal,
				{
					open,
					onClose: onCancel,
					title: t("update.confirm.title"),
					closeLabel: t("update.confirm.cancel"),
					footer: h(
						"div",
						{ className: "uc_actions" },
						h(
							Button,
							{ variant: "ghost", size: "sm", onClick: onCancel, "data-uc-confirm-cancel": "" },
							t("update.confirm.cancel"),
						),
						h(
							Button,
							{
								variant: "primary",
								size: "sm",
								disabled: blocked,
								onClick: onProceed,
								"data-uc-confirm-proceed": "",
							},
							applying === true ? t("update.confirm.applying") : t("update.confirm.proceed"),
						),
					),
				},
				h(
					"div",
					{ className: "uc_confirm", "data-uc-confirm": "", "aria-label": t("update.a11y.confirm") },
					h("p", { className: "uc_confirmBody" }, t("update.confirm.body")),
					h("div", { className: "uc_confirmHead", "data-uc-confirm-version": version }, `v${version}`),
					h(
						"div",
						{ className: "uc_confirmHead" },
						t("update.confirm.segments", { count: isolatable.length }),
					),
					isolatable.length === 0
						? h("p", { className: "uc_note", "data-uc-confirm-none": "" }, t("update.report.nothingToIsolate"))
						: h(
							"ul",
							{ className: "uc_segments", "data-uc-segments": "" },
							isolatable.map((item, index) =>
								h(
									"li",
									{
										key: `segment:${String(item.rule ?? "?")}:${String(item.target ?? "?")}:${index}`,
										className: "uc_segment",
										"data-uc-segment": String(item.target ?? ""),
									},
									h(
										"span",
										{ className: "uc_segmentRule" },
										t("update.confirm.segment", {
											rule: String(item.rule ?? ""),
											target: String(item.target ?? ""),
										}),
									),
									h("span", { className: "uc_segmentDetail" }, String(item.detail ?? "")),
									typeof item.fix === "string" && item.fix !== ""
										? h("span", { className: "uc_segmentFix" }, t("update.report.fix", { fix: item.fix }))
										: null,
								),
							),
						),
					unisolatable.length === 0
						? null
						: h(
							"p",
							{ className: "uc_warn", "data-uc-confirm-unfixable": "" },
							t("update.report.unfixableNote", { count: unisolatable.length }),
						),
					h(
						"div",
						{ className: "uc_backup" },
						h("span", { className: "uc_factKey" }, t("update.confirm.backup")),
						h("code", { className: "uc_backupName", "data-uc-backup-name": "" }, t("update.confirm.backupName")),
					),
					h("p", { className: "uc_note" }, t("update.confirm.backupNote")),
				),
			);
		}

		/**
		 * WP8's second-stage confirmation for the progress view's two write
		 * affordances (ux-spec §6: rollback and the isolated-plugin restore both
		 * need an explicit confirmation). Cancelling never reaches the Remote.
		 */
		function ActionConfirm({ open, kind, version, backupPath, busy, t, onCancel, onProceed }) {
			const isRollback = kind === "rollback";
			const title = isRollback ? t("update.confirm.rollback.title") : t("update.confirm.restore.title");
			const body = isRollback ? t("update.confirm.rollback.body") : t("update.confirm.restore.body");
			const proceedLabel = isRollback ? t("update.confirm.proceed.rollback") : t("update.confirm.proceed.restore");
			return h(
				Modal,
				{
					open,
					onClose: onCancel,
					title,
					closeLabel: t("update.action.cancel"),
					footer: h(
						"div",
						{ className: "uc_actions" },
						h(
							Button,
							{ variant: "ghost", size: "sm", onClick: onCancel, "data-uc-progress-confirm-cancel": "" },
							t("update.action.cancel"),
						),
						h(
							Button,
							{
								variant: "primary",
								size: "sm",
								disabled: busy === true,
								onClick: onProceed,
								"data-uc-progress-confirm-proceed": kind,
							},
							busy === true ? t("update.status.busy") : proceedLabel,
						),
					),
				},
				h(
					"div",
					{
						className: "uc_confirm",
						"data-uc-progress-confirm": kind,
						"aria-label": t("update.a11y.progressConfirm"),
					},
					h("p", { className: "uc_confirmBody" }, body),
					isRollback
						? h("div", { className: "uc_confirmHead", "data-uc-confirm-version": version }, `v${version}`)
						: h(
							"div",
							{ className: "uc_backup" },
							h("span", { className: "uc_factKey" }, t("update.confirm.restore.path")),
							h("code", { className: "uc_backupName", "data-uc-restore-path": "" }, String(backupPath ?? "")),
						),
				),
			);
		}

		// ---- T6: version handshake + offline recovery -------------------------

		/**
		 * How long `status()` must keep failing before the recovery panel is
		 * warranted. A restart legitimately drops the page for a few seconds
		 * (ux-spec §4: "重启会断开当前页面，稍后自动重连"), so the panel must not
		 * fire on the ordinary gap.
		 */
		const OFFLINE_AFTER_MS = 20000;

		/**
		 * Phases that mean "a restart is genuinely in flight". The panel is only
		 * for a restart that never came back: without one of these the outage is
		 * not ours and the panel would be a false alarm.
		 */
		const RESTART_PHASES = ["switched", "restarting"];

		/** The recovery command, exactly as an operator would type it. */
		const RECOVERY_COMMAND = "~/.local/bin/dsh web";

		/** The diagnostic command shown beside it. */
		const RECOVERY_VERSION_COMMAND = "~/.local/bin/dsh --version";

		/** Where dsh writes its logs. */
		const RECOVERY_LOGS = "~/.dsh/logs/";

		/**
		 * The harness seam.
		 *
		 * A test harness sets `window.__PERSE_UPDATER_TEST__` before loading this
		 * bundle to substitute the clock and the reload action. Neither the DSH
		 * host nor the shipped bundle ever sets that global, so in production both
		 * helpers below take their real path, and the bundle publishes no
		 * `__internals` handle at all (see the export at the end of the factory).
		 */
		function testSeam() {
			return typeof window !== "undefined" && window.__PERSE_UPDATER_TEST__ !== undefined
				? window.__PERSE_UPDATER_TEST__
				: undefined;
		}

		/** Now, in ms: the seam clock when a harness supplies one, else the real one. */
		function nowMs() {
			const seam = testSeam();
			return seam !== undefined && typeof seam.now === "function" ? seam.now() : Date.now();
		}

		/**
		 * Reload the page.
		 *
		 * The ONLY caller is the version handshake: a page whose server was
		 * replaced under it must fetch the bundle the new server ships. Nothing
		 * else in this bundle reloads, so no other code path can refresh the page.
		 */
		function requestReload() {
			const seam = testSeam();
			if (seam !== undefined && typeof seam.reload === "function") {
				seam.reload();
				return;
			}
			window.location.reload();
		}

		/**
		 * The version handshake plus the outage clock.
		 *
		 * `observe()` is fed every successful `status()` answer, including the
		 * startup read. The first answer it ever sees is adopted as "the version
		 * this page was loaded against" — memory only, never persisted. Any later
		 * answer naming a different `runningVersion` means the process was
		 * replaced, so the page reloads; that is the single condition.
		 *
		 * `fail()` is fed every failed attempt and answers whether the outage has
		 * lasted long enough, starting from a restart phase, to warrant the panel.
		 */
		function createStatusTracker() {
			/** The version this page was loaded against. In memory only. */
			let loadedVersion;
			/** When the current run of consecutive `status()` failures began. */
			let firstFailureAt = null;
			/** Phase of the last successful `status()` answer. */
			let lastPhase;
			/** `jobId` of the last successful `status()` answer, when it named one. */
			let lastJobId;
			return {
				/**
				 * One successful `status()` answer.
				 * @returns `{reload}` — true when a reload was just requested.
				 */
				observe(value) {
					firstFailureAt = null;
					lastPhase = String(value?.phase ?? "idle");
					lastJobId = typeof value?.jobId === "string" && value.jobId !== "" ? value.jobId : undefined;
					const reported = typeof value?.runningVersion === "string" && value.runningVersion !== ""
						? value.runningVersion
						: undefined;
					// Nothing to compare: keep the page. Guessing here would either
					// reload on every answer or never reload at all.
					if (reported === undefined) return { reload: false };
					if (loadedVersion === undefined) {
						loadedVersion = reported;
						return { reload: false };
					}
					if (reported !== loadedVersion) {
						requestReload();
						return { reload: true };
					}
					return { reload: false };
				},
				/**
				 * One failed `status()` attempt.
				 * @returns `{offline}` plus the clock state, for the panel decision.
				 */
				fail() {
					if (firstFailureAt === null) firstFailureAt = nowMs();
					const waitedMs = nowMs() - firstFailureAt;
					const restarting = RESTART_PHASES.indexOf(String(lastPhase)) >= 0;
					return {
						offline: restarting === true && waitedMs >= OFFLINE_AFTER_MS,
						waitedMs,
						restarting,
						lastPhase,
					};
				},
				/** A recovery attempt restarts the outage clock. */
				resetOutage() { firstFailureAt = null; },
				/** The version adopted at startup plus the last answered phase/job. */
				snapshot() { return { loadedVersion, lastPhase, lastJobId }; },
			};
		}

		/**
		 * The panel's translator.
		 *
		 * Falls back to the bundled `en` dictionary rather than the locale service:
		 * this panel exists precisely for the case where the host is not
		 * answering, so it must be able to render on its own.
		 */
		function offlineText(key, params) {
			const template = typeof en[key] === "string" ? en[key] : key;
			if (params === undefined) return template;
			return template.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])));
		}

		/** The legacy copy path; needs the selection {@link copyNodeText} made. */
		function legacyCopy(doc) {
			try {
				return typeof doc.execCommand === "function" && doc.execCommand("copy") === true;
			} catch (error) {
				return false;
			}
		}

		/**
		 * Copy `text` through a real selection of `node`'s text.
		 *
		 * The node is selected first, so the clipboard write and the operator's
		 * own Ctrl/Cmd+C act on the same genuine DOM text — never an image and
		 * never a `user-select: none` box.
		 *
		 * @returns a boolean or a promise of one.
		 */
		function copyNodeText(doc, node, text) {
			const selection = typeof doc.getSelection === "function" ? doc.getSelection() : undefined;
			if (selection !== undefined && selection !== null && typeof doc.createRange === "function") {
				const range = doc.createRange();
				range.selectNodeContents(node);
				selection.removeAllRanges();
				selection.addRange(range);
			}
			const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
			if (clipboard !== undefined && clipboard !== null && typeof clipboard.writeText === "function") {
				try {
					const written = clipboard.writeText(text);
					if (written !== undefined && typeof written.then === "function") {
						return written.then(() => true, () => legacyCopy(doc));
					}
					return true;
				} catch (error) {
					return legacyCopy(doc);
				}
			}
			return legacyCopy(doc);
		}

		/**
		 * Build the offline recovery panel.
		 *
		 * Purely local: it reads no remote service and makes no network call, so it
		 * renders on a page whose server is gone. It is appended to
		 * `document.body` — above the sidebar and in the root stacking context —
		 * with a top-of-stack `z-index`, so the host's own reconnect mask cannot
		 * cover it. Its command is real, selectable text with a copy button.
		 *
		 * @returns `{element, destroy}` or `undefined` when there is no document.
		 */
		function mountOfflinePanel(options) {
			const settings = options ?? {};
			const doc = settings.document ?? (typeof document === "undefined" ? undefined : document);
			if (doc === undefined || doc.body === undefined || doc.body === null) return undefined;
			const t = typeof settings.t === "function" ? settings.t : offlineText;
			/** One styled element. Inline styles: the panel must not depend on host CSS. */
			const make = (tag, css, text) => {
				const node = doc.createElement(tag);
				if (css !== undefined) node.style.cssText = css;
				if (text !== undefined) node.textContent = text;
				return node;
			};

			const root = make("div", "position:fixed;inset:0;margin:0;padding:0;box-sizing:border-box;"
				+ "display:flex;align-items:center;justify-content:center;background:rgba(4,7,10,0.86);"
				+ "z-index:2147483000;pointer-events:auto;user-select:text;-webkit-user-select:text;"
				+ "font-family:system-ui,-apple-system,'Segoe UI',sans-serif;");
			root.setAttribute("data-perse-update-center", "offline-recovery");
			root.setAttribute("role", "alertdialog");
			root.setAttribute("aria-modal", "true");
			root.setAttribute("aria-label", t("update.offline.title"));

			const card = make("div", "box-sizing:border-box;width:min(560px,92vw);max-height:88vh;overflow:auto;"
				+ "padding:20px 22px;border-radius:12px;background:#11161d;color:#eef3f8;"
				+ "border:1px solid rgba(255,255,255,0.18);box-shadow:0 24px 64px rgba(0,0,0,0.6);"
				+ "user-select:text;-webkit-user-select:text;");
			card.appendChild(make("div", "font-size:15px;font-weight:600;line-height:1.4;margin:0 0 8px;",
				t("update.offline.title")));
			card.appendChild(make("p", "margin:0 0 14px;font-size:13px;line-height:1.6;color:#c9d4e0;",
				t("update.offline.body")));
			card.appendChild(make("div", "font-size:12px;color:#9fb0c2;margin:0 0 6px;",
				t("update.offline.commandLabel")));

			// The command itself: a real, selectable text node.
			const command = make("code", "display:block;flex:1 1 auto;min-width:0;box-sizing:border-box;"
				+ "padding:10px 12px;border-radius:8px;background:#05080b;color:#e8eef5;"
				+ "border:1px solid rgba(255,255,255,0.14);user-select:text;-webkit-user-select:text;"
				+ "cursor:text;white-space:pre-wrap;word-break:break-all;"
				+ "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:1.5;",
				RECOVERY_COMMAND);
			command.setAttribute("data-perse-offline-command", "");

			const copyButton = make("button", "flex:0 0 auto;box-sizing:border-box;padding:8px 12px;"
				+ "border-radius:8px;border:1px solid rgba(255,255,255,0.24);background:#1d2733;color:#eef3f8;"
				+ "font-size:12px;cursor:pointer;", t("update.offline.copy"));
			copyButton.setAttribute("type", "button");
			copyButton.setAttribute("data-perse-offline-copy", "");
			copyButton.addEventListener("click", () => {
				Promise.resolve(copyNodeText(doc, command, RECOVERY_COMMAND)).then((copied) => {
					const ok = copied === true;
					copyButton.textContent = ok ? t("update.offline.copied") : t("update.offline.copy");
					copyButton.setAttribute("data-perse-offline-copied", ok ? "1" : "0");
				});
			});

			const commandRow = make("div", "display:flex;gap:8px;align-items:stretch;margin:0 0 12px;");
			commandRow.appendChild(command);
			commandRow.appendChild(copyButton);
			card.appendChild(commandRow);

			// The diagnostic command, also real text.
			const versionRow = make("div", "display:flex;gap:8px;align-items:baseline;margin:0 0 12px;"
				+ "font-size:12px;color:#9fb0c2;");
			versionRow.appendChild(make("span", "flex:0 0 auto;", t("update.offline.versionLabel")));
			const versionCommand = make("code", "user-select:text;-webkit-user-select:text;cursor:text;"
				+ "white-space:pre-wrap;word-break:break-all;color:#dfe8f2;"
				+ "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;", RECOVERY_VERSION_COMMAND);
			versionCommand.setAttribute("data-perse-offline-version", "");
			versionRow.appendChild(versionCommand);
			card.appendChild(versionRow);

			const facts = make("div", "font-size:12px;line-height:1.7;color:#9fb0c2;margin:0 0 14px;");
			facts.appendChild(make("div", undefined, t("update.offline.logs", { path: RECOVERY_LOGS })));
			const jobId = typeof settings.jobId === "string" && settings.jobId !== "" ? settings.jobId : undefined;
			if (jobId !== undefined) {
				facts.appendChild(make("div", "user-select:text;-webkit-user-select:text;",
					t("update.offline.job", { dir: `~/.dsh/update-center/jobs/${jobId}` })));
			}
			card.appendChild(facts);

			const retryButton = make("button", "box-sizing:border-box;padding:9px 14px;border-radius:8px;"
				+ "border:1px solid rgba(120,190,255,0.5);background:#12304d;color:#eaf3ff;font-size:13px;"
				+ "cursor:pointer;", t("update.offline.retry"));
			retryButton.setAttribute("type", "button");
			retryButton.setAttribute("data-perse-offline-retry", "");
			retryButton.addEventListener("click", () => {
				if (typeof settings.onRetry === "function") settings.onRetry();
			});
			const footer = make("div", "display:flex;align-items:center;gap:12px;flex-wrap:wrap;");
			footer.appendChild(retryButton);
			footer.appendChild(make("span", "font-size:12px;color:#9fb0c2;", t("update.offline.note")));
			card.appendChild(footer);

			root.appendChild(card);
			doc.body.appendChild(root);
			return {
				element: root,
				commandText: RECOVERY_COMMAND,
				destroy() {
					if (root.parentNode !== null && root.parentNode !== undefined) root.parentNode.removeChild(root);
				},
			};
		}

		/**
		 * The sidebar footer action plus its version panel.
		 *
		 * Panel semantics: `Modal` supplies `role="dialog"`/`aria-modal` and Esc
		 * handling; focus is returned to the trigger here on every close path.
		 */
		function UpdateEntry({ ctx, wide, t }) {
			const [status, setStatus] = React.useState("unknown");
			const [open, setOpen] = React.useState(false);
			const [result, setResult] = React.useState(undefined);
			const [failure, setFailure] = React.useState(undefined);
			const [selected, setSelected] = React.useState(undefined);
			const [busy, setBusy] = React.useState(false);
			// ---- WP4 preflight flow state ----------------------------------
			/** Which face the dialog shows: the version list or the report. */
			const [view, setView] = React.useState("versions");
			/** Last successful `PreflightReport`. */
			const [report, setReport] = React.useState(undefined);
			/** Failure of the preflight/apply flow (kept apart from the list's own). */
			const [reportFailure, setReportFailure] = React.useState(undefined);
			const [preflighting, setPreflighting] = React.useState(false);
			/** `ok` group folds away by default (ux-spec §3). */
			const [okExpanded, setOkExpanded] = React.useState(false);
			const [logOpen, setLogOpen] = React.useState(false);
			/** The D3 second stage. */
			const [confirming, setConfirming] = React.useState(false);
			const [applying, setApplying] = React.useState(false);
			/** Phase-2 placeholder: the submitted job handle, no progress view yet. */
			const [progress, setProgress] = React.useState(undefined);
			// ---- WP8 progress / restart / rollback / restore -----------------
			/** Last `status()` payload: the whole progress view is rebuilt from it. */
			const [live, setLive] = React.useState(undefined);
			/** Failure of `status()`/`restart()`/`rollback()`/`restorePatch()`. */
			const [statusFailure, setStatusFailure] = React.useState(undefined);
			/** A progress action (restart/rollback/restore) is in flight. */
			const [acting, setActing] = React.useState(false);
			/** Which second-stage confirmation is open: `rollback` | `restore`. */
			const [confirmAction, setConfirmAction] = React.useState(undefined);
			const pollingRef = React.useRef(false);
			const timerRef = React.useRef(null);
			/** Consecutive `status()` failures; reset by every successful answer. */
			const retryRef = React.useRef(0);
			// ---- T8: the page-wide version watch -----------------------------
			/**
			 * Exactly one `status()` read may be in flight. Both the in-flight poll
			 * and the idle watch go through this latch, so the two cadences can
			 * never add up to a doubled request.
			 */
			const statusBusyRef = React.useRef(false);
			/** A caller arrived while a read was running; ask again right after it. */
			const statusWakeRef = React.useRef(false);
			/** Whether the last observed phase was settled (idle vs in-flight). */
			const settledRef = React.useRef(true);
			/** Whether the last `status()` payload is already on screen. */
			const liveKeyRef = React.useRef(undefined);
			const isolateRef = React.useRef(null);
			const triggerRef = React.useRef(null);
			const reportScrollRef = React.useRef(null);
			const [reportOverflow, setReportOverflow] = React.useState(false);
			// ---- T6: version handshake + offline recovery --------------------
			/** The handshake/outage tracker. Memory only; nothing is persisted. */
			const trackerRef = React.useRef(null);
			if (trackerRef.current === null) trackerRef.current = createStatusTracker();
			/** The mounted offline recovery panel, when one is on screen. */
			const offlineRef = React.useRef(null);
			/** The startup handshake read's retry timer. */
			const handshakeTimerRef = React.useRef(null);
			/** Latest `refreshStatus`, so the panel's retry never captures a stale one. */
			const refreshStatusRef = React.useRef(null);

			// D4: the report body is a fixed-height scroller, so an expanded group can
			// push the last card past the fold. Detect that and say so explicitly
			// rather than letting the card read as "cut off".
			React.useEffect(() => {
				const node = reportScrollRef.current;
				if (node === null || node === undefined) {
					setReportOverflow(false);
					return undefined;
				}
				const measure = () => setReportOverflow(node.scrollHeight > node.clientHeight + 1);
				measure();
				if (typeof ResizeObserver !== "function") return undefined;
				const observer = new ResizeObserver(measure);
				observer.observe(node);
				return () => observer.disconnect();
			}, [report, okExpanded, logOpen, open]);

			/**
			 * T8: arm the next `status()` read.
			 *
			 * This is the single scheduling point for BOTH cadences: the 1 s
			 * in-flight poll and the slow idle watch are the same chained timer with
			 * a different delay, so they can never both be armed (the previous tick
			 * is always dropped first) and never overlap.
			 *
			 * @param settled - whether the last observed phase was settled.
			 * @param immediate - ask on the next tick instead of waiting (used when a
			 * tab becomes visible again, and to hand over to the in-flight cadence).
			 */
			const armStatus = React.useCallback((settled, immediate) => {
				if (timerRef.current !== null && timerRef.current !== undefined) {
					clearTimeout(timerRef.current);
					timerRef.current = null;
				}
				// Nothing owns the watch any more (unmounted, or the retry cap was hit).
				if (pollingRef.current !== true) return;
				const delay = immediate === true
					? 0
					: settled !== true
						? STATUS_POLL_MS
						: (pageHidden() === true ? IDLE_CHECK_HIDDEN_MS : IDLE_CHECK_MS);
				timerRef.current = setTimeout(() => {
					const run = refreshStatusRef.current;
					if (typeof run === "function") void run();
				}, delay);
			}, []);

			/**
			 * T8: keep the page's version watch alive after the progress view is left.
			 *
			 * T6 stopped the poll outright here; that is exactly the gap T7 found —
			 * an idle page stopped asking, so it could not notice an upgrade.
			 */
			const idleWatch = React.useCallback(() => {
				pollingRef.current = true;
				settledRef.current = true;
				armStatus(true);
			}, [armStatus]);

			// T6: read the running version once at startup and keep it in memory as
			// "the version this page was loaded against". The Remote contribution is
			// mounted fire-and-forget, so the namespace can still be absent here:
			// retry briefly, then keep looking slowly.
			//
			// T8: this first read is also the first link of the page-wide idle watch.
			// Once the baseline is adopted the chain is armed, so an idle page keeps
			// asking (slowly) instead of falling silent at load.
			React.useEffect(() => {
				let cancelled = false;
				let attempts = 0;
				const read = async () => {
					const namespace = resolveNamespace(ctx);
					if (namespace === undefined) {
						if (cancelled === true) return;
						// Fast retries while the mount settles, then the slow cadence.
						const delay = attempts < 20 ? 500 : IDLE_CHECK_MS;
						attempts += 1;
						handshakeTimerRef.current = setTimeout(() => { void read(); }, delay);
						return;
					}
					try {
						const answered = await namespace.status();
						if (cancelled === true || answered === undefined || answered.ok !== true) return;
						const value = answered.value ?? {};
						pollingRef.current = true;
						if (trackerRef.current.observe(value).reload === true) {
							pollingRef.current = false;
							return;
						}
						settledRef.current = SETTLED_PHASES.indexOf(String(value.phase ?? "idle")) >= 0;
						armStatus(settledRef.current);
					} catch (error) {
						// No baseline yet; try again at the slow cadence rather than
						// leaving the page with no watch at all.
						if (cancelled !== true) armStatus(true);
					}
				};
				void read();
				return () => {
					cancelled = true;
					if (handshakeTimerRef.current !== null && handshakeTimerRef.current !== undefined) {
						clearTimeout(handshakeTimerRef.current);
						handshakeTimerRef.current = null;
					}
				};
			}, [armStatus, ctx]);

			// T8: a tab that comes back to the foreground catches up at once; a tab
			// that goes to the background drops to the slow cadence. Both go through
			// `armStatus`, so neither can add a request on top of a running read.
			React.useEffect(() => {
				const onVisibility = () => {
					if (pollingRef.current !== true) return;
					if (pageHidden() === true) armStatus(settledRef.current);
					else armStatus(settledRef.current, true);
				};
				document.addEventListener("visibilitychange", onVisibility);
				return () => document.removeEventListener("visibilitychange", onVisibility);
			}, [armStatus]);

			// T8: the watch is armed for the life of the page, so unmount must disarm
			// it — otherwise a pending tick would read `status()` for a dead tree.
			React.useEffect(() => () => {
				pollingRef.current = false;
				if (timerRef.current !== null && timerRef.current !== undefined) {
					clearTimeout(timerRef.current);
					timerRef.current = null;
				}
			}, []);

			// T6: never leave the recovery panel behind on unmount.
			React.useEffect(() => () => {
				const mounted = offlineRef.current;
				offlineRef.current = null;
				if (mounted !== null && mounted !== undefined && typeof mounted.destroy === "function") mounted.destroy();
			}, []);

			// T8: `stopPolling` (T6) is gone. Leaving the progress view no longer
			// stops the status chain — it drops to the idle cadence (`idleWatch`),
			// because the chain is also the page's only way to notice an upgrade.
			// The one hard stop left is unmount, above.

			// ---- T6: version handshake + offline recovery --------------------

			/** Drop the offline recovery panel, if one is mounted. */
			const hideOffline = React.useCallback(() => {
				const mounted = offlineRef.current;
				offlineRef.current = null;
				if (mounted !== null && mounted !== undefined && typeof mounted.destroy === "function") mounted.destroy();
			}, []);

			/** The panel's "retry" only restarts this page's own poll. */
			const retryAfterOutage = React.useCallback(() => {
				trackerRef.current.resetOutage();
				retryRef.current = 0;
				pollingRef.current = true;
				if (typeof refreshStatusRef.current === "function") void refreshStatusRef.current();
			}, []);

			/**
			 * Mount the offline recovery panel.
			 *
			 * This path touches no Remote service at all — the server may not exist
			 * — and it is the only thing in this bundle that renders while
			 * `status()` is failing.
			 */
			const showOffline = React.useCallback(() => {
				if (offlineRef.current !== null && offlineRef.current !== undefined) return;
				const snapshot = trackerRef.current.snapshot();
				const mounted = mountOfflinePanel({
					t: typeof t === "function" ? t : undefined,
					jobId: snapshot.lastJobId,
					onRetry: retryAfterOutage,
				});
				offlineRef.current = mounted === undefined ? null : mounted;
			}, [retryAfterOutage, t]);

			/**
			 * Rebuild the progress view from `status()`.
			 *
			 * `status()` is a pure function of disk + probes (U-09), so polling it
			 * is exactly the documented reconnect story: nothing is carried in
			 * memory between calls. While the phase is in flight the cadence is 1 s;
			 * at a settled phase T8 drops it to the slow idle watch instead of
			 * stopping, because the same read is what detects that the server was
			 * replaced under the page.
			 */
			const refreshStatus = React.useCallback(async () => {
				// T8: one read at a time. A caller that arrives while a read is
				// running is coalesced into it (and re-asked right after), never
				// allowed to race it into a second request.
				if (statusBusyRef.current === true) {
					statusWakeRef.current = true;
					return;
				}
				statusBusyRef.current = true;
				// This read owns the chain now; drop any tick still armed so two
				// chains can never coexist.
				if (timerRef.current !== null && timerRef.current !== undefined) {
					clearTimeout(timerRef.current);
					timerRef.current = null;
				}
				try {
					const namespace = resolveNamespace(ctx);
					if (namespace === undefined) {
						setStatusFailure({ code: "update/namespace-missing", message: "remote.updateCenter is not mounted" });
						pollingRef.current = false;
						return;
					}
					/**
					 * Keep polling through a transient outage.
					 *
					 * A restart gap (`switched`/`restarting`) keeps T6's 1 s cadence,
					 * capped by STATUS_RETRY_MAX, so the offline recovery panel still
					 * arrives on time. A settled page is not in a gap: it waits for
					 * the next slow check instead of hammering a server that is down.
					 */
					const retry = (restarting) => {
						retryRef.current += 1;
						if (restarting === true) {
							if (pollingRef.current && retryRef.current <= STATUS_RETRY_MAX) armStatus(false);
							else pollingRef.current = false;
							return;
						}
						if (pollingRef.current) armStatus(true);
					};
					try {
						const answered = await namespace.status();
						if (answered === undefined || answered.ok !== true) {
							setStatusFailure(answered?.error ?? { code: "update/unknown", message: "empty answer" });
							// T6: an outage that began at a restart phase buys the offline
							// recovery panel after OFFLINE_AFTER_MS. Nothing else does.
							const verdict = trackerRef.current.fail();
							if (verdict.offline === true) showOffline();
							retry(verdict.restarting === true);
							return;
						}
						const value = answered.value ?? {};
						// T6: every successful answer runs the version handshake. A page
						// whose server was replaced under it reloads here, and nowhere else.
						if (trackerRef.current.observe(value).reload === true) {
							pollingRef.current = false;
							return;
						}
						hideOffline();
						// T8: an idle tick often answers exactly what is already on screen;
						// re-rendering for it would be pure churn.
						const key = JSON.stringify(value);
						if (liveKeyRef.current !== key) {
							liveKeyRef.current = key;
							setLive(value);
						}
						setStatusFailure(undefined);
						retryRef.current = 0;
						const settled = SETTLED_PHASES.indexOf(String(value.phase)) >= 0;
						settledRef.current = settled;
						armStatus(settled);
					} catch (error) {
						setStatusFailure({
							code: "update/unknown",
							message: error instanceof Error ? error.message : String(error),
						});
						const verdict = trackerRef.current.fail();
						if (verdict.offline === true) showOffline();
						retry(verdict.restarting === true);
					}
				} finally {
					statusBusyRef.current = false;
					if (statusWakeRef.current === true) {
						statusWakeRef.current = false;
						armStatus(settledRef.current, true);
					}
				}
			}, [armStatus, ctx, hideOffline, showOffline]);

			// The panel's retry must reach the newest poll, whatever else changed.
			React.useEffect(() => {
				refreshStatusRef.current = refreshStatus;
			}, [refreshStatus]);

			/** Enter the progress view for one job and start polling its status. */
			const startProgress = React.useCallback((jobId) => {
				setProgress(jobId === undefined || jobId === "" ? undefined : { jobId: String(jobId) });
				setStatusFailure(undefined);
				setView("progress");
				setLive(undefined);
				pollingRef.current = true;
				void refreshStatus();
			}, [refreshStatus]);

			const check = React.useCallback(
				async (force) => {
					setBusy(true);
					setStatus("checking");
					setFailure(undefined);
					const namespace = resolveNamespace(ctx);
					if (namespace === undefined) {
						setBusy(false);
						setFailure({ code: "update/namespace-missing", message: "remote.updateCenter is not mounted" });
						setStatus("error");
						return;
					}
					try {
						// Exactly one argument: the generated descriptor declares one
						// (optional) parameter and the gateway counts arity strictly.
						const answered = await namespace.versions(force === true ? { force: true } : undefined);
						if (answered === undefined || answered.ok !== true) {
							setFailure(answered?.error ?? { code: "update/unknown", message: "empty answer" });
							setStatus("error");
						} else {
							const value = answered.value ?? {};
							const candidates = newestFirst(Array.isArray(value.candidates) ? value.candidates : []);
							setResult({ ...value, candidates });
							setSelected(candidates[0]?.version);
							setStatus(candidates.length > 0 ? "available" : "latest");
						}
					} catch (error) {
						setFailure({
							code: "update/unknown",
							message: error instanceof Error ? error.message : String(error),
						});
						setStatus("error");
					} finally {
						setBusy(false);
					}
				},
				[ctx],
			);

			/**
			 * One `preflight` round-trip through the lazily resolved namespace.
			 *
			 * The `return await namespace.preflight(...)` line is the WP4 smoke
			 * harness's fixture seam: `scripts/wp4-ui-smoke.mjs` copies this bundle
			 * into a throwaway profile and rewrites exactly that statement to answer
			 * a literal report, so the report view can be exercised deterministically
			 * without a live registry. The shipped bundle always calls the Remote.
			 */
			const requestPreflight = React.useCallback(
				async (version) => {
					const namespace = resolveNamespace(ctx);
					if (namespace === undefined) {
						return {
							ok: false,
							error: { code: "update/namespace-missing", message: "remote.updateCenter is not mounted" },
						};
					}
					return await namespace.preflight({ version });
				},
				[ctx],
			);

			/** Run preflight for one version and switch the dialog to its report. */
			const runPreflight = React.useCallback(
				async (version) => {
					if (typeof version !== "string" || version === "") return;
					setPreflighting(true);
					setReportFailure(undefined);
					setProgress(undefined);
					try {
						const answered = await requestPreflight(version);
						if (answered === undefined || answered.ok !== true) {
							setReportFailure(answered?.error ?? { code: "update/unknown", message: "empty answer" });
							setView("versions");
						} else {
							setReport(answered.value ?? {});
							setOkExpanded(false);
							setLogOpen(false);
							setView("report");
						}
					} catch (error) {
						setReportFailure({
							code: "update/unknown",
							message: error instanceof Error ? error.message : String(error),
						});
						setView("versions");
					} finally {
						setPreflighting(false);
					}
				},
				[requestPreflight],
			);

			/** Leave the progress/report view without touching anything on disk. */
			const back = React.useCallback(() => {
				// T8: leaving the view returns the page to the slow version watch,
				// it does not switch the watch off.
				liveKeyRef.current = undefined;
				idleWatch();
				setView("versions");
				setReportFailure(undefined);
				setStatusFailure(undefined);
				setProgress(undefined);
				setLive(undefined);
			}, [idleWatch]);

			/** Cancel the second stage: closes it, never reaches `apply` (UI-03). */
			const cancelConfirm = React.useCallback(() => {
				setConfirming(false);
				const node = isolateRef.current;
				if (node !== null && node !== undefined && typeof node.focus === "function") {
					requestAnimationFrame(() => node.focus());
				}
			}, []);

			/**
			 * The D3 second stage's only write path: `apply` with the operator's
			 * isolation consent and the report id the host bound in `preflight`.
			 * A refusal is rendered verbatim by the §5 map and writes nothing.
			 */
			const proceedIsolate = React.useCallback(async () => {
				if (report === undefined) return;
				setApplying(true);
				setReportFailure(undefined);
				try {
					const namespace = resolveNamespace(ctx);
					if (namespace === undefined) {
						setReportFailure({
							code: "update/namespace-missing",
							message: "remote.updateCenter is not mounted",
						});
						setConfirming(false);
						return;
					}
					const answered = await namespace.apply({
						reportId: String(report.id ?? ""),
						isolateBlocked: true,
					});
					if (answered === undefined || answered.ok !== true) {
						setReportFailure(answered?.error ?? { code: "update/unknown", message: "empty answer" });
					} else {
						setConfirming(false);
						startProgress(String(answered.value?.jobId ?? ""));
						return;
					}
					setConfirming(false);
				} catch (error) {
					setReportFailure({
						code: "update/unknown",
						message: error instanceof Error ? error.message : String(error),
					});
					setConfirming(false);
				} finally {
					setApplying(false);
				}
			}, [ctx, report, startProgress]);

			/**
			 * The non-blocked report's primary action: `apply` with
			 * `isolateBlocked:false` (nothing to isolate) and then the WP8 progress
			 * view, which is driven purely by `status()`.
			 */
			const proceedApply = React.useCallback(async () => {
				if (report === undefined) return;
				setApplying(true);
				setReportFailure(undefined);
				try {
					const namespace = resolveNamespace(ctx);
					if (namespace === undefined) {
						setReportFailure({
							code: "update/namespace-missing",
							message: "remote.updateCenter is not mounted",
						});
						return;
					}
					const answered = await namespace.apply({
						reportId: String(report.id ?? ""),
						isolateBlocked: false,
					});
					if (answered === undefined || answered.ok !== true) {
						setReportFailure(answered?.error ?? { code: "update/unknown", message: "empty answer" });
					} else {
						startProgress(String(answered.value?.jobId ?? ""));
					}
				} catch (error) {
					setReportFailure({
						code: "update/unknown",
						message: error instanceof Error ? error.message : String(error),
					});
				} finally {
					setApplying(false);
				}
			}, [ctx, report, startProgress]);

			/**
			 * Page-reconnect path: ask `status()` once when the panel opens and, if
			 * a job is already on disk, rebuild the progress view from it.
			 *
			 * T8: this read shares the page-wide single-flight latch with the idle
			 * watch, so opening the panel during an idle tick can never stack a
			 * second request, and it hands the watch over to the in-flight cadence
			 * (or back to the slow one) instead of switching it off.
			 */
			const resumeProgress = React.useCallback(async () => {
				if (statusBusyRef.current === true) {
					statusWakeRef.current = true;
					return;
				}
				const namespace = resolveNamespace(ctx);
				if (namespace === undefined) return;
				statusBusyRef.current = true;
				pollingRef.current = true;
				let settled = settledRef.current;
				try {
					const answered = await namespace.status();
					if (answered === undefined || answered.ok !== true) return;
					const value = answered.value ?? {};
					liveKeyRef.current = JSON.stringify(value);
					setLive(value);
					settled = SETTLED_PHASES.indexOf(String(value.phase)) >= 0;
					settledRef.current = settled;
					if (JOB_PHASES.indexOf(String(value.phase)) < 0) return;
					setProgress(value.jobId === undefined ? undefined : { jobId: String(value.jobId) });
					setView("progress");
					setStatusFailure(undefined);
				} catch (error) {
					console.error(LOG, "resuming the update progress failed", error);
				} finally {
					statusBusyRef.current = false;
					statusWakeRef.current = false;
					armStatus(settled);
				}
			}, [armStatus, ctx]);

			/**
			 * D4 / I5: the restart is a user gesture, never an automatic consequence
			 * of reaching `switched`. This callback IS the click.
			 */
			const doRestart = React.useCallback(async () => {
				setActing(true);
				setStatusFailure(undefined);
				try {
					const namespace = resolveNamespace(ctx);
					if (namespace === undefined) {
						setStatusFailure({ code: "update/namespace-missing", message: "remote.updateCenter is not mounted" });
						return;
					}
					const answered = await namespace.restart();
					if (answered === undefined || answered.ok !== true) {
						setStatusFailure(answered?.error ?? { code: "update/unknown", message: "empty answer" });
						return;
					}
					pollingRef.current = true;
					void refreshStatus();
				} catch (error) {
					setStatusFailure({
						code: "update/unknown",
						message: error instanceof Error ? error.message : String(error),
					});
				} finally {
					setActing(false);
				}
			}, [ctx, refreshStatus]);

			/** ux-spec §6: rollback, after the second-stage confirmation. */
			const doRollback = React.useCallback(async () => {
				setActing(true);
				setStatusFailure(undefined);
				try {
					const namespace = resolveNamespace(ctx);
					if (namespace === undefined) {
						setStatusFailure({ code: "update/namespace-missing", message: "remote.updateCenter is not mounted" });
						return;
					}
					const answered = await namespace.rollback();
					if (answered === undefined || answered.ok !== true) {
						setStatusFailure(answered?.error ?? { code: "update/unknown", message: "empty answer" });
						return;
					}
					setConfirmAction(undefined);
					setView("progress");
					setProgress(undefined);
					setLive(undefined);
					pollingRef.current = true;
					void refreshStatus();
				} catch (error) {
					setStatusFailure({
						code: "update/unknown",
						message: error instanceof Error ? error.message : String(error),
					});
				} finally {
					setActing(false);
				}
			}, [ctx, refreshStatus]);

			/** ux-spec §6: restore the isolated plugins' `cordis.patch.yml`, after confirmation. */
			const doRestorePatch = React.useCallback(async () => {
				setActing(true);
				setStatusFailure(undefined);
				try {
					const namespace = resolveNamespace(ctx);
					if (namespace === undefined) {
						setStatusFailure({ code: "update/namespace-missing", message: "remote.updateCenter is not mounted" });
						return;
					}
					const answered = await namespace.restorePatch();
					if (answered === undefined || answered.ok !== true) {
						setStatusFailure(answered?.error ?? { code: "update/unknown", message: "empty answer" });
						return;
					}
					setConfirmAction(undefined);
					void refreshStatus();
				} catch (error) {
					setStatusFailure({
						code: "update/unknown",
						message: error instanceof Error ? error.message : String(error),
					});
				} finally {
					setActing(false);
				}
			}, [ctx, refreshStatus]);

			/** Failed phase's retry: run the candidate through preflight again. */
			const retryFailed = React.useCallback(() => {
				const version = String(live?.version ?? report?.version ?? selected ?? "");
				// T8: the version watch survives leaving the progress view.
				liveKeyRef.current = undefined;
				idleWatch();
				if (version === "") {
					void check(true);
					return;
				}
				void runPreflight(version);
			}, [live, report, selected, check, runPreflight, idleWatch]);

			// Dialog close runs for Esc, the mask, and the footer/close buttons alike, so
			// the focus restore lives here rather than in one key handler.
			const close = React.useCallback(() => {
				liveKeyRef.current = undefined;
				idleWatch();
				setOpen(false);
				setConfirming(false);
				setConfirmAction(undefined);
				setView("versions");
				setReportFailure(undefined);
				setStatusFailure(undefined);
				setProgress(undefined);
				setLive(undefined);
				const node = triggerRef.current;
				if (node !== null && node !== undefined && typeof node.focus === "function") {
					requestAnimationFrame(() => node.focus());
				}
			}, [idleWatch]);

			// Esc reaches BOTH stacked dialogs (each `Modal` listens on document). The
			// first stage therefore treats "a confirmation is open" as "close only the
			// confirmation", so one Esc dismisses the second stage — not the report.
			const requestClose = React.useCallback(() => {
				if (confirmAction !== undefined) {
					setConfirmAction(undefined);
					return;
				}
				if (confirming) {
					setConfirming(false);
					return;
				}
				close();
			}, [confirming, confirmAction, close]);

			const openPanel = () => {
				setOpen(true);
				if (status === "unknown") void check(false);
				// Reconnect rebuild: if a job is already on disk, show its progress
				// instead of pretending the update never happened (ux-spec §4).
				if (view === "versions") void resumeProgress();
			};

			const current = result?.current;
			const candidates = result?.candidates ?? [];
			const distTags = result?.distTags ?? {};
			const rows = [];
			for (const item of candidates) rows.push(normalizeRow(item, current?.version, distTags));
			if (current !== undefined && !rows.some((item) => item.isCurrent === true || item.version === current.version)) {
				// The host lists only candidates strictly newer than the current
				// install, so the current row is synthesized here to keep the
				// `= current` reference visible (design/ux-spec.md §2).
				rows.push(normalizeRow({
					version: current.version,
					publishedAt: "",
					isCurrent: true,
				}, current.version, distTags));
			}
			const selectedItem = candidates.find((item) => item.version === selected);

			// ux-spec §1: a job in flight spins the entry icon and its tooltip says so.
			const jobRunning = acting === true || (live !== undefined && ACTIVE_PHASES.indexOf(String(live.phase ?? "")) >= 0);

			const label = t("update.button.label");
			const tooltip =
				jobRunning
					? t("update.button.tooltip.running")
					: status === "latest"
						? t("update.button.tooltip.latest", { version: current?.version ?? "" })
						: status === "available"
							? t("update.button.tooltip.available", { count: candidates.length, version: candidates[0]?.version ?? "" })
							: status === "error"
								? t("update.button.tooltip.failed")
								: status === "checking"
									? t("update.button.tooltip.checking")
									: t("update.button.tooltip.unknown");

			const badge =
				status === "available" && candidates.length > 0
					? h(
						"span",
						{ className: "uc_dot uc_dotCount", "data-uc-badge": "available", "aria-hidden": "true" },
						candidates.length > 9 ? "9+" : String(candidates.length),
					)
					: status === "error"
						? h(
							"span",
							{
								className: "uc_dot uc_dotError",
								"data-uc-badge": "error",
								title: t("update.button.dotFailed"),
								"aria-hidden": "true",
							},
							h(IconWarningOutline16, { size: 12 }),
						)
						: null;

			const button = h(
				"button",
				{
					type: "button",
					ref: triggerRef,
					className: "uc_button",
					onClick: openPanel,
					"aria-label": `${label} — ${tooltip}`,
					"aria-haspopup": "dialog",
					"aria-expanded": open ? "true" : "false",
					title: tooltip,
					"data-uc-entry": ENTRY_ID,
					"data-uc-state": status,
					...(candidates.length > 0 ? { "data-uc-count": String(candidates.length) } : {}),
					...(busy || jobRunning ? { "data-uc-busy": "true" } : {}),
				},
				h("span", { className: `uc_icon${busy || jobRunning ? " uc_spin" : ""}` }, h(IconRefreshOutline16, { size: wide ? 16 : 18 })),
				wide ? h("span", { className: "uc_label" }, label) : null,
				badge,
			);

			const facts =
				current === undefined
					? null
					: h(
						"div",
						{ className: "uc_facts", "data-uc-current-version": current.version },
						h("div", { className: "uc_fact" }, h("span", { className: "uc_factKey" }, t("update.current")), h("span", { className: "uc_factValue" }, `v${current.version}`)),
						current.channel === undefined || current.channel === ""
							? null
							: h("div", { className: "uc_fact" }, h("span", { className: "uc_factKey" }, t("update.channel")), h("span", { className: "uc_factValue" }, current.channel)),
						current.prefix === undefined || current.prefix === ""
							? null
							: h("div", { className: "uc_fact" }, h("span", { className: "uc_factKey" }, t("update.installPrefix")), h("span", { className: "uc_factValue", title: current.prefix }, current.prefix)),
					);

			// ---- WP4 report, second stage, and the §5 error bar ------------------

			/** The §5 error bar: mapped copy, suggested action, and a scoped retry. */
			const errorBar = (record, retry) => {
				if (record === undefined) return null;
				// `update/blocked` means "a block needs your decision": its suggested
				// action ("查看报告") becomes a button that takes the operator back to
				// the retained report instead of only offering a retry.
				const backToReport = record.code === "update/blocked" && report !== undefined;
				const actionText = failureActionText(record, t);
				const retryLabel = t("update.action.retry");
				const retryDisabled = busy || preflighting || applying;
				// N1: when the mapped §5 action IS the retry copy (an unmapped code such
				// as `update/network` falls through to `update.errorAction.unknown` =
				// "重试"), the static `.uc_errorAction` span and the scoped retry button
				// printed "重试" twice and stranded the second copy on its own wrapped
				// line (S6d/S6e/S6f all show 2 nodes). Action and control are the same
				// thing there, so they merge into ONE button carrying both hooks.
				const retryIsAction = !backToReport && actionText === retryLabel;
				const action = backToReport
					? h(
						Button,
						{
							variant: "ghost",
							size: "sm",
							onClick: () => {
								setReportFailure(undefined);
								setView("report");
							},
							"data-uc-error-action": record.code,
							"data-uc-view-report": "",
						},
						actionText,
					)
					: retryIsAction
						? h(
							Button,
							{
								variant: "ghost",
								size: "sm",
								onClick: retry,
								disabled: retryDisabled,
								"data-uc-error-action": record.code,
								"data-uc-retry": "",
							},
							retryLabel,
						)
						: h("span", { className: "uc_errorAction", "data-uc-error-action": record.code }, actionText);
				return h(
					"div",
					{ className: "uc_errorBar", role: "alert", "data-uc-error": record.code },
					h(IconWarningOutline16, { size: 14 }),
					h("span", null, failureText(record, t)),
					action,
					retryIsAction
						? null
						: h(
							Button,
							{
								variant: "ghost",
								size: "sm",
								onClick: retry,
								disabled: retryDisabled,
								"data-uc-retry": "",
							},
							retryLabel,
						),
				);
			};

			const groups = report === undefined ? undefined : groupItems(report);
			const isolatable = report === undefined ? [] : isolatableItems(report);
			const unisolatable = report === undefined ? [] : unisolatableBlocks(report);
			const verdict =
				report?.verdict === "ok" || report?.verdict === "warn" || report?.verdict === "blocked"
					? report.verdict
					: "warn";
			// `groups` is undefined until a report exists, so the count is guarded:
			// this component renders (as the sidebar entry) long before any preflight.
			const verdictCount =
				report === undefined || groups === undefined
					? 0
					: verdict === "blocked"
						? groups.block.length
						: verdict === "warn"
							? groups.warn.length
							: 0;
			const canIsolate = verdict === "blocked" && isolatable.length > 0 && unisolatable.length === 0;

			// ---- WP8 progress view (all of it is rebuilt from `status()`) --------
			const liveSteps = live === undefined ? [] : progressSteps(live);
			const isolated = live === undefined ? [] : isolatedPlugins(live);
			const livePhase = String(live?.phase ?? "idle");
			const banner = live === undefined ? undefined : progressBanner(live, t);
			const jobLog = String(live?.logTail ?? "");
			const progressError =
				statusFailure !== undefined
					? statusFailure
					: live?.error === undefined
						? undefined
						: { code: String(live.error.code), message: String(live.error.message), stage: String(live.error.stage) };
			const canRollbackNow = live?.canRollback === true;
			const patchBackup = live?.patchBackup === undefined ? undefined : String(live.patchBackup);
			const targetVersion = String(live?.version ?? report?.version ?? progress?.jobId ?? "");
			const jobIdText = String(live?.jobId ?? progress?.jobId ?? "");

			const reportBody =
				report === undefined
					? null
					: h(
						"div",
						{
							className: "uc_panel",
							"data-uc-panel": "",
							"data-uc-view": "report",
							"data-uc-report-version": String(report.version ?? ""),
							"data-uc-report-id": String(report.id ?? ""),
							"aria-label": t("update.a11y.report"),
						},
						errorBar(reportFailure, () => void runPreflight(report.version ?? selected)),
						h(
							"div",
							{ className: "uc_reportTitle", "data-uc-report-title": "" },
							t("update.report.title", { version: String(report.version ?? "") }),
						),
						h(
							"div",
							{ className: "uc_verdict", "data-uc-verdict": verdict, role: "status" },
							h("span", { "aria-hidden": "true" }, verdict === "blocked" ? "✖" : verdict === "warn" ? "⚠" : "✔"),
							h("span", { "data-uc-verdict-text": "" }, t(VERDICT_KEYS[verdict], { count: verdictCount })),
						),
						h(
							"div",
							{ className: "uc_reportScroll", "data-uc-report": "", ref: reportScrollRef },
							GROUP_ORDER.map((severity) =>
								groups[severity].length === 0
									? null
									: h(GroupSection, {
										key: severity,
										severity,
										items: groups[severity],
										t,
										collapsed: severity === "ok" && okExpanded !== true,
										onToggle: () => setOkExpanded((value) => !value),
									}),
							),
						),
						reportOverflow
							? h(
								"p",
								{ className: "uc_scrollHint", "data-uc-scroll-hint": "", role: "note" },
								t("update.report.scrollHint"),
							)
							: null,
						h(StagingLine, {
							staging: report.staging,
							t,
							logOpen,
							onToggleLog: () => setLogOpen((value) => !value),
						}),
						progress === undefined
							? null
							: h(
								"p",
								{ className: "uc_note", "data-uc-progress-placeholder": String(progress.jobId ?? "") },
								t("update.report.progressPlaceholder", { jobId: String(progress.jobId ?? "") }),
							),
					);

			const reportFooter = h(
				"div",
				{ className: "uc_footerStack" },
				unisolatable.length > 0
					? h(
						"p",
						{ className: "uc_warn", "data-uc-unfixable-note": "" },
						t("update.report.unfixableNote", { count: unisolatable.length }),
					)
					: null,
				verdict === "blocked" && isolatable.length === 0
					? h("p", { className: "uc_note", "data-uc-nothing-to-isolate": "" }, t("update.report.nothingToIsolate"))
					: null,
				h(
					"div",
					{ className: "uc_actionsSplit" },
					h(Button, { variant: "ghost", size: "sm", onClick: back, "data-uc-back": "" }, t("update.report.back")),
					h(
						"div",
						{ className: "uc_actions" },
						h(
							Button,
							{ variant: "ghost", size: "sm", onClick: close, "data-uc-report-cancel": "" },
							t("update.action.cancel"),
						),
						verdict === "blocked"
							? h(
								Button,
								{
									variant: "primary",
									size: "sm",
									ref: isolateRef,
									disabled: canIsolate !== true || preflighting || applying,
									onClick: () => setConfirming(true),
									"data-uc-isolate": "",
									...(canIsolate
										? {}
										: {
											title: unisolatable.length > 0
												? t("update.report.unfixableNote", { count: unisolatable.length })
												: t("update.report.nothingToIsolate"),
										}),
								},
								t("update.action.isolate"),
							)
							: h(
								// WP8: the non-blocked report's primary action is now the
								// real `apply` (reportId-bound, isolateBlocked:false),
								// which hands over to the status()-driven progress view.
								Button,
								{
									variant: "primary",
									size: "sm",
									disabled: preflighting || applying,
									onClick: () => void proceedApply(),
									"data-uc-apply": "",
								},
								applying === true ? t("update.confirm.applying") : t("update.action.apply"),
							),
					),
				),
			);

			// D8: with no selectable candidate the preflight action cannot run, so the
			// panel's real primary action is "检查更新" and the inert preflight control
			// must not masquerade as a broken (grey-on-grey) primary button.
			const selectable = selectedItem !== undefined;
			const versionsFooter = h(
				"div",
				{ className: "uc_actions" },
				h(
					Button,
					{
						variant: selectable ? "ghost" : "primary",
						size: "sm",
						onClick: () => void check(true),
						disabled: busy || preflighting,
						"data-uc-check": "",
					},
					t("update.action.check"),
				),
				// WP8: `canRollback` (from status()) is the only thing that enables
				// this; the confirmation is the second stage (ux-spec §6).
				h(
					Button,
					{
						variant: "ghost",
						size: "sm",
						disabled: live?.canRollback !== true || acting,
						...(live?.canRollback === true ? {} : { title: t("update.action.rollbackPlaceholder") }),
						onClick: () => setConfirmAction("rollback"),
						"data-uc-rollback": "",
					},
					t("update.action.rollback"),
				),
				h(
					Button,
					{
						variant: selectable ? "primary" : "ghost",
						size: "sm",
						disabled: selectable !== true || busy || preflighting,
						onClick: () => void runPreflight(selected),
						"data-uc-preflight": "",
					},
					preflighting ? t("update.status.preflighting") : t("update.action.preflight"),
				),
			);

			const body = h(
				"div",
				{ className: "uc_panel", "data-uc-panel": "", "data-uc-state": status, "aria-label": t("update.a11y.panel") },
				errorBar(
					failure ?? reportFailure,
					failure !== undefined ? () => void check(true) : () => void runPreflight(selected),
				),
				facts,
				busy && result === undefined ? h("p", { className: "uc_note", "data-uc-loading": "" }, t("update.status.loading")) : null,
				busy && result !== undefined ? h("p", { className: "uc_note", "data-uc-checking": "" }, t("update.status.busy")) : null,
				h("div", { className: "uc_listHead" }, t("update.list.title")),
				candidates.length === 0 && result !== undefined
					? h("p", { className: "uc_empty", "data-uc-empty": "" }, t("update.list.empty"))
					: null,
				rows.length === 0
					? null
					: h(
						"ul",
						{ className: "uc_list", "data-uc-list": "" },
						rows.map((item) =>
							h(VersionRow, {
								key: item.version,
								item,
								isCurrent: item.isCurrent === true,
								selected: item.isCurrent === true ? false : item.version === selected,
								onSelect: setSelected,
								t,
								now: Date.now(),
							}),
						),
					),
				selectedItem?.prerelease === true
					? h("p", { className: "uc_warn", "data-uc-warn": "prerelease" }, t("update.warn.prerelease"))
					: null,
				result?.fetchedAt === undefined
					? null
					: h("p", { className: "uc_note", "data-uc-fetched-at": result.fetchedAt }, t("update.fetchedAt", { time: publishedText(result.fetchedAt, t, Date.now()) ?? result.fetchedAt })),
			);

			const showReport = view === "report" && reportBody !== null;

			// The progress face: a step bar aligned to the state machine, the
			// phase banner, the isolated-plugin list with the REAL backup path from
			// `status.patchBackup`, and the job log tail (ux-spec §4/§6).
			const progressBody = h(
				"div",
				{
					className: "uc_panel",
					"data-uc-panel": "",
					"data-uc-view": "progress",
					"data-uc-progress": "",
					"data-uc-progress-phase": livePhase,
					"aria-label": t("update.a11y.progress"),
				},
				errorBar(progressError, () => void refreshStatus()),
				h(
					"div",
					{ className: "uc_progress" },
					h(
						"div",
						{ className: "uc_progressHead" },
						h("div", { className: "uc_reportTitle", "data-uc-progress-title": "" }, t("update.progress.title")),
						targetVersion === ""
							? null
							: h(
								"span",
								{ className: "uc_phase", "data-uc-progress-version": targetVersion },
								t("update.progress.version", { version: targetVersion }),
							),
						h("span", { className: "uc_phase", "data-uc-progress-phase-text": livePhase }, t("update.progress.phase", { phase: phaseText(livePhase, t) })),
					),
					h(
						"ul",
						{ className: "uc_steps", "data-uc-steps": "" },
						liveSteps.map((step) =>
							h(
								"li",
								{
									key: step.id,
									className: "uc_step",
									"data-uc-step": step.id,
									"data-uc-step-state": step.state,
									...(step.current ? { "data-uc-current": "true" } : {}),
								},
								h("span", { className: "uc_stepMark", "aria-hidden": "true" }, STEP_MARKS[step.state] ?? "○"),
								h(
									"span",
									{ className: "uc_stepBody" },
									h("span", { className: "uc_stepLabel" }, t(step.key)),
									step.detail === undefined
										? null
										: h("span", { className: "uc_stepText", "data-uc-step-detail": step.id }, step.detail),
									h(
										"span",
										{ className: "uc_stepText", "data-uc-step-state-text": step.state },
										t(`update.progress.state.${step.state}`),
									),
								),
							),
						),
					),
					banner === undefined
						? null
						: h("p", { className: "uc_banner", "data-uc-banner": banner.kind, "data-uc-banner-text": "" }, banner.text),
					jobIdText === ""
						? null
						: h("p", { className: "uc_note", "data-uc-job": jobIdText }, t("update.progress.job", { jobId: jobIdText })),
					h("div", { className: "uc_sectionHead", "data-uc-isolated-head": "" }, t("update.progress.isolated", { count: isolated.length })),
					isolated.length === 0
						? h("p", { className: "uc_note", "data-uc-isolated-empty": "" }, t("update.progress.isolatedEmpty"))
						: h(
							"ul",
							{ className: "uc_isolated", "data-uc-isolated": "" },
							isolated.map((item, index) =>
								h(
									"li",
									{
										key: `${String(item.rule ?? "?")}:${String(item.target ?? "?")}:${index}`,
										className: "uc_isolatedItem",
										"data-uc-isolated-item": String(item.target ?? ""),
									},
									h("span", { className: "uc_isolatedName" }, String(item.target ?? "")),
									h(Tag, { tone: "outline" }, String(item.rule ?? "?")),
								),
							),
						),
					patchBackup === undefined
						? null
						: h(
							"div",
							{ className: "uc_backup", "data-uc-patch-backup-row": "" },
							h("span", { className: "uc_factKey" }, t("update.progress.patchBackup")),
							h("code", { className: "uc_path", "data-uc-patch-backup": "" }, patchBackup),
						),
					patchBackup === undefined
						? null
						: h("p", { className: "uc_note", "data-uc-restore-note": "" }, t("update.progress.restoreNote")),
					h("div", { className: "uc_sectionHead" }, t("update.progress.log")),
					h("pre", { className: "uc_log", "data-uc-job-log": "" }, jobLog === "" ? t("update.progress.logEmpty") : jobLog),
				),
			);

			const progressFooter = h(
				"div",
				{ className: "uc_footerStack" },
				livePhase === "rollback-failed"
					? h(
						"p",
						{ className: "uc_alarm", role: "alert", "data-uc-rollback-alarm": "" },
						h(IconWarningOutline16, { size: 14 }),
						t("update.progress.rollbackFailed"),
					)
					: null,
				h(
					"div",
					{ className: "uc_actionsSplit" },
					h(Button, { variant: "ghost", size: "sm", onClick: back, "data-uc-back": "" }, t("update.report.back")),
					h(
						"div",
						{ className: "uc_actions" },
						livePhase === "failed"
							? h(
								Button,
								{ variant: "ghost", size: "sm", disabled: busy || acting, onClick: () => void retryFailed(), "data-uc-retry": "" },
								t("update.action.retry"),
							)
							: null,
						canRollbackNow
							? h(
								Button,
								{ variant: "ghost", size: "sm", disabled: acting, onClick: () => setConfirmAction("rollback"), "data-uc-rollback": "" },
								t("update.action.rollback"),
							)
							: null,
						patchBackup === undefined
							? null
							: h(
								Button,
								{ variant: "ghost", size: "sm", disabled: acting, onClick: () => setConfirmAction("restore"), "data-uc-restore-patch": "" },
								t("update.action.restorePatch"),
							),
						// D4: the ONLY restart affordance, and it is a click.
						livePhase === "switched"
							? h(
								Button,
								{ variant: "primary", size: "sm", disabled: acting, onClick: () => void doRestart(), "data-uc-restart": "" },
								t("update.action.restart"),
							)
							: null,
						h(Button, { variant: "ghost", size: "sm", onClick: close, "data-uc-progress-close": "" }, t("update.action.close")),
					),
				),
			);

			const showProgress = view === "progress";

			const panel = h(
				Modal,
				{
					open,
					onClose: requestClose,
					title: t("update.title"),
					closeLabel: t("update.action.close"),
					footer: showProgress ? progressFooter : showReport ? reportFooter : versionsFooter,
				},
				showProgress ? progressBody : showReport ? reportBody : body,
			);

			// Rendered AFTER the panel so the second stage's portal lands later in
			// `<body>` and therefore paints on top of the report dialog.
			const confirmDialog = h(IsolateConfirm, {
				open: confirming,
				version: String(report?.version ?? selected ?? ""),
				isolatable,
				unisolatable,
				applying,
				t,
				onCancel: cancelConfirm,
				onProceed: () => void proceedIsolate(),
			});

			// WP8's second stage for the two progress-view writes (ux-spec §6).
			const progressConfirm = h(ActionConfirm, {
				open: confirmAction !== undefined,
				kind: confirmAction,
				version: targetVersion,
				backupPath: patchBackup,
				busy: acting,
				t,
				onCancel: () => setConfirmAction(undefined),
				onProceed: () => {
					if (confirmAction === "rollback") void doRollback();
					else if (confirmAction === "restore") void doRestorePatch();
				},
			});

			return h(
				"div",
				{ className: wide ? "uc_entry" : "uc_entry uc_entryRail" },
				wide ? button : h(Tooltip, { label: tooltip, side: "bottom", delayMs: 500 }, button),
				panel,
				confirmDialog,
				progressConfirm,
			);
		}

		// ---- plugin body -------------------------------------------------------

		/**
		 * Services this client half needs, by SERVICE NAME:
		 *   slots   — the sidebar footer action slot.
		 *   locale  — dictionary registration for the `update-center` namespace.
		 *   remote  — `ctx.remote.$mount(...)` for this package's contribution.
		 * `remote.updateCenter` is deliberately absent: this plugin creates that
		 * namespace, so injecting it would deadlock boot (see the file header).
		 */
		const inject = ["slots", "locale", "remote"];

		/** Mount the typed-remote contribution and register the footer entry. */
		function apply(ctx) {
			try {
				// Fire-and-forget: `$mount` settles through the gateway's enqueue
				// queue, and awaiting it here parks UI registration (R1 §3.2).
				const mounting = ctx.remote.$mount(TYPERT_REMOTE);
				if (mounting !== undefined && typeof mounting.catch === "function") {
					mounting.catch((error) => {
						console.error(LOG, "mounting the updateCenter Remote contribution failed", error);
					});
				}

				ctx.effect(() => ctx.locale.register(NS, { zh, en }), "update-center: dictionaries");

				ctx.slots.inject(SLOT, () =>
					ctx.slots.register(
						{
							name: SLOT,
							id: ENTRY_ID,
							order: 0,
							locale: NS,
							inject: () => ({ ctx }),
						},
						UpdateEntry,
					),
				);

				console.log(LOG, "client half loaded: sidebar entry + version panel registered");
			} catch (error) {
				console.error(LOG, "apply failed", error);
			}
		}

		// Module-body side effect: runs at materialization, i.e. before
		// `claimStyles(id)` records this module's owned style tags.
		ensureStyle();

		exports.apply = apply;
		exports.inject = inject;
		// Test seam only: `scripts/verify-client-bundle.mjs` compares this against the
		// generated `lib/typert.remote-client.js` so the two faces cannot drift.
		exports.__contribution = TYPERT_REMOTE;
		// T6 seam-gated internals: this handle exists ONLY when a harness set
		// `window.__PERSE_UPDATER_TEST__` before loading the bundle. A shipped page
		// never sets it, so production has no way to reach these functions, and the
		// reload/clock substitution in `testSeam()` is likewise unreachable there.
		if (testSeam() !== undefined) {
			exports.__internals = {
				createStatusTracker,
				mountOfflinePanel,
				copyNodeText,
				offlineText,
				OFFLINE_AFTER_MS,
				RECOVERY_COMMAND,
				RECOVERY_VERSION_COMMAND,
			};
		}
		return module.exports;
	}
});

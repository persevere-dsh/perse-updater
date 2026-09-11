# perse-updater — 安全地把 DSH 带到下一个版本

**perse-updater** 是 DSH 的版本更新插件：发现候选版本、预检、暂存与验证，然后把
启动器切换到已通过验证的构建；任何一步失败都可以回滚。

属于 **Persevere with DSH** 插件合集，短称 **perse**（*perse* = *persevere*，即"坚持"）。

---

## 它做什么

| 阶段 | 保证 |
|------|------|
| **发现** | 从 npm 注册表（默认 `https://registry.npmjs.org`）解析版本并读取候选的依赖闭包。 |
| **预检** | 候选不安全就拒绝动安装：契约扫描、farm/isolate 检查、磁盘预算、补丁冲突规则。 |
| **暂存 + 验证** | 把候选装进带版本号的暂存目录，切换前先验证。 |
| **切换** | 原子地把启动器软链（默认 `~/.local/bin/dsh`）指向已验证目录。 |
| **回滚** | 每个任务都记录已验证备份，失败即恢复。状态位于 `<dshHome>/update-center`（`state.json`、`lock`、`jobs/<id>/*`、`audit.jsonl`）。 |

宿主侧注册 `updateCenter` 类型化 Remote 命名空间
（`versions` / `preflight` / `apply` / `status` / `rollback`）；浏览器侧把它渲染到
侧边栏页脚动作槽位。

## 安装

先构建并打包——插件通过 tarball 安装，**不要**用目录 link：

```sh
npm install        # 构建工具（TypeScript、tsdown、Typert 生成器）
npm run pack       # 构建 + `npm pack --workspace perse-updater`
                   # npm 会打印生成的 tarball 路径

dsh plugin --profile web add <npm 打印的 tarball 路径>
```

> **不要**用目录路径安装（`dsh plugin --profile web add ./`）。加载器按包名解析，
> 并要求生成的 Typert 工件（`lib/typert.host.js`、`lib/typert.remote-client.js`）
> 与编译入口相邻。目录 link 不提供该布局，插件会加载失败。

## 开发

```sh
npm run typecheck          # tsc -b tsconfig.host.json（输出 lib/types）
npm run codegen            # 由带注解源码重新生成 lib/typert.*
npm run bundle             # tsdown -> lib/index.js
npm test                   # 先构建，再跑 verify-versions + verify-client-bundle
npm run verify:installer   # 版本化安装 / 软链切换（沙箱位于 $TMPDIR）
npm run verify:preflight   # 预检规则表（沙箱位于 $TMPDIR）
```

`@deepseek-ai/cordis`、`@deepseek-ai/dsh-typert-protocol` 与 `zod` 故意不打包：
必须由宿主提供同一实例，否则第二份拷贝会静默禁用 Remote 层。

## 环境要求

- Node.js 22+
- DSH，且带有 `@deepseek-ai/cordis` ^4.0.2 与 `@deepseek-ai/dsh-typert-protocol` ^0.1.5-rc.2

## 许可证

MIT — © Xilong Liu，见 [`LICENSE`](./LICENSE)。

---

<sub>Part of Persevere with DSH</sub>

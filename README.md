# perse-updater — carry DSH to its next version, safely.

**perse-updater** is a DSH plugin that carries your install to its next version: it
discovers candidate releases, preflights them, stages and verifies them, then switches
the launcher to the verified build — and rolls back when anything fails.

Part of **Persevere with DSH** — a collection of DSH plugins published under the
short name **perse** (*perse* = *persevere*).

---

## What it does

| Phase | Guarantee |
|-------|-----------|
| **Discover** | Resolves a version from the npm registry (default `https://registry.npmjs.org`) and reads the candidate's dependency closure. |
| **Preflight** | Refuses to touch the install unless the candidate is safe: contract scan, farm/isolate checks, disk budget, patch-conflict rules. |
| **Stage + verify** | Installs the candidate into a versioned staging tree and verifies it before anything is switched. |
| **Switch** | Atomically flips the launcher symlink (`~/.local/bin/dsh` by default) to the verified tree. |
| **Roll back** | Every job records a verified backup; failure restores it. State lives in `<dshHome>/update-center` (`state.json`, `lock`, `jobs/<id>/*`, `audit.jsonl`). |

The host half registers the `updateCenter` typed Remote namespace
(`versions` / `preflight` / `apply` / `status` / `rollback`); the browser half
renders it in the sidebar footer action slot.

## Install

Build and pack first — the plugin is installed from a tarball, **not** from a
directory link:

```sh
npm install        # build tooling (TypeScript, tsdown, the Typert generator)
npm run pack       # build + `npm pack --workspace perse-updater`
                   # npm prints the tarball path it produced

dsh plugin --profile web add <path/to/perse-updater-0.1.0.tgz>
```

> **Do not** install with a directory path (`dsh plugin --profile web add ./`).
> The loader resolves the package by its name and expects the generated Typert
> artifacts (`lib/typert.host.js`, `lib/typert.remote-client.js`) to sit next to
> the compiled entry. A directory link does not provide that layout and the
> plugin will fail to load.

## Develop

```sh
npm run typecheck          # tsc -b tsconfig.host.json  (emits lib/types)
npm run codegen            # regenerate lib/typert.* from the annotated source
npm run bundle             # tsdown -> lib/index.js
npm test                   # builds, then runs verify-versions + verify-client-bundle
npm run verify:installer   # versioned install / symlink switch (sandboxed under $TMPDIR)
npm run verify:preflight   # preflight rule table (sandboxed under $TMPDIR)
```

`@deepseek-ai/cordis`, `@deepseek-ai/dsh-typert-protocol` and `zod` stay
unbundled on purpose: the host must supply its own instances, otherwise a second
copy silently disables the Remote layer.

## Requirements

- Node.js 22+
- DSH with `@deepseek-ai/cordis` ^4.0.2 and `@deepseek-ai/dsh-typert-protocol` ^0.1.5-rc.2

## License

MIT — © Xilong Liu. See [`LICENSE`](./LICENSE).

---

<sub>Part of Persevere with DSH</sub>

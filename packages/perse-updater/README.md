# perse-updater — carry DSH to its next version, safely.

The **perse-updater** plugin for DSH: discover a candidate DSH release, preflight
it, stage and verify it, switch the launcher to the verified build — and roll
back if anything fails.

Part of **Persevere with DSH** — the **perse** plugin collection (*perse* = *persevere*).

## Install

Installed from a tarball, never from a directory link:

```sh
npm install && npm run pack
dsh plugin --profile web add <path/to/perse-updater-0.1.0.tgz>
```

Do **not** run `dsh plugin --profile web add ./`: the loader resolves this package
by name and needs the generated Typert artifacts next to the compiled entry.

## Host surface

Registers the typed Remote namespace `updateCenter`
(`versions`, `preflight`, `apply`, `status`, `rollback`) and hosts the sidebar
footer action that drives it.

## Peer requirements

`@deepseek-ai/cordis` ^4.0.2 and `@deepseek-ai/dsh-typert-protocol` ^0.1.5-rc.2
must come from the host so the Remote layer shares one module instance.

## License

MIT — © Xilong Liu.

---

<sub>Part of Persevere with DSH</sub>

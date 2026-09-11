#!/usr/bin/env node
/**
 * `apply-helper.mjs` — the detached helper entry point (WP7).
 *
 * The host spawns exactly this file:
 *
 *   node <plugin>/apply-helper.mjs --job <jobId> --home <DSH_HOME>
 *
 * It is a thin shim on purpose: all of the logic lives in the compiled
 * `./lib/types/helper/cli.js`, so the helper can be exercised directly by the
 * acceptance harness without a host process (`design/helper-protocol.md` §4).
 */

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const cli = resolve(here, 'lib/types/helper/cli.js')

if (!existsSync(cli)) {
  process.stderr.write(
    `apply-helper: ${cli} is missing; run \`npm run build\` in ${here} before invoking the helper\n`,
  )
  process.exit(2)
}

const { main } = await import(cli)
process.exitCode = await main(process.argv.slice(2), { pluginRoot: here })

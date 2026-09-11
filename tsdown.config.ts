/**
 * Optional bundling of the compiled package entry (`lib/types/index.js` ->
 * `lib/index.js`), mirroring the repo convention where tsc owns declarations and
 * a bundler owns the published single-file entry.
 *
 * The bundle is NOT on the critical path for this package: `exports["."]` and the
 * generated artifacts resolve without it. Run it with `npm run bundle` to produce
 * the conventional `lib/index.js`.
 *
 * The Typert generator does not run here — it already ran via
 * `scripts/gen-typert.mjs`, which is why `lib/typert.*` are inputs, not outputs.
 */

import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'packages/perse-updater/lib/types/index.js' },
  outDir: 'packages/perse-updater/lib',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  // Declarations come from tsc; the generated d.ts files are the only shipped types.
  dts: false,
  sourcemap: false,
  clean: false,
  // Node platform otherwise forces `.mjs`; the published entry must be `lib/index.js`
  // next to the generated `lib/typert.host.js` (both are ESM via "type": "module").
  fixedExtension: false,
  // Runtime peers must stay bare specifiers: the host supplies its own instances
  // (R1 §4.4 hard constraint 2) and the profile resolves `zod` from its farm.
  deps: {
    neverBundle: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-typert-protocol', 'zod'],
  },
})

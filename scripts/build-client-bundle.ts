/**
 * Final step of `pnpm build`: bundle `dsh-ui-github`'s client half into the
 * CJS closure-factory format the dsh client module loader executes
 * (`window.__ModuleLoader__.load({ id, factory })`, mirroring dsh's
 * `clientBundle` tsdown preset). The factory `id` MUST equal the package name
 * — the loader refuses a bundle that registers anything else — and only the
 * platform modules the dsh web shell provides at runtime stay external;
 * everything else is inlined. `lib/client.js` missing from a published
 * package fails the WHOLE dsh web UI at boot, so this runs inside `build`,
 * never as an optional extra.
 *
 * Run with `node scripts/build-client-bundle.ts` (Node ≥ 22.18 strips types).
 * @module scripts/build-client-bundle
 */

import { build } from 'esbuild'

/** Modules the dsh client loader supplies through the factory's `require`. */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
]

const PACKAGE_NAME = 'dsh-ui-github'
const PACKAGE_DIR = 'packages/github/ui-github'

await build({
  entryPoints: [`${PACKAGE_DIR}/src/client/index.ts`],
  outfile: `${PACKAGE_DIR}/lib/client.js`,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  sourcemap: true,
  // Never minified: keeps the closure factory inspectable and mirrors dsh's
  // client preset.
  minify: false,
  external: PLATFORM_MODULES,
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: 'return module.exports; } });' },
})

console.log(`${PACKAGE_DIR}: lib/client.js (closure factory for ${PACKAGE_NAME})`)

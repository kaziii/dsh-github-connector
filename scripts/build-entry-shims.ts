/**
 * Post-`tsc -b` step of `pnpm build`: write each package's declared entry
 * files. tsc emits compiled JS under `lib/types/` (alongside declarations);
 * the package.json exports map points at `lib/index.js` / `lib/invariant.js`
 * (the dsh publish layout), so this script bridges the two with re-export
 * shims. `export *` does not forward a default export, so packages whose
 * source declares one (class plugins) get an explicit default line.
 *
 * Run with `node scripts/build-entry-shims.ts` (Node ≥ 22.18 strips types).
 * @module scripts/build-entry-shims
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const PACKAGE_DIRS = [
  'packages/github/github',
  'packages/github/github-rest',
  'packages/github/tool-github',
  'packages/github/github-connect',
  'packages/github/ui-github',
]

/** Build one shim, forwarding the default export only where the source has one. */
function shim(target: string, hasDefault: boolean): string {
  const lines = [`export * from '${target}'`]
  if (hasDefault) lines.push(`export { default } from '${target}'`)
  return `${lines.join('\n')}\n`
}

for (const dir of PACKAGE_DIRS) {
  const indexSource = await readFile(join(dir, 'src/index.ts'), 'utf8')
  const hasDefault = /^export default /m.test(indexSource)
  await writeFile(join(dir, 'lib/index.js'), shim('./types/index.js', hasDefault))
  await writeFile(join(dir, 'lib/invariant.js'), shim('./types/invariant.js', false))
  console.log(`${dir}: lib/index.js${hasDefault ? ' (with default)' : ''}, lib/invariant.js`)
}

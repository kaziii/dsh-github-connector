/**
 * Guard for runnable examples: package entries resolve through `lib/`, which
 * only exists after `pnpm build`. Fails fast with the fix instead of letting
 * node produce a bare ERR_MODULE_NOT_FOUND.
 * @module scripts/require-build
 */

import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
try {
  await access(join(root, 'packages/github/github/lib/index.js'))
} catch {
  console.error('packages are not built yet — run `pnpm build` at the repository root first.')
  process.exit(1)
}

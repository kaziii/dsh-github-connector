/**
 * Tool-catalog boot manifest (engineering gate §8): every tool package this
 * repository ships is registered in {@link BOOT_MANIFEST}; the script mounts
 * each entry in a REAL composition (tools + system-prompt services, the
 * `ctx.github` seam, a stub provider) per config variant and snapshots the
 * registered tool schemas into `tool-catalog.json` at the repository root.
 *
 * - `node scripts/gen-tool-catalog.ts` regenerates the committed catalog.
 * - `node scripts/gen-tool-catalog.ts --check` fails (exit 1) when the
 *   committed catalog no longer matches what the packages register — the
 *   drift gate to run before merging tool changes.
 *
 * Run `pnpm build` first (package entries resolve through `lib/`); the root
 * scripts `gen:catalog` / `gate:catalog` chain both steps.
 * @module scripts/gen-tool-catalog
 */

import { readFile, writeFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRegistry } from '@deepseek-ai/dsh-tools'
import GitHubRuntime, { GitHubError, type GitHubProvider } from 'dsh-github'
import * as toolGitHub from 'dsh-tool-github'

const CATALOG_PATH = 'tool-catalog.json'

/** One tool package registration: the plugin and its cataloged config variants. */
interface ManifestEntry {
  readonly package: string
  readonly plugin: { readonly name?: string, readonly apply: (ctx: Context, config: never) => void }
  readonly variants: Readonly<Record<string, object>>
}

/** Every tool package in this repository. New tool packages MUST be added here. */
const BOOT_MANIFEST: readonly ManifestEntry[] = [
  {
    package: 'dsh-tool-github',
    plugin: toolGitHub,
    variants: {
      'default': {},
      'read-only': { write: false },
      // Snapshots the widened review-event enum, so flipping the ADR-0014
      // default would show up here as a diff instead of silently.
      'verdicts-on': { reviewVerdicts: true },
    },
  },
]

/** Catalog-time stand-in: registration must never reach a network. */
function stubProvider(): GitHubProvider {
  const refuse = (): never => {
    throw new GitHubError('the catalog stub provider executes nothing', 'GITHUB_PROVIDER_UNAVAILABLE')
  }
  return {
    id: 'catalog-stub',
    available: () => true,
    search: refuse,
    getIssue: refuse,
    getPullRequest: refuse,
    getComments: refuse,
    getDiff: refuse,
    getChecks: refuse,
    getReviews: refuse,
    getReviewComments: refuse,
    getCheckFailures: refuse,
    getMergeability: refuse,
    listPullRequests: refuse,
    submitReview: refuse,
    updatePullRequest: refuse,
    requestReviewers: refuse,
    setLabels: refuse,
    createIssue: refuse,
    createComment: refuse,
    createPullRequest: refuse,
  }
}

/** Mount one manifest entry variant and snapshot its registered tool schemas. */
async function snapshotVariant(entry: ManifestEntry, config: object): Promise<object[]> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry, {})
  await ctx.plugin(GitHubRuntime)
  ctx.github.registerProvider(stubProvider())
  await ctx.plugin(entry.plugin as never, config as never)
  return ctx.tools.schemas()
    .map(schema => ({
      name: schema.name,
      description: schema.description,
      parameters: parameterDigest(schema.parameters),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Parameter names, each carrying its closed enum when it has one
 * (`event:COMMENT|APPROVE`).
 *
 * Names alone would make two config variants that differ only in an enum look
 * identical — exactly the drift the `verdicts-on` variant exists to catch
 * (ADR-0014).
 */
function parameterDigest(parameters: unknown): string[] {
  const properties = (parameters as { properties?: Record<string, unknown> }).properties ?? {}
  return Object.entries(properties)
    .map(([name, spec]) => {
      const values = (spec as { enum?: unknown }).enum
      return Array.isArray(values) ? `${name}:${values.join('|')}` : name
    })
    .sort()
}

/** Build the whole catalog document, deterministically ordered. */
async function generate(): Promise<string> {
  const packages = []
  for (const entry of BOOT_MANIFEST) {
    const variants: Record<string, object[]> = {}
    for (const [variant, config] of Object.entries(entry.variants)) {
      variants[variant] = await snapshotVariant(entry, config)
    }
    packages.push({ package: entry.package, plugin: entry.plugin.name, variants })
  }
  const document = {
    generatedBy: 'scripts/gen-tool-catalog.ts',
    note: 'Boot manifest snapshot of every model-facing tool this repository registers. Regenerate with `pnpm gen:catalog`; `pnpm gate:catalog` fails on drift.',
    packages,
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

const fresh = await generate()
if (process.argv.includes('--check')) {
  const committed = await readFile(CATALOG_PATH, 'utf8').catch(() => '')
  if (committed !== fresh) {
    console.error(`${CATALOG_PATH} is stale: the registered tools changed. Run \`pnpm gen:catalog\` and commit the result.`)
    process.exit(1)
  }
  console.log(`${CATALOG_PATH} matches the registered tools.`)
} else {
  await writeFile(CATALOG_PATH, fresh)
  console.log(`wrote ${CATALOG_PATH}`)
}

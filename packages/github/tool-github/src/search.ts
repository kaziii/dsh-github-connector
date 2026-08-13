/**
 * The model-facing `github_search` tool. Execution goes through `ctx.github`;
 * this module owns only the schema (with the CLOSED `kind` union), validation,
 * the result bound, lean formatting, and presentation.
 * @module dsh-tool-github/search
 */

import type { Context } from '@deepseek-ai/cordis'
import { assertNever } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolResult } from '@deepseek-ai/dsh-tools'
import type { GitHubSearchItem, GitHubSearchKind, GitHubSearchResult } from 'dsh-github'
import { assertPositiveArg, runGitHub, type ResolvedToolGitHubConfig } from './shared.ts'

/** One lean model-facing search hit; `repo` collapses to `owner/repo`. */
interface SearchValueItem {
  readonly title: string
  readonly url: string
  readonly repo?: string
  readonly number?: number
  readonly state?: string
  readonly snippet?: string
}

/** Present-call title per kind — the CLOSED-union switch the design demands. */
export function searchCallTitle(kind: GitHubSearchKind, query: string): string {
  switch (kind) {
    case 'issues': return `Search GitHub issues: ${query}`
    case 'pull-requests': return `Search GitHub pull requests: ${query}`
    case 'repositories': return `Search GitHub repositories: ${query}`
    case 'code': return `Search GitHub code: ${query}`
    default: return assertNever(kind, 'GitHubSearchKind')
  }
}

/** Project one seam hit into the lean output item, omitting absent fields. */
function projectItem(item: GitHubSearchItem): SearchValueItem {
  return {
    title: item.title,
    url: item.url,
    ...item.repo === undefined ? {} : { repo: `${item.repo.owner}/${item.repo.repo}` },
    ...item.number === undefined ? {} : { number: item.number },
    ...item.state === undefined ? {} : { state: item.state },
    ...item.snippet === undefined ? {} : { snippet: item.snippet },
  }
}

/**
 * Format the search outcome as one lean text block: one line per hit
 * (`owner/repo#N [state] title` when addressable), a refine hint when
 * truncated, or a plain no-results notice.
 * @param value - the canonical output value.
 * @returns the model-facing text.
 */
export function formatSearchOutput(value: { items: readonly SearchValueItem[], truncated: boolean }): string {
  if (value.items.length === 0) return 'No results found.'
  const lines = value.items.map(item => {
    const head = item.repo !== undefined && item.number !== undefined
      ? `${item.repo}#${item.number}${item.state === undefined ? '' : ` [${item.state}]`} ${item.title}`
      : `${item.title}${item.snippet === undefined ? '' : ` — ${item.snippet}`}`
    return `- ${head}\n  ${item.url}`
  })
  const parts = [lines.join('\n')]
  if (value.truncated) parts.push('(Result list truncated. Refine the query or read items directly.)')
  return parts.join('\n\n')
}

/** Narrow opaque result meta to the search presentation meta, or undefined. */
export function searchMetaFromResult(meta: unknown): { count: number, truncated: boolean } | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const { count, truncated } = meta as Record<string, unknown>
  if (typeof count !== 'number' || typeof truncated !== 'boolean') return undefined
  return { count, truncated }
}

/** Completed-call presentation: replace the title with the hit count. */
export function presentSearchResult(result: ToolResult): { card: 'generic', title: string } | undefined {
  if (result.isError) return undefined
  const meta = searchMetaFromResult(result.meta)
  if (meta === undefined) return undefined
  return {
    card: 'generic',
    title: `${meta.count} GitHub result${meta.count === 1 ? '' : 's'}${meta.truncated ? ' (truncated)' : ''}`,
  }
}

/**
 * Register `github_search`.
 * @param ctx - context carrying `ctx.tools` and `ctx.github`.
 * @param config - resolved plugin config (`searchMaxResults` bound, timeout).
 */
export function applyGitHubSearchTool(ctx: Context, config: ResolvedToolGitHubConfig): void {
  ctx.tools.register(defineTool({
    name: 'github_search',
    description: 'Search GitHub for issues, pull requests, repositories, or code. Returns a lean list of hits; read an issue or PR directly with github_issue_read / github_pr_read using the owner/repo and number of a hit.',
    parameters: {
      kind: {
        type: 'string',
        enum: ['issues', 'pull-requests', 'repositories', 'code'],
        required: true,
        description: 'What to search.',
      },
      query: {
        type: 'string',
        required: true,
        description: 'GitHub search query; qualifiers like repo:owner/name or is:open are supported.',
      },
      max_results: {
        type: 'integer',
        description: 'Upper bound on returned hits (subject to the deployment cap).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string', required: true },
                url: { type: 'string', required: true },
                repo: { type: 'string' },
                number: { type: 'integer' },
                state: { type: 'string' },
                snippet: { type: 'string' },
              },
            },
          },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatSearchOutput(value) }],
      presentationMeta: (_args, value) => ({ count: value.items.length, truncated: value.truncated }),
    },
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.query.trim() === '') throw new Error('query must be a non-empty string')
      if (args.max_results !== undefined) assertPositiveArg('max_results', args.max_results)
      const maxResults = Math.min(args.max_results ?? config.searchMaxResults, config.searchMaxResults)
      const result: GitHubSearchResult = await runGitHub(() =>
        ctx.github.search({ kind: args.kind, query: args.query, maxResults }, exec.signal))
      return { items: result.items.map(projectItem), truncated: result.truncated }
    },
    presentCall: args => ({
      card: 'generic',
      title: searchCallTitle(args.kind, args.query),
      kind: 'search',
      rawInput: args.query,
    }),
    presentResult: (_args, result) => presentSearchResult(result),
  }))
}

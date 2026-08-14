/**
 * Quickstart: the CLI + token path of the dsh GitHub connector, composed for
 * real — the `ctx.github` seam, the REST provider (per-operation token
 * resolution with the process-environment fallback), and the model-facing
 * tool suite — plus deterministic flow-state detection on the repository you
 * run it from (ADR-0002).
 *
 * Run from this directory (Node ≥ 22.18 runs TypeScript directly):
 *
 *     pnpm build           # once, at the repository root
 *     export GITHUB_TOKEN=ghp_xxx
 *     pnpm demo            # or: node main.ts
 *
 * Without GITHUB_TOKEN the composition still mounts (the flow-state section
 * runs); the API sections print what to configure instead of failing.
 * Everything here is read-only — no issue, comment, or PR is created.
 * @module github-quickstart
 */

import { execFile } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRegistry } from '@deepseek-ai/dsh-tools'
import GitHubRuntime, { GitHubError } from 'dsh-github'
import * as githubRest from 'dsh-github-rest'
import * as toolGitHub from 'dsh-tool-github'
import { detectFlowState } from 'dsh-github-connect'

const token = process.env.GITHUB_TOKEN?.trim()
const banner = (title: string): void => console.log(`\n=== ${title} ===`)

/**
 * Run one live-API section, folding the seam's typed refusals into readable
 * demo output (GITHUB_AUTH = the token was rejected, GITHUB_RATE_LIMITED
 * carries retryAfterMs, …) instead of a stack trace.
 */
async function liveSection(run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error
    console.log(`refused [${error.code}]: ${error.message}`)
    if (error.code === 'GITHUB_AUTH') console.log('(the exported GITHUB_TOKEN is not accepted by api.github.com — use a personal access token)')
  }
}

// —— 1. real composition: seam + provider + tools ————————————————————————————

const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRegistry, {})
await ctx.plugin(GitHubRuntime)
await ctx.plugin(githubRest, { credentialRef: 'GITHUB_TOKEN', baseURL: 'https://api.github.com' })
await ctx.plugin(toolGitHub, {})           // registers github_search / *_read / write tools

banner('composition')
console.log('registered tools:', ctx.tools.schemas().map(schema => schema.name).join(', '))

// —— 2. the seam, called directly (what the tools ride on) ———————————————————

banner('ctx.github seam')
if (token === undefined || token === '') {
  console.log('GITHUB_TOKEN is not set — skipping real API calls. Export a token to see live results.')
} else {
  await liveSection(async () => {
    const results = await ctx.github.search({ kind: 'repositories', query: 'deepseek-harness', maxResults: 3 })
    for (const hit of results.items) console.log(`- ${hit.title}  ${hit.url ?? ''}`)
    const issue = await ctx.github.getIssue({ repo: { owner: 'octocat', repo: 'Hello-World' }, number: 7 })
    console.log(`octocat/Hello-World#7: "${issue.title}" (${issue.state})`)
  })
}

// —— 3. a model tool call, end to end (presented output included) ————————————

banner('github_search tool (as the model sees it)')
if (token === undefined || token === '') {
  console.log('GITHUB_TOKEN is not set — skipping the tool call.')
} else {
  // Tool execution never throws at the model: refusals come back as an
  // isError result with the tool's friendly presentation.
  const result = await ctx.tools.execute({
    callId: CallId('quickstart-1'),
    name: 'github_search',
    arguments: { kind: 'issues', query: 'repo:octocat/Hello-World state:open' },
    signal: new AbortController().signal,
  })
  const [block] = result.content
  console.log(block !== undefined && block.type === 'text' ? block.text : '(no text block)')
}

// —— 4. flow-state detection on THIS repository (zero tokens, pure git) ——————

banner('flow-state detection (design §2)')
const runGit = (args: readonly string[], cwd: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile('git', args as string[], { cwd, windowsHide: true }, (error, stdout) => {
      if (error !== null) reject(error)
      else resolve(stdout)
    })
  })
try {
  const snapshot = await detectFlowState({
    runGit,
    cwd: process.cwd(),
    host: 'github.com',
    // The PR lookups are host-service concerns (dsh-github-connect wires them
    // to the REST API); the git-side states show without them.
    findOpenPr: () => Promise.resolve(undefined),
    findMergedPr: () => Promise.resolve(undefined),
  })
  console.log('state:', JSON.stringify(snapshot.state))
  console.log('(hidden = not a GitHub repo / on the base branch / no commits ahead; pr-ready = the status bar would offer [Create PR])')
} catch (error) {
  if (error instanceof GitHubError) console.log(`detection refused: ${error.message}`)
  else throw error
}

console.log('\ndone.')

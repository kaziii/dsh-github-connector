/**
 * Deterministic flow-state detection (ADR-0002): cheap git facts — current
 * branch, ahead count, head sha — plus one PR lookup fold into the four-state
 * machine driving the conversation status bar. No model involvement: git is
 * the objective signal. Dependencies are injected so fixture repositories and
 * scripted PR lookups cover every transition (M5 DoD).
 * @module dsh-github-connect/flow-state
 */

import type { GitHubRepoRef } from 'dsh-github'

/** CI rollup of a PR's check runs. */
export type ChecksSummary = 'pending' | 'passing' | 'failing'

/** The four states of the conversation PR status bar (design §2). */
export type GitHubFlowState =
  | { kind: 'hidden' }
  | { kind: 'pr-ready', repo: GitHubRepoRef, branch: string, base: string, aheadCount: number }
  | { kind: 'pr-open', repo: GitHubRepoRef, branch: string, number: number, url?: string, ci?: ChecksSummary }
  | { kind: 'pr-merged', repo: GitHubRepoRef, branch: string, number: number }

/** A PR hit from the host-side branch lookup. */
export interface BranchPullRequest {
  readonly number: number
  readonly url?: string
}

/** Injected facts source for one detection pass. */
export interface FlowStateDeps {
  /** Run one git command in `cwd`, resolving stdout; MUST reject on a non-zero exit. */
  readonly runGit: (args: readonly string[], cwd: string) => Promise<string>
  readonly cwd: string
  /** GitHub host the remote must point at (gating: non-GitHub remotes are invisible). */
  readonly host: string
  /** Configured base branch override; otherwise the remote HEAD (falling back to `main`). */
  readonly baseBranch?: string | undefined
  /** Open PR for the branch, or undefined. */
  readonly findOpenPr: (repo: GitHubRepoRef, branch: string) => Promise<BranchPullRequest | undefined>
  /** Most recent MERGED PR for the branch, or undefined. */
  readonly findMergedPr: (repo: GitHubRepoRef, branch: string) => Promise<BranchPullRequest | undefined>
  /** CI rollup for an open PR; undefined when unavailable. */
  readonly checksSummary?: (repo: GitHubRepoRef, number: number) => Promise<ChecksSummary | undefined>
}

/** One detection outcome: the state plus the head sha it was computed at. */
export interface FlowStateSnapshot {
  readonly state: GitHubFlowState
  /** Head commit at detection time; absent when the cwd is not a usable git repo. */
  readonly headSha?: string
}

const HIDDEN: FlowStateSnapshot = { state: { kind: 'hidden' } }

/**
 * Parse a GitHub remote URL (`git@host:owner/repo.git`, `https://host/owner/repo`,
 * `ssh://git@host/owner/repo.git`) into a repo ref, or undefined for another host
 * or shape.
 * @param url - the raw remote URL.
 * @param host - the accepted GitHub host, e.g. `github.com`.
 * @returns the repo ref, or undefined.
 */
export function parseGitHubRemote(url: string, host: string): GitHubRepoRef | undefined {
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|[@/])${escaped}[:/]([^/:]+)/([^/:]+?)(?:\\.git)?/?$`).exec(url.trim())
  return match === null ? undefined : { owner: match[1]!, repo: match[2]! }
}

/** Summarize seam check runs into the badge rollup; empty = undefined (nothing to show). */
export function summarizeChecks(runs: readonly { status: string, conclusion?: string }[]): ChecksSummary | undefined {
  if (runs.length === 0) return undefined
  const failing = runs.some(run =>
    run.conclusion !== undefined && run.conclusion !== 'success' && run.conclusion !== 'neutral' && run.conclusion !== 'skipped')
  if (failing) return 'failing'
  if (runs.some(run => run.status !== 'completed')) return 'pending'
  return 'passing'
}

/**
 * Run one full detection pass. Never throws: any git or lookup failure folds
 * to `hidden` — the status bar silently disappears rather than erroring.
 * @param deps - injected git runner, repo gating, and PR lookups.
 * @returns the state and the head sha it was computed at.
 */
export async function detectFlowState(deps: FlowStateDeps): Promise<FlowStateSnapshot> {
  let remote: string
  try {
    remote = await deps.runGit(['remote', 'get-url', 'origin'], deps.cwd)
  } catch {
    return HIDDEN
  }
  const repo = parseGitHubRemote(remote, deps.host)
  if (repo === undefined) return HIDDEN
  try {
    const branch = (await deps.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], deps.cwd)).trim()
    if (branch === 'HEAD') return HIDDEN
    const headSha = (await deps.runGit(['rev-parse', 'HEAD'], deps.cwd)).trim()
    const base = deps.baseBranch ?? await detectBaseBranch(deps.runGit, deps.cwd)
    if (branch === base) return { state: { kind: 'hidden' }, headSha }

    const open = await deps.findOpenPr(repo, branch)
    if (open !== undefined) {
      const ci = await deps.checksSummary?.(repo, open.number)
      return {
        state: {
          kind: 'pr-open',
          repo,
          branch,
          number: open.number,
          ...open.url === undefined ? {} : { url: open.url },
          ...ci === undefined ? {} : { ci },
        },
        headSha,
      }
    }
    const merged = await deps.findMergedPr(repo, branch)
    if (merged !== undefined) {
      return { state: { kind: 'pr-merged', repo, branch, number: merged.number }, headSha }
    }
    const aheadCount = await countAhead(deps, base)
    if (aheadCount > 0) {
      return { state: { kind: 'pr-ready', repo, branch, base, aheadCount }, headSha }
    }
    return { state: { kind: 'hidden' }, headSha }
  } catch {
    return HIDDEN
  }
}

/**
 * The remote HEAD branch (`origin/HEAD` → `main`), falling back to `main`.
 * @param runGit - the injected git runner.
 * @param cwd - the workspace directory.
 * @returns the base branch name.
 */
export async function detectBaseBranch(runGit: FlowStateDeps['runGit'], cwd: string): Promise<string> {
  try {
    const ref = (await runGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd)).trim()
    const slash = ref.indexOf('/')
    return slash === -1 ? ref : ref.slice(slash + 1)
  } catch {
    return 'main'
  }
}

/** Commits ahead of the base: prefer the remote-tracking base, else the local one, else 0. */
async function countAhead(deps: FlowStateDeps, base: string): Promise<number> {
  for (const range of [`origin/${base}..HEAD`, `${base}..HEAD`]) {
    try {
      return Number.parseInt((await deps.runGit(['rev-list', '--count', range], deps.cwd)).trim(), 10)
    } catch {
      // Base ref absent in this form — try the next.
    }
  }
  return 0
}

import { describe, expect, it } from 'vitest'
import { RestGitHubProvider } from 'dsh-github-rest'

const token = process.env.GITHUB_TOKEN?.trim()

/**
 * Real-API smoke: read-only operations against github.com, exercising the
 * whole transport (auth header, URL composition, pagination plumbing, error
 * mapping) once for real. Self-skips without GITHUB_TOKEN (engineering gate
 * §8); writes stay out — a smoke test must not mutate anyone's repository.
 */
describe.skipIf(token === undefined || token === '')('dsh-github-rest real API smoke', () => {
  const provider = new RestGitHubProvider({
    config: () => ({ credentialRef: 'GITHUB_TOKEN', baseURL: 'https://api.github.com' }),
    resolveToken: () => Promise.resolve(token),
    tokenConfigured: () => true,
  })

  it('searches repositories', async () => {
    const result = await provider.search({ kind: 'repositories', query: 'deepseek-harness', maxResults: 3 })
    expect(Array.isArray(result.items)).toBe(true)
    for (const hit of result.items) {
      expect(typeof hit.title).toBe('string')
      expect(hit.url).toMatch(/^https:\/\//)
    }
  })

  it('reads a well-known issue with its comments', async () => {
    // octocat/Hello-World#7 is GitHub's own long-lived demo issue.
    const item = { repo: { owner: 'octocat', repo: 'Hello-World' }, number: 7 }
    const issue = await provider.getIssue(item)
    expect(issue.ref.number).toBe(7)
    expect(issue.title.length).toBeGreaterThan(0)
    const comments = await provider.getComments(item)
    expect(Array.isArray(comments)).toBe(true)
  })

  it('maps a missing repository to GITHUB_NOT_FOUND', async () => {
    await expect(provider.getIssue({ repo: { owner: 'octocat', repo: 'no-such-repo-dsh-e2e' }, number: 1 }))
      .rejects.toThrow(expect.objectContaining({ code: 'GITHUB_NOT_FOUND' }))
  })

  it('reads reviews and line-anchored review comments off a real pull request (M8)', async () => {
    // octocat/Hello-World#2385 is an old, open, community PR — a stable target
    // that exercises both review endpoints without depending on our own repos.
    const item = { repo: { owner: 'octocat', repo: 'Hello-World' }, number: 2385 }
    const reviews = await provider.getReviews(item)
    expect(Array.isArray(reviews)).toBe(true)
    for (const review of reviews) {
      expect(['commented', 'approved', 'changes-requested', 'dismissed', 'pending']).toContain(review.state)
    }
    const comments = await provider.getReviewComments(item)
    expect(Array.isArray(comments)).toBe(true)
    for (const comment of comments) {
      expect(typeof comment.path).toBe('string')
      expect(['left', 'right']).toContain(comment.side)
    }
  })

  it('gathers CI failure evidence without exploding on a PR that has none (M8)', async () => {
    const item = { repo: { owner: 'octocat', repo: 'Hello-World' }, number: 2385 }
    const result = await provider.getCheckFailures(item, { maxLogLines: 20, maxLogChars: 2000 })
    expect(Array.isArray(result.failures)).toBe(true)
    expect(typeof result.truncated).toBe('boolean')
    for (const failure of result.failures) {
      // The provider hands logs over whole — budgets are the seam's job
      // (ADR-0005), so only the SHAPE is assertable here.
      expect(Array.isArray(failure.annotations)).toBe(true)
      if (failure.log !== undefined) expect(typeof failure.log.text).toBe('string')
    }
  })
})

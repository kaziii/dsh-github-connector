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
})

/**
 * Host-side PR title/body derivation (design §6: the [Create PR] button's
 * fields arrive prefilled by the host, then edited by the user). Purely
 * deterministic — the commits ahead of base ARE the agent's own writing, so
 * no model turn is spent: one commit lends its subject and body verbatim,
 * several commits fold into a branch-derived title over a commit list.
 * @module dsh-github-connect/pr-draft
 */

/** A prefilled PR form: what the create panel shows before the user edits. */
export interface PrDraft {
  readonly title: string
  readonly body?: string
}

/** One commit ahead of base, as parsed from `git log`. */
export interface DraftCommit {
  readonly subject: string
  readonly body: string
}

/** Conventional-commit types recognized in a branch name's first segment. */
const BRANCH_TYPES = new Set(['feat', 'fix', 'docs', 'chore', 'refactor', 'test', 'perf', 'ci', 'build', 'style'])

/**
 * Turn a branch name into a readable title: a leading conventional-commit
 * segment becomes the `type:` prefix (`docs/root-readme` → `docs: root readme`),
 * and the remaining separators read as spaces.
 * @param branch - the head branch name.
 * @returns the humanized title.
 */
export function titleFromBranch(branch: string): string {
  const slash = branch.indexOf('/')
  const first = slash === -1 ? '' : branch.slice(0, slash)
  const rest = (slash === -1 ? branch : branch.slice(slash + 1)).replace(/[-_/]+/g, ' ').trim()
  if (BRANCH_TYPES.has(first) && rest !== '') return `${first}: ${rest}`
  const whole = branch.replace(/[-_/]+/g, ' ').trim()
  return whole === '' ? branch : whole
}

/**
 * Fold the commits ahead of base into a prefilled PR form.
 * @param branch - the head branch name (the multi-commit title source).
 * @param commits - oldest-first commits ahead of base; may be empty.
 * @returns the draft: single commit → its subject and body; several → a
 * branch-derived title over a bullet list of subjects; none → branch title only.
 */
export function derivePrDraft(branch: string, commits: readonly DraftCommit[]): PrDraft {
  if (commits.length === 1) {
    const only = commits[0]!
    const body = only.body.trim()
    return { title: only.subject, ...body === '' ? {} : { body } }
  }
  const title = titleFromBranch(branch)
  if (commits.length === 0) return { title }
  return { title, body: commits.map(commit => `- ${commit.subject}`).join('\n') }
}

/** Field separator inside one commit record (US, never present in messages). */
const FIELD = ''
/** Record separator between commits (RS, never present in messages). */
const RECORD = ''

/** The `git log --format` template {@link parseCommitLog} expects (%x1f / %x1e keep the raw command ASCII-only). */
export const commitLogFormat = '--format=%s%x1f%b%x1e'

/**
 * Parse `git log` output produced with {@link commitLogFormat}.
 * @param stdout - the raw log output.
 * @returns the commits in the log's order.
 */
export function parseCommitLog(stdout: string): DraftCommit[] {
  return stdout.split(RECORD)
    .map(record => record.replace(/^\n/, ''))
    .filter(record => record.trim() !== '')
    .map(record => {
      const separator = record.indexOf(FIELD)
      return separator === -1
        ? { subject: record.trim(), body: '' }
        : { subject: record.slice(0, separator).trim(), body: record.slice(separator + 1).trim() }
    })
}

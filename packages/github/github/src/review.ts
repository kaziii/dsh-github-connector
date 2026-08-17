/**
 * Deterministic half of a structured review (ADR-0013): classify the changed
 * files, decide which dimensions apply to THIS pull request, and package the
 * evidence with the checklists and output contract the reviewer must satisfy.
 *
 * Nothing here judges code. Every function is total and pure — given the same
 * diff it always routes the same way, which is exactly why this half lives in
 * the host and the findings half lives with the model.
 * @module dsh-github/review
 */

import type {
  GitHubDiff,
  GitHubDiffFile,
  GitHubPullRequest,
  GitHubReviewBrief,
  GitHubReviewBriefRequest,
  GitHubReviewDimension,
  GitHubReviewDimensionBrief,
  GitHubReviewSeverity,
} from './types.ts'

/** What kind of file one changed path is. Drives every routing rule below. */
export type GitHubFileKind = 'test' | 'types' | 'docs' | 'code' | 'asset'

/** Documentation and prose — never carries executable behavior. */
const DOCS_PATTERN = /(\.(?:md|mdx|markdown|txt|rst|adoc)$)|(^|\/)docs?\//i

/** Test files across the conventions this project is likely to meet. */
const TEST_PATTERN = /(\.(?:test|spec)\.[cm]?[jt]sx?$)|((^|\/)(?:tests?|__tests__|spec)\/)/i

/** Dedicated type-declaration files. Type edits INSIDE code files are caught by patch inspection. */
const TYPES_PATTERN = /(\.d\.ts$)|((^|\/)types?\.[cm]?tsx?$)|(\.types\.[cm]?tsx?$)/i

/** Source files whose changes can alter behavior. */
const CODE_PATTERN = /\.(?:[cm]?[jt]sx?|py|go|rs|java|rb|php|cs|kt|kts|swift|scala|c|cc|cpp|cxx|h|hpp|m|mm|sh|bash|zsh|sql|vue|svelte)$/i

/** Error-handling constructs, matched against CHANGED lines only. */
const ERROR_PATTERN = /\b(?:try|catch|except|rescue|finally|throw|raise|panic|recover|reject|onError)\b|\.catch\s*\(|\berrors?\.(?:New|Is|As)\b/

/** Type-shaping constructs, matched against CHANGED lines only. */
const TYPE_PATTERN = /\b(?:interface|type|enum|struct|typedef|trait|Protocol|dataclass|NamedTuple|TypedDict)\b/

/**
 * Comment openers across the languages above, matched against CHANGED lines
 * only. SQL's `--` is left out on purpose: it collides with ordinary prose and
 * arithmetic far more often than it would correctly flag a comment.
 */
const COMMENT_PATTERN = /(^|\s)(?:\/\/|\/\*|\*\/|#|<!--|"""|''')/

/**
 * Classify one changed path.
 *
 * Order matters and encodes precedence: a file under `tests/` that also ends in
 * `.d.ts` is a TEST first — what it is used for beats what it contains.
 * @param path - the repository-relative path.
 * @returns the file kind driving dimension routing.
 */
export function classifyFile(path: string): GitHubFileKind {
  if (TEST_PATTERN.test(path)) return 'test'
  if (DOCS_PATTERN.test(path)) return 'docs'
  if (TYPES_PATTERN.test(path)) return 'types'
  if (CODE_PATTERN.test(path)) return 'code'
  return 'asset'
}

/**
 * The lines a patch ADDS or REMOVES, without the surrounding context lines.
 *
 * Context is excluded deliberately: a `catch` the author merely happened to
 * scroll past must not route the whole review through error handling.
 * @param patch - unified-diff hunk text, or undefined for a patch-less file.
 * @returns the changed lines with their leading +/- markers stripped.
 */
export function changedLines(patch: string | undefined): readonly string[] {
  if (patch === undefined) return []
  const lines: string[] = []
  for (const line of patch.split('\n')) {
    // '+++'/'---' are file headers, not content.
    if ((line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')) {
      lines.push(line.slice(1))
    }
  }
  return lines
}

/** Does any changed line of this file match the probe? */
function patchMatches(file: GitHubDiffFile, probe: RegExp): boolean {
  return changedLines(file.patch).some(line => probe.test(line))
}

/** Checklists are constants, not configuration — a review's coverage must not vary per deployment. */
const CHECKLISTS: Readonly<Record<GitHubReviewDimension, readonly string[]>> = {
  'correctness': [
    'Does the logic still hold at the boundaries — empty, zero, one element, maximum, absent optional?',
    'Is every new branch reachable, and is every reachable path actually handled?',
    'Async and concurrency: unawaited promises, races on shared mutable state, ordering assumptions that are not enforced?',
    'Does anything here contradict a convention this repository documents (AGENTS.md / CLAUDE.md / neighbouring code)?',
    'Are failure paths given the same care as the success path?',
  ],
  'tests': [
    'Is each new behavior ASSERTED, not merely executed? Line coverage is not behavior coverage.',
    'Are the boundaries and the error paths covered, or only the happy path?',
    'Do the assertions pin behavior rather than implementation details that will churn?',
    'When a test fails, does its message say enough to locate the cause?',
    'For source changed without a matching test: why does this change not need one?',
  ],
  'error-handling': [
    'Does any catch block swallow the error — no rethrow, no log, no documented degradation?',
    'Could a fallback mask a real failure and let the caller proceed on wrong data?',
    'Does the error carry what the caller needs in order to act, or only that something went wrong?',
    'Are expected outcomes modelled as exceptions, or genuine faults modelled as ordinary return values?',
  ],
  'types': [
    'Do the types make illegal states unrepresentable, or is validity left to convention?',
    'Is each optional field genuinely optional, or is absence standing in for a meaning it should not carry?',
    'Are unions closed and exhaustively consumed?',
    'Are invariants enforced at construction, or only assumed by every caller?',
  ],
  'comments': [
    'Does each comment still match the code beside it after this change?',
    'Does it explain WHY, or merely restate what the next line already says?',
    'Did any changed code leave a now-stale comment or doc behind?',
    'Do documented examples and signatures still compile and still mean what they say?',
  ],
  'simplification': [
    'Is logic duplicated here that an existing helper already covers?',
    'Can nesting be flattened by returning early?',
    'Was an abstraction introduced that has exactly one caller?',
    'Do the names let a reader understand this without jumping to their definitions?',
  ],
}

/** The severity vocabulary, fixed so findings stay comparable across reviews. */
const SEVERITY_SCALE: readonly GitHubReviewSeverity[] = [
  { level: 'blocker', meaning: 'Ships a defect, a data loss, or a security hole. Must not merge.' },
  { level: 'major', meaning: 'Wrong or unsafe under realistic conditions, though not on the common path.' },
  { level: 'minor', meaning: 'Works, but will mislead or cost the next reader real time.' },
  { level: 'nit', meaning: 'Preference. The author may decline it without argument.' },
]

/** What every finding must contain, so a review is actionable rather than impressionistic. */
const OUTPUT_CONTRACT: readonly string[] = [
  'Give every finding a `path:line` you can point at. If you cannot locate it, you cannot report it.',
  'Label every finding with exactly one severity from the scale.',
  'State what is wrong, why it matters, and the concrete change you propose — all three.',
  'When a dimension yields nothing, say so explicitly. Do not pad it to look thorough.',
  'Judge only what this diff changes; pre-existing problems belong in a separate issue, not this review.',
]

/** All dimensions, in the order they are presented. */
const ALL_DIMENSIONS: readonly GitHubReviewDimension[] = [
  'correctness', 'tests', 'error-handling', 'types', 'comments', 'simplification',
]

/** One routing outcome before checklists are attached. */
interface Route {
  readonly reason: string
  readonly paths: readonly string[]
}

/**
 * Decide which dimensions apply to a diff, and which files each is about.
 *
 * The rules are intentionally asymmetric. `correctness` and `simplification`
 * ride any executable change, so they nearly always apply — routing earns its
 * keep by EXCLUDING the ones that would otherwise arrive empty (a docs-only PR
 * gets no type review), not by distributing dimensions evenly.
 * @param files - the changed files of the pull request.
 * @returns a route per applicable dimension, in presentation order.
 */
export function routeDimensions(files: readonly GitHubDiffFile[]): ReadonlyMap<GitHubReviewDimension, Route> {
  const kinds = new Map(files.map(file => [file, classifyFile(file.path)] as const))
  const pathsOf = (predicate: (file: GitHubDiffFile) => boolean): string[] =>
    files.filter(predicate).map(file => file.path)

  const code = pathsOf(file => kinds.get(file) === 'code' || kinds.get(file) === 'types')
  const tests = pathsOf(file => kinds.get(file) === 'test')
  const routes = new Map<GitHubReviewDimension, Route>()

  if (code.length > 0) {
    routes.set('correctness', { reason: `${code.length} source file(s) changed`, paths: code })
    routes.set('simplification', { reason: `${code.length} source file(s) changed`, paths: code })
  }

  // Tests apply whenever executable code moved — either to judge the new tests,
  // or to ask why source changed without them. A docs-only PR gets neither.
  if (code.length > 0 || tests.length > 0) {
    routes.set('tests', tests.length > 0
      ? { reason: `${tests.length} test file(s) changed`, paths: [...tests, ...code] }
      : { reason: 'source changed with no test file touched', paths: code })
  }

  const errorPaths = pathsOf(file => kinds.get(file) !== 'docs' && patchMatches(file, ERROR_PATTERN))
  if (errorPaths.length > 0) {
    routes.set('error-handling', { reason: 'changed lines touch error handling', paths: errorPaths })
  }

  const typePaths = pathsOf(file =>
    kinds.get(file) === 'types' || (kinds.get(file) !== 'docs' && patchMatches(file, TYPE_PATTERN)))
  if (typePaths.length > 0) {
    routes.set('types', { reason: 'changed lines declare or reshape types', paths: typePaths })
  }

  const commentPaths = pathsOf(file =>
    kinds.get(file) === 'docs' || patchMatches(file, COMMENT_PATTERN))
  if (commentPaths.length > 0) {
    routes.set('comments', { reason: 'changed lines include comments or documentation', paths: commentPaths })
  }

  return routes
}

/**
 * Assemble a review brief from already-fetched material.
 *
 * Kept separate from the seam operation so the whole deterministic pipeline is
 * testable without a provider.
 * @param pullRequest - the PR under review.
 * @param diff - its budgeted diff; carried into the brief exactly once.
 * @param request - optional dimension restriction from the caller.
 * @returns the brief, with dimensions in presentation order.
 */
export function buildReviewBrief(
  pullRequest: GitHubPullRequest,
  diff: GitHubDiff,
  request: GitHubReviewBriefRequest = {},
): GitHubReviewBrief {
  const routes = routeDimensions(diff.files)
  const wanted = request.dimensions === undefined ? undefined : new Set(request.dimensions)
  const dimensions: GitHubReviewDimensionBrief[] = []
  for (const dimension of ALL_DIMENSIONS) {
    const route = routes.get(dimension)
    if (route === undefined) continue
    if (wanted !== undefined && !wanted.has(dimension)) continue
    dimensions.push({
      dimension,
      reason: route.reason,
      paths: route.paths,
      checklist: CHECKLISTS[dimension],
    })
  }
  return {
    pullRequest,
    diff,
    dimensions,
    severityScale: SEVERITY_SCALE,
    outputContract: OUTPUT_CONTRACT,
    truncated: diff.truncated,
  }
}

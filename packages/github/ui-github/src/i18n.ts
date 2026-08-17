/**
 * Built-in bilingual string catalogs for the two slots. Catalogs are frozen
 * module constants so component callbacks can depend on them without
 * re-rendering churn; the zh-CN strings mirror the design document's wording.
 * @module dsh-ui-github/i18n
 */

import type { ChecksSummary, MergeMethod } from 'dsh-github-connect'

/** Locales the UI ships built in. */
export type UiLocale = 'en' | 'zh-CN'

/** Every user-visible string of the two slots, parameterized where needed. */
export interface UiCatalog {
  readonly connectLoading: string
  readonly connectButton: string
  readonly connectedAs: (login: string) => string
  readonly connectedAnonymous: string
  readonly disconnectButton: string
  readonly connectDescription: string
  readonly waitingForAuthorization: (userCode: string) => string
  readonly waitingHint: string
  readonly openAuthPage: string
  readonly deviceExpired: string
  readonly deviceDenied: string
  readonly deviceFailed: (message: string) => string
  readonly retryButton: string
  readonly aheadOfBase: (branch: string, base: string, count: number) => string
  readonly createPrButton: string
  readonly creatingButton: string
  readonly createPrompt: (branch: string, base: string) => string
  readonly createTimedOut: string
  readonly dismissLabel: string
  readonly openPr: (number: number) => string
  readonly ciBadge: (summary: ChecksSummary) => string
  readonly reviewButton: string
  readonly reviewPrompt: (number: number) => string
  readonly mergeButton: string
  readonly mergeMethodLabel: (method: MergeMethod) => string
  readonly openOnGitHub: string
  readonly mergeConfirm: (number: number, methodLabel: string) => string
  readonly mergeFailed: (message: string) => string
  readonly mergedBanner: (number: number) => string
}

const EN: UiCatalog = Object.freeze<UiCatalog>({
  connectLoading: 'Checking GitHub connection…',
  connectButton: 'Connect GitHub',
  connectedAs: login => `Connected as @${login}`,
  connectedAnonymous: 'Connected',
  disconnectButton: 'Disconnect',
  connectDescription: 'Authorize once with GitHub Device Flow — the token stays on the host and never touches a config file.',
  waitingForAuthorization: userCode => `Enter code ${userCode} on GitHub to finish connecting (copied to clipboard)`,
  waitingHint: 'Enter this code on the GitHub authorization page (copied to clipboard)',
  openAuthPage: 'Open authorization page',
  deviceExpired: 'The authorization code expired before it was used',
  deviceDenied: 'The authorization request was denied on GitHub',
  deviceFailed: message => `Connecting to GitHub failed: ${message}`,
  retryButton: 'Retry',
  aheadOfBase: (branch, base, count) => `${branch} is ahead of ${base} by ${count} ${count === 1 ? 'commit' : 'commits'}`,
  createPrButton: 'Create PR',
  creatingButton: 'Creating PR…',
  createPrompt: (branch, base) => `Create a pull request from ${branch} into ${base}: derive a clear title and description from this session's work and commit history, then create it with the GitHub tools.`,
  createTimedOut: 'PR creation timed out — check the conversation for details.',
  dismissLabel: 'Dismiss',
  openPr: number => `#${number}`,
  ciBadge: summary => {
    switch (summary) {
      case 'pending': return 'CI running'
      case 'passing': return 'CI passing'
      case 'failing': return 'CI failing'
    }
  },
  reviewButton: 'AI review',
  // Routes the turn through github_pr_review (ADR-0013) rather than leaving the
  // model to improvise over a raw diff. Deliberately does NOT ask for the review
  // to be submitted to GitHub — that stays the user's next word (ADR-0014).
  reviewPrompt: number => `Review PR #${number}. Call github_pr_review to get the dimensions that apply and the contract your findings must satisfy, then report the findings here. Do not submit anything to GitHub.`,
  mergeButton: 'Merge',
  mergeMethodLabel: method => {
    switch (method) {
      case 'squash': return 'Squash'
      case 'merge': return 'Merge commit'
      case 'rebase': return 'Rebase'
    }
  },
  openOnGitHub: 'Open on GitHub',
  mergeConfirm: (number, methodLabel) => `Merge PR #${number} (${methodLabel})? This cannot be undone.`,
  mergeFailed: message => `Merge failed: ${message}`,
  mergedBanner: number => `#${number} merged`,
})

const ZH_CN: UiCatalog = Object.freeze<UiCatalog>({
  connectLoading: '正在检查 GitHub 连接…',
  connectButton: '连接 GitHub',
  connectedAs: login => `已连接 @${login}`,
  connectedAnonymous: '已连接',
  disconnectButton: '断开连接',
  connectDescription: '通过 GitHub Device Flow 一键授权——token 只保存在宿主，不落入任何配置文件。',
  waitingForAuthorization: userCode => `在 GitHub 输入代码 ${userCode} 完成连接（已复制到剪贴板）`,
  waitingHint: '在 GitHub 授权页输入此代码完成连接（已复制到剪贴板）',
  openAuthPage: '打开授权页',
  deviceExpired: '授权码在使用前已过期',
  deviceDenied: '授权请求在 GitHub 上被拒绝',
  deviceFailed: message => `连接 GitHub 失败：${message}`,
  retryButton: '重试',
  aheadOfBase: (branch, base, count) => `${branch} 领先 ${base} ${count} 个提交`,
  createPrButton: '创建 PR',
  creatingButton: '创建中…',
  createPrompt: (branch, base) => `请从 ${branch} 向 ${base} 创建一个 Pull Request：根据本次会话的工作与提交记录归纳标题和描述，然后用 GitHub 工具创建。`,
  createTimedOut: '创建 PR 超时——请在会话中查看执行情况。',
  dismissLabel: '关闭',
  openPr: number => `#${number}`,
  ciBadge: summary => {
    switch (summary) {
      case 'pending': return 'CI 运行中'
      case 'passing': return 'CI 通过'
      case 'failing': return 'CI 失败'
    }
  },
  reviewButton: 'AI 审查',
  reviewPrompt: number => `审查 PR #${number}。先调用 github_pr_review 拿到适用的维度与 findings 必须满足的契约，然后在此汇报 findings。不要向 GitHub 提交任何内容。`,
  mergeButton: 'Merge',
  mergeMethodLabel: method => {
    switch (method) {
      case 'squash': return 'Squash'
      case 'merge': return 'Merge commit'
      case 'rebase': return 'Rebase'
    }
  },
  openOnGitHub: '在 GitHub 打开',
  mergeConfirm: (number, methodLabel) => `确定以 ${methodLabel} 方式合并 PR #${number}？此操作不可撤销。`,
  mergeFailed: message => `合并失败：${message}`,
  mergedBanner: number => `#${number} 已合并`,
})

/**
 * Resolve the frozen catalog for one locale.
 * @param locale - a built-in locale.
 * @returns the catalog constant (stable identity per locale).
 */
export function catalogFor(locale: UiLocale): UiCatalog {
  return locale === 'zh-CN' ? ZH_CN : EN
}

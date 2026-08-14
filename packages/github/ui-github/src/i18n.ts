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
  readonly waitingForAuthorization: (userCode: string) => string
  readonly deviceExpired: string
  readonly deviceDenied: string
  readonly deviceFailed: (message: string) => string
  readonly retryButton: string
  readonly aheadOfBase: (branch: string, base: string, count: number) => string
  readonly createPrButton: string
  readonly prTitlePlaceholder: string
  readonly prBodyPlaceholder: string
  readonly confirmCreateButton: string
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
  waitingForAuthorization: userCode => `Enter code ${userCode} on GitHub to finish connecting (copied to clipboard)`,
  deviceExpired: 'The authorization code expired before it was used',
  deviceDenied: 'The authorization request was denied on GitHub',
  deviceFailed: message => `Connecting to GitHub failed: ${message}`,
  retryButton: 'Retry',
  aheadOfBase: (branch, base, count) => `${branch} is ahead of ${base} by ${count} ${count === 1 ? 'commit' : 'commits'}`,
  createPrButton: 'Create PR',
  prTitlePlaceholder: 'PR title',
  prBodyPlaceholder: 'PR description (optional)',
  confirmCreateButton: 'Confirm',
  openPr: number => `#${number}`,
  ciBadge: summary => {
    switch (summary) {
      case 'pending': return 'CI running'
      case 'passing': return 'CI passing'
      case 'failing': return 'CI failing'
    }
  },
  reviewButton: 'AI review',
  reviewPrompt: number => `Review PR #${number}: read its diff and checks, then summarize risks and needed changes.`,
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
  waitingForAuthorization: userCode => `在 GitHub 输入代码 ${userCode} 完成连接（已复制到剪贴板）`,
  deviceExpired: '授权码在使用前已过期',
  deviceDenied: '授权请求在 GitHub 上被拒绝',
  deviceFailed: message => `连接 GitHub 失败：${message}`,
  retryButton: '重试',
  aheadOfBase: (branch, base, count) => `${branch} 领先 ${base} ${count} 个提交`,
  createPrButton: '创建 PR',
  prTitlePlaceholder: 'PR 标题',
  prBodyPlaceholder: 'PR 描述（可选）',
  confirmCreateButton: '确认',
  openPr: number => `#${number}`,
  ciBadge: summary => {
    switch (summary) {
      case 'pending': return 'CI 运行中'
      case 'passing': return 'CI 通过'
      case 'failing': return 'CI 失败'
    }
  },
  reviewButton: 'AI 审查',
  reviewPrompt: number => `审查 PR #${number}：阅读其 diff 与检查结果，总结风险与需要的修改。`,
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

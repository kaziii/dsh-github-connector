/**
 * GitHub workflow UI for the dsh web client: the "Connect GitHub" settings
 * section and the conversation PR status bar (design §1), bound to the client
 * shell through the {@link GitHubUiShell} port (ADR-0007) and to the host
 * through `dsh-github-connect`'s Typert Remote face. No model turns except
 * the [AI review] button (design §6).
 * @module dsh-ui-github
 */

export { catalogFor, type UiCatalog, type UiLocale } from './i18n.ts'
export { installGitHubUi, type GitHubUiOptions } from './install.ts'
export {
  MERGE_METHODS,
  connectErrorText,
  connectViewFromStatus,
  reduceConnectView,
  sameFlowState,
  type ConnectView,
} from './model.ts'
export { ConnectGitHubSection, type ConnectSectionProps } from './settings-section.ts'
export {
  type ConnectStatus,
  type GitHubUiRemote,
  type GitHubUiShell,
  type GitHubUiSlotId,
  type GitHubUiVisibility,
} from './types.ts'
export {
  PrStatusBar,
  defaultTimers,
  type PollPolicy,
  type PrStatusBarProps,
  type StatusBarTimers,
} from './status-bar.ts'

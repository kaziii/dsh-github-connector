/**
 * GitHub workflow UI for the dsh web client: the "Connect GitHub" settings
 * section and the conversation PR status bar (design §1), bound to the client
 * shell through the {@link GitHubUiShell} port (ADR-0007) and to the host
 * through `dsh-github-connect`'s Typert Remote face. No model turns except
 * the [AI review] button (design §6).
 * @module dsh-ui-github
 */

/**
 * Empty node half (dsh surface-plugin convention): the loader entry's only
 * job is existing in the host cordis.yml, which lets the dsh client-module
 * scanner discover this package's `dsh.client` manifest and serve
 * `lib/client.js` into the browser (ADR-0008). Never a default export.
 */
export function apply(): void {}

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

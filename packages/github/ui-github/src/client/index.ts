/**
 * The dsh client half of `dsh-ui-github` (ADR-0008/ADR-0009): self-mounts the
 * hand-written `githubConnect` Remote contribution through `ctx.remote.$mount`
 * (no dsh-repo change required), then installs the connect card and the PR
 * status bar over the browser shell adapter. Locale follows the page
 * language; every registration is an effect on this plugin's fiber.
 * @module dsh-ui-github/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { UiLocale } from '../i18n.ts'
import { installGitHubUi } from '../install.ts'
import { GITHUB_CONNECT_REMOTE } from './contribution.ts'
import { createBrowserShell } from './shell.ts'
import type {} from './shims.ts'

/** Cordis client plugin name. */
export const name = 'ui-github'
/** Services the client half consumes (ADR-0008: NOT `remote.githubConnect` — this plugin mounts that namespace itself, and injecting it would deadlock). */
export const inject = ['remote', 'slots', 'sessions']

/**
 * Map a page language to a catalog locale.
 * @param lang - `document.documentElement.lang` or `navigator.language`.
 * @returns the catalog to render with.
 */
export function detectLocale(lang: string | undefined): UiLocale {
  return lang !== undefined && /^zh(-|$)/i.test(lang) ? 'zh-CN' : 'en'
}

/**
 * Mount the Remote face and both UI surfaces.
 * @param ctx - the client plugin context.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(GITHUB_CONNECT_REMOTE)
  const shell = createBrowserShell(ctx)
  const locale = detectLocale(document.documentElement.lang === '' ? navigator.language : document.documentElement.lang)
  ctx.effect(() => installGitHubUi(shell, ctx.remote, { locale }), 'ui-github.install')
}

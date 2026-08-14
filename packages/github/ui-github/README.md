# dsh-ui-github

English | [中文](README.zh.md)

The **GitHub workflow UI** for the dsh web client (design §1): two React slot fills, driven entirely by `dsh-github-connect`'s `@Remote` methods plus frontend-paced polling (ADR-0009 — dsh forwards no custom host events to the browser; the only forwarded event this UI uses is `credentials/updated`).

1. **"Connect GitHub" card** (mounted as a `settings.plugin.item` card on the dsh 插件 → 插件配置 page, ADR-0008): [Connect GitHub] starts the Device Flow — the user code is auto-copied, the authorization page opens, progress arrives by polling `deviceFlowStatus` at the server-dictated interval (stretched on `slow_down`), and a connected user sees `Connected as @login` plus [Disconnect]. The token never transits the frontend.
2. **Conversation PR status bar** (`conversation.input.dock` slot), the three stages of design §1: `feat/x is ahead of main by 3 commits` + [Create PR ▾] (title/body prefilled by the host from the commits ahead via `prDraft`, then editable) → `#123 · CI badge` + [AI review] [Merge ▾] (squash / merge commit / rebase / open on GitHub) → `#123 merged`, collapsing shortly after. Hidden for unconnected users; disappears immediately on disconnect. [Create PR] and [Merge] call `@Remote` directly (zero model turns, merge behind the irreversible-action confirmation); [AI review] is the only button that spends a turn, via `sessions.prompt`.

Both pollers back off exponentially and **stop while the page is hidden**: the CI badge (`prChecks`) and the flow state (`refreshFlowState`, whose unchanged rounds never close an open dropdown, discard a draft, or resurrect a collapsed merged banner) — the risk-table rule that polling must not eat the rate limit.

## Binding (ADR-0007/0008)

This package binds to the web client through two contracts in `src/types.ts`: the **`GitHubUiShell` port** (slot registration, `prompt`, `openExternal`, `copyText`, `confirmIrreversible`, page visibility) and the hand-authored **Typert Remote client face** for the `githubConnect` namespace, replaced by the real generated artifact once the Typert generator runs over the host package. Install everything with one call:

```ts
import { installGitHubUi } from 'dsh-ui-github'

const dispose = installGitHubUi(shellAdapter, typertClientRemote, { locale: 'zh-CN' })
```

## The dsh client half (`dsh-ui-github/client`)

`src/client/` is the shipped implementation of that port for a real dsh web deployment (ADR-0008), packaged in the dsh client-plugin form: `exports["./client"]` + the `dsh.client` manifest, an empty node `apply` whose loader entry (this package's `cordis.patch.yml`, applied by `dsh plugin add`) anchors the dsh client-module scan, and `lib/client.js` built as the CJS closure factory the dsh module loader executes (`scripts/build-client-bundle.ts`; only react and cordis stay external). On boot it self-mounts the hand-written `githubConnect` contribution through `ctx.remote.$mount` — no dsh-repo change required — then installs both surfaces over the browser shell adapter: the settings fill lands as the `settings.plugin.item` card, [AI review] sends through `ctx.sessions.scope(sessionId).conversation.send`, external links open as http(s)-only new tabs, and the locale follows the page language. The dsh service types it consumes are shimmed in `src/client/shims.ts`, to be deleted on migration into the dsh workspace.

## i18n

Both built-in locales (`en`, `zh-CN`) ship complete catalogs (`catalogFor`); every user-visible string of both slots is paired.

## Testing

Component tests run under jsdom with a scripted fake remote and shell: all four flow states render and transition through the poll, disconnect hides the bar immediately, the Device Flow walk (waiting → authorized → connected, plus denied / expired / failed), the backoff-and-pause schedules, draft survival across unchanged polls, the collapsed-banner memory, both dropdowns, and the client half (contribution codecs, browser shell, plugin apply). 100% per-file coverage, keyless.

## Model Experience

None directly — this UI exists so the buttons DON'T spend model turns. Its one model-facing effect is the [AI review] button, which sends a localized review prompt (`Review PR #N…`) into the session as a normal agent turn; everything else goes straight to `dsh-github-connect`.

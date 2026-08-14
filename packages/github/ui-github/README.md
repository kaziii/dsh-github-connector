# dsh-ui-github

English | [中文](README.zh.md)

The **GitHub workflow UI** for the dsh web client (design §1): two React slot fills, driven entirely by `dsh-github-connect`'s `@Remote` methods and forwarded events.

1. **"Connect GitHub" settings section** (`settings.section` slot): [Connect GitHub] starts the Device Flow — the user code is auto-copied, the authorization page opens, progress arrives over the forwarded `github/device-flow` event, and a connected user sees `Connected as @login` plus [Disconnect]. The token never transits the frontend.
2. **Conversation PR status bar** (`conversation.input.dock` slot), the three stages of design §1: `feat/x is ahead of main by 3 commits` + [Create PR ▾] (editable title/body) → `#123 · CI badge` + [AI review] [Merge ▾] (squash / merge commit / rebase / open on GitHub) → `#123 merged`, collapsing shortly after. Hidden for unconnected users; disappears immediately on disconnect. [Create PR] and [Merge] call `@Remote` directly (zero model turns, merge behind the irreversible-action confirmation); [AI review] is the only button that spends a turn, via `sessions.prompt`.

The CI badge is polled from the frontend with exponential backoff (`prChecks`), and the poller **stops while the page is hidden** — the risk-table rule that checks polling must not eat the rate limit.

## Binding (ADR-0007)

The dsh client plane is registry-restricted, so this package binds to the web client through two contracts in `src/types.ts`: the **`GitHubUiShell` port** (slot registration, `prompt`, `openExternal`, `copyText`, `confirmIrreversible`, page visibility) that the web client adapts in one file at composition time, and the hand-authored **Typert Remote client face** for the `githubConnect` namespace, shaped after the generated `typert.remote-client` artifact of `@deepseek-ai/dsh-message-feedback` and replaced by the real generated artifact once the Typert generator runs over the host package. Install everything with one call:

```ts
import { installGitHubUi } from 'dsh-ui-github'

const dispose = installGitHubUi(shellAdapter, typertClientRemote, { locale: 'zh-CN' })
```

## i18n

Both built-in locales (`en`, `zh-CN`) ship complete catalogs (`catalogFor`); every user-visible string of both slots is paired.

## Testing

Component tests run under jsdom with a scripted fake remote and shell: all four flow states render and transition on events, disconnect hides the bar immediately, the Device Flow walk (waiting → authorized → connected, plus denied / expired / failed), the poll backoff-and-pause schedule, and both dropdowns. 100% per-file coverage, keyless.

## Model Experience

None directly — this UI exists so the buttons DON'T spend model turns. Its one model-facing effect is the [AI review] button, which sends a localized review prompt (`Review PR #N…`) into the session as a normal agent turn; everything else goes straight to `dsh-github-connect`.

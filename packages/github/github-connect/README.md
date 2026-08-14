# dsh-github-connect

English | [中文](README.zh.md)

The **GitHub connect service** (`ctx.githubConnect`): everything between "the user clicks Connect GitHub" and "the status bar above the input knows what to offer". Three responsibilities:

1. **Device Flow authorization** (ADR-0001): `startDeviceFlow()` returns the user code immediately and polls in the background at the server's pace (`authorization_pending` continues, `slow_down` adds 5s, `expired_token` / `access_denied` settle terminally). On success the token lands in the **credentials seam** (`credentials.set`) — its `credentials/updated` event is what refreshes every consumer, no restart, and the token value never transits the frontend. v1 uses non-expiring authorization; the refresh-token gap is documented in the code where it will land.
2. **Deterministic flow-state detection** (ADR-0002): after each `agent/turn-stopping`, cheap git facts (current branch, head sha, ahead count) plus one branch-PR lookup fold into the four-state machine — `hidden` / `pr-ready` / `pr-open` (with CI rollup) / `pr-merged` — pushed over the `github/flow-state` event. Gated hard: non-GitHub remote or unresolvable credential ⇒ no events (unconnected users never see the feature). Turns that produced no new commits emit nothing (noise rule). Detection never throws into the turn.
3. **`@Remote` button methods** (design §6, zero model turns): `connectStatus()` (cached login lookup), `startDeviceFlow()`, `deviceFlowStatus()`, `disconnect()`, `prDraft()` (deterministic title/body prefill from the commits ahead of base), `createPr()` (branch/base from git, PR through the seam's idempotent create), `mergePr()` (squash / merge / rebase; 405/409 map to `GITHUB_MERGE_BLOCKED`), `prChecks()` and `refreshFlowState()` for the badge poller — the FRONTEND owns the polling cadence and stops while the page is hidden.

## Configuration

| Field | Default | Semantics |
|---|---|---|
| `clientId` | the shared `dsh-github-connector` OAuth App | Client id for the Device Flow (a public identifier, not a secret). Override on GHES with an App registered on your instance. |
| `credentialRef` | `GITHUB_TOKEN` | Where the token is stored and resolved (credentials seam, env fallback). |
| `apiBaseURL` / `authBaseURL` | github.com endpoints | GHES: point `apiBaseURL` at `/api/v3`, `authBaseURL` at the GHES host. |
| `host` | `github.com` | The host a workspace remote must point at to activate flow-state. |
| `cwd` / `baseBranch` | calling session’s workspace, else process cwd / remote HEAD | `cwd` forces every git check into one directory (ADR-0010: normally the calling session’s `header.cwd` decides); `baseBranch` overrides the detected base. |
| `scope` | `repo` | OAuth scope requested by the Device Flow. |

## Events (host-internal, ADR-0009)

dsh does not forward custom host events to the browser, so both events below serve host-side consumers only; the web UI polls `refreshFlowState` and `deviceFlowStatus` instead. `deviceFlowStatus()` returns the active flow's latest `DeviceFlowUpdate` (updates from a superseded flow are dropped, so a poller never sees a stale terminal phase).

- `github/flow-state` — the status bar's state (four kinds above).
- `github/device-flow` — `awaiting-authorization` (with the prompt) → `slow-down`* → `authorized` | `expired` | `denied` | `failed`.

## Testing

Device Flow paths run against fully mocked GitHub OAuth endpoints; flow-state transitions run on REAL fixture git repositories built per test; the service suite verifies the credentials write, the `credentials/updated` announcement, gating, and the no-new-commits noise rule. 100% per-file coverage, keyless.

## Model Experience

None directly — this service exists so the buttons DON'T spend model turns. Its one model-facing effect is indirect: [AI review] (M6) triggers a normal agent turn via `sessions.prompt`, and the token it stores is what makes the `github_*` tools usable.

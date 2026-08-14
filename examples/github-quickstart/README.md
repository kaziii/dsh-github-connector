# github-quickstart

English | [中文](README.zh.md)

The minimal runnable example of the dsh GitHub connector — the **CLI + token path** for real, plus the **full UI path** as wiring.

## Run it

```bash
pnpm install && pnpm build     # at the repository root, once
cd examples/github-quickstart
export GITHUB_TOKEN=ghp_xxx    # optional; a personal access token
pnpm demo                      # or: node main.ts  (Node ≥ 22.18 runs TS directly)
```

`main.ts` composes the real thing — the `ctx.github` seam, the REST provider (per-operation token resolution, process-env fallback), and the `github_*` tool suite — then:

1. lists the registered tools (the same names `tool-catalog.json` pins),
2. calls the seam directly (repository search + reading `octocat/Hello-World#7`),
3. executes `github_search` through `ctx.tools.execute`, printing the model-facing presentation,
4. runs deterministic **flow-state detection** (design §2) on the repository you run it from — see `hidden` vs `pr-ready` change as you commit on a branch.

Everything is read-only. Without `GITHUB_TOKEN` the API sections skip with guidance and the flow-state section still runs; a rejected token demonstrates the typed refusal (`GITHUB_AUTH`) instead of a stack trace.

## The UI path

`ui-wiring.ts` is the compile-checked shape of the dsh web client's one-file adapter (ADR-0007): how `installGitHubUi` receives the client's slot registry, `sessions.prompt`, clipboard/window, the approval surface, and page visibility. It is not executed here — those facilities exist only inside the dsh web client; copy `wireGitHubUi` into that adapter when composing the full experience.

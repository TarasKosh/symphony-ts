# Symphony-ts

**This project is an unofficial TypeScript implementation of [OpenAI Symphony](https://github.com/openai/symphony).**

Symphony-ts turns project work into isolated, autonomous implementation runs: it reads work from
your tracker, creates a dedicated workspace for each issue, runs a coding agent inside that
boundary, and gives operators a clean surface for runtime visibility, retries, and control.

Tracker support is adapter-based. This fork supports both Linear and Notion without changing the
orchestrator flow.

> [!WARNING]
> Symphony is intended for trusted environments.

![Symphony demo showing Linear issue tracking alongside the Symphony observability dashboard](.github/media/demo.png)

## Tracker Adapters

Symphony uses tracker adapters. Each target repository chooses its project management platform in
`WORKFLOW.md` through `tracker.kind`; the runtime then loads the matching adapter and normalizes
tickets into Symphony's shared issue model. Linear remains the default adapter, Notion is bundled
as the first non-Linear option, and the adapter layer is designed so additional platforms can be
added without changing orchestration, workspace, dashboard, or prompt behavior.

See [docs/TRACKER_ADAPTERS.md](docs/TRACKER_ADAPTERS.md) for the adapter contract, recommended
ticket fields, and status lifecycle.

Write-capable adapters can also own lifecycle transitions. The bundled Notion adapter claims
`Todo` work into `In Progress` before Codex starts and exposes a `symphony_handoff` tool so an
agent can move ready PRs to the configured review state without raw tracker API calls. It also
exposes tracker-backed ticket context tools so agents can read Notion page body/comments and append
ordinary checkpoints or questions during the run.

For trackers that expose readable comments, workflows can opt into
`polling.issue_comments_between_turns`. Symphony then adds newly observed operator comments to the
next Codex turn on the same live thread instead of interrupting a running turn. Optional workspace
retention can age out abandoned non-terminal workspaces, but only after clean-Git, upstream, ahead,
age, state, and active-run checks all pass.

## Running Symphony Locally

### Requirements

- Node.js `>= 22`
- pnpm `>= 10`
- a target repository with a valid `WORKFLOW.md`
- tracker credentials for the selected adapter, such as `LINEAR_API_KEY` or `NOTION_API_KEY`
- a coding agent runtime that supports app-server mode, such as `codex app-server`

### Build the local CLI

```bash
cd /path/to/symphony-ts
pnpm install
pnpm build
```

Verify the built CLI:

```bash
node dist/src/cli/main.js --help
```

This fork does not require a global `symphony` or `symphony-ts` npm install. When you want to run
the local implementation against another repository, call the built CLI directly:

```bash
node /path/to/symphony-ts/dist/src/cli/main.js \
  /path/to/target-repo/WORKFLOW.md \
  --acknowledge-high-trust-preview \
  --port 4321
```

### Target a Repository

`WORKFLOW.md` is repository-owned policy. Put it in the target repository root when the workflow
should travel with that codebase. Symphony reads that file, creates one workspace directory per
eligible tracker issue, and runs Codex from inside the per-issue workspace.

The positional CLI argument selects the workflow file:

```bash
cd /path/to/symphony-ts
export LINEAR_API_KEY=your-linear-token
node dist/src/cli/main.js /path/to/target-repo/WORKFLOW.md \
  --acknowledge-high-trust-preview \
  --port 4321
```

If you do not pass a path, Symphony defaults to `./WORKFLOW.md`:

```bash
cd /path/to/target-repo
export LINEAR_API_KEY=your-linear-token
node /path/to/symphony-ts/dist/src/cli/main.js \
  --acknowledge-high-trust-preview \
  --port 4321
```

Symphony does not generate `WORKFLOW.md` for you. It expects a repository-owned workflow file.
Relative paths in workflow config, such as `workspace.root`, resolve from the workflow file's
directory.

The workspace is empty when Symphony first creates it. Configure `hooks.after_create` to clone or
prepare the target repository before Codex starts; otherwise the agent will run in an empty
directory.

<details>
<summary>Agent setup prompt</summary>

```text
Set up and start Symphony in this repository.

Requirements:
- create or update WORKFLOW.md for Linear
- use LINEAR_API_KEY from the environment or tell me exactly which variable is missing
- build the local symphony-ts checkout and start it with the required --acknowledge-high-trust-preview flag
- if startup fails, stop and report the exact failing step and command
```

</details>

### `WORKFLOW.md` template

```md
---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: your-linear-project-slug
  claim_state: In Progress
  handoff_states: [In Review, Review]
  blocked_state: Needs decision
  require_claim_before_agent: true
workspace:
  root: ~/code/symphony-workspaces
polling:
  issue_comments_between_turns: true
hooks:
  after_create: |
    git clone git@github.com:your-org/your-repo.git .
    npm install
codex:
  command: codex app-server
server:
  port: 4321
---

You are working on Linear issue {{ issue.identifier }}.
If the task is missing implementation-ready requirements, ask concrete blocker questions through
the configured blocker mechanism. Otherwise implement the task, validate the result, and use the
configured handoff mechanism when ready.
```

This is the only example `WORKFLOW.md` you need to get started. Copy it into your repository root
as `WORKFLOW.md`, then change these fields before starting Symphony:

- `tracker.project_slug`
- `workspace.root`
- `hooks.after_create`
- `codex.command`

For Notion workflows, Symphony also guards against empty tickets before Codex starts: when a task
has no usable description, no usable page-body/comment context, and `blocked_state` is configured,
it posts default clarification questions and moves the task to the blocked state without launching a
Codex turn. Existing body/comment answers are treated as usable task context even when the
description property itself is empty.

If you want the dashboard, keep `server.port` in the workflow or pass `--port` on the CLI.
The web dashboard now opens with a server-rendered snapshot and continues updating live in the
browser over server-sent events.

If your agent workflow needs access to environment variables from the launching shell, configure
Codex to inherit them in `codex.command`, for example:

```yaml
codex:
  command: codex --config shell_environment_policy.inherit=all app-server
```

If your agent must push branches, open PRs, or call external APIs during a turn, configure a turn
sandbox policy that explicitly allows network access and writable roots for the active workspace.
Symphony expands `{{ workspace.path }}` and `{{ workspace.git_dir }}` placeholders before starting
Codex. Codex still protects `.git` recursively in `workspaceWrite`, even when `.git` appears in
`writableRoots`. For automated branch, commit, and push workflows, use `approval_policy: on-request`
and instruct the agent to request a narrow sandbox escalation for the required Git command. The
current high-trust Symphony client auto-approves every approval request it recognizes; it does not
enforce a Git-only or command-kind allowlist. `on-request` still lets Codex escalate individual operations
while the rest of the turn remains in `workspaceWrite`. Use this posture only when ticket input,
workflow instructions, and available credentials are trusted.

If a specific external CLI still does not see the credentials or executable paths it needs in your
environment, provide that tool's credential via environment variables before launching Symphony and
consider prefixing `codex.command` with an explicit `PATH=...`.

For GitHub workflows, `capabilities.github.credential_source: gh_auth_token` can reuse a one-time
`gh auth login`: when no explicit `GH_TOKEN` or `GITHUB_TOKEN` exists, Symphony reads the current
GitHub CLI token and passes it only in memory to the worker's Codex app-server. The sandboxed GitHub
preflight still has to prove identity, repository resolution, and push permission before a turn.

For a complete reference covering every supported field with defaults and inline documentation, see
[docs/WORKFLOW.template.md](docs/WORKFLOW.template.md).

For adapter-specific setup:

- [docs/TRACKER_ADAPTERS.md](docs/TRACKER_ADAPTERS.md)
- [docs/NOTION_ADAPTER.md](docs/NOTION_ADAPTER.md)

### What You Get

Once Symphony is running, it will:

- poll your tracker for eligible work
- create a dedicated workspace per issue
- run your coding agent inside that workspace
- expose a local dashboard and JSON API when `--port` or `server.port` is set
- keep retry, reconciliation, and cleanup state visible to operators

### Develop

To develop Symphony itself you will need:

- Node.js `>= 22`
- pnpm `>= 10`
- Codex CLI with `codex app-server` support

```bash
pnpm install
pnpm build
node dist/src/cli/main.js --help   # verify the build
```

Run checks:

```bash
pnpm test           # run all tests once
pnpm test:watch     # watch mode
pnpm typecheck      # TypeScript type check only
pnpm lint           # Biome lint check
pnpm format         # Biome auto-format
```

### Run Against a Target Project

```bash
pnpm install
pnpm build
node dist/src/cli/main.js /path/to/target-repo/WORKFLOW.md \
  --acknowledge-high-trust-preview \
  --port 4321
```

See [docs/DEV_GUIDE.md](docs/DEV_GUIDE.md) for a full walkthrough including Linear setup, `WORKFLOW.md` configuration, and troubleshooting.

## Roadmap

| Item | Status |
| --- | --- |
| Implement Symphony and Linear integration | ✅ Complete |
| Add pluggable tracker adapter layer | ✅ Complete |
| Add bundled Notion tracker adapter | ✅ Complete |
| Add a per-ticket status screen with current agent work and changed files | 🟡 Planned |
| Refine the dashboard home page around operator attention and daily use | 🟡 Planned |
| Stabilize ticket/worktree continuation across restarts and retries | 🟡 Planned |
| Notify operators when a newer `symphony-ts` version is available | 🟡 Planned |
| Support more platforms such as GitHub Projects | 🟡 Planned |
| Support a local board GUI | 🟡 Planned |
| Support more coding agents such as Claude Code scheduling | 🟡 Planned |

If there is a platform you want Symphony to support, open an issue and let us know.

## What Symphony Does

Symphony is a long-running service that:

- monitors your tracker for eligible work
- creates deterministic, per-issue workspaces
- renders repository-owned workflow prompts from `WORKFLOW.md`
- runs coding agents in isolated execution contexts
- handles retries, reconciliation, and cleanup
- exposes structured logs and an operator-facing status surface

In a typical setup, Symphony watches a Linear board, dispatches agent runs for ready tickets, and
lets the agents produce proof of work such as CI status, review feedback, and pull requests. Human
operators stay focused on the work itself instead of supervising every agent turn.

## Why Teams Use It

- to turn tracker tickets into autonomous implementation runs
- to isolate agent work by issue instead of sharing one mutable directory
- to keep workflow policy inside the repository
- to operate multiple concurrent agents without losing observability
- to introduce a higher-level operating model for AI-assisted engineering

## Contributing

If you are extending this TypeScript implementation, keep changes aligned with the upstream product
model in [`SPEC.upstream.md`](SPEC.upstream.md) and follow the repository workflow documented in
[`AGENTS.md`](AGENTS.md).

## License

This repository is licensed under [`Apache-2.0`](LICENSE). See [`NOTICE`](NOTICE) for attribution
information related to the upstream OpenAI Symphony project and this unofficial TypeScript
implementation.

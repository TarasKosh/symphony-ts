# Symphony-TS Developer Quick-Start Guide

> For: developers with a Linear test project who want to run Symphony locally and start contributing.

---

## What Is This Project

Symphony-TS is a TypeScript implementation of the [Symphony](https://github.com/openai/symphony) specification.

**In one sentence**: A long-running daemon that polls a Linear board, creates isolated workspaces for each active issue, launches a Codex (OpenAI coding agent) subprocess per issue, and manages concurrency, retries, state reconciliation, and observability.

**Core data flow**:

```
WORKFLOW.md (config + prompt template)
      |
      v
[Orchestrator] -- polls Linear --> active Issues
      |
      v
[WorkspaceManager] -- creates /tmp/symphony_workspaces/<issue-key>/
      |
      v
[AgentRunner] -- spawns codex app-server subprocess in workspace
      |
      v
Codex agent works on the issue, writes back to Linear via linear_graphql tool
```

---

## Project Structure

```
src/
  cli/              # Entry point: main.ts - parses CLI args, loads config, starts runtime
  config/           # WORKFLOW.md parsing, typed config resolution, hot-reload file watcher
  domain/           # Core type definitions (Issue, RunAttempt, LiveSession, etc.)
  orchestrator/     # Dispatch core (core.ts) + runtime host (runtime-host.ts)
  agent/            # AgentRunner (spawns Codex subprocess) + prompt builder
  tracker/          # Linear GraphQL client, queries, response normalization
  codex/            # Codex app-server protocol client + linear_graphql dynamic tool
  workspace/        # Workspace directory management, path safety, lifecycle hooks
  logging/          # Structured logging, session metrics, runtime snapshots
  observability/    # Optional HTTP dashboard server
  errors/           # Error code constants
  index.ts          # Public API exports

tests/              # Vitest tests, mirroring src/ structure
```

**Key files at a glance**:

| Concern | File |
|---------|------|
| Dispatch logic | [src/orchestrator/core.ts](src/orchestrator/core.ts) |
| Runtime startup | [src/orchestrator/runtime-host.ts](src/orchestrator/runtime-host.ts) |
| Config resolution | [src/config/config-resolver.ts](src/config/config-resolver.ts) |
| Defaults | [src/config/defaults.ts](src/config/defaults.ts) |
| Linear client | [src/tracker/linear-client.ts](src/tracker/linear-client.ts) |
| Agent launch | [src/agent/runner.ts](src/agent/runner.ts) |
| Prompt construction | [src/agent/prompt-builder.ts](src/agent/prompt-builder.ts) |
| Codex protocol | [src/codex/app-server-client.ts](src/codex/app-server-client.ts) |
| CLI entry | [src/cli/main.ts](src/cli/main.ts) |
| Domain model | [src/domain/model.ts](src/domain/model.ts) |

Codex client-side tools are advertised with `thread/start.params.dynamicTools`, not the legacy
`tools` field. The client opts into `experimentalApi` during `initialize`, accepts v2
`item/tool/call` requests with `params.tool` and `params.arguments`, and replies with official
`contentItems` output.

---

## Step-by-Step Quick Start

### Step 1: Prerequisites

Make sure you have:
- Node.js >= 22
- pnpm >= 10
- Codex CLI installed (`codex app-server` command must be available)

```bash
node --version    # must be v22+
pnpm --version    # must be 10+
codex --version   # must support codex app-server
```

### Step 2: Install Dependencies and Build

```bash
cd /path/to/symphony-ts
pnpm install
pnpm build
```

Build output goes to `dist/`. The CLI entry point is `dist/src/cli/main.js`.

Verify the build:

```bash
node dist/src/cli/main.js --help
```

Do not install this fork globally through npm for local development. Use the built CLI path directly
when targeting another repository.

### Step 3: Get Your Linear API Key and Project Slug

1. Go to Linear -> Settings -> API -> Personal API Keys
2. Create a new key and copy it
3. Find your test project's **slug** (visible in the URL or project settings)

Export the key as an environment variable (never commit it):

```bash
export LINEAR_API_KEY="lin_api_xxxxxxxxxxxx"
```

Or put it in an untracked `.env.local` and source it yourself — Symphony does not auto-load `.env` files.

### Step 4: Create WORKFLOW.md

Create `WORKFLOW.md` in the **target repository** (the codebase Codex will work in). Symphony can
load a workflow from any path, but keeping it in the target repository versions the tracker config,
workspace bootstrap, and agent prompt with that codebase.

Symphony creates an empty per-issue workspace first. Use `hooks.after_create` to clone or otherwise
populate the target repository before Codex starts.

Minimal working example:

```markdown
---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: "your-project-slug"
  active_states:
    - "Todo"
    - "In Progress"
  claim_state: "In Progress"
  handoff_states:
    - "In Review"
    - "Review"
  blocked_state: "Needs decision"
  require_claim_before_agent: true
  terminal_states:
    - "Closed"
    - "Cancelled"
    - "Canceled"
    - "Duplicate"
    - "Done"

polling:
  interval_ms: 30000

workspace:
  root: ~/symphony_workspaces/your-repo

hooks:
  after_create: |
    git clone git@github.com:your-org/your-repo.git .
    npm install
  timeout_ms: 300000

agent:
  max_concurrent_agents: 2
  max_turns: 20

codex:
  command: "codex app-server"
  approval_policy: "never"
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000
---

You are a software engineer working on a Linear issue.

Issue: {{ issue.identifier }} - {{ issue.title }}
State: {{ issue.state }}
Description: {{ issue.description | default: "No description provided." }}
{% if attempt %}Retry attempt: {{ attempt }}{% endif %}

Work on this issue. When done, use the configured handoff mechanism. For Linear,
use the linear_graphql tool. For write-capable adapters such as Notion, call
the symphony_ticket_read tool before repo edits, symphony_ticket_note for
retrievable checkpoints, and symphony_handoff with PR evidence and validation
results when ready for review.
```

**WORKFLOW.md field reference**:

> For an annotated file covering every field with defaults and comments, see
> [WORKFLOW.template.md](WORKFLOW.template.md).

| Field | Description | Default |
|-------|-------------|---------|
| `tracker.kind` | Tracker backend. Bundled: `linear`, `notion` | `linear` |
| `tracker.endpoint` | Tracker API endpoint | Linear or Notion default |
| `tracker.api_key` | Tracker API key; use `$ENV_VAR` to reference env | Reads adapter canonical env var |
| `tracker.project_slug` | Linear project slug — required for Linear | None |
| `tracker.active_states` | Issue states that trigger dispatch | `[Todo, In Progress]` |
| `tracker.claim_state` | State written before Codex starts when lifecycle writes are supported | `In Progress` |
| `tracker.handoff_states` | Exact handoff states, in preference order | `[In Review, Review]` |
| `tracker.blocked_state` | Operator-action state name for workflows that use one | `Needs decision` |
| `tracker.require_claim_before_agent` | Failed claim blocks Codex startup for write-capable adapters | `true` |
| `tracker.terminal_states` | States that trigger workspace cleanup | `[Closed, Cancelled, Canceled, Duplicate, Done]` |
| `polling.interval_ms` | Poll interval in milliseconds | `30000` |
| `polling.issue_comments_between_turns` | Add newly observed tracker comments to the next turn on the same live thread | `false` |
| `polling.issue_comment_ignored_authors` | Integration/bot authors excluded from comment delivery | `[]` |
| `workspace.root` | Root directory for all workspaces | `<os.tmpdir()>/symphony_workspaces` |
| `workspace.retention.states` | Non-active states eligible for guarded stale cleanup | `[]` (disabled) |
| `workspace.retention.stale_after_days` | Age since tracker update before guarded cleanup | unset (disabled) |
| `workspace.retention.check_interval_ms` | Interval between stale-workspace sweeps | `86400000` |
| `hooks.after_create` | Shell command run after a new empty workspace is created; normally clone the target repo here | `null` |
| `hooks.before_run` | Shell command run before each agent turn (fatal on non-zero exit) | `null` |
| `hooks.after_run` | Shell command run after each agent turn (errors suppressed) | `null` |
| `hooks.before_remove` | Shell command run before workspace removal (errors suppressed) | `null` |
| `hooks.timeout_ms` | Max time in ms for any single hook | `60000` |
| `agent.max_concurrent_agents` | Global agent concurrency cap | `10` |
| `agent.max_turns` | Max Codex turns per run | `20` |
| `agent.max_retry_backoff_ms` | Max retry back-off delay in ms (exponential cap) | `300000` |
| `agent.max_concurrent_agents_by_state` | Per-state concurrency overrides (map of state → limit) | `{}` |
| `codex.command` | Shell command to launch Codex | `codex app-server` |
| `codex.approval_policy` | Codex approval policy, passed through to the installed Codex schema | Inherits Codex default |
| `codex.thread_sandbox` | Thread-level sandbox mode (e.g. `workspace-write`) | `null` |
| `codex.turn_sandbox_policy` | Per-turn sandbox policy object | `null` |
| `codex.turn_timeout_ms` | Max wall-clock time in ms for a full agent turn | `3600000` |
| `codex.read_timeout_ms` | Max response wait for synchronous Codex requests; Windows session-start requests use at least `30000` ms | `5000` |
| `codex.stall_timeout_ms` | Max silent time in ms before a running agent is declared stalled and stopped | `300000` |
| `capabilities.commands` | Map of safe executable basenames to hook/agent boundary requirements | `{}` |
| `capabilities.commands.<command>.hooks` | Required hook boundaries (`after_create`, `before_run`, `after_run`, `before_remove`) | `[]` |
| `capabilities.commands.<command>.agent` | Probe through the worker Codex app-server before tracker claim and turn start | `false` |
| `capabilities.commands.<command>.probe_args` | Direct argv used only for the agent probe | `[]` |
| `capabilities.github.required` | Require a read-only `gh` identity, target-repository, and push-permission preflight before Codex starts | `false` |
| `capabilities.github.credential_source` | Use inherited env credentials, or bridge the current `gh auth` token into Codex memory-only | `environment` |
| `server.port` | HTTP dashboard port; omit or `null` to disable | `null` |
| `observability.dashboard_enabled` | Enable live dashboard updates when the HTTP server is running | `true` |
| `observability.refresh_ms` | Dashboard heartbeat interval in ms for time-based refreshes | `1000` |
| `observability.render_interval_ms` | Minimum spacing in ms between pushed dashboard renders | `16` |

The prompt body uses **Liquid template syntax**. Available variables:
- `{{ issue.identifier }}`, `{{ issue.title }}`, `{{ issue.description }}`
- `{{ issue.state }}`, `{{ issue.url }}`, `{{ issue.labels }}`
- `{{ attempt }}` — `null` on first run, integer on retries

### Step 5: Run Symphony

```bash
# From this symphony-ts checkout, pass the target workflow path explicitly.
cd /path/to/symphony-ts
node dist/src/cli/main.js /path/to/target-repo/WORKFLOW.md \
  --acknowledge-high-trust-preview

# Or run from the target repository root; ./WORKFLOW.md is the default.
cd /path/to/target-repo
node /path/to/symphony-ts/dist/src/cli/main.js \
  --acknowledge-high-trust-preview

# Enable the optional HTTP dashboard
node /path/to/symphony-ts/dist/src/cli/main.js \
  --acknowledge-high-trust-preview \
  --port 3000
```

> `--acknowledge-high-trust-preview` is a required safety flag. Symphony runs agent code without sandboxing by default; this flag confirms you understand that.

### Environment and networked CLI note

If your workflow depends on environment variables from the launching shell, launch Codex with
shell environment inheritance enabled:

```yaml
codex:
  command: codex --config shell_environment_policy.inherit=all app-server
```

If the agent must use networked tools during a turn, configure an explicit
`codex.turn_sandbox_policy` that allows network access, for example:

```yaml
codex:
  approval_policy: on-request
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
    writableRoots:
      - "{{ workspace.path }}"
      - "{{ workspace.git_dir }}"
    networkAccess: true
    excludeTmpdirEnvVar: false
    excludeSlashTmp: false
```

Symphony expands `{{ workspace.path }}` and `{{ workspace.git_dir }}` before starting Codex. For
`workspaceWrite` policies it ensures both paths are present in `writableRoots`, but Codex still
protects `.git` recursively. Git commands that create refs or commits therefore need a narrow
sandbox escalation. With `approval_policy: on-request`, the current high-trust Symphony client
auto-approves every approval request it recognizes; it does not enforce a Git-only or command-kind
allowlist. The rest of the turn remains in `workspaceWrite`, so use this posture only for trusted
ticket input, workflow instructions, and credentials.

With that in place, env-based credentials exported before launching Symphony are available to turn
commands. If a specific external CLI still does not find usable credentials or executable paths in
your environment, provide that tool's credential via an env var such as `GH_TOKEN`, `GITHUB_TOKEN`,
or a provider-specific API key and launch `codex.command` with an explicit `PATH=...` prefix.

For a workflow that requires an external command, declare every real execution boundary:

```yaml
capabilities:
  commands:
    rg:
      hooks: [after_create, before_run]
      agent: true
      probe_args: [--version]
```

Command keys are simple executable basenames; paths, whitespace, shell metacharacters, and inactive
declarations are `config_invalid`. Omitting the map is a true no-op. Hook checks run before the hook
body in the same `sh -lc` invocation and do not invoke the required command. Agent checks use a
direct argv vector through the same app-server instance, workspace cwd, inherited environment, and
prepared turn sandbox as the later Codex session. Success in one boundary does not prove the other.

Missing and execution-denied commands enter a timer-free operator hold. Repair the command's PATH,
installation, execute permission, or sandbox policy in the named boundary, then use the dashboard's
explicit retry action. Timeout, protocol, and unclassified checks use ordinary retry backoff. The
operator surfaces retain only sanitized command, boundary, capability, stable code, and remediation
metadata; raw PATH, probe output, arguments, and credentials are discarded.

Symphony does not auto-inject Codex's bundled ripgrep. `codex.command` can name an arbitrary wrapper
or compatible app-server, bundled installation paths are private and unstable, and injecting PATH
would alter command precedence while still saying nothing about the hook shell boundary.

For workflows that must push through GitHub CLI, enable the opt-in preflight:

```yaml
capabilities:
  github:
    required: true
    credential_source: gh_auth_token
```

With `gh_auth_token`, log in once with `gh auth login`. If neither `GH_TOKEN` nor `GITHUB_TOKEN` is
already set, Symphony reads the current `github.com` token from the GitHub CLI credential store for
each worker and passes it to that worker's app-server as an in-memory `GH_TOKEN`. Symphony does not
persist or print it. Explicit env tokens have priority and are never silently replaced. This bridge
is high-trust: Codex and commands launched by the agent can access the credential they need to push.

After `hooks.before_run` succeeds, Symphony initializes the worker's Codex app-server and runs
read-only `gh` checks through its experimental `command/exec` method. The checks use the ticket
workspace, inherit the app-server environment without overrides, and receive the same prepared
`codex.turn_sandbox_policy` as the later turn. Symphony does not send `thread/start` or `turn/start`
until the checks pass. Probe output is capped at 64 KiB per stream where Codex supports custom caps;
on Windows sandbox execution, Symphony uses the app-server's built-in bounded capture.

The exact accepted sandbox and approval values depend on the installed Codex app-server version. To
inspect the local schema, run `codex app-server generate-json-schema --out <dir>` and inspect the
generated `ThreadStartParams` and `TurnStartParams` schema files.

### Step 6: Trigger a Test Issue in Linear

1. Open your Linear test project
2. Create an issue and set its state to `Todo` or `In Progress`
3. Wait for the next poll cycle (default: 30 seconds)
4. Watch Symphony's terminal output — the issue should be dispatched
5. Codex will run inside `~/symphony_workspaces/<issue-key>/`

### Step 7: Run Tests

```bash
pnpm test           # run all tests once
pnpm test:watch     # watch mode
pnpm typecheck      # TypeScript type check only
pnpm lint           # Biome lint check
pnpm format         # Biome auto-format
```

---

## Key Concepts for Development

### Orchestrator State Machine

Each issue moves through these internal states:

```
unclaimed -> claimed -> running -> (retry_queued -> running)* -> released
```

- **unclaimed**: fetched from Linear but not yet reserved
- **claimed**: slot reserved; prevents duplicate dispatch
- **running**: Codex agent is active
- **retry_queued**: agent exited, waiting to re-dispatch (normal exit: 1s delay; abnormal exit: exponential backoff capped at 5 minutes)
- **released**: issue reached a terminal state; claim freed

### Workspace Lifecycle Hooks

Configure shell scripts in `WORKFLOW.md` that run at workspace lifecycle points:

```yaml
hooks:
  after_create: |
    git clone https://github.com/your-org/your-repo.git .
    npm install
  before_run: |
    git pull --rebase
  after_run: |
    echo "Agent finished"
  before_remove: |
    echo "Workspace being cleaned up"
  timeout_ms: 60000
```

`after_create` is the most important hook — use it to clone your repo into the fresh workspace before the agent starts.

### linear_graphql Dynamic Tool

Every Codex agent run automatically gets a `linear_graphql` tool injected, allowing the agent to read and write Linear directly:

```graphql
# Example mutation an agent might run to update issue state
mutation UpdateState($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success
  }
}
```

### Concurrency Control

```yaml
agent:
  max_concurrent_agents: 5           # global cap
  max_concurrent_agents_by_state:    # per-state fine-grained control
    "in progress": 3
    "todo": 2
```

State keys are matched case-insensitively.

### Config Hot-Reload

These fields take effect on the next poll tick without restarting Symphony:
- `polling.interval_ms`
- `polling.issue_comments_between_turns`
- `polling.issue_comment_ignored_authors`
- `workspace.retention.*`
- `agent.max_concurrent_agents`
- `agent.max_retry_backoff_ms`
- `hooks.timeout_ms`
- `capabilities.github.required`
- `capabilities.github.credential_source`

---

## Troubleshooting

**Issues are not being dispatched after startup**
- Verify `tracker.project_slug` matches exactly (check Linear project URL)
- Verify `LINEAR_API_KEY` is set and valid
- Check that the issue's current state matches an entry in `active_states` (comparison is case-insensitive after trim)

**`codex app-server` command not found**
- Confirm Codex CLI is installed and on `PATH`
- Use an absolute path in WORKFLOW.md: `codex.command: "/usr/local/bin/codex app-server"`

**GitHub capability preflight is on operator hold**
- `github_cli_not_found`: install `gh` and make it resolvable in both the Symphony launch environment
  and the Codex command environment.
- `github_remote_missing`: inspect the named ticket workspace and clone or configure its
  GitHub-backed git remote. Repairing credentials does not fix this hold.
- `github_auth_invalid`: with `credential_source: gh_auth_token`, run `gh auth login` again if the
  stored credential was revoked or expired. Otherwise provide a valid `GH_TOKEN` or `GITHUB_TOKEN`
  without writing it to workflow files or logs.
- `github_permission_denied`: grant the authenticated identity push access to the workspace target
  repository, and resolve organization or SSO authorization requirements.
- The hold reason may include a one-line, stderr-only GitHub CLI diagnostic excerpt. It is bounded
  and credential-redacted; use it to distinguish workspace, authentication, permission, and
  transient failures without expecting raw command output.
- After correcting a deterministic failure, explicitly retry only the selected held issue with
  `POST /api/v1/holds/<url-encoded-issue-identifier>/retry`, or restart Symphony if the repaired
  environment is only available to a new process. The `gh_auth_token` source is re-read on the
  selected issue's retry, so a completed `gh auth login` does not require a Symphony restart.
  Transient/network failures retry automatically with normal failure backoff.

**Required command capability is on operator hold**

- Read the structured `command`, `boundary`, and `remediation` fields; raw PATH and probe output are
  intentionally unavailable.
- Install or expose the executable in the named boundary, or repair its execute/sandbox policy.
- Explicitly retry only the held issue after the boundary is repaired.

**Agent stalls and never finishes**
- `codex.stall_timeout_ms` (default 5 minutes) will kill and retry a stalled agent
- Set `codex.stall_timeout_ms: 0` to disable stall detection

**How to watch runtime state**
- Structured JSON logs are the primary observability surface
- Launch with `--port 3000` to access the HTTP dashboard at `http://localhost:3000`
- The dashboard serves an initial HTML snapshot, then stays current over `/api/v1/events`

---

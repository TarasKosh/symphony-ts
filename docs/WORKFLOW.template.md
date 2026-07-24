---
# ============================================================
# tracker — Issue tracker adapter connection
# ============================================================
tracker:
  # Tracker adapter selected by this repository.
  # Currently bundled: "linear" and "notion".
  kind: linear

  # GraphQL endpoint for the Linear API.
  # Default: https://api.linear.app/graphql
  endpoint: https://api.linear.app/graphql

  # Tracker API key. Use $ENV_VAR syntax to read from environment.
  # Canonical env fallback:
  # - linear -> LINEAR_API_KEY
  # - notion -> NOTION_API_KEY
  api_key: $LINEAR_API_KEY

  # Linear-only: project slug (the short identifier visible in issue URLs).
  # Required for tracker.kind: linear. Example: ENG, MYPROJECT-abc123
  project_slug: YOUR_PROJECT_SLUG

  # Notion alternative:
  # kind: notion
  # endpoint: https://api.notion.com/v1
  # api_key: $NOTION_API_KEY
  # data_source_id: YOUR_NOTION_DATA_SOURCE_ID
  # title_property: Name
  # status_property: Status
  # identifier_property: Key
  # description_property: Description
  # priority_property: Priority
  # labels_property: Labels
  # blocked_by_property: Blocked by

  # Issue states that are eligible for the agent to pick up.
  # Default: [Todo, In Progress]
  active_states: [Todo, In Progress]

  # State Symphony writes before launching Codex when the adapter supports lifecycle write-back.
  # Default: In Progress
  claim_state: In Progress

  # Handoff states Symphony may write after the agent calls `symphony_handoff`.
  # The first exact option that exists in the tracker schema is used.
  # Default: [In Review, Review]
  handoff_states: [In Review, Review]

  # Optional operator-action state name for project workflows that expose one.
  # Default: Needs decision
  blocked_state: Needs decision

  # If true and the adapter supports lifecycle writes, failed claim write-back
  # blocks Codex startup and schedules a cheap orchestration retry.
  # Default: true
  require_claim_before_agent: true

  # Issue states that are considered permanently finished.
  # Reaching one of these triggers workspace cleanup.
  # Default: [Closed, Cancelled, Canceled, Duplicate, Done]
  terminal_states: [Closed, Cancelled, Canceled, Duplicate, Done]

# ============================================================
# polling — How often Symphony checks for new/changed issues
# ============================================================
polling:
  # Interval between poll ticks in milliseconds.
  # Default: 30000 (30 s)
  interval_ms: 30000

# ============================================================
# workspace — Per-issue working directory management
# ============================================================
workspace:
  # Root directory under which per-issue workspaces are created.
  # Supports ~ expansion, relative paths (resolved from WORKFLOW.md),
  # and $ENV_VAR references.
  # Default: <os.tmpdir()>/symphony_workspaces
  root: /tmp/symphony_workspaces

# ============================================================
# hooks — Shell commands run at workspace lifecycle events
# All hooks are optional (omit or set to null/empty to skip).
# ============================================================
hooks:
  # Run after a new empty workspace directory is created.
  # This is where you normally clone or bootstrap the target repository.
  # Example:
  #   after_create: |
  #     git clone git@github.com:your-org/your-repo.git .
  #     npm install
  after_create: null

  # Run before each agent turn starts (fatal on non-zero exit).
  before_run: null

  # Run after each agent turn finishes (best-effort, errors suppressed).
  after_run: null

  # Run before a workspace is removed (best-effort, errors suppressed).
  before_remove: null

  # Maximum time in ms any single hook may run before being killed.
  # Default: 60000 (60 s)
  timeout_ms: 60000

# ============================================================
# capabilities — Required external CLI access (all opt-in)
# ============================================================
capabilities:
  # External commands required by this workflow. Keys must be simple executable
  # basenames: no whitespace, path separators, or shell metacharacters.
  # Omit this map (or leave it empty) for no added startup behavior.
  # Example (replace the empty map below):
  #   commands:
  #     rg:
  #       hooks: [after_create, before_run]
  #       agent: true
  #       probe_args: [--version]
  # Hook checks run immediately before the hook body in the same sh -lc
  # invocation. Agent checks run through the same app-server, cwd,
  # environment, and prepared sandbox as the later turn.
  # Defaults: hooks [], agent false, probe_args []
  commands: {}

  github:
    # Before the first Codex turn, verify gh identity and push access to the
    # repository checked out in the ticket workspace. The probe is read-only.
    # Default: false
    required: false

    # Credential handling for the worker app-server:
    # - environment: use GH_TOKEN/GITHUB_TOKEN or credentials already visible
    #   at the Codex command boundary.
    # - gh_auth_token: preserve explicit env tokens; otherwise read the current
    #   github.com token from `gh auth token` in the Symphony host process and
    #   pass it to Codex only in memory. Log in once with `gh auth login`.
    # Default: environment
    credential_source: environment

# ============================================================
# agent — Concurrency and retry behaviour
# ============================================================
agent:
  # Maximum number of issues being processed simultaneously.
  # Default: 10
  max_concurrent_agents: 10

  # Maximum number of Codex turns allowed per run attempt.
  # Default: 20
  max_turns: 20

  # Maximum retry back-off delay in milliseconds (exponential back-off cap).
  # Default: 300000 (5 min)
  max_retry_backoff_ms: 300000

  # Per-state concurrency limits (optional, overrides max_concurrent_agents
  # for issues in a specific state). Example:
  #   max_concurrent_agents_by_state:
  #     In Review: 2
  # Default: {} (no per-state limits)
  max_concurrent_agents_by_state: {}

# ============================================================
# codex — Codex app-server process configuration
# ============================================================
codex:
  # Shell command used to launch the Codex app-server.
  # Add `--config shell_environment_policy.inherit=all` if agent turns
  # should inherit environment variables from the launching shell.
  # Default: codex app-server
  command: codex app-server

  # Codex approval policy, passed through to the app-server.
  # Common values depend on the installed Codex schema.
  # Example values: never, on-request, on-failure
  # Use on-request when trusted turns must create branches or commits: Codex protects
  # .git in workspace-write. The high-trust client auto-approves every approval
  # request it recognizes; it has no Git-only or command-kind allowlist.
  # Default: (not set — inherits Codex default)
  approval_policy: on-request

  # Thread-level sandbox mode passed through to Codex.
  # Example values: workspace-write
  # Default: (not set)
  thread_sandbox: null

  # Per-turn sandbox policy passed through to Codex.
  # Example:
  #   turn_sandbox_policy:
  #     type: workspaceWrite
  #     writableRoots:
  #       - "{{ workspace.path }}"
  #       - "{{ workspace.git_dir }}"
  #     networkAccess: true
  #     excludeTmpdirEnvVar: false
  #     excludeSlashTmp: false
  # Symphony expands both placeholders and includes them in writableRoots.
  # Codex still protects .git recursively in workspace-write. For trusted workflows,
  # use on-request and prompt for per-command escalation; narrowness is not enforced.
  # Default: (not set)
  turn_sandbox_policy: null

  # Maximum wall-clock time in ms for a full agent turn.
  # Default: 3600000 (1 h)
  turn_timeout_ms: 3600000

  # Maximum response wait in ms for synchronous Codex requests.
  # Default: 5000 (5 s)
  # On Windows, initialize/thread-start/turn-start requests use at least 30000 ms.
  read_timeout_ms: 5000

  # Maximum time in ms a running agent may be silent before being
  # declared stalled and stopped.
  # Default: 300000 (5 min)
  stall_timeout_ms: 300000

# ============================================================
# server — Built-in HTTP status server (optional)
# ============================================================
server:
  # Port to listen on. Set to a number to enable, or omit/null to disable.
  # Default: null (disabled)
  port: null

# ============================================================
# observability — Live dashboard refresh behavior (optional)
# ============================================================
observability:
  # Enable live updates for the HTTP dashboard.
  # Default: true
  dashboard_enabled: true

  # Heartbeat interval in milliseconds for live dashboard refreshes.
  # Used to keep runtime counters current even when no orchestration state changes.
  # Default: 1000 (1 s)
  refresh_ms: 1000

  # Minimum spacing between pushed dashboard renders in milliseconds.
  # Default: 16 (~60 FPS upper bound)
  render_interval_ms: 16
---

You are implementing work for tracker issue {{ issue.identifier }}.

<!-- Replace the lines below with your actual agent instructions. -->

Rules:

1. Implement only what the ticket asks for.
2. Keep changes scoped and safe.
3. Run the test suite before finishing.
4. Do not add secrets or credentials to the repository.
5. When `symphony_ticket_read` is available, call it before repo edits and treat page body/comments
   as live ticket context alongside the rendered description.
6. When `symphony_ticket_note` is available, use it for retrievable checkpoints, branch/PR links,
   validation notes, and non-blocking questions.
7. When the task is not implementation-ready and `symphony_block` is available, use it for concrete
   blocker questions and blocked-state write-back instead of raw tracker API calls.

If this workflow needs environment variables from the launching shell:

1. Launch Codex with `--config shell_environment_policy.inherit=all`.
2. Export the required environment variables before launching Symphony. For GitHub, alternatively
   set `capabilities.github.credential_source: gh_auth_token` and log in once with `gh auth login`.

If the agent must call networked tools during a turn:

1. Configure `codex.turn_sandbox_policy` with explicit `networkAccess: true`.
2. If a specific CLI still does not find usable credentials in your environment, provide that
   tool's credential via an env var such as `GH_TOKEN`, `GITHUB_TOKEN`, or a provider-specific API
   key.

If `capabilities.github.required` is enabled, Symphony runs the GitHub check after `before_run`
through `command/exec` on the same Codex app-server that will own the worker session. It uses the
ticket workspace, inherited app-server environment, and prepared `turn_sandbox_policy`, and it must
pass before `thread/start` or `turn/start`. Fix `gh` installation, authentication, repository push
access, or sandbox network access, then retry only the selected held issue with
`POST /api/v1/holds/<url-encoded-issue-identifier>/retry`. Restart Symphony instead when the repaired
environment is only available to a new process.

With `credential_source: gh_auth_token`, Symphony keeps the GitHub CLI token in memory only and
re-reads it for a new worker or explicit retry. Non-empty `GH_TOKEN` and `GITHUB_TOKEN` values always
take priority. Codex and its agent commands can access the selected credential, so enable this only
for trusted workflows.

Declared `capabilities.commands` are boundary-scoped. Hook requirements are checked without
invoking the command, inside the hook's own `sh -lc`; agent requirements execute the declared
basename plus `probe_args` through Codex `command/exec`. A command listed for both boundaries must
pass both. Missing and execution-denied commands create a timer-free operator hold; timeout,
protocol, and unclassified failures use retry backoff. Diagnostics contain only the command,
boundary, stable code, capability name, and remediation—never PATH, resolved paths, probe output,
arguments, or credentials.

Symphony deliberately does not inject a private Codex-bundled `rg`. Codex may be launched through
an arbitrary compatible wrapper, bundled paths are not a stable API, and PATH injection would alter
command precedence without proving availability in the hook shell. Install the command in each
declared boundary, then explicitly retry the held issue.

When finished:

1. Use the configured handoff mechanism when the repository workflow is ready for review.
   - For write-capable adapters such as Notion, call `symphony_handoff` with:
     - `ready_for_review: true`
     - PR URL or number
     - head SHA
     - validation summary
     - residual risks
   - For Linear, use the `linear_graphql` tool unless your workflow provides another
     adapter-neutral handoff path.
   - Do not move the tracker ticket to a terminal state such as `Done` unless this workflow
     explicitly instructs you to do so.

2. Provide a summary:
   - What changed
   - Test command and result
   - Any follow-up risks

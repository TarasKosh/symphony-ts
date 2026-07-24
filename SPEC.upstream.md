# Symphony Service Specification

Status: Draft v1 (language-agnostic)

Purpose: Define a service that orchestrates coding agents to get project work done.

## 1. Problem Statement

Symphony is a long-running automation service that continuously reads work from an issue tracker
(Linear in this specification version), creates an isolated workspace for each issue, and runs a
coding agent session for that issue inside the workspace.

The service solves four operational problems:

- It turns issue execution into a repeatable daemon workflow instead of manual scripts.
- It isolates agent execution in per-issue workspaces so agent commands run only inside per-issue
  workspace directories.
- It keeps the workflow policy in-repo (`WORKFLOW.md`) so teams version the agent prompt and runtime
  settings with their code.
- It provides enough observability to operate and debug multiple concurrent agent runs.

Implementations are expected to document their trust and safety posture explicitly. This
specification does not require a single approval, sandbox, or operator-confirmation policy; some
implementations may target trusted environments with a high-trust configuration, while others may
require stricter approvals or sandboxing.

Important boundary:

- Symphony is a scheduler/runner and tracker reader with optional adapter-neutral lifecycle
  write-back for claim and handoff transitions.
- Workflow-specific ticket writes such as comments, PR links, and provider-specific metadata are
  typically performed by the coding agent using tools available in the workflow/runtime
  environment.
- A successful run may end at a workflow-defined handoff state (for example `Human Review`), not
  necessarily `Done`.

## 2. Goals and Non-Goals

### 2.1 Goals

- Poll the issue tracker on a fixed cadence and dispatch work with bounded concurrency.
- Maintain a single authoritative orchestrator state for dispatch, retries, and reconciliation.
- Create deterministic per-issue workspaces and preserve them across runs.
- Stop active runs when issue state changes make them ineligible.
- Recover from transient failures with exponential backoff.
- Load runtime behavior from a repository-owned `WORKFLOW.md` contract.
- Expose operator-visible observability (at minimum structured logs).
- Support restart recovery without requiring a persistent database.

### 2.2 Non-Goals

- Rich web UI or multi-tenant control plane.
- Prescribing a specific dashboard or terminal UI implementation.
- General-purpose workflow engine or distributed job scheduler.
- Built-in platform-specific business logic for how to edit tickets, PRs, or comments. Generic
  lifecycle claim/handoff write-back may be implemented through the tracker adapter contract.
- Mandating strong sandbox controls beyond what the coding agent and host OS provide.
- Mandating a single default approval, sandbox, or operator-confirmation posture for all
  implementations.

## 3. System Overview

### 3.1 Main Components

1. `Workflow Loader`
   - Reads `WORKFLOW.md`.
   - Parses YAML front matter and prompt body.
   - Returns `{config, prompt_template}`.

2. `Config Layer`
   - Exposes typed getters for workflow config values.
   - Applies defaults and environment variable indirection.
   - Performs validation used by the orchestrator before dispatch.

3. `Issue Tracker Client`
   - Fetches candidate issues in active states.
   - Fetches current states for specific issue IDs (reconciliation).
   - Fetches terminal-state issues during startup cleanup.
   - Normalizes tracker payloads into a stable issue model.

4. `Orchestrator`
   - Owns the poll tick.
   - Owns the in-memory runtime state.
   - Decides which issues to dispatch, retry, stop, or release.
   - Tracks session metrics and retry queue state.

5. `Workspace Manager`
   - Maps issue identifiers to workspace paths.
   - Ensures per-issue workspace directories exist.
   - Runs workspace lifecycle hooks.
   - Cleans workspaces for terminal issues.

6. `Agent Runner`
   - Creates workspace.
   - Builds prompt from issue + workflow template.
   - Launches the coding agent app-server client.
   - Streams agent updates back to the orchestrator.

7. `Status Surface` (optional)
   - Presents human-readable runtime status (for example terminal output, dashboard, or other
     operator-facing view).

8. `Logging`
   - Emits structured runtime logs to one or more configured sinks.

### 3.2 Abstraction Levels

Symphony is easiest to port when kept in these layers:

1. `Policy Layer` (repo-defined)
   - `WORKFLOW.md` prompt body.
   - Team-specific rules for ticket handling, validation, and handoff.

2. `Configuration Layer` (typed getters)
   - Parses front matter into typed runtime settings.
   - Handles defaults, environment tokens, and path normalization.

3. `Coordination Layer` (orchestrator)
   - Polling loop, issue eligibility, concurrency, retries, reconciliation.

4. `Execution Layer` (workspace + agent subprocess)
   - Filesystem lifecycle, workspace preparation, coding-agent protocol.

5. `Integration Layer` (Linear adapter)
   - API calls and normalization for tracker data.

6. `Observability Layer` (logs + optional status surface)
   - Operator visibility into orchestrator and agent behavior.

### 3.3 External Dependencies

- Issue tracker API (Linear for `tracker.kind: linear` in this specification version).
- Local filesystem for workspaces and logs.
- Optional workspace population tooling (for example Git CLI, if used).
- Coding-agent executable that supports JSON-RPC-like app-server mode over stdio.
- Host environment authentication for the issue tracker and coding agent.

## 4. Core Domain Model

### 4.1 Entities

#### 4.1.1 Issue

Normalized issue record used by orchestration, prompt rendering, and observability output.

Fields:

- `id` (string)
  - Stable tracker-internal ID.
- `identifier` (string)
  - Human-readable ticket key (example: `ABC-123`).
- `title` (string)
- `description` (string or null)
- `priority` (integer or null)
  - Lower numbers are higher priority in dispatch sorting.
- `state` (string)
  - Current tracker state name.
- `branch_name` (string or null)
  - Tracker-provided branch metadata if available.
- `url` (string or null)
- `labels` (list of strings)
  - Normalized to lowercase.
- `blocked_by` (list of blocker refs)
  - Each blocker ref contains:
    - `id` (string or null)
    - `identifier` (string or null)
    - `state` (string or null)
- `created_at` (timestamp or null)
- `updated_at` (timestamp or null)

#### 4.1.2 Workflow Definition

Parsed `WORKFLOW.md` payload:

- `config` (map)
  - YAML front matter root object.
- `prompt_template` (string)
  - Markdown body after front matter, trimmed.

#### 4.1.3 Service Config (Typed View)

Typed runtime values derived from `WorkflowDefinition.config` plus environment resolution.

Examples:

- poll interval
- workspace root
- active and terminal issue states
- concurrency limits
- coding-agent executable/args/timeouts
- workspace hooks

#### 4.1.4 Workspace

Filesystem workspace assigned to one stable issue key.

Fields (logical):

- `path` (workspace path; current runtime typically uses absolute paths, but relative roots are
  possible if configured without path separators)
- `workspace_key` (sanitized stable issue key; the TypeScript implementation uses `issue.id`)
- `created_now` (boolean, used to gate `after_create` hook)

#### 4.1.5 Run Attempt

One execution attempt for one issue.

Fields (logical):

- `issue_id`
- `issue_identifier`
- `attempt` (integer or null, `null` for first run, `>=1` for retries/continuation)
- `workspace_path`
- `started_at`
- `status`
- `error` (optional)

#### 4.1.6 Live Session (Agent Session Metadata)

State tracked while a coding-agent subprocess is running.

Fields:

- `session_id` (string, `<thread_id>-<turn_id>`)
- `thread_id` (string)
- `turn_id` (string)
- `codex_app_server_pid` (string or null)
- `last_codex_event` (string/enum or null)
- `last_codex_timestamp` (timestamp or null)
- `last_codex_message` (summarized payload)
- `codex_input_tokens` (integer)
- `codex_output_tokens` (integer)
- `codex_total_tokens` (integer)
- `last_reported_input_tokens` (integer)
- `last_reported_output_tokens` (integer)
- `last_reported_total_tokens` (integer)
- `turn_count` (integer)
  - Number of coding-agent turns started within the current worker lifetime.

#### 4.1.7 Retry Entry

Scheduled retry state for an issue.

Fields:

- `issue_id`
- `identifier` (best-effort human ID for status surfaces/logs)
- `attempt` (integer, 1-based for retry queue)
- `due_at_ms` (monotonic clock timestamp)
- `timer_handle` (runtime-specific timer reference)
- `error` (string or null)
- `capability_failure` (optional sanitized capability metadata; see Section 14.1)

#### 4.1.8 Operator Hold Entry

An issue paused for deterministic operator action. A held issue remains claimed but has no retry
timer.

Fields:

- `issue_id`
- `identifier` (best-effort human ID)
- `attempt` (next explicit retry attempt)
- `held_at_ms`
- `error` (sanitized compatibility string)
- `capability_failure` (optional sanitized capability metadata; see Section 14.1)

#### 4.1.9 Orchestrator Runtime State

Single authoritative in-memory state owned by the orchestrator.

Fields:

- `poll_interval_ms` (current effective poll interval)
- `max_concurrent_agents` (current effective global concurrency limit)
- `running` (map `issue_id -> running entry`)
- `claimed` (set of issue IDs reserved, running, retrying, or held)
- `retry_attempts` (map `issue_id -> RetryEntry`)
- `operator_holds` (map `issue_id -> OperatorHoldEntry`)
- `completed` (set of issue IDs; bookkeeping only, not dispatch gating)
- `codex_totals` (aggregate tokens + runtime seconds)
- `codex_rate_limits` (latest rate-limit snapshot from agent events)

### 4.2 Stable Identifiers and Normalization Rules

- `Issue ID`
  - Use for tracker lookups and internal map keys.
- `Issue Identifier`
  - Use only for human-readable logs and status surfaces unless an implementation explicitly
    selects it as its stable workspace input.
- `Workspace Key`
  - Derive from one implementation-selected stable issue input by replacing any character not in
    `[A-Za-z0-9._-]` with `_`. The TypeScript implementation always selects `issue.id`.
  - Use the sanitized value for the workspace directory name.
- `Normalized Issue State`
  - Compare states after `trim` + `lowercase`.
- `Session ID`
  - Compose from coding-agent `thread_id` and `turn_id` as `<thread_id>-<turn_id>`.

## 5. Workflow Specification (Repository Contract)

### 5.1 File Discovery and Path Resolution

Workflow file path precedence:

1. Explicit application/runtime setting (set by CLI startup path).
2. Default: `WORKFLOW.md` in the current process working directory.

Loader behavior:

- If the file cannot be read, return `missing_workflow_file` error.
- The workflow file is expected to be repository-owned and version-controlled.

### 5.2 File Format

`WORKFLOW.md` is a Markdown file with optional YAML front matter.

Design note:

- `WORKFLOW.md` should be self-contained enough to describe and run different workflows (prompt,
  runtime settings, hooks, and tracker selection/config) without requiring out-of-band
  service-specific configuration.

Parsing rules:

- If file starts with `---`, parse lines until the next `---` as YAML front matter.
- Remaining lines become the prompt body.
- If front matter is absent, treat the entire file as prompt body and use an empty config map.
- YAML front matter must decode to a map/object; non-map YAML is an error.
- Prompt body is trimmed before use.

Returned workflow object:

- `config`: front matter root object (not nested under a `config` key).
- `prompt_template`: trimmed Markdown body.

### 5.3 Front Matter Schema

Top-level keys:

- `tracker`
- `polling`
- `workspace`
- `hooks`
- `agent`
- `codex`
- `capabilities`

Unknown keys should be ignored for forward compatibility.

Note:

- The workflow front matter is extensible. Optional extensions may define additional top-level keys
  (for example `server`) without changing the core schema above.
- Extensions should document their field schema, defaults, validation rules, and whether changes
  apply dynamically or require restart.
- Common extension: `server.port` (integer) enables the optional HTTP server described in Section
  13.7.

#### 5.3.1 `tracker` (object)

Fields:

- `kind` (string)
  - Required for dispatch.
  - Current supported value: `linear`
- `endpoint` (string)
  - Default for `tracker.kind == "linear"`: `https://api.linear.app/graphql`
- `api_key` (string)
  - May be a literal token or `$VAR_NAME`.
  - Canonical environment variable for `tracker.kind == "linear"`: `LINEAR_API_KEY`.
  - If `$VAR_NAME` resolves to an empty string, treat the key as missing.
- `project_slug` (string)
  - Required for dispatch when `tracker.kind == "linear"`.
- `active_states` (list of strings or comma-separated string)
  - Default: `Todo`, `In Progress`
- `terminal_states` (list of strings or comma-separated string)
  - Default: `Closed`, `Cancelled`, `Canceled`, `Duplicate`, `Done`

#### 5.3.2 `polling` (object)

Fields:

- `interval_ms` (integer or string integer)
  - Default: `30000`
  - Changes should be re-applied at runtime and affect future tick scheduling without restart.

#### 5.3.3 `workspace` (object)

Fields:

- `root` (path string or `$VAR`)
  - Default: `<system-temp>/symphony_workspaces`
  - `~` and strings containing path separators are expanded.
  - Bare strings without path separators are preserved as-is (relative roots are allowed but
    discouraged).

#### 5.3.4 `hooks` (object)

Fields:

- `after_create` (multiline shell script string, optional)
  - Runs only when a workspace directory is newly created.
  - Failure aborts workspace creation.
- `before_run` (multiline shell script string, optional)
  - Runs before each agent attempt after workspace preparation and before launching the coding
    agent.
  - Failure aborts the current attempt.
- `after_run` (multiline shell script string, optional)
  - Runs after each agent attempt (success, failure, timeout, or cancellation) once the workspace
    exists.
  - Failure is logged but ignored.
- `before_remove` (multiline shell script string, optional)
  - Runs before workspace deletion if the directory exists.
  - Failure is logged but ignored; cleanup still proceeds.
- `timeout_ms` (integer, optional)
  - Default: `60000`
  - Applies to all workspace hooks.
  - Non-positive values should be treated as invalid and fall back to the default.
  - Changes should be re-applied at runtime for future hook executions.

#### 5.3.5 `agent` (object)

Fields:

- `max_concurrent_agents` (integer or string integer)
  - Default: `10`
  - Changes should be re-applied at runtime and affect subsequent dispatch decisions.
- `max_retry_backoff_ms` (integer or string integer)
  - Default: `300000` (5 minutes)
  - Changes should be re-applied at runtime and affect future retry scheduling.
- `max_concurrent_agents_by_state` (map `state_name -> positive integer`)
  - Default: empty map.
  - State keys are normalized (`trim` + `lowercase`) for lookup.
  - Invalid entries (non-positive or non-numeric) are ignored.

#### 5.3.6 `codex` (object)

Fields:

For Codex-owned config values such as `approval_policy`, `thread_sandbox`, and
`turn_sandbox_policy`, supported values are defined by the targeted Codex app-server version.
Implementors should treat them as pass-through Codex config values rather than relying on a
hand-maintained enum in this spec. To inspect the installed Codex schema, run
`codex app-server generate-json-schema --out <dir>` and inspect the relevant definitions referenced
by `v2/ThreadStartParams.json` and `v2/TurnStartParams.json`. Implementations may validate these
fields locally if they want stricter startup checks.

- `command` (string shell command)
  - Default: `codex app-server`
  - The runtime launches this command via `bash -lc` in the workspace directory.
  - The launched process must speak a compatible app-server protocol over stdio.
- `approval_policy` (Codex `AskForApproval` value)
  - Default: implementation-defined.
- `thread_sandbox` (Codex `SandboxMode` value)
  - Default: implementation-defined.
- `turn_sandbox_policy` (Codex `SandboxPolicy` value)
  - Default: implementation-defined.
- `turn_timeout_ms` (integer)
  - Default: `3600000` (1 hour)
- `read_timeout_ms` (integer)
  - Default: `5000`
  - On Windows, `initialize`, `thread/start`, and `turn/start` use at least `30000` to absorb
    sandbox and MCP startup overhead. Other synchronous requests and non-Windows platforms use the
    configured value unless their contract defines a longer outer envelope.
- `stall_timeout_ms` (integer)
  - Default: `300000` (5 minutes)
  - If `<= 0`, stall detection is disabled.

#### 5.3.7 `capabilities` (object, optional extension)

External capabilities are opt-in. Omitting this object preserves the existing dispatch and agent
startup behavior.

- `commands` (map `executable_basename -> command requirement`)
  - Default: `{}`.
  - Each key is the executable basename that the workflow requires. Keys must match
    `[A-Za-z0-9][A-Za-z0-9._-]*` and must not be `.` or `..`; whitespace, path separators, absolute
    or relative paths, control characters, and shell metacharacters are invalid.
  - Each value is an object with these fields:
    - `hooks` (list of `after_create`, `before_run`, `after_run`, or `before_remove`)
      - Default: `[]`.
      - A declared command is checked independently in every listed hook boundary.
    - `agent` (boolean)
      - Default: `false`.
      - When `true`, the command is checked in the Codex command boundary before tracker claim and
        before `thread/start` or `turn/start`.
    - `probe_args` (list of strings)
      - Default: `[]`.
      - Used only by the agent-boundary probe. Arguments are passed as a direct argv vector and are
        never interpolated into a shell command or included in diagnostics.
  - The declaration schema is closed: unknown fields and duplicate hook names are invalid. Hook and
    probe argument order is preserved. Probe arguments containing ASCII control characters,
    including NUL, are invalid because they cannot be passed portably as direct process arguments.
  - A declaration must enable at least one hook or the agent boundary. Non-map declarations,
    unknown hook names, non-boolean `agent`, non-list, non-string, or control-character probe
    arguments, unsafe command keys, and declarations with no enabled boundary fail dispatch as
    `config_invalid`.
  - Omitting `capabilities` or `capabilities.commands` selects the empty default. Explicit `null`,
    scalar, or list values for either object are malformed and fail as `config_invalid`.
  - The same `config_invalid` result fails startup validation, skips per-tick dispatch, and rejects
    a dynamic reload while the runtime keeps using the last known good effective configuration.
  - Omission is a true no-op: an empty command map adds no hook script, subprocess, app-server
    initialization, command probe, tracker-claim deferral, retry dependency, or log entry.
  - A command declaration naming a hook creates that hook boundary even when the corresponding
    workflow hook script is omitted: Symphony runs one preflight-only `sh -lc` invocation with an
    empty body. This is an effect of the explicit declaration, not of the empty default.
  - Hook requirements are checked inside the same hook-shell invocation and explicit environment
    as the hook body, immediately before that body. The TypeScript implementation's hook shell is
    `sh -lc`; ports using another host-appropriate shell must still compose one invocation.
  - Hook preflight is resolution and execute-permission validation only; it never invokes the
    required command. For each declaration, the generated prefix first uses the shell's real
    command lookup. A resolved filesystem path without execute permission is
    `required_command_execution_denied`. If lookup fails, the prefix scans the effective PATH
    internally for a matching non-executable basename (and `<basename>.exe` on Windows) to
    distinguish denied from absent; PATH and candidate paths are never emitted. No match is
    `required_command_not_found`.
  - Each hook invocation uses at least 128 bits from a cryptographically secure random source for
    its hexadecimal nonce. A failed hook check emits exactly one line in the form
    `__SYMPHONY_REQUIRED_COMMAND_V1__:<nonce>:<code>:<basename>` and exits before the workflow body
    with `126` for denied or `127` for absent. The nonce is a fresh Symphony-generated hexadecimal
    value used only for that invocation. The runner recognizes only an exact marker containing the
    current nonce, one of the current hook's declared basenames, and the matching fixed exit code.
  - After all checks pass, the prefix emits one owned
    `__SYMPHONY_REQUIRED_COMMAND_V1__:<nonce>:ok` marker and then begins the workflow body. The
    runner strips owned markers from captured output. Once the current invocation's success marker
    exists, no later workflow output can be interpreted as a capability failure, even if the body
    exits `126`/`127` or prints marker-like text.
  - Before the owned success marker, a valid failure marker with its matching exit status is a
    deterministic command failure. A launched hook shell that times out, exits, or produces an
    otherwise unclassified result before either valid marker is
    `required_command_capability_transient`. After the owned success marker, failures and timeouts
    are ordinary hook-body `hook_failed` or `hook_timed_out` outcomes. Failure to launch the hook
    shell means the command boundary was never entered and remains a non-timeout `hook_failed`.
  - Generated shell code is fixed by Symphony, never uses `eval`, disables pathname expansion while
    scanning PATH, treats each PATH entry and command name only as data, quotes every parameter
    expansion used as a path, and restores shell state before the workflow body. Arbitrary workflow
    stdout/stderr is never parsed for capability meaning.
  - Agent requirements are checked through the same Codex app-server instance that will own the
    worker session. Each `command/exec` receives the ticket workspace cwd, inherited app-server
    environment, and prepared `turn_sandbox_policy`. A successful check in a hook shell is not
    proof for the agent boundary, and a successful agent check is not proof for a hook boundary.
  - Agent probes pass `[declared_basename, ...probe_args]` directly to `command/exec`, with one
    exception: on Windows, an extensionless safe basename such as `rg` is passed as `rg.exe`.
    Symphony performs no parent-side PATH lookup or path resolution. An explicitly declared
    extension is preserved, and `.cmd`/`.bat` wrappers are not inferred.
  - Agent probe success requires exit code `0`. Empty `probe_args` means the executable is invoked
    with no arguments and must therefore exit successfully; authors should declare a
    side-effect-free argument such as `--version` when no-argument behavior is not a successful
    probe.
  - Agent exit `127` or an app-server/OS not-found signal maps to
    `required_command_not_found`. Exit `126`, `EACCES`/`EPERM`, or an app-server/OS
    execution-denied signal maps to `required_command_execution_denied`. Other non-zero exits,
    malformed responses, timeout, protocol failure, and unrecognized errors map to
    `required_command_capability_transient`. Implementations may inspect bounded probe output to
    recognize platform not-found/denied signals, but may never propagate that output.
  - Generic command probes use a `60000` ms command timeout on Windows and `15000` ms elsewhere.
    The client-side response timer adds `codex.read_timeout_ms` to that command budget. Probe output
    is bounded to 64 KiB per stream where custom command caps are supported; Windows uses the
    app-server's built-in bounded capture.
  - A fatal `after_create` or `before_run` command failure and any agent-boundary command failure
    follows the deterministic-hold/transient-retry rules above. `after_run` and `before_remove`
    preserve their existing best-effort semantics: their typed capability failure is logged with
    sanitized metadata, but does not change the completed attempt, create a hold, or prevent
    cleanup.
  - Capability failures use the stable metadata object
    `{code, capability, command, boundary, remediation}`. Generic command failures set capability
    to `external_command`; boundary is one of `hook:after_create`, `hook:before_run`,
    `hook:after_run`, `hook:before_remove`, or `agent`. Structured logs flatten these fields;
    retry/hold state, snapshots, and operator-facing JSON retain them as `capability_failure` while
    preserving the existing `error` string for compatibility.
  - Only that sanitized metadata may cross the capability boundary. Raw PATH values, resolved
    paths, probe output, hook stdout/stderr, argv probe values, credentials, and authorization
    material must never enter the error message, structured state, logs, snapshots, or status
    surfaces.
  - Symphony validates declared requirements but does not install a command, synthesize PATH, or
    discover and inject a provider's private bundled executable. In particular, a Codex-bundled
    `rg` path is not a Symphony runtime contract and must not be borrowed automatically.
- `github.required` (boolean or boolean string)
  - Default: `false`.
  - When `true`, each worker must verify GitHub CLI authentication and push access to the repository
    checked out in its ticket workspace after `hooks.before_run` succeeds and before the first Codex
    session starts.
  - Symphony initializes the same Codex app-server process that will own the worker session, then
    invokes non-mutating `gh` argv vectors through the experimental `command/exec` method before
    sending `thread/start` or `turn/start`.
  - `command/exec` receives the ticket workspace cwd and the same prepared `turn_sandbox_policy`
    that the later turn receives. It inherits the app-server process environment without a
    per-command override, so executable lookup, credentials, and network restrictions are checked
    at the effective Codex command boundary. A successful hook in another shell is not proof of
    this capability.
  - Probe output is bounded to 64 KiB per stream where custom command caps are supported. Windows
    sandbox execution uses the app-server's built-in bounded capture because current Codex versions
    reject a custom `outputBytesCap` there.
  - Each GitHub probe command uses a `60000` ms command timeout on Windows and `15000` ms elsewhere.
    The client-side `command/exec` response timer adds `read_timeout_ms` to that command budget so
    the outer JSON-RPC wait cannot expire before the bounded command itself.
- `github.credential_source` (string)
  - Default: `environment`.
  - `environment` starts the app-server with a snapshot of Symphony's launch environment and does
    not copy credentials out of a host credential store.
  - `gh_auth_token` preserves any non-empty `GH_TOKEN` or `GITHUB_TOKEN` already present. When both
    are absent, Symphony runs `gh auth token --hostname github.com` as a direct, bounded argv call in
    the Symphony launch environment, keeps the returned token only in memory, and adds it as
    `GH_TOKEN` to the cloned app-server environment.
  - An explicit environment token always wins, including when it is invalid; Symphony must not
    silently replace it with keyring state. The bridge never writes the token to a workflow, temp
    file, log, error, dashboard, or command line. Because the Codex process and its agent commands
    receive the bridged credential, this mode is intended only for trusted workflows.
  - Credential loading is not capability proof. The normal `command/exec` checks must still pass in
    the prepared Codex sandbox before any session starts.

### 5.4 Prompt Template Contract

The Markdown body of `WORKFLOW.md` is the per-issue prompt template.

Rendering requirements:

- Use a strict template engine (Liquid-compatible semantics are sufficient).
- Unknown variables must fail rendering.
- Unknown filters must fail rendering.

Template input variables:

- `issue` (object)
  - Includes all normalized issue fields, including labels and blockers.
- `attempt` (integer or null)
  - `null`/absent on first attempt.
  - Integer on retry or continuation run.

Fallback prompt behavior:

- If the workflow prompt body is empty, the runtime may use a minimal default prompt
  (`You are working on an issue from Linear.`).
- Workflow file read/parse failures are configuration/validation errors and should not silently fall
  back to a prompt.

### 5.5 Workflow Validation and Error Surface

Error classes:

- `missing_workflow_file`
- `workflow_parse_error`
- `workflow_front_matter_not_a_map`
- `template_parse_error` (during prompt rendering)
- `template_render_error` (unknown variable/filter, invalid interpolation)

Dispatch gating behavior:

- Workflow file read/YAML errors block new dispatches until fixed.
- Template errors fail only the affected run attempt.

## 6. Configuration Specification

### 6.1 Source Precedence and Resolution Semantics

Configuration precedence:

1. Workflow file path selection (runtime setting -> cwd default).
2. YAML front matter values.
3. Environment indirection via `$VAR_NAME` inside selected YAML values.
4. Built-in defaults.

Value coercion semantics:

- Path/command fields support:
  - `~` home expansion
  - `$VAR` expansion for env-backed path values
  - Apply expansion only to values intended to be local filesystem paths; do not rewrite URIs or
    arbitrary shell command strings.

### 6.2 Dynamic Reload Semantics

Dynamic reload is required:

- The software should watch `WORKFLOW.md` for changes.
- On change, it should re-read and re-apply workflow config and prompt template without restart.
- The software should attempt to adjust live behavior to the new config (for example polling
  cadence, concurrency limits, active/terminal states, codex settings, workspace paths/hooks, and
  prompt content for future runs).
- Reloaded config applies to future dispatch, retry scheduling, reconciliation decisions, hook
  execution, and agent launches.
- Implementations are not required to restart in-flight agent sessions automatically when config
  changes.
- Extensions that manage their own listeners/resources (for example an HTTP server port change) may
  require restart unless the implementation explicitly supports live rebind.
- Implementations should also re-validate/reload defensively during runtime operations (for example
  before dispatch) in case filesystem watch events are missed.
- Invalid reloads should not crash the service; keep operating with the last known good effective
  configuration and emit an operator-visible error.

### 6.3 Dispatch Preflight Validation

This validation is a scheduler preflight run before attempting to dispatch new work. It validates
the workflow/config needed to poll and launch workers, not a full audit of all possible workflow
behavior.

Startup validation:

- Validate configuration before starting the scheduling loop.
- If startup validation fails, fail startup and emit an operator-visible error.

Per-tick dispatch validation:

- Re-validate before each dispatch cycle.
- If validation fails, skip dispatch for that tick, keep reconciliation active, and emit an
  operator-visible error.

Validation checks:

- Workflow file can be loaded and parsed.
- `tracker.kind` is present and supported.
- `tracker.api_key` is present after `$` resolution.
- `tracker.project_slug` is present when required by the selected tracker kind.
- `codex.command` is present and non-empty.
- Every `capabilities.commands` key and declaration is structurally valid, enables at least one
  execution boundary, and contains only supported hook names and string argv probe values.

### 6.4 Config Fields Summary (Cheat Sheet)

This section is intentionally redundant so a coding agent can implement the config layer quickly.

- `tracker.kind`: string, required, currently `linear`
- `tracker.endpoint`: string, default `https://api.linear.app/graphql` when `tracker.kind=linear`
- `tracker.api_key`: string or `$VAR`, canonical env `LINEAR_API_KEY` when `tracker.kind=linear`
- `tracker.project_slug`: string, required when `tracker.kind=linear`
- `tracker.active_states`: list/string, default `Todo, In Progress`
- `tracker.terminal_states`: list/string, default `Closed, Cancelled, Canceled, Duplicate, Done`
- `polling.interval_ms`: integer, default `30000`
- `workspace.root`: path, default `<system-temp>/symphony_workspaces`
- `hooks.after_create`: shell script or null
- `hooks.before_run`: shell script or null
- `hooks.after_run`: shell script or null
- `hooks.before_remove`: shell script or null
- `hooks.timeout_ms`: integer, default `60000`
- `agent.max_concurrent_agents`: integer, default `10`
- `agent.max_turns`: integer, default `20`
- `agent.max_retry_backoff_ms`: integer, default `300000` (5m)
- `agent.max_concurrent_agents_by_state`: map of positive integers, default `{}`
- `codex.command`: shell command string, default `codex app-server`
- `codex.approval_policy`: Codex `AskForApproval` value, default implementation-defined
- `codex.thread_sandbox`: Codex `SandboxMode` value, default implementation-defined
- `codex.turn_sandbox_policy`: Codex `SandboxPolicy` value, default implementation-defined
- `codex.turn_timeout_ms`: integer, default `3600000`
- `codex.read_timeout_ms`: integer, default `5000`
- `codex.stall_timeout_ms`: integer, default `300000`
- `capabilities.commands`: map of safe executable basenames to boundary requirements, default `{}`
- `capabilities.commands.<command>.hooks`: list of hook names, default `[]`
- `capabilities.commands.<command>.agent`: boolean, default `false`
- `capabilities.commands.<command>.probe_args`: direct argv string list, default `[]`
- `capabilities.github.required`: boolean, default `false`
- `capabilities.github.credential_source`: `environment` or `gh_auth_token`, default `environment`
- `server.port` (extension): integer, optional; enables the optional HTTP server, `0` may be used
  for ephemeral local bind, and CLI `--port` overrides it

## 7. Orchestration State Machine

The orchestrator is the only component that mutates scheduling state. All worker outcomes are
reported back to it and converted into explicit state transitions.

### 7.1 Issue Orchestration States

This is not the same as tracker states (`Todo`, `In Progress`, etc.). This is the service's internal
claim state.

1. `Unclaimed`
   - Issue is not running and has no retry scheduled.

2. `Claimed`
   - Orchestrator has reserved the issue to prevent duplicate dispatch.
   - In practice, claimed issues are `Running`, `RetryQueued`, or `Held`.

3. `Running`
   - Worker task exists and the issue is tracked in `running` map.

4. `RetryQueued`
   - Worker is not running, but a retry timer exists in `retry_attempts`.

5. `Held`
   - Worker is not running and a deterministic capability or lifecycle failure requires operator
     action.
   - Issue remains in `claimed` and `operator_holds`, with no retry timer.
   - Ordinary polling must not redispatch it.

6. `Released`
   - Claim removed because issue is terminal, non-active, missing, or retry path completed without
     re-dispatch.

Important nuance:

- A successful worker exit does not mean the issue is done forever.
- The worker may continue through multiple back-to-back coding-agent turns before it exits.
- After each normal turn completion, the worker re-checks the tracker issue state.
- If the issue is still in an active state, the worker should start another turn on the same live
  coding-agent thread in the same workspace, up to `agent.max_turns`.
- The first turn should use the full rendered task prompt.
- Continuation turns should send only continuation guidance to the existing thread, not resend the
  original task prompt that is already present in thread history.
- Once the worker exits normally, the orchestrator still schedules a short continuation retry
  (about 1 second) so it can re-check whether the issue remains active and needs another worker
  session.

### 7.2 Run Attempt Lifecycle

A run attempt transitions through these phases:

1. `PreparingWorkspace`
2. `BuildingPrompt`
3. `LaunchingAgentProcess`
4. `InitializingSession`
5. `StreamingTurn`
6. `Finishing`
7. `Succeeded`
8. `Failed`
9. `TimedOut`
10. `Stalled`
11. `CanceledByReconciliation`

Distinct terminal reasons are important because retry logic and logs differ.

### 7.3 Transition Triggers

- `Poll Tick`
  - Reconcile active runs.
  - Validate config.
  - Fetch candidate issues.
  - Dispatch until slots are exhausted.

- `Worker Exit (normal)`
  - Remove running entry.
  - Update aggregate runtime totals.
  - Schedule continuation retry (attempt `1`) after the worker exhausts or finishes its in-process
    turn loop.

- `Worker Exit (abnormal)`
  - Remove running entry.
  - Update aggregate runtime totals.
  - Schedule exponential-backoff retry.

- `Codex Update Event`
  - Update live session fields, token counters, and rate limits.

- `Retry Timer Fired`
  - Re-fetch active candidates and attempt re-dispatch, or release claim if no longer eligible.

- `Explicit Operator Retry`
  - Select one held issue, re-fetch that issue, remove only its hold immediately before dispatch,
    and rerun every applicable boundary check.
  - If the issue is no longer eligible, release its claim. If the same deterministic failure
    recurs, create a fresh hold without affecting any other held issue.

- `Reconciliation State Refresh`
  - Stop runs whose issue states are terminal or no longer active.

- `Stall Timeout`
  - Kill worker and schedule retry.

### 7.4 Idempotency and Recovery Rules

- The orchestrator serializes state mutations through one authority to avoid duplicate dispatch.
- `claimed` and `running` checks are required before launching any worker.
- The orchestrator's local `claimed` reservation is distinct from tracker lifecycle claim
  write-back. Dispatch starts a worker handle and atomically records it in `running` and `claimed`
  before yielding to another poll/retry/control operation. Workspace preparation and pre-dispatch
  capability checks run inside that locally reserved worker slot, so concurrent ticks cannot start
  duplicate preflights or exceed concurrency limits.
- Tracker claim write-back may be deferred until the reserved worker passes its pre-dispatch checks.
  A deterministic or transient preflight failure returns through the registered worker-exit path,
  which atomically replaces the local running reservation with a hold or retry. Cancellation and
  ineligibility release the same reservation through normal reconciliation.
- Held issues remain claimed and are excluded from polling dispatch until a selected explicit retry
  or eligibility release.
- Reconciliation runs before dispatch on every tick.
- Restart recovery is tracker-driven and filesystem-driven (no durable orchestrator DB required).
- Startup terminal cleanup removes stale workspaces for issues already in terminal states.

## 8. Polling, Scheduling, and Reconciliation

### 8.1 Poll Loop

At startup, the service validates config, performs startup cleanup, schedules an immediate tick, and
then repeats every `polling.interval_ms`.

The effective poll interval should be updated when workflow config changes are re-applied.

Tick sequence:

1. Reconcile running issues.
2. Run dispatch preflight validation.
3. Fetch candidate issues from tracker using active states.
4. Sort issues by dispatch priority.
5. Dispatch eligible issues while slots remain.
6. Notify observability/status consumers of state changes.

If per-tick validation fails, dispatch is skipped for that tick, but reconciliation still happens
first.

### 8.2 Candidate Selection Rules

An issue is dispatch-eligible only if all are true:

- It has `id`, `identifier`, `title`, and `state`.
- Its state is in `active_states` and not in `terminal_states`.
- It is not already in `running`.
- It is not already in `claimed`.
- Global concurrency slots are available.
- Per-state concurrency slots are available.
- Blocker rule for `Todo` state passes:
  - If the issue state is `Todo`, do not dispatch when any blocker is non-terminal.

Sorting order (stable intent):

1. `priority` ascending (1..4 are preferred; null/unknown sorts last)
2. `created_at` oldest first
3. `identifier` lexicographic tie-breaker

### 8.3 Concurrency Control

Global limit:

- `available_slots = max(max_concurrent_agents - running_count, 0)`

Per-state limit:

- `max_concurrent_agents_by_state[state]` if present (state key normalized)
- otherwise fallback to global limit

The runtime counts issues by their current tracked state in the `running` map.

### 8.4 Retry and Backoff

Retry entry creation:

- Cancel any existing retry timer for the same issue.
- Store `attempt`, `identifier`, `error`, `due_at_ms`, and new timer handle.

Backoff formula:

- Normal continuation retries after a clean worker exit use a short fixed delay of `1000` ms.
- Failure-driven retries use `delay = min(10000 * 2^(attempt - 1), agent.max_retry_backoff_ms)`.
- Power is capped by the configured max retry backoff (default `300000` / 5m).

Retry handling behavior:

1. Fetch active candidate issues (not all issues).
2. Find the specific issue by `issue_id`.
3. If not found, release claim.
4. If found and still candidate-eligible:
   - Dispatch if slots are available.
   - Otherwise requeue with error `no available orchestrator slots`.
5. If found but no longer active, release claim.

Note:

- Terminal-state workspace cleanup is handled by startup cleanup and active-run reconciliation
  (including terminal transitions for currently running issues).
- Retry handling mainly operates on active candidates and releases claims when the issue is absent,
  rather than performing terminal cleanup itself.

### 8.5 Active Run Reconciliation

Reconciliation runs every tick and has two parts.

Part A: Stall detection

- For each running issue, compute `elapsed_ms` since:
  - `last_codex_timestamp` if any event has been seen, else
  - `started_at`
- If `elapsed_ms > codex.stall_timeout_ms`, terminate the worker and queue a retry.
- If `stall_timeout_ms <= 0`, skip stall detection entirely.

Part B: Tracker state refresh

- Fetch current issue states for all running and held issue IDs.
- For each running issue:
  - If tracker state is terminal: terminate worker and clean workspace.
  - If tracker state is still active: update the in-memory issue snapshot.
  - If tracker state is neither active nor terminal: terminate worker without workspace cleanup.
- If state refresh fails, keep workers running and try again on the next tick.
- For each held issue:
  - Terminal state -> release the hold and local claim, and clean the workspace.
  - Active state -> retain the hold without re-probing.
  - Non-active state or missing issue -> release the hold and local claim without cleanup.
- Held-state reconciliation never performs tracker claim write-back or capability probing.

### 8.6 Startup Terminal Workspace Cleanup

When the service starts:

1. Query tracker for issues in terminal states.
2. For each returned issue, remove the workspace directory using the implementation's stable
   workspace key. The TypeScript implementation passes `issue.id`.
3. If the terminal-issues fetch fails, log a warning and continue startup.

This prevents stale terminal workspaces from accumulating after restarts.

## 9. Workspace Management and Safety

### 9.1 Workspace Layout

Workspace root:

- `workspace.root` (normalized path; the current config layer expands path-like values and preserves
  bare relative names)

Per-issue workspace path:

- `<workspace.root>/<sanitized_stable_workspace_key>`

Workspace persistence:

- Workspaces are reused across runs for the same issue.
- Successful runs do not auto-delete workspaces.

### 9.2 Workspace Creation and Reuse

Input: an implementation-selected stable issue key. The TypeScript implementation uses `issue.id`
for every workspace-manager operation.

The implementation must persist or deterministically reuse that exact same input for all later
cleanup. A refreshed human identifier must never redirect cleanup to a different path.

Algorithm summary:

1. Sanitize the implementation-selected stable input to `workspace_key`.
2. Compute workspace path under workspace root.
3. Serialize create, recovery, state transition, and explicit removal through a process-wide
   lifecycle coordinator keyed by normalized workspace root plus workspace key. If the workspace is
   missing, persist an `in_progress` reservation with a unique generation before creating the
   directory, then bind that state to the directory's no-follow filesystem identity before running
   `after_create`.
4. Mark `created_now=true` only if the directory was created during this call; otherwise
   `created_now=false`.
5. If `created_now=true`, run `after_create` if configured, then atomically promote the same
   generation to `ready` only after the hook succeeds. A workspace with no configured
   `after_create` hook is promoted immediately.
6. If a declared `after_create` command preflight, hook, or `ready` promotion fails and this call
   created the directory, re-resolve and revalidate the exact workspace path, verify the matching
   generation and directory identity, atomically rename that path into the generation-specific
   manager recovery quarantine, verify the moved identity again, then recursively remove it even if
   the failed hook populated it. Cleanup remains best-effort and must never mask the original typed
   capability or hook error.
7. After acquiring the lifecycle coordinator, if an existing workspace has valid `in_progress`
   state with a matching non-null identity, emit `workspace_provisioning_incomplete` with
   `outcome=recovering`, revalidate its path and directory identity, move it through the same
   identity-checked recovery quarantine, recreate it, and emit `outcome=recovered` only after the
   new generation reaches `ready`. An `in_progress` reservation with `directoryIdentity=null`
   follows the separate empty-versus-populated lifecycle-table outcomes below.
8. A missing provisioning marker always denotes a legacy workspace and must be reused without
   destructive recovery or rerunning `after_create`, regardless of its contents. A valid `ready`
   marker whose identity still matches is also reused. This preserves workspaces created by
   versions that predate explicit provisioning state; workspace contents or VCS metadata must not
   be used as a health heuristic.
9. Malformed, unknown-version, unreadable, path/key-mismatched, or identity-mismatched state is never
   a deletion authority. Preserve the workspace, emit `workspace_provisioning_incomplete` with
   `outcome=failed`, and fail with the same error code and fixed operator remediation before agent
   capability checks. The orchestrator treats this code as an operator hold rather than an automatic
   retry.

Notes:

- This section does not assume any specific repository/VCS workflow.
- Workspace preparation beyond directory creation (for example dependency bootstrap, checkout/sync,
  code generation) is implementation-defined and is typically handled via hooks.

#### TypeScript provisioning-state contract

The TypeScript implementation stores state at
`<workspace_root>/.symphony+/provisioning/<workspace_key>.json`. The `+` cannot occur in a sanitized
workspace key, so the manager control directory cannot collide with a per-issue workspace. State is
outside the per-issue workspace so `after_create` starts with an empty working directory.

State records use a strict discriminated version-1 JSON schema. Reservations use:

```json
{
  "version": 1,
  "state": "in_progress",
  "workspaceKey": "stable-sanitized-key",
  "workspacePath": "/normalized/absolute/workspace/path",
  "generation": "cryptographically-random-id",
  "directoryIdentity": null
}
```

After directory creation, `directoryIdentity` is:

```json
{
  "dev": "decimal-bigint",
  "ino": "decimal-bigint",
  "birthtimeNs": "decimal-bigint"
}
```

`ready` requires that identity object; `in_progress` permits the object or `null` only for the short
reservation before directory creation. All shown fields are required, no additional fields are
accepted, strings must be non-empty, and `version`, `state`, and every field type must match exactly.
`generation` must match the lower-case UUID v4 grammar
`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` before it is used in any
control path; separators, traversal segments, and all other values are malformed state. Identity
values are exact decimal strings from Node `lstat(..., { bigint: true })`.

State creation and transition use a temporary file plus same-directory atomic rename. A module-wide
coordinator serializes all manager instances in the process, including instances replaced during
workflow reload, and covers `createForIssue`, recovery, cleanup, state changes, and `removeForIssue`.
After acquiring that coordinator, an `in_progress` record belongs to an abandoned earlier
invocation and may be recovered only if its bindings still match. Running multiple Symphony
processes against the same workspace root is outside this implementation profile.

The lifecycle is:

| Observed workspace/state | Required behavior |
| --- | --- |
| Missing workspace; no state | Provision a new generation |
| Missing workspace; valid stale `in_progress` or `ready` state | Remove any matching recovery-quarantine residue, replace that control record, and provision a new generation |
| Existing workspace; no state | Reuse as legacy; never run `after_create` or delete it |
| Existing workspace; matching `ready` state | Reuse without rerunning `after_create` |
| Existing workspace; matching `in_progress` state | Recursively remove that exact identity, then provision a new generation |
| Existing empty workspace; `in_progress` reservation with no identity | Remove with a non-recursive empty-directory operation, then provision |
| Existing populated workspace; reservation with no identity | Preserve and fail as `workspace_provisioning_incomplete` |
| Invalid, unreadable, symlinked, or identity-mismatched state | Preserve all workspace data and fail as `workspace_provisioning_incomplete` |

Only a matching state generation plus matching no-follow identity authorizes recursive recovery.
The implementation atomically renames the workspace to
`.symphony+/recovery/<workspace_key>-<generation>`, then verifies the moved identity before recursive
deletion. Before the move, the destination must be absent; an existing target while the workspace
also exists is preserved alongside the workspace and fails closed rather than relying on
platform-specific rename-overwrite behavior. A mismatch is preserved in quarantine and fails for
operator action. The manager control namespace is trusted and reserved for Symphony; hooks must not
mutate it. Successful
current-attempt cleanup or explicit workspace removal deletes the matching state after the
workspace path is gone. If state deletion then fails, a later create may replace that valid record
because the workspace path is absent; no user workspace data is deleted in that case. Failed
workspace cleanup leaves `in_progress` state and any matching quarantine residue for a later
invocation. Workspace and control paths are checked with no-follow `lstat`: the workspace/control
directory must be a real directory, the state must be a real regular file, and symlinks or
unavailable identity fields fail closed. The implementation rereads the state and compares the
exact `dev`, `ino`, and `birthtimeNs` strings immediately before the atomic move and after it. The
fixed remediation is: `Inspect the workspace and Symphony provisioning state; remove the workspace
only after verifying it is safe, then retry.`

During later-invocation recovery, any quarantine collision, move failure, post-move identity failure,
or recursive-delete failure emits `outcome=failed` and throws
`workspace_provisioning_incomplete` with the fixed remediation, which enters operator hold instead
of generic retry. During best-effort cleanup of the current failed `after_create`, the same
diagnostic is emitted but the original hook or capability error remains the attempt result.

Provisioning diagnostics use this callback payload:

```ts
type WorkspaceProvisioningLogger = (entry: {
  level: "info" | "warn" | "error";
  event: "workspace_provisioning_incomplete";
  outcome: "recovering" | "recovered" | "failed";
  issueId: string;
  workspacePath: string;
  errorCode: "workspace_provisioning_incomplete";
  remediation: string;
}) => void;
```

`WorkspaceManagerOptions` exposes the callback as
`provisioningLogger?: WorkspaceProvisioningLogger`. `recovering` is emitted at `warn`, `recovered`
at `info`, and `failed` at `error`. `runtime-host` forwards it to the structured logger, and
the error is transported as a `WorkspacePathError` with
`ERROR_CODES.workspaceProvisioningIncomplete = "workspace_provisioning_incomplete"` and the fixed
remediation in its message. In `orchestrator/core`, an explicit
`errorCode === ERROR_CODES.workspaceProvisioningIncomplete` branch runs before deterministic
capability and generic retry classification. It creates an operator hold whose `error` begins with
the exact code and whose `capabilityFailure` is absent. The code remains present in the hold
error/status path and structured worker-exit logs. This change does not alter GitHub capability
classification, and `src/agent/github-capability.ts` remains untouched.

### 9.3 Optional Workspace Population (Implementation-Defined)

The spec does not require any built-in VCS or repository bootstrap behavior.

Implementations may populate or synchronize the workspace using implementation-defined logic and/or
hooks (for example `after_create` and/or `before_run`).

Failure handling:

- Workspace population/synchronization failures return an error for the current attempt.
- The standard `after_create` hook failure path may recursively remove a workspace only when the
  current invocation created it, using the safeguards in Section 9.2, and must preserve the
  original failure.
- A reused workspace may be reset only when valid manager-owned state explicitly identifies an
  interrupted provisioning attempt. Markerless legacy workspaces and workspaces marked `ready`
  must not be destructively reset.

### 9.4 Workspace Hooks

Supported hooks:

- `hooks.after_create`
- `hooks.before_run`
- `hooks.after_run`
- `hooks.before_remove`

Execution contract:

- Execute in a local shell context appropriate to the host OS, with the workspace directory as
  `cwd`.
- On POSIX systems, `sh -lc <script>` (or a stricter equivalent such as `bash -lc <script>`) is a
  conforming default.
- Pass an explicit environment to the hook subprocess.
- For every command scoped to the hook, prepend a resolution/execution check to the hook body and
  run the combined payload in one shell invocation. Complete all checks before starting the
  workflow-owned body.
- Preserve the original hook script byte-for-byte when no command is declared for that hook.
- Hook timeout uses `hooks.timeout_ms`; default: `60000 ms`.
- Log hook start, failures, and timeouts.

Failure semantics:

- `after_create` failure or timeout is fatal to workspace creation.
- `before_run` failure or timeout is fatal to the current run attempt.
- `after_run` failure or timeout is logged and ignored.
- `before_remove` failure or timeout is logged and ignored.
- A declared-command marker produces the typed command capability error instead of `hook_failed`.
- Only expiry of the configured timeout produces `hook_timed_out`; shell spawn or launch rejection
  is a non-timeout hook failure.

Command-capability scheduling semantics:

| Hook | Check timing | Failure effect |
| --- | --- | --- |
| `after_create` | In the new workspace's hook invocation, before its body and tracker claim | Fatal; deterministic failures hold, transient failures retry; failure cleanup may remove only the identity-matched generation installed by this invocation; interrupted existing generations are recovered before this hook starts |
| `before_run` | In the attempt's hook invocation, before its body and tracker claim | Fatal; deterministic failures hold, transient failures retry |
| `after_run` | In the post-attempt hook invocation, before its body | Best-effort log only; never changes the attempt result or creates a hold |
| `before_remove` | In the cleanup hook invocation, before its body | Best-effort log only; never creates a hold or prevents cleanup |

### 9.5 Safety Invariants

This is the most important portability constraint.

Invariant 1: Run the coding agent only in the per-issue workspace path.

- Before launching the coding-agent subprocess, validate:
  - `cwd == workspace_path`

Invariant 2: Workspace path must stay inside workspace root.

- Normalize both paths to absolute.
- Require `workspace_path` to have `workspace_root` as a prefix directory.
- Reject any path outside the workspace root.

Invariant 3: Workspace key is sanitized.

- Only `[A-Za-z0-9._-]` allowed in workspace directory names.
- Replace all other characters with `_`.

## 10. Agent Runner Protocol (Coding Agent Integration)

This section defines the language-neutral contract for integrating a coding agent app-server.

Compatibility profile:

- The normative contract is message ordering, required behaviors, and the logical fields that must
  be extracted (for example session IDs, completion state, approval handling, and usage/rate-limit
  telemetry).
- Exact JSON field names may vary slightly across compatible app-server versions.
- Implementations should tolerate equivalent payload shapes when they carry the same logical
  meaning, especially for nested IDs, approval requests, user-input-required signals, and
  token/rate-limit metadata.

### 10.1 Launch Contract

Subprocess launch parameters:

- Command: `codex.command`
- Invocation: `bash -lc <codex.command>`
- Working directory: workspace path
- Stdout/stderr: separate streams
- Framing: line-delimited protocol messages on stdout (JSON-RPC-like JSON per line)

Notes:

- The default command is `codex app-server`.
- Approval policy, cwd, and prompt are expressed in the protocol messages in Section 10.2.

Recommended additional process settings:

- Max line size: 10 MB (for safe buffering)

### 10.2 Session Startup Handshake

Reference: https://developers.openai.com/codex/app-server/

The client must send these protocol messages in order:

Illustrative startup transcript (equivalent payload shapes are acceptable if they preserve the same
semantics):

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"symphony","version":"1.0"},"capabilities":{"experimentalApi":true,"requestAttestation":false}}}
{"method":"initialized","params":{}}
{"id":2,"method":"thread/start","params":{"approvalPolicy":"<implementation-defined>","sandbox":"<implementation-defined>","cwd":"/abs/workspace","dynamicTools":[{"name":"example_tool","description":"Example client-side tool.","inputSchema":{"type":"object"}}]}}
{"id":3,"method":"turn/start","params":{"threadId":"<thread-id>","input":[{"type":"text","text":"<rendered prompt-or-continuation-guidance>"}],"cwd":"/abs/workspace","title":"ABC-123: Example","approvalPolicy":"<implementation-defined>","sandboxPolicy":{"type":"<implementation-defined>"}}}
```

1. `initialize` request
   - Params include:
     - `clientInfo` object (for example `{name, version}`)
     - `capabilities` object with `experimentalApi: true` when client-side dynamic tools are used
   - Wait for response (`read_timeout_ms`, subject to the Windows session-start floor in Section
     5.3.6)
2. `initialized` notification
3. `thread/start` request
   - Params include:
     - `approvalPolicy` = implementation-defined session approval policy value
     - `sandbox` = implementation-defined session sandbox value
     - `cwd` = absolute workspace path
     - If optional client-side tools are implemented, include their advertised tool specs in
       `dynamicTools`; each spec must include `name`, `description`, and `inputSchema`.
4. `turn/start` request
   - Params include:
     - `threadId`
     - `input` = single text item containing rendered prompt for the first turn, or continuation
       guidance for later turns on the same thread
     - `cwd`
     - `title` = `<issue.identifier>: <issue.title>`
     - `approvalPolicy` = implementation-defined turn approval policy value
     - `sandboxPolicy` = implementation-defined object-form sandbox policy payload when required by
       the targeted app-server version

Session identifiers:

- Read `thread_id` from `thread/start` result `result.thread.id`
- Read `turn_id` from each `turn/start` result `result.turn.id`
- Emit `session_id = "<thread_id>-<turn_id>"`
- Reuse the same `thread_id` for all continuation turns inside one worker run

### 10.3 Streaming Turn Processing

The client reads line-delimited messages until the turn terminates.

Completion conditions:

- `turn/completed` -> success
- `turn/failed` -> failure
- `turn/cancelled` -> failure
- turn timeout (`turn_timeout_ms`) -> failure
- subprocess exit -> failure

Continuation processing:

- If the worker decides to continue after a successful turn, it should issue another `turn/start`
  on the same live `threadId`.
- The app-server subprocess should remain alive across those continuation turns and be stopped only
  when the worker run is ending.

Line handling requirements:

- Read protocol messages from stdout only.
- Buffer partial stdout lines until newline arrives.
- Attempt JSON parse on complete stdout lines.
- Stderr is not part of the protocol stream:
  - ignore it or log it as diagnostics
  - do not attempt protocol JSON parsing on stderr

### 10.4 Emitted Runtime Events (Upstream to Orchestrator)

The app-server client emits structured events to the orchestrator callback. Each event should
include:

- `event` (enum/string)
- `timestamp` (UTC timestamp)
- `codex_app_server_pid` (if available)
- optional `usage` map (token counts)
- payload fields as needed

Important emitted events may include:

- `session_started`
- `startup_failed`
- `turn_completed`
- `turn_failed`
- `turn_cancelled`
- `turn_ended_with_error`
- `turn_input_required`
- `approval_auto_approved`
- `unsupported_tool_call`
- `notification`
- `other_message`
- `malformed`

### 10.5 Approval, Tool Calls, and User Input Policy

Approval, sandbox, and user-input behavior is implementation-defined.

Policy requirements:

- Each implementation should document its chosen approval, sandbox, and operator-confirmation
  posture.
- Approval requests and user-input-required events must not leave a run stalled indefinitely. An
  implementation should either satisfy them, surface them to an operator, auto-resolve them, or
  fail the run according to its documented policy.

Example high-trust behavior:

- Auto-approve command execution approvals for the session.
- Auto-approve file-change approvals for the session.
- Treat user-input-required turns as hard failure.

Unsupported dynamic tool calls:

- Supported dynamic tool calls that are explicitly implemented and advertised by the runtime should
  be handled according to their extension contract.
- If the agent requests a dynamic tool call (`item/tool/call`) that is not supported, return a tool
  failure response with `success: false` and `contentItems` output, then continue the session.
- This prevents the session from stalling on unsupported tool execution paths.

Optional client-side tool extension:

- An implementation may expose a limited set of client-side tools to the app-server session.
- Current optional standardized tool: `linear_graphql`.
- If implemented, supported tools should be advertised to the app-server session during startup
  using the protocol mechanism supported by the targeted Codex app-server version.
- Unsupported tool names should still return a failure result and continue the session.

`linear_graphql` extension contract:

- Purpose: execute a raw GraphQL query or mutation against Linear using Symphony's configured
  tracker auth for the current session.
- Availability: only meaningful when `tracker.kind == "linear"` and valid Linear auth is configured.
- Preferred input shape:

  ```json
  {
    "query": "single GraphQL query or mutation document",
    "variables": {
      "optional": "graphql variables object"
    }
  }
  ```

- `query` must be a non-empty string.
- `query` must contain exactly one GraphQL operation.
- `variables` is optional and, when present, must be a JSON object.
- Implementations may additionally accept a raw GraphQL query string as shorthand input.
- Execute one GraphQL operation per tool call.
- If the provided document contains multiple operations, reject the tool call as invalid input.
- `operationName` selection is intentionally out of scope for this extension.
- Reuse the configured Linear endpoint and auth from the active Symphony workflow/runtime config; do
  not require the coding agent to read raw tokens from disk.
- Tool result semantics:
  - transport success + no top-level GraphQL `errors` -> `success=true`
  - top-level GraphQL `errors` present -> `success=false`, but preserve the GraphQL response body
    for debugging
  - invalid input, missing auth, or transport failure -> `success=false` with an error payload
- Return the GraphQL response or error payload as structured tool output that the model can inspect
  in-session.

Illustrative responses (equivalent payload shapes are acceptable if they preserve the same outcome):

```json
{"id":"<approval-id>","result":{"approved":true}}
{"id":"<tool-call-id>","result":{"success":false,"error":"unsupported_tool_call"}}
```

Hard failure on user input requirement:

- If the agent requests user input, fail the run attempt immediately.
- The client detects this via:
  - explicit method (`item/tool/requestUserInput`), or
  - turn methods/flags indicating input is required.

### 10.6 Timeouts and Error Mapping

Timeouts:

- `codex.read_timeout_ms`: request/response timeout during startup and synchronous requests; on
  Windows, `initialize`, `thread/start`, and `turn/start` use at least `30000` ms
- `command/exec`: outer response timeout is the command timeout plus `codex.read_timeout_ms`
- `codex.turn_timeout_ms`: total turn stream timeout
- `codex.stall_timeout_ms`: enforced by orchestrator based on event inactivity

Error mapping (recommended normalized categories):

- `codex_not_found`
- `invalid_workspace_cwd`
- `response_timeout`
- `turn_timeout`
- `port_exit`
- `response_error`
- `turn_failed`
- `turn_cancelled`
- `turn_input_required`

### 10.7 Agent Runner Contract

The `Agent Runner` wraps workspace + prompt + app-server client.

Behavior:

1. Create/reuse workspace for issue.
2. Run `hooks.before_run` and its declared command checks in the same shell invocation when
   configured.
3. Prepare the turn sandbox and resolve all environment-affecting capability prerequisites,
   including the optional GitHub credential bridge. Finish this environment construction before
   creating a shared app-server; its child environment cannot be changed afterwards.
4. Initialize the shared app-server early when any generic agent command or GitHub capability is
   declared.
5. Probe every generic agent command through that app-server using the workspace cwd, prepared
   sandbox, inherited environment, configured timeout, and declared direct argv.
6. When `capabilities.github.required` is enabled, verify authenticated GitHub identity, resolve
   the workspace target repository, and verify that repository reports push permission without
   mutating GitHub through the same shared app-server.
7. Claim the tracker issue only after all declared pre-dispatch checks pass. This is tracker
   lifecycle write-back, not the orchestrator's earlier local `claimed`/`running` reservation.
   Pre-dispatch checks are
   `after_create` when a new workspace is created, `before_run`, generic agent probes, and the
   GitHub probe. A declaration scoped only to `after_run` or `before_remove` does not defer claim.
8. Build prompt from workflow template.
9. Start app-server session.
10. Forward app-server events to orchestrator.
11. On any error, fail the worker attempt; deterministic capability failures enter an operator hold,
   while transient failures use normal orchestrator retry semantics.

Failure transport:

- A typed capability failure crosses the runner/scheduler boundary as
  `{error, capability_failure}`.
- `capability_failure` is the complete sanitized metadata object created by the boundary probe.
  Worker logging, `on_worker_exit`, retry/hold creation, snapshots, and status APIs propagate that
  object unchanged rather than reconstructing command, boundary, or remediation from prose.

Note:

- Workspaces are intentionally preserved after successful runs.

## 11. Issue Tracker Integration Contract (Linear-Compatible)

### 11.1 Required Operations

An implementation must support these tracker adapter operations:

1. `fetch_candidate_issues()`
   - Return issues in configured active states for a configured project.

2. `fetch_issues_by_states(state_names)`
   - Used for startup terminal cleanup.

3. `fetch_issue_states_by_ids(issue_ids)`
   - Used for active-run reconciliation.

### 11.2 Query Semantics (Linear)

Linear-specific requirements for `tracker.kind == "linear"`:

- `tracker.kind == "linear"`
- GraphQL endpoint (default `https://api.linear.app/graphql`)
- Auth token sent in `Authorization` header
- `tracker.project_slug` maps to Linear project `slugId`
- Candidate issue query filters project using `project: { slugId: { eq: $projectSlug } }`
- Issue-state refresh query uses GraphQL issue IDs with variable type `[ID!]`
- Pagination required for candidate issues
- Page size default: `50`
- Network timeout: `30000 ms`

Important:

- Linear GraphQL schema details can drift. Keep query construction isolated and test the exact query
  fields/types required by this specification.

A non-Linear implementation may change transport details, but the normalized outputs must match the
domain model in Section 4.

### 11.3 Normalization Rules

Candidate issue normalization should produce fields listed in Section 4.1.1.

Additional normalization details:

- `labels` -> lowercase strings
- `blocked_by` -> derived from inverse relations where relation type is `blocks`
- `priority` -> integer only (non-integers become null)
- `created_at` and `updated_at` -> parse ISO-8601 timestamps

### 11.4 Error Handling Contract

Recommended error categories:

- `unsupported_tracker_kind`
- `missing_tracker_api_key`
- `missing_tracker_project_slug`
- `linear_api_request` (transport failures)
- `linear_api_status` (non-200 HTTP)
- `linear_graphql_errors`
- `linear_unknown_payload`
- `linear_missing_end_cursor` (pagination integrity error)

Orchestrator behavior on tracker errors:

- Candidate fetch failure: log and skip dispatch for this tick.
- Running-state refresh failure: log and keep active workers running.
- Startup terminal cleanup failure: log warning and continue startup.

### 11.5 Tracker Writes (Important Boundary)

Symphony does not require platform-specific tracker write APIs in the orchestrator.

- Adapters may implement optional lifecycle write methods for claim and handoff transitions.
- Ticket mutations outside that generic lifecycle, such as comments and PR metadata, are typically
  handled by the coding agent using tools defined by the workflow prompt.
- The service remains a scheduler/runner and tracker reader; adapter-specific API details stay in
  the adapter.
- Workflow-specific success often means "reached the next handoff state" (for example
  `Human Review`) rather than tracker terminal state `Done`.
- If the optional `linear_graphql` client-side tool extension is implemented, it is still part of
  the agent toolchain rather than orchestrator business logic.

## 12. Prompt Construction and Context Assembly

### 12.1 Inputs

Inputs to prompt rendering:

- `workflow.prompt_template`
- normalized `issue` object
- optional `attempt` integer (retry/continuation metadata)

### 12.2 Rendering Rules

- Render with strict variable checking.
- Render with strict filter checking.
- Convert issue object keys to strings for template compatibility.
- Preserve nested arrays/maps (labels, blockers) so templates can iterate.

### 12.3 Retry/Continuation Semantics

`attempt` should be passed to the template because the workflow prompt may provide different
instructions for:

- first run (`attempt` null or absent)
- continuation run after a successful prior session
- retry after error/timeout/stall

### 12.4 Failure Semantics

If prompt rendering fails:

- Fail the run attempt immediately.
- Let the orchestrator treat it like any other worker failure and decide retry behavior.

## 13. Logging, Status, and Observability

### 13.1 Logging Conventions

Required context fields for issue-related logs:

- `issue_id`
- `issue_identifier`

Required context for coding-agent session lifecycle logs:

- `session_id`

Message formatting requirements:

- Use stable `key=value` phrasing.
- Include action outcome (`completed`, `failed`, `retrying`, etc.).
- Include concise failure reason when present.
- Avoid logging large raw payloads unless necessary.

### 13.2 Logging Outputs and Sinks

The spec does not prescribe where logs must go (stderr, file, remote sink, etc.).

Requirements:

- Operators must be able to see startup/validation/dispatch failures without attaching a debugger.
- Implementations may write to one or more sinks.
- If a configured log sink fails, the service should continue running when possible and emit an
  operator-visible warning through any remaining sink.

### 13.3 Runtime Snapshot / Monitoring Interface (Optional but Recommended)

If the implementation exposes a synchronous runtime snapshot (for dashboards or monitoring), it
should return:

- `running` (list of running session rows)
- each running row should include `turn_count`
- `retrying` (list of retry queue rows)
- `holds` (list of operator-hold rows)
  - Each row includes issue ID/identifier, attempt, held timestamp, sanitized error string, and
    optional `capability_failure`.
- `counts.held`
- `codex_totals`
  - `input_tokens`
  - `output_tokens`
  - `total_tokens`
  - `seconds_running` (aggregate runtime seconds as of snapshot time, including active sessions)
- `rate_limits` (latest coding-agent rate limit payload, if available)

Recommended snapshot error modes:

- `timeout`
- `unavailable`

### 13.4 Optional Human-Readable Status Surface

A human-readable status surface (terminal output, dashboard, etc.) is optional and
implementation-defined.

If present, it should draw from orchestrator state/metrics only and must not be required for
correctness.

### 13.5 Session Metrics and Token Accounting

Token accounting rules:

- Agent events may include token counts in multiple payload shapes.
- Prefer absolute thread totals when available, such as:
  - `thread/tokenUsage/updated` payloads
  - `total_token_usage` within token-count wrapper events
- Ignore delta-style payloads such as `last_token_usage` for dashboard/API totals.
- Extract input/output/total token counts leniently from common field names within the selected
  payload.
- For absolute totals, track deltas relative to last reported totals to avoid double-counting.
- Do not treat generic `usage` maps as cumulative totals unless the event type defines them that
  way.
- Accumulate aggregate totals in orchestrator state.

Runtime accounting:

- Runtime should be reported as a live aggregate at snapshot/render time.
- Implementations may maintain a cumulative counter for ended sessions and add active-session
  elapsed time derived from `running` entries (for example `started_at`) when producing a
  snapshot/status view.
- Add run duration seconds to the cumulative ended-session runtime when a session ends (normal exit
  or cancellation/termination).
- Continuous background ticking of runtime totals is not required.

Rate-limit tracking:

- Track the latest rate-limit payload seen in any agent update.
- Any human-readable presentation of rate-limit data is implementation-defined.

### 13.6 Humanized Agent Event Summaries (Optional)

Humanized summaries of raw agent protocol events are optional.

If implemented:

- Treat them as observability-only output.
- Do not make orchestrator logic depend on humanized strings.

### 13.7 Optional HTTP Server Extension

This section defines an optional HTTP interface for observability and operational control.

If implemented:

- The HTTP server is an extension and is not required for conformance.
- The implementation may serve server-rendered HTML or a client-side application for the dashboard.
- The dashboard/API must be observability/control surfaces only and must not become required for
  orchestrator correctness.

Enablement (extension):

- Start the HTTP server when a CLI `--port` argument is provided.
- Start the HTTP server when `server.port` is present in `WORKFLOW.md` front matter.
- `server.port` is extension configuration and is intentionally not part of the core front-matter
  schema in Section 5.3.
- Precedence: CLI `--port` overrides `server.port` when both are present.
- `server.port` must be an integer. Positive values bind that port. `0` may be used to request an
  ephemeral port for local development and tests.
- Implementations should bind loopback by default (`127.0.0.1` or host equivalent) unless explicitly
  configured otherwise.
- Changes to HTTP listener settings (for example `server.port`) do not need to hot-rebind;
  restart-required behavior is conformant.

#### 13.7.1 Human-Readable Dashboard (`/`)

- Host a human-readable dashboard at `/`.
- The returned document should depict the current state of the system (for example active sessions,
  retry delays, token consumption, runtime totals, recent events, and health/error indicators).
- It is up to the implementation whether this is server-generated HTML or a client-side app that
  consumes the JSON API below.

#### 13.7.2 JSON REST API (`/api/v1/*`)

Provide a JSON REST API under `/api/v1/*` for current runtime state and operational debugging.

Minimum endpoints:

- `GET /api/v1/state`
  - Returns a summary view of the current system state (running sessions, retry queue/delays,
    aggregate token/runtime totals, latest rate limits, and any additional tracked summary fields).
  - Suggested response shape:

    ```json
    {
      "generated_at": "2026-02-24T20:15:30Z",
      "counts": {
        "running": 2,
        "retrying": 1,
        "held": 1
      },
      "running": [
        {
          "issue_id": "abc123",
          "issue_identifier": "MT-649",
          "state": "In Progress",
          "session_id": "thread-1-turn-1",
          "turn_count": 7,
          "last_event": "turn_completed",
          "last_message": "",
          "started_at": "2026-02-24T20:10:12Z",
          "last_event_at": "2026-02-24T20:14:59Z",
          "tokens": {
            "input_tokens": 1200,
            "output_tokens": 800,
            "total_tokens": 2000
          }
        }
      ],
      "retrying": [
        {
          "issue_id": "def456",
          "issue_identifier": "MT-650",
          "attempt": 3,
          "due_at": "2026-02-24T20:16:00Z",
          "error": "no available orchestrator slots"
        }
      ],
      "holds": [
        {
          "issue_id": "ghi789",
          "issue_identifier": "MT-651",
          "attempt": 2,
          "held_at": "2026-02-24T20:15:45Z",
          "error": "required_command_not_found: required command rg is unavailable at agent",
          "capability_failure": {
            "code": "required_command_not_found",
            "capability": "external_command",
            "command": "rg",
            "boundary": "agent",
            "remediation": "Install rg in the agent execution environment, then explicitly retry the held issue."
          }
        }
      ],
      "codex_totals": {
        "input_tokens": 5000,
        "output_tokens": 2400,
        "total_tokens": 7400,
        "seconds_running": 1834.2
      },
      "rate_limits": null
    }
    ```

- `GET /api/v1/<issue_identifier>`
  - Returns issue-specific runtime/debug details for the identified issue, including any information
    the implementation tracks that is useful for debugging.
  - Suggested response shape:

    ```json
    {
      "issue_identifier": "MT-649",
      "issue_id": "abc123",
      "status": "running",
      "workspace": {
        "path": "/tmp/symphony_workspaces/MT-649"
      },
      "attempts": {
        "restart_count": 1,
        "current_retry_attempt": 2
      },
      "running": {
        "session_id": "thread-1-turn-1",
        "turn_count": 7,
        "state": "In Progress",
        "started_at": "2026-02-24T20:10:12Z",
        "last_event": "notification",
        "last_message": "Working on tests",
        "last_event_at": "2026-02-24T20:14:59Z",
        "tokens": {
          "input_tokens": 1200,
          "output_tokens": 800,
          "total_tokens": 2000
        }
      },
      "retry": null,
      "logs": {
        "codex_session_logs": [
          {
            "label": "latest",
            "path": "/var/log/symphony/codex/MT-649/latest.log",
            "url": null
          }
        ]
      },
      "recent_events": [
        {
          "at": "2026-02-24T20:14:59Z",
          "event": "notification",
          "message": "Working on tests"
        }
      ],
      "last_error": null,
      "tracked": {}
    }
    ```

  - If the issue is unknown to the current in-memory state, return `404` with an error response (for
    example `{\"error\":{\"code\":\"issue_not_found\",\"message\":\"...\"}}`).

- `POST /api/v1/refresh`
  - Queues an immediate tracker poll + reconciliation cycle (best-effort trigger; implementations
    may coalesce repeated requests).
  - Suggested request body: empty body or `{}`.
  - Suggested response (`202 Accepted`) shape:

    ```json
    {
      "queued": true,
      "coalesced": false,
      "requested_at": "2026-02-24T20:15:30Z",
      "operations": ["poll", "reconcile"]
    }
    ```

- `POST /api/v1/holds/<issue_identifier>/retry`
  - Explicitly retries only the selected operator hold after the operator repairs the declared
    command, environment, sandbox, credential, or permission.
  - Returns `202 Accepted` with the selected issue ID/identifier and whether it was dispatched or
    released.
  - Returns `404` when the selected issue is not currently held. Repeating a deterministic failure
    creates a new hold; it never schedules an automatic timer.

API design notes:

- The JSON shapes above are the recommended baseline for interoperability and debugging ergonomics.
- Implementations may add fields, but should avoid breaking existing fields within a version.
- Endpoints should be read-only except for operational triggers like `/refresh` and selected hold
  retry.
- Unsupported methods on defined routes should return `405 Method Not Allowed`.
- API errors should use a JSON envelope such as `{"error":{"code":"...","message":"..."}}`.
- If the dashboard is a client-side app, it should consume this API rather than duplicating state
  logic.

## 14. Failure Model and Recovery Strategy

### 14.1 Failure Classes

1. `Workflow/Config Failures`
   - Missing `WORKFLOW.md`
   - Invalid YAML front matter
   - Unsupported tracker kind or missing tracker credentials/project slug
   - Missing coding-agent executable

2. `Workspace Failures`
   - Workspace directory creation failure
   - Workspace population/synchronization failure (implementation-defined; may come from hooks)
   - Invalid workspace path configuration
   - Hook timeout/failure

3. `External Capability Failures`
   - `required_command_not_found`: a declared executable is unavailable in a declared hook or agent
     execution boundary.
   - `required_command_execution_denied`: a declared executable resolves but that boundary refuses
     execution.
   - `required_command_capability_transient`: command resolution/execution timed out, the
     app-server protocol failed, or the result could not be classified deterministically.
   - `github_cli_not_found`: `gh` cannot be resolved where the configured credential is loaded or
     in the Codex command environment.
   - `github_auth_invalid`: authentication is missing, invalid, expired, or returns HTTP 401.
   - `github_permission_denied`: repository access returns HTTP 403 or push permission is false.
   - `github_capability_transient`: timeout, network, provider, or unclassified probe failure.

4. `Agent Session Failures`
   - Startup handshake failure
   - Turn failed/cancelled
   - Turn timeout
   - User input requested (hard fail)
   - Subprocess exit
   - Stalled session (no activity)

5. `Tracker Failures`
   - API transport errors
   - Non-200 status
   - GraphQL errors
   - malformed payloads

6. `Observability Failures`
   - Snapshot timeout
   - Dashboard render errors
   - Log sink configuration failure

Sanitized capability metadata:

- `code`: stable machine-readable error code.
- `capability`: stable capability name, such as `external_command` or `github`.
- `command`: safe declared executable basename when applicable.
- `boundary`: stable declared boundary when applicable.
- `remediation`: fixed actionable guidance derived only from safe declaration and boundary values.

The metadata object contains no optional raw diagnostic bag. Resolved executable paths, PATH,
stdout/stderr, probe argv, environment values, and credentials are forbidden.

### 14.2 Recovery Behavior

- Dispatch validation failures:
  - Skip new dispatches.
  - Keep service alive.
  - Continue reconciliation where possible.

- Worker failures:
  - Convert to retries with exponential backoff.

- External capability failures:
  - Put `required_command_not_found`, `required_command_execution_denied`,
    `github_cli_not_found`, `github_auth_invalid`, and `github_permission_denied` into the existing
    operator hold with no automatic retry timer.
  - Retry `required_command_capability_transient` and `github_capability_transient` using the normal
    failure backoff.
  - Expose only the capability name, stable error code, and sanitized command/boundary/remediation
    context in logs and retry/status data. Never include PATH, probe or hook output, probe argv,
    tokens, authorization headers, or credential environment values.
  - A deterministic fatal capability failure atomically removes any retry entry, creates an
    `operator_holds` entry with no timer, and keeps the issue claimed.
  - An explicit retry targets exactly one hold, re-fetches eligibility, and reruns all applicable
    pre-dispatch checks. It does not release or redispatch other held issues.

- Tracker candidate-fetch failures:
  - Skip this tick.
  - Try again on next tick.

- Reconciliation state-refresh failures:
  - Keep current workers.
  - Retry on next tick.

- Dashboard/log failures:
  - Do not crash the orchestrator.

### 14.3 Partial State Recovery (Restart)

Current design is intentionally in-memory for scheduler state.

After restart:

- No retry timers are restored from prior process memory.
- No running sessions are assumed recoverable.
- Service recovers by:
  - startup terminal workspace cleanup
  - fresh polling of active issues
  - re-dispatching eligible work

### 14.4 Operator Intervention Points

Operators can control behavior by:

- Editing `WORKFLOW.md` (prompt and most runtime settings).
- `WORKFLOW.md` changes should be detected and re-applied automatically without restart.
- Changing issue states in the tracker:
  - terminal state -> running session is stopped and workspace cleaned when reconciled
  - non-active state -> running session is stopped without cleanup
- Restarting the service for process recovery or deployment (not as the normal path for applying
  workflow config changes).

## 15. Security and Operational Safety

### 15.1 Trust Boundary Assumption

Each implementation defines its own trust boundary.

Operational safety requirements:

- Implementations should state clearly whether they are intended for trusted environments, more
  restrictive environments, or both.
- Implementations should state clearly whether they rely on auto-approved actions, operator
  approvals, stricter sandboxing, or some combination of those controls.
- Workspace isolation and path validation are important baseline controls, but they are not a
  substitute for whatever approval and sandbox policy an implementation chooses.

### 15.2 Filesystem Safety Requirements

Mandatory:

- Workspace path must remain under configured workspace root.
- Coding-agent cwd must be the per-issue workspace path for the current run.
- Workspace directory names must use sanitized identifiers.

Recommended additional hardening for ports:

- Run under a dedicated OS user.
- Restrict workspace root permissions.
- Mount workspace root on a dedicated volume if possible.

### 15.3 Secret Handling

- Support `$VAR` indirection in workflow config.
- Do not log API tokens or secret env values.
- Validate presence of secrets without printing them.

### 15.4 Hook Script Safety

Workspace hooks are arbitrary shell scripts from `WORKFLOW.md`.

Implications:

- Hooks are fully trusted configuration.
- Hooks run inside the workspace directory.
- Hook output should be truncated in logs.
- Hook timeouts are required to avoid hanging the orchestrator.

### 15.5 Harness Hardening Guidance

Running Codex agents against repositories, issue trackers, and other inputs that may contain
sensitive data or externally-controlled content can be dangerous. A permissive deployment can lead
to data leaks, destructive mutations, or full machine compromise if the agent is induced to execute
harmful commands or use overly-powerful integrations.

Implementations should explicitly evaluate their own risk profile and harden the execution harness
where appropriate. This specification intentionally does not mandate a single hardening posture, but
ports should not assume that tracker data, repository contents, prompt inputs, or tool arguments are
fully trustworthy just because they originate inside a normal workflow.

Possible hardening measures include:

- Tightening Codex approval and sandbox settings described elsewhere in this specification instead
  of running with a maximally permissive configuration.
- Adding external isolation layers such as OS/container/VM sandboxing, network restrictions, or
  separate credentials beyond the built-in Codex policy controls.
- Filtering which Linear issues, projects, teams, labels, or other tracker sources are eligible for
  dispatch so untrusted or out-of-scope tasks do not automatically reach the agent.
- Narrowing the optional `linear_graphql` tool so it can only read or mutate data inside the
  intended project scope, rather than exposing general workspace-wide tracker access.
- Reducing the set of client-side tools, credentials, filesystem paths, and network destinations
  available to the agent to the minimum needed for the workflow.

The correct controls are deployment-specific, but implementations should document them clearly and
treat harness hardening as part of the core safety model rather than an optional afterthought.

## 16. Reference Algorithms (Language-Agnostic)

### 16.1 Service Startup

```text
function start_service():
  configure_logging()
  start_observability_outputs()
  start_workflow_watch(on_change=reload_and_reapply_workflow)

  state = {
    poll_interval_ms: get_config_poll_interval_ms(),
    max_concurrent_agents: get_config_max_concurrent_agents(),
    running: {},
    claimed: set(),
    retry_attempts: {},
    operator_holds: {},
    completed: set(),
    codex_totals: {input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0},
    codex_rate_limits: null
  }

  validation = validate_dispatch_config()
  if validation is not ok:
    log_validation_error(validation)
    fail_startup(validation)

  startup_terminal_workspace_cleanup()
  schedule_tick(delay_ms=0)

  event_loop(state)
```

### 16.2 Poll-and-Dispatch Tick

```text
on_tick(state):
  state = reconcile_running_and_held_issues(state)

  validation = validate_dispatch_config()
  if validation is not ok:
    log_validation_error(validation)
    notify_observers()
    schedule_tick(state.poll_interval_ms)
    return state

  issues = tracker.fetch_candidate_issues()
  if issues failed:
    log_tracker_error()
    notify_observers()
    schedule_tick(state.poll_interval_ms)
    return state

  for issue in sort_for_dispatch(issues):
    if no_available_slots(state):
      break

    if should_dispatch(issue, state):
      state = dispatch_issue(issue, state, attempt=null)

  notify_observers()
  schedule_tick(state.poll_interval_ms)
  return state
```

### 16.3 Reconcile Active Runs and Holds

```text
function reconcile_running_and_held_issues(state):
  state = reconcile_stalled_runs(state)

  running_ids = keys(state.running)
  held_ids = keys(state.operator_holds)
  tracked_ids = unique(running_ids + held_ids)
  if tracked_ids is empty:
    return state

  refreshed = tracker.fetch_issue_states_by_ids(tracked_ids)
  if refreshed failed:
    log_debug("keep workers running and holds claimed")
    return state

  for issue in refreshed:
    if issue.id in state.running:
      if issue.state in terminal_states:
        state = terminate_running_issue(state, issue.id, cleanup_workspace=true)
      else if issue.state in active_states:
        state.running[issue.id].issue = issue
      else:
        state = terminate_running_issue(state, issue.id, cleanup_workspace=false)

    if issue.id in state.operator_holds:
      if issue.state in terminal_states:
        workspace_manager.remove_for_issue(issue.id)
        state = release_hold_and_claim(state, issue.id)
      else if issue.state in active_states:
        state.operator_holds[issue.id].identifier = issue.identifier
      else:
        state = release_hold_and_claim(state, issue.id)

  for held_id in held_ids not present in refreshed:
    state = release_hold_and_claim(state, held_id)

  return state
```

### 16.4 Dispatch One Issue

```text
function dispatch_issue(issue, state, attempt):
  # Reserve the issue and one concurrency slot before any worker code can run.
  state.running[issue.id] = {
    worker_handle: null,
    monitor_handle: null,
    identifier: issue.identifier,
    issue,
    session_id: null,
    codex_app_server_pid: null,
    last_codex_message: null,
    last_codex_event: null,
    last_codex_timestamp: null,
    codex_input_tokens: 0,
    codex_output_tokens: 0,
    codex_total_tokens: 0,
    last_reported_input_tokens: 0,
    last_reported_output_tokens: 0,
    last_reported_total_tokens: 0,
    retry_attempt: normalize_attempt(attempt),
    started_at: now_utc()
  }
  state.claimed.add(issue.id)
  state.retry_attempts.remove(issue.id)

  worker = spawn_worker(
    fn -> run_agent_attempt(issue, attempt, parent_orchestrator_pid) end
  )

  if worker spawn failed:
    state.running.remove(issue.id)
    return schedule_retry(state, issue.id, next_attempt(attempt), {
      identifier: issue.identifier,
      error: "failed to spawn agent"
    })

  state.running[issue.id].worker_handle = worker.worker_handle
  state.running[issue.id].monitor_handle = worker.monitor_handle
  return state
```

### 16.5 Worker Attempt (Workspace + Prompt + Agent)

```text
function run_agent_attempt(issue, attempt, orchestrator_channel):
  workspace = null
  app_server = null

  try:
    # The TypeScript profile uses stable issue.id for every workspace-manager call.
    workspace_result = workspace_manager.create_for_issue(issue.id)
    if workspace_result failed:
      fail_worker(
        workspace_result.error,
        capability_failure=workspace_result.capability_failure
      )
    workspace = workspace_result.workspace

    before_run_result = run_hook("before_run", workspace.path)
    if before_run_result failed:
      fail_worker(
        before_run_result.error,
        capability_failure=before_run_result.capability_failure
      )

    sandbox = prepare_turn_sandbox_policy(workspace.path)
    app_server_environment = resolve_all_capability_environment()

    if generic_agent_commands_declared() or github_capability_required():
      initialize_result = initialize_app_server(
        workspace=workspace.path,
        environment=app_server_environment,
        sandbox=sandbox
      )
      if initialize_result failed:
        fail_worker("agent app-server initialization failed")
      app_server = initialize_result.app_server

    for command in declared_generic_agent_commands_in_order():
      result = app_server.command_exec(
        argv=[platform_executable_basename(command), ...command.probe_args],
        cwd=workspace.path,
        sandbox=sandbox
      )
      if result failed:
        fail_worker(result.error, capability_failure=result.capability_failure)

    if github_capability_required():
      github_result = probe_github_capability(
        app_server=app_server,
        cwd=workspace.path,
        sandbox=sandbox
      )
      if github_result failed:
        fail_worker(
          github_result.error,
          capability_failure=github_result.capability_failure
        )

    claim_result = tracker.claim_issue_if_configured(issue)
    if claim_result failed:
      fail_worker("tracker claim failed")
    issue = claim_result.issue

    max_turns = config.agent.max_turns
    turn_number = 1

    while true:
      prompt_result = build_turn_prompt(
        workflow_template,
        issue,
        attempt,
        turn_number,
        max_turns
      )
      if prompt_result failed:
        fail_worker("prompt error")

      if app_server is null:
        late_initialize_result = initialize_app_server(
          workspace=workspace.path,
          environment=app_server_environment,
          sandbox=sandbox
        )
        if late_initialize_result failed:
          fail_worker("agent app-server initialization failed")
        app_server = late_initialize_result.app_server

      turn_result =
        if turn_number == 1:
          app_server.start_session(
            prompt=prompt_result.prompt,
            issue=issue,
            workspace=workspace.path,
            sandbox=sandbox
          )
        else:
          app_server.continue_turn(
            prompt=prompt_result.prompt,
            issue=issue,
            workspace=workspace.path,
            sandbox=sandbox
          )

      if turn_result failed:
        fail_worker("agent turn error")

      refreshed_issue = tracker.fetch_issue_states_by_ids([issue.id])
      if refreshed_issue failed:
        fail_worker("issue state refresh error")

      issue = refreshed_issue[0] or issue
      if issue.state is not active or turn_number >= max_turns:
        break

      turn_number = turn_number + 1

    exit_normal()
  finally:
    if app_server is not null:
      app_server.stop()
    if workspace is not null:
      run_hook_best_effort("after_run", workspace.path)
```

### 16.6 Worker Exit and Retry Handling

```text
on_worker_exit(issue_id, reason, capability_failure, state):
  running_entry = state.running.remove(issue_id)
  state = add_runtime_seconds_to_totals(state, running_entry)

  if reason == normal:
    state.completed.add(issue_id)  # bookkeeping only
    state = schedule_retry(state, issue_id, 1, {
      identifier: running_entry.identifier,
      delay_type: continuation
    })
  else if capability_failure is deterministic:
    state.retry_attempts.remove(issue_id)
    state.operator_holds[issue_id] = {
      issue_id,
      identifier: running_entry.identifier,
      attempt: next_attempt_from(running_entry),
      held_at_ms: now_ms(),
      error: reason,
      capability_failure
    }
    state.claimed.add(issue_id)
  else:
    state = schedule_retry(state, issue_id, next_attempt_from(running_entry), {
      identifier: running_entry.identifier,
      error: format("worker exited: %reason"),
      capability_failure
    })

  notify_observers()
  return state
```

```text
on_retry_timer(issue_id, state):
  retry_entry = state.retry_attempts.pop(issue_id)
  if missing:
    return state

  validation = validate_dispatch_config()
  if validation is not ok:
    return schedule_retry(state, issue_id, retry_entry.attempt + 1, {
      identifier: retry_entry.identifier,
      error: validation.error
    })

  candidates = tracker.fetch_candidate_issues()
  if fetch failed:
    return schedule_retry(state, issue_id, retry_entry.attempt + 1, {
      identifier: retry_entry.identifier,
      error: "retry poll failed"
    })

  issue = find_by_id(candidates, issue_id)
  if issue is null or not is_dispatch_eligible(issue, allow_own_claim=issue_id):
    state.claimed.remove(issue_id)
    return state

  if available_slots(state) == 0:
    return schedule_retry(state, issue_id, retry_entry.attempt + 1, {
      identifier: issue.identifier,
      error: "no available orchestrator slots"
    })

  return dispatch_issue(issue, state, attempt=retry_entry.attempt)
```

```text
on_explicit_hold_retry(issue_id, state):
  hold = state.operator_holds[issue_id]
  if hold is missing:
    return state

  validation = validate_dispatch_config()
  if validation is not ok:
    return state

  refreshed = tracker.fetch_issue_states_by_ids([issue_id])
  if refreshed failed:
    return state  # preserve the selected hold

  issue = refreshed[0]
  if issue is missing or not is_dispatch_eligible(issue, allow_own_claim=issue_id):
    return release_hold_and_claim(state, issue_id)

  if no_available_slots(state):
    return state

  state.operator_holds.remove(issue_id)
  return dispatch_issue(issue, state, attempt=hold.attempt)
```

## 17. Test and Validation Matrix

A conforming implementation should include tests that cover the behaviors defined in this
specification.

Validation profiles:

- `Core Conformance`: deterministic tests required for all conforming implementations.
- `Extension Conformance`: required only for optional features that an implementation chooses to
  ship.
- `Real Integration Profile`: environment-dependent smoke/integration checks recommended before
  production use.

Unless otherwise noted, Sections 17.1 through 17.7 are `Core Conformance`. Bullets that begin with
`If ... is implemented` are `Extension Conformance`.

### 17.1 Workflow and Config Parsing

- Workflow file path precedence:
  - explicit runtime path is used when provided
  - cwd default is `WORKFLOW.md` when no explicit runtime path is provided
- Workflow file changes are detected and trigger re-read/re-apply without restart
- Invalid workflow reload keeps last known good effective configuration and emits an
  operator-visible error
- Missing `WORKFLOW.md` returns typed error
- Invalid YAML front matter returns typed error
- Front matter non-map returns typed error
- Config defaults apply when optional values are missing
- `capabilities.commands` defaults to an empty map and omitted workflows add no execution
  dependency
- Valid hook-only, agent-only, and dual-boundary command declarations are normalized
- Unsafe executable names, unknown hooks, inactive declarations, and malformed probe argv fail
  dispatch as `config_invalid`
- `tracker.kind` validation enforces currently supported kind (`linear`)
- `tracker.api_key` works (including `$VAR` indirection)
- `$VAR` resolution works for tracker API key and path values
- `~` path expansion works
- `codex.command` is preserved as a shell command string
- Per-state concurrency override map normalizes state names and ignores invalid values
- Prompt template renders `issue` and `attempt`
- Prompt rendering fails on unknown variables (strict mode)

### 17.2 Workspace Manager and Safety

- Deterministic workspace path per stable workspace input (`issue.id` in the TypeScript
  implementation)
- Missing workspace directory is created
- Existing workspace directory is reused
- Existing non-directory path at workspace location is handled safely (replace or fail per
  implementation policy)
- Optional workspace population/synchronization errors are surfaced
- Temporary artifacts (`tmp`, `.elixir_ls`) are removed during prep
- `after_create` hook runs only on new workspace creation, including recreation of a workspace with
  valid interrupted-provisioning state
- Provisioning state is recorded outside the per-issue workspace as `in_progress` before
  `after_create` and promoted to `ready` only after success
- A workspace created by the current invocation is recursively removed when `after_create` command
  preflight or hook-body execution fails, even if the failed hook populated it; retry recreates it
  and reruns `after_create`
- The original typed `required_command_*` error and sanitized metadata survive `after_create`
  recovery, including a failed recursive removal, and are never replaced by
  `workspace_create_failed`
- An existing workspace with valid `in_progress` state is recovered before worker preflight and
  emits the greppable `workspace_provisioning_incomplete` diagnostic
- A markerless legacy workspace or workspace marked `ready` is never deleted or re-provisioned
- Invalid, unreadable, symlinked, path/key-mismatched, or directory-identity-mismatched state preserves
  workspace data and enters operator hold as `workspace_provisioning_incomplete`
- A fresh creation runs `after_create` once and reaches `ready`
- A current-attempt hook failure that populated the workspace recursively removes that owned
  generation without replacing the original hook/capability error
- A matching leftover `in_progress` workspace is recovered and re-provisioned instead of silently
  skipping `after_create`
- A populated markerless legacy workspace remains untouched and is not re-provisioned
- Additional tests preserve identity-mismatched workspaces, assert exact recovery diagnostics and
  state removal, classify the dedicated error as operator hold, and serialize two manager instances
  for one normalized root/key across create and remove
- Malformed generations, including separators and traversal payloads, preserve workspace data and
  fail before a recovery path is constructed
- Quarantine collisions and recovery move/identity/delete failures preserve data, emit the exact
  failed diagnostic, and enter operator hold; the corresponding current-attempt cleanup failure
  still preserves the original hook/capability error
- `before_run` hook runs before each attempt and failure/timeouts abort the current attempt
- Hook-shell launch rejection is reported as `hook_failed`, not `hook_timed_out`
- `after_run` hook runs after each attempt and failure/timeouts are logged and ignored
- `before_remove` hook runs on cleanup and failures/timeouts are ignored
- A typed declared-command failure in `after_run` or `before_remove` is logged with sanitized
  capability metadata but remains best-effort and does not create an operator hold
- Workspace path sanitization and root containment invariants are enforced before agent launch
- Agent launch uses the per-issue workspace path as cwd and rejects out-of-root paths

### 17.3 Issue Tracker Client

- Candidate issue fetch uses active states and project slug
- Linear query uses the specified project filter field (`slugId`)
- Empty `fetch_issues_by_states([])` returns empty without API call
- Pagination preserves order across multiple pages
- Blockers are normalized from inverse relations of type `blocks`
- Labels are normalized to lowercase
- Issue state refresh by ID returns minimal normalized issues
- Issue state refresh query uses GraphQL ID typing (`[ID!]`) as specified in Section 11.2
- Error mapping for request errors, non-200, GraphQL errors, malformed payloads

### 17.4 Orchestrator Dispatch, Reconciliation, and Retry

- Dispatch sort order is priority then oldest creation time
- `Todo` issue with non-terminal blockers is not eligible
- `Todo` issue with terminal blockers is eligible
- Active-state issue refresh updates running entry state
- Non-active state stops running agent without workspace cleanup
- Terminal state stops running agent and cleans workspace
- Reconciliation with no running issues is a no-op
- Normal worker exit schedules a short continuation retry (attempt 1)
- Abnormal worker exit increments retries with 10s-based exponential backoff
- Retry backoff cap uses configured `agent.max_retry_backoff_ms`
- Retry queue entries include attempt, due time, identifier, and error
- Stall detection kills stalled sessions and schedules retry
- Slot exhaustion requeues retries with explicit error reason
- If a snapshot API is implemented, it returns running rows, retry rows, token totals, and rate
  limits
- If a snapshot API is implemented, timeout/unavailable cases are surfaced
- Deterministic required-command failures enter operator hold without a timer and suppress polling
  redispatch
- Transient required-command failures use normal exponential retry backoff
- Explicit operator retry targets only the selected held issue
- A tracker refresh failure during explicit operator retry preserves the selected hold unchanged
- Tracker claim deferral applies whenever any pre-dispatch capability is declared
- A locally reserved preflight consumes one worker slot and concurrent poll/retry requests cannot
  duplicate it
- Held terminal issues release and clean their workspace; held non-active or missing issues release
  without cleanup; active held issues remain held without re-probing
- Invalid config at retry time prevents dispatch, retry-time ineligibility releases only that
  issue's claim, and an explicit held retry with no available slot preserves the selected hold

### 17.5 Coding-Agent App-Server Client

- Launch command uses workspace cwd and invokes `bash -lc <codex.command>`
- Startup handshake sends `initialize`, `initialized`, `thread/start`, `turn/start`
- `initialize` includes client identity/capabilities payload required by the targeted Codex
  app-server protocol
- Policy-related startup payloads use the implementation's documented approval/sandbox settings
- `thread/start` and `turn/start` parse nested IDs and emit `session_started`
- Request/response read timeout is enforced
- Turn timeout is enforced
- Partial JSON lines are buffered until newline
- Stdout and stderr are handled separately; protocol JSON is parsed from stdout only
- Non-JSON stderr lines are logged but do not crash parsing
- Command/file-change approvals are handled according to the implementation's documented policy
- Generic agent command probes use the same app-server instance, cwd, environment, and prepared
  sandbox as the later turn
- The app-server is stopped when any generic command preflight, GitHub capability preflight, tracker
  claim, prompt build, or agent turn fails after initialization
- A combined generic-agent and GitHub `gh_auth_token` workflow resolves the credential environment
  before starting the shared app-server, then runs both probes before tracker claim and turn start
- Hook-boundary success is not accepted as agent-boundary proof, or vice versa
- Hook marker recognition requires the invocation nonce, a matching declaration, the matching
  deterministic exit status, and absence of the owned success marker; hook-authored marker-like text
  cannot spoof a capability result
- Not-found, execution-denied, and transient outcomes are exercised independently in both hook and
  agent boundaries; a failed hook preflight proves that the workflow hook body did not run
- Windows extensionless executable names resolve to `.exe` for the agent argv and use the Windows
  command timeout
- Unsupported dynamic tool calls are rejected without stalling the session
- User input requests are handled according to the implementation's documented policy and do not
  stall indefinitely
- Usage and rate-limit payloads are extracted from nested payload shapes
- Compatible payload variants for approvals, user-input-required signals, and usage/rate-limit
  telemetry are accepted when they preserve the same logical meaning
- If optional client-side tools are implemented, the startup handshake advertises the supported tool
  specs required for discovery by the targeted app-server version
- If the optional `linear_graphql` client-side tool extension is implemented:
  - the tool is advertised to the session
  - valid `query` / `variables` inputs execute against configured Linear auth
  - top-level GraphQL `errors` produce `success=false` while preserving the GraphQL body
  - invalid arguments, missing auth, and transport failures return structured failure payloads
  - unsupported tool names still fail without stalling the session

### 17.6 Observability

- Validation failures are operator-visible
- Structured logging includes issue/session context fields
- Required-command failures expose only stable sanitized code/capability/command/boundary/remediation
  fields in logs and hold snapshots; raw PATH, probe output, hook output, argv, and credentials are
  absent
- Logging sink failures do not crash orchestration
- Token/rate-limit aggregation remains correct across repeated agent updates
- If a human-readable status surface is implemented, it is driven from orchestrator state and does
  not affect correctness
- If humanized event summaries are implemented, they cover key wrapper/agent event classes without
  changing orchestrator behavior

### 17.7 CLI and Host Lifecycle

- CLI accepts an optional positional workflow path argument (`path-to-WORKFLOW.md`)
- CLI uses `./WORKFLOW.md` when no workflow path argument is provided
- CLI errors on nonexistent explicit workflow path or missing default `./WORKFLOW.md`
- CLI surfaces startup failure cleanly
- CLI exits with success when application starts and shuts down normally
- CLI exits nonzero when startup fails or the host process exits abnormally

### 17.8 Real Integration Profile (Recommended)

These checks are recommended for production readiness and may be skipped in CI when credentials,
network access, or external service permissions are unavailable.

- A real tracker smoke test can be run with valid credentials supplied by `LINEAR_API_KEY` or a
  documented local bootstrap mechanism (for example `~/.linear_api_key`).
- Real integration tests should use isolated test identifiers/workspaces and clean up tracker
  artifacts when practical.
- A skipped real-integration test should be reported as skipped, not silently treated as passed.
- If a real-integration profile is explicitly enabled in CI or release validation, failures should
  fail that job.

## 18. Implementation Checklist (Definition of Done)

Use the same validation profiles as Section 17:

- Section 18.1 = `Core Conformance`
- Section 18.2 = `Extension Conformance`
- Section 18.3 = `Real Integration Profile`

### 18.1 Required for Conformance

- Workflow path selection supports explicit runtime path and cwd default
- `WORKFLOW.md` loader with YAML front matter + prompt body split
- Typed config layer with defaults and `$` resolution
- Dynamic `WORKFLOW.md` watch/reload/re-apply for config and prompt
- Polling orchestrator with single-authority mutable state
- Issue tracker client with candidate fetch + state refresh + terminal fetch
- Workspace manager with sanitized per-issue workspaces
- Workspace lifecycle hooks (`after_create`, `before_run`, `after_run`, `before_remove`)
- Hook timeout config (`hooks.timeout_ms`, default `60000`)
- Coding-agent app-server subprocess client with JSON line protocol
- Codex launch command config (`codex.command`, default `codex app-server`)
- Strict prompt rendering with `issue` and `attempt` variables
- Exponential retry queue with continuation retries after normal exit
- Configurable retry backoff cap (`agent.max_retry_backoff_ms`, default 5m)
- Reconciliation that stops runs on terminal/non-active tracker states
- Workspace cleanup for terminal issues (startup sweep + active transition)
- Structured logs with `issue_id`, `issue_identifier`, and `session_id`
- Operator-visible observability (structured logs; optional snapshot/status surface)

### 18.2 Recommended Extensions (Not Required for Conformance)

This TypeScript implementation elects the declared external-command capability extension below, so
its extension-conformance requirements are mandatory for this repository even though workflows
that omit it retain no new runtime dependency.

- Optional HTTP server honors CLI `--port` over `server.port`, uses a safe default bind host, and
  exposes the baseline endpoints/error semantics in Section 13.7 if shipped.
- Optional declared external-command capabilities implement boundary-scoped hook and agent probes,
  deterministic operator holds, transient backoff, sanitized diagnostics, and empty-workspace
  recovery as defined in Sections 5.3.7, 9, 10.7, and 14.
- Optional `linear_graphql` client-side tool extension exposes raw Linear GraphQL access through the
  app-server session using configured Symphony auth.
- TODO: Persist retry queue and session metadata across process restarts.
- TODO: Make observability settings configurable in workflow front matter without prescribing UI
  implementation details.
- TODO: Add first-class comment/checkpoint write APIs after lifecycle claim and handoff write-back.
- TODO: Add pluggable issue tracker adapters beyond Linear.

### 18.3 Operational Validation Before Production (Recommended)

- Run the `Real Integration Profile` from Section 17.8 with valid credentials and network access.
- Verify hook execution and workflow path resolution on the target host OS/shell environment.
- If the optional HTTP server is shipped, verify the configured port behavior and loopback/default
  bind expectations on the target environment.

# Implementation Plan

This file is the required development sequence for this repository. Keep it in sync with
`SPEC.upstream.md` and update it when the implementation order changes.

## Tracker Adapter Layer

Goal: make tracker support extensible while preserving the existing Linear behavior.

### Task 1: Introduce the Adapter Boundary

Status: Complete

- Add a tracker adapter registry that maps `tracker.kind` from `WORKFLOW.md` to a concrete
  `IssueTracker` implementation.
- Move Linear client construction out of the runtime host into the registry.
- Move tracker-specific Codex dynamic tool injection behind the same adapter registry.
- Keep `linear` as the default and only bundled adapter in this task.
- Preserve existing Linear config behavior, including `LINEAR_API_KEY` fallback and
  `tracker.project_slug` validation.

Acceptance:

- Existing Linear workflows still start without config changes.
- Unsupported `tracker.kind` values fail during dispatch validation with the list of supported
  adapters.
- The runtime host no longer imports or constructs `LinearTrackerClient` directly.

### Task 2: Document the Adapter Contract

Status: Complete

- Document the normalized `IssueTracker` contract.
- Document how adapter-specific `WORKFLOW.md` fields are preserved for future adapters.
- Define the recommended ticket fields and status lifecycle that any connected tracking system
  should expose.
- Add a first-page README note so operators see that Symphony uses tracker adapters.

Acceptance:

- A contributor can create a new adapter by following the docs without reading Linear internals
  first.
- README explains that adapter choice happens in project-owned `WORKFLOW.md`.

### Task 3: Add the First Non-Linear Adapter

Status: Complete

- Added the bundled Notion tracker adapter.
- Added a dedicated client, normalizer, adapter registration, tests, and documentation.
- Did not add platform-specific assumptions to the orchestrator, workspace manager, dashboard, or
  prompt builder.

Acceptance:

- The Notion adapter implements the same `IssueTracker` behavior as Linear.
- Projects can switch between Linear and Notion by changing `tracker.kind` and adapter-specific
  fields in `WORKFLOW.md`.

### Task 4: Add Tracker Lifecycle Write-Back

Status: Complete

- Added optional write-capable tracker lifecycle methods for claim and handoff transitions.
- Implemented Notion status option discovery and page status writes for `status` and `select`
  properties.
- Added workflow lifecycle config for claim, handoff, blocked, and claim-before-agent behavior.
- Added `symphony_handoff` for structured PR-ready handoff evidence.
- Prevented Codex startup when required claim write-back fails.
- Suppressed continuation after successful handoff and held operator-action cases for failed
  handoff or repeated no-progress exits.

Acceptance:

- Notion can claim `Todo` work into `In Progress` before a Codex session starts.
- Missing lifecycle state options produce clear errors with available Notion options.
- Successful structured handoff moves tickets to the configured review state and suppresses
  continuation.
- Handoff write failures and missing progress are surfaced without launching another Codex turn.
- Linear read and dynamic tool behavior remains unchanged.

### Task 5: Harden Multi-Adapter Operations

Status: Planned

- Add conformance tests shared by all adapters.
- Add adapter smoke-test guidance for real credentials.
- Revisit any state-name-specific orchestration rules and promote them to config if needed.

Acceptance:

- Adapter behavior is verified through shared contract tests.
- New adapters do not need runtime-host or agent-runner edits unless adding new cross-cutting
  capabilities.

## Operator Experience and Reliability

Goal: make Symphony easier to supervise and safer to resume while preserving the existing
orchestration contract.

### Task 5: Add a Ticket Status Screen

Status: Planned

- Add a dedicated ticket detail view linked from the dashboard and issue-specific JSON endpoint.
- Show the current agent state for the ticket, including run status, turn count, latest agent event,
  retry state, workspace path, and recent errors.
- Show the files currently changed by the agent inside the ticket workspace or worktree.
- Keep the screen adapter-neutral by reading normalized issue data, orchestrator state, workspace
  metadata, and filesystem/git status rather than tracker-specific fields.

Acceptance:

- Operators can open a ticket status screen from the dashboard and see what the agent is doing now.
- The screen lists changed files for the active workspace or explains when file status is
  unavailable.
- Live dashboard updates keep the ticket screen current without requiring a manual refresh.
- Tests cover the JSON shape, rendered HTML, empty states, and non-git workspace fallback.

### Task 6: Refine the Dashboard Home Page

Status: Planned

- Reduce low-signal details on the main dashboard and move issue-specific debugging details to the
  ticket status screen.
- Add the most useful operator summary: active tickets, queued retries, recent failures, runtime
  totals, latest rate-limit state, and clear links to ticket details.
- Improve responsive layout, spacing, table density, and empty/error states so the page works as a
  daily operations surface instead of a raw snapshot dump.

Acceptance:

- The home page answers "what needs attention?" without requiring operators to inspect raw JSON.
- No ticket-specific details are lost; they are reachable from ticket detail links.
- Desktop and mobile layouts avoid overlap and keep status text readable.
- Tests cover rendered sections, empty states, and live-update DOM targets.

### Task 7: Stabilize Ticket and Worktree Continuation

Status: Partial

Implemented safety slice:

- Opt-in tracker comment polling re-reads ticket comments after each completed turn and adds only
  newly observed operator comments to the next turn on the same live coding-agent thread.
- Configured integration authors can be ignored so Symphony-authored checkpoints are not echoed
  back to the agent.
- Opt-in stale-workspace retention removes only non-active workspaces whose tracker issue has
  exceeded the configured age and whose Git checkout is clean, has an upstream, and has no
  unpushed commits. Dirty, ahead, unverifiable, and active workspaces are preserved and logged.

Remaining continuation work:

- Persist enough run state to distinguish a continuation from a brand-new ticket execution after
  process restarts, retries, and config reloads.
- Reuse the existing workspace/worktree and coding-agent thread when a ticket is still active and
  resumable.
- Make workspace/worktree creation, hook execution, cleanup, and retry scheduling idempotent across
  restarts.
- Prevent duplicate agents from claiming the same active ticket when Symphony restarts or multiple
  poll/reconcile cycles overlap.
- Add explicit recovery behavior for missing workspaces, moved terminal tickets, stale locks, and
  interrupted agent sessions.

Acceptance:

- Restarting Symphony during active work continues the existing ticket run when continuation data is
  valid.
- Restarting with incomplete or stale continuation data fails safe, surfaces the reason, and does
  not silently start unrelated work.
- Worktree reuse and cleanup are covered by tests for active, handoff, terminal, and retry states.
- Operators can see from logs and status surfaces whether a ticket was resumed or started fresh.

### Task 8: Notify Operators About New `symphony-ts` Versions

Status: Planned

- Add a non-blocking version check that compares the running package version with the latest
  published `symphony-ts` version.
- Surface update availability in the CLI startup output, structured logs, and dashboard when the
  check succeeds.
- Cache version-check results and make network failures silent except for debug-level diagnostics.
- Provide configuration to disable the check for offline, private, or reproducible environments.

Acceptance:

- Operators can see when a newer `symphony-ts` release is available.
- Version checks never block startup, dispatch, or agent continuation.
- Offline and disabled-check modes are tested.
- The dashboard clearly distinguishes update notices from runtime errors.

### Task 9: Validate External CLI Capabilities Before Dispatch

Status: Complete

- Add adapter-neutral, workflow-configured capability probes for external CLIs that a coding agent
  must use, such as GitHub CLI authentication and target-repository access.
- Execute probes in the same effective shell, environment, credential context, and sandbox boundary
  that agent commands will use; a hook succeeding in a different shell must not count as proof.
- For the GitHub capability, verify the authenticated identity and non-mutating repository access,
  including whether the account can push, without logging tokens or other credential material.
- Distinguish deterministic operator-action failures such as missing credentials, expired tokens,
  and repository permission denial from transient network or provider failures.
- Put deterministic capability failures into an operator hold before substantive agent work starts,
  and suppress automatic continuation while the failure signature is unchanged.
- Surface the failed capability, effective executable/config context, remediation guidance, and hold
  state in structured logs and operator-facing status surfaces.
- Keep external capabilities opt-in so workflows that do not use GitHub or another specific CLI do
  not acquire an unrelated startup dependency.

Acceptance:

- Tests reproduce a split-shell credential case where a hook sees valid `gh` credentials but the
  agent command environment receives `HTTP 401`, and dispatch fails safe before implementation.
- A repeated unchanged authentication or permission failure does not launch another Codex turn or
  consume continuation retries; an explicit retry or relevant environment/config change can release
  the operator hold.
- A successful GitHub probe confirms identity and target-repository access through non-mutating API
  checks and allows the normal worker lifecycle to continue.
- Credential precedence cases such as keyring state, `GH_TOKEN`, `GITHUB_TOKEN`, and alternate
  config directories are covered without exposing secret values in logs, errors, or the dashboard.
- Missing executables, invalid credentials, insufficient repository permissions, and transient
  network failures produce distinct machine-readable error codes and actionable messages.
- Workflow templates and operator documentation explain how to declare required capabilities and
  how to recover a held ticket after credentials are repaired.

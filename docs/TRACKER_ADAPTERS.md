# Tracker Adapters

Symphony reads work through tracker adapters. A project selects the adapter in its repository-owned
`WORKFLOW.md`, and the runtime turns `tracker.kind` into a concrete `IssueTracker`
implementation.

Bundled adapters:

| Kind | Auth fallback | Required fields | Dynamic tool |
| --- | --- | --- | --- |
| `linear` | `LINEAR_API_KEY` | `project_slug` | `linear_graphql` |
| `notion` | `NOTION_API_KEY` | `data_source_id`, `title_property`, `status_property` | `symphony_handoff`, `symphony_block`, `symphony_ticket_read`, `symphony_ticket_note` |

The adapter layer exists so platforms can be added without changing orchestrator, workspace,
dashboard, or prompt-rendering behavior.

## Runtime Boundary

The stable runtime contract is `IssueTracker`:

```ts
interface IssueTracker {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;
  fetchIssueStatesByIds(issueIds: string[]): Promise<IssueStateSnapshot[]>;
  readIssueContext?(input): Promise<TrackerIssueContext>;
  appendIssueNote?(input): Promise<TrackerIssueNoteResult>;
  claimIssue?(input): Promise<TrackerLifecycleTransitionResult>;
  handoffIssue?(input): Promise<TrackerLifecycleTransitionResult>;
  blockIssue?(input): Promise<TrackerLifecycleTransitionResult>;
}
```

Adapters must normalize platform data into the shared `Issue` model:

- `id`: stable platform ID used for claims, retries, workspaces, and reconciliation.
- `identifier`: human-readable ticket key shown in logs, prompts, and dashboards.
- `title`: non-empty task title.
- `description`: task body or `null`.
- `priority`: integer priority where lower values dispatch first, or `null`.
- `state`: current workflow state/status name.
- `branchName`: platform-provided branch metadata, or `null`.
- `url`: browser URL for the ticket, or `null`.
- `labels`: lowercase labels.
- `blockedBy`: blockers with best-effort `id`, `identifier`, and `state`.
- `createdAt` and `updatedAt`: ISO timestamps or `null`.

The orchestrator treats every adapter the same after normalization. It sorts candidates by
priority, then creation time, then identifier. It dispatches only configured active states, stops
workers when state reconciliation leaves active states, and cleans workspaces for terminal states.

Lifecycle writes are optional adapter capabilities. If an adapter implements `claimIssue` and
`handoffIssue`, Symphony can claim work before Codex starts and provide the issue-scoped
`symphony_handoff` dynamic tool. If it implements `blockIssue`, Symphony can provide the
issue-scoped `symphony_block` dynamic tool for clarification questions and blocked-state
write-back. If it implements `readIssueContext` and `appendIssueNote`, Symphony can provide
issue-scoped ticket tools for reading tracker-native body/comment context and appending ordinary
notes without requiring an unrelated connector. Adapters that do not implement those methods keep
their existing behavior. When `polling.issue_comments_between_turns` is enabled, adapters with
`readIssueContext` also provide newly observed comments to the next turn on the same live agent
thread; implementations should return stable entry IDs when the tracker exposes them.

## WORKFLOW.md Selection

Adapter choice belongs to each target repository:

```yaml
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: ENG
  active_states: [Todo, In Progress]
  claim_state: In Progress
  handoff_states: [In Review, Review]
  blocked_state: Needs decision
  require_claim_before_agent: true
  terminal_states: [Done, Canceled]
```

Common tracker fields:

- `kind`: adapter key. Currently supported: `linear`, `notion`.
- `endpoint`: adapter API endpoint when the adapter supports overriding it.
- `api_key`: token value or `$ENV_VAR` reference.
- `active_states`: state names eligible for dispatch.
- `claim_state`: state to write before launching Codex for a write-capable adapter.
- `handoff_states`: exact state names, in preference order, for structured handoff.
- `blocked_state`: operator-action state name reserved for workflows that use it.
- `require_claim_before_agent`: when true, a failed claim blocks Codex startup.
- `terminal_states`: state names that trigger terminal cleanup.

Adapter-specific fields stay under `tracker`. The config resolver preserves non-common tracker keys
in `config.tracker.adapterOptions`, so an adapter can read fields such as `data_source_id`,
`board_id`, `workspace_id`, or property mappings without changing the shared config shape first.

## Recommended Ticket Shape

Connected systems should expose, or let the adapter derive, this minimum structure:

| Field | Required | Recommendation |
| --- | --- | --- |
| Stable ID | Yes | Use the platform's immutable ID, not a mutable title or URL. |
| Identifier | Yes | Prefer a short key such as `ENG-123`; otherwise derive a stable display key. |
| Title | Yes | Keep it concise and action-oriented. |
| Description | Recommended | Include acceptance criteria, constraints, and links. |
| Status | Yes | Map to a small workflow with active, handoff, and terminal states. |
| Priority | Recommended | Use integers where lower numbers are higher priority. |
| Labels | Optional | Normalize to lowercase. |
| Blockers | Optional | Return blocker state when available. |
| URL | Recommended | Link operators and agents back to the source ticket. |
| Created/updated timestamps | Recommended | Creation time is used for stable dispatch ordering. |

## Recommended Status Lifecycle

Use a small, explicit lifecycle. Names may differ by platform, but each state should map clearly to
one of these categories.

| Category | Example states | Symphony behavior |
| --- | --- | --- |
| Intake | Backlog, Triage | Not active. Symphony ignores these tickets. |
| Ready | Todo | Active. Eligible for dispatch when unclaimed and unblocked. |
| Running | In Progress | Active. Eligible for continuation and reconciliation. |
| Blocked | Blocked | Not active unless the adapter can safely pre-filter blocked work. |
| Handoff | In Review, Human Review | Not active and not terminal. The worker stops after reaching handoff. |
| Terminal | Done, Closed, Canceled, Duplicate | Terminal. Startup and reconciliation can clean the workspace. |

Recommended defaults:

```yaml
tracker:
  active_states: [Todo, In Progress]
  claim_state: In Progress
  handoff_states: [In Review, Review]
  blocked_state: Needs decision
  require_claim_before_agent: true
  terminal_states: [Done, Closed, Canceled, Cancelled, Duplicate]
```

Current orchestration applies blocker gating to normalized `Todo` issues: a `Todo` issue with
blockers dispatches only when every blocker is in a terminal state. If an adapter uses a different
ready-state name, either normalize that state to `Todo` or pre-filter blocked candidates until this
policy becomes configurable.

## Linear

Linear behavior is unchanged:

- `src/tracker/linear-client.ts` owns GraphQL reads.
- `src/codex/linear-graphql-tool.ts` injects `linear_graphql`.
- `project_slug` remains required for dispatch.

## Notion

The Notion adapter reads pages from a single Notion data source through the REST API.

### Required fields

- `data_source_id`
- `title_property`
- `status_property`

### Optional fields and fallbacks

- `identifier_property`: falls back to the first 8 hex chars of the page ID.
- `description_property`: falls back to `null`.
- `priority_property`: falls back to `null`.
- `labels_property`: falls back to `[]`.
- `blocked_by_property`: falls back to `[]`.

### Normalization

The adapter maps Notion pages to the shared `Issue` model like this:

- `id`: Notion page ID.
- `identifier`: configured identifier property or short page ID fallback.
- `title`: configured title property.
- `description`: configured rich text property or `null`.
- `priority`: number/select/status/formula best effort.
- `state`: configured status/select property.
- `branchName`: always `null`.
- `url`: Notion page URL.
- `labels`: lowercased `multi_select` or `select` values.
- `blockedBy`: relation page IDs with best-effort identifier/state hydration.
- `createdAt`: page `created_time`.
- `updatedAt`: page `last_edited_time`.

### Query behavior

- `fetchCandidateIssues()`: queries pages where status is in `active_states`.
- `fetchIssuesByStates(stateNames)`: queries pages for the provided state names.
- `fetchIssueStatesByIds(issueIds)`: retrieves the current state for each page ID.
- pagination is implemented for data source queries and relation property expansion.
- Notion queries request `created_time` ascending sort; final dispatch ordering still happens in
  the orchestrator.

### Notion lifecycle write-back

The Notion adapter implements first-class lifecycle writes for the configured `status_property`.
It validates `claim_state` and `handoff_states` against the Notion data source schema and writes
exact matching `status` or `select` options with `PATCH /v1/pages/{page_id}`.

- Before Codex starts, `Todo` work is claimed into `claim_state` when
  `require_claim_before_agent` is true.
- If claim validation or write-back fails, Symphony does not launch Codex; it queues a cheap
  orchestration retry and surfaces `tracker_claim_failed`.
- The agent calls `symphony_handoff` with PR URL/SHA and validation evidence when the repository
  workflow is ready for review.
- A successful handoff writes the first configured exact `handoff_states` match and suppresses
  continuation.
- If handoff status write-back fails, Symphony pauses automatic continuation and surfaces
  `tracker_handoff_failed` for operator action.
- The agent calls `symphony_block` with specific questions when the task is not
  implementation-ready. Notion writes a page comment first, then moves the ticket to
  `blocked_state`. If comments are forbidden with HTTP 403, Notion appends the questions to the page
  body before moving status; if all question write paths fail, automatic continuation pauses so
  operators see the broken tracker path instead of repeated turns.
- For Notion, Symphony also blocks before Codex starts only when the configured description field is
  empty and the readable page body/comments do not contain usable human context. The preflight check
  strips Symphony's own default blocker template before deciding whether context is usable.
- If page body/comment reads are partially unavailable, Symphony skips this automatic preflight
  block and lets the agent inspect degraded context through `symphony_ticket_read`.
- The agent can call `symphony_ticket_read` to refresh page body/comment context and
  `symphony_ticket_note` to append ordinary checkpoints, questions, validation notes, branch names,
  and PR links. `symphony_ticket_note` uses the same comment-first, page-body fallback write path as
  blocker questions.
- Ordinary Notion comments are optional checkpointing, but blocker questions are required because
  they are the retrievable question trail before a status change to `blocked_state`.

See [docs/NOTION_ADAPTER.md](./NOTION_ADAPTER.md) for full setup and examples.

## Adding an Adapter

1. Add a platform client under `src/tracker/<kind>-client.ts`.
2. Add a normalizer under `src/tracker/<kind>-normalize.ts`.
3. Implement `IssueTracker`.
4. Register the adapter in `src/tracker/adapters.ts`.
5. Define adapter-specific validation in the registry entry.
6. Add optional lifecycle methods or dynamic tools when the adapter needs platform-native write
   access.
7. Export public adapter APIs from `src/index.ts` when useful.
8. Add unit tests for client requests, normalization, config validation, and registry behavior.
9. Update `docs/WORKFLOW.template.md` and this guide with the adapter fields.

Adapters should keep platform API details isolated. Do not add platform-specific branches to
`OrchestratorCore`, `OrchestratorRuntimeHost`, `WorkspaceManager`, dashboard rendering, or prompt
templates unless the shared product contract itself changes.

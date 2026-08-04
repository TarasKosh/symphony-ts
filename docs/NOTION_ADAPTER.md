# Notion adapter

This guide covers the MVP Notion tracker adapter that ships in `tracker.kind: notion`.

## What it supports

- reading candidate tickets from one Notion data source
- fetching pages by explicit workflow states
- reconciling current state by page ID
- claiming eligible tasks into a configured running state before Codex starts
- handing ready work off through the adapter-neutral `symphony_handoff` tool
- posting clarification questions and moving non-actionable tasks through the adapter-neutral
  `symphony_block` tool
- reading page body/comments through `symphony_ticket_read`
- appending ordinary checkpoints, notes, and non-blocking questions through `symphony_ticket_note`
- normalizing Notion pages into Symphony `Issue` objects
- best-effort blocker hydration through relation properties

## 1. Create a token

Use either:

- an internal Notion connection token
- a personal access token, where your workspace policy allows it

Expose it as `NOTION_API_KEY`. This is the canonical environment fallback for
`tracker.kind: notion`.

## 2. Share the data source with the connection

Share the target database/data source with the integration before running Symphony.

If you configure `blocked_by_property`, also share the related data source that the relation points
to. Otherwise Notion may omit relation schema or relation values from API responses.

## 3. Find the data source ID

Use the Notion UI's "Copy data source ID" action or extract it from the database URL.

## 4. Create the required properties

Required:

| Workflow field | Recommended Notion type | Notes |
| --- | --- | --- |
| `title_property` | `title` | Human-readable ticket title |
| `status_property` | `status` or `select` | Dispatch and reconciliation read from here |
| `data_source_id` | n/a | Target data source ID |

Optional:

| Workflow field | Recommended type | Fallback when omitted |
| --- | --- | --- |
| `identifier_property` | `rich_text`, `title`, `unique_id`, `number`, `select`, `status`, or string/number `formula` | short page ID |
| `description_property` | `rich_text` | `null` |
| `priority_property` | `number`, `select`, `status`, or number/string `formula` | `null` |
| `labels_property` | `multi_select` or `select` | `[]` |
| `blocked_by_property` | `relation` | `[]` |

## 5. Recommended statuses

Recommended active states:

- `Todo`
- `In Progress`

Recommended lifecycle write-back states:

- `claim_state`: `In Progress`
- `handoff_states`: `In Review`, `Review`
- `blocked_state`: `Needs decision`

Recommended terminal states:

- `Done`
- `Closed`
- `Canceled`
- `Cancelled`
- `Duplicate`

## 6. Example WORKFLOW.md

```md
---
tracker:
  kind: notion
  api_key: $NOTION_API_KEY
  data_source_id: "your-notion-data-source-id"
  active_states: [Todo, In Progress]
  claim_state: In Progress
  handoff_states: [In Review, Review]
  blocked_state: Needs decision
  require_claim_before_agent: true
  terminal_states: [Done, Closed, Canceled, Cancelled, Duplicate]

  title_property: Name
  status_property: Status
  identifier_property: Key
  description_property: Description
  priority_property: Priority
  labels_property: Labels
  blocked_by_property: Blocked by

workspace:
  root: ~/symphony-workspaces/your-repo

hooks:
  after_create: |
    git clone git@github.com:your-org/your-repo.git .
    pnpm install

codex:
  command: codex --config shell_environment_policy.inherit=all app-server
  approval_policy: on-request
  turn_sandbox_policy:
    type: workspaceWrite
    writableRoots:
      - "{{ workspace.path }}"
      - "{{ workspace.git_dir }}"
    networkAccess: true
---

You are working on Notion issue {{ issue.identifier }}.
Implement the task and run validation. When the PR is ready for review, call `symphony_handoff`
with the PR URL, head SHA, validation summary, and residual risks.
```

Codex keeps `.git` read-only in `workspaceWrite` even when it is listed in `writableRoots`. Keep
`approval_policy: on-request` when the task must create branches or commits, and have the agent
request a narrow sandbox escalation for the required Git command. The current high-trust Symphony
client auto-approves every approval request it recognizes and does not enforce a Git-only or
command-kind allowlist. The rest of the turn remains in `workspaceWrite`; use this posture only for trusted
ticket input, workflow instructions, and credentials.

## 7. Lifecycle write-back

The Notion adapter owns status lifecycle writes. Agents should not make raw Notion status REST
calls from the workflow prompt.

### Claim

When Symphony dispatches a Notion task and `require_claim_before_agent` is true, it validates
`claim_state` against the data source schema and writes that exact `status` or `select` option
before starting the Codex app-server session. If the write or read-back fails, Codex is not
started; Symphony surfaces `tracker_claim_failed` in logs, dashboard state, and the JSON API.

### Handoff

When repository-owned workflow checks say the PR is ready, call the injected tool:

```json
{
  "ready_for_review": true,
  "pr_url": "https://github.com/your-org/your-repo/pull/123",
  "pr_number": "123",
  "head_sha": "abc123",
  "validation_summary": "pnpm test, pnpm typecheck, pnpm lint passed",
  "risks": "No known residual risks"
}
```

Symphony selects the first configured exact match from `handoff_states`, writes it to Notion, and
suppresses continuation after the successful tool call. It never moves tickets to `Done`, `Closed`,
or another terminal state unless your workflow explicitly instructs the agent to do so through a
separate mechanism.

If no configured handoff option exists, Symphony reports a validation error listing available
Notion options. If the handoff status write fails, Symphony pauses automatic continuation and
surfaces `tracker_handoff_failed` for operator action instead of burning another Codex turn.

### Blocker questions

When the task is not implementation-ready, call the injected tool:

```json
{
  "title": "Blocked: clarification needed",
  "details": "The task is missing concrete acceptance criteria.",
  "questions": [
    "Which user flow should this change affect?",
    "What observable validation proves this is done?"
  ]
}
```

Symphony writes a Notion page comment first, then moves the task to the configured
`blocked_state`. If Notion rejects the comments endpoint with HTTP 403, Symphony falls back to
appending the blocker questions to the page body before changing status. If both question write
paths fail, or if the status write fails, Symphony suppresses further automatic progress and
surfaces the exact failure for operator action. This keeps raw tasks from burning repeated Codex
turns without a retrievable question trail in Notion.

Symphony also performs a preflight blocker check before launching Codex: if the Notion page has no
usable `description_property` value, no usable page body/comment context, and `blocked_state` is
configured, Symphony writes default clarification questions and moves the task to `blocked_state`
immediately. It ignores Symphony's own previous default blocker template when deciding whether the
ticket has usable context. If body/comments contain a human answer, the task still runs through the
normal Codex agent path even when the description property itself is empty.

If page body or comment reads are unavailable, this preflight check is conservative and does not
auto-block solely from the empty description property. The agent can then use the injected ticket
tools, surface degraded tracker mode, and decide whether to ask more questions with
`symphony_block`.

### Ticket context and notes

When the Notion adapter can read a page, Symphony injects:

- `symphony_ticket_read`: returns the current issue state snapshot, page body entries, readable
  comments, and any unavailable context sources.
- `symphony_ticket_note`: appends a plain-text/Markdown note to the ticket. It writes a Notion page
  comment first and falls back to appending a page-body paragraph when comment insert is forbidden
  with HTTP 403.

Use these tools for ordinary checkpoints, remaining non-blocking questions, validation notes, branch
and PR references, and context refreshes. Use `symphony_block` only when the run should move the
task to `blocked_state` and stop automatic continuation.

Set `polling.issue_comments_between_turns: true` to make context refresh automatic at safe turn
boundaries. Symphony snapshots existing comments before the first turn, then re-reads the ticket
after each completed turn and includes only new comments in the next continuation prompt on the
same Codex thread. It does not inject input into an already running turn. Use
`polling.issue_comment_ignored_authors` for the Notion integration name that writes Symphony's own
checkpoint comments so those notes are not echoed back to the agent.

### Comments

Comments are optional checkpointing for ordinary progress, but `symphony_block` must leave
retrievable questions in the ticket before moving status. Enable Notion comment read/insert
capability for the integration token used by `NOTION_API_KEY` when available; otherwise the adapter
records unavailable sources and falls back to appending writable notes/questions to the page body
where supported.

Example:

```yaml
polling:
  interval_ms: 30000
  issue_comments_between_turns: true
  issue_comment_ignored_authors: [Hermes_Connectio]
```

## 8. Operational notes

- `claim_state` and `handoff_states` must exactly match Notion option names.
- `status_property` may be either Notion `status` or `select`.
- Vercel, deploy, or CI statuses are workflow evidence only; Symphony lifecycle readiness is driven
  by the structured handoff tool.
- Normal worker exit without handoff can still continue while the ticket stays active, but repeated
  exits with unchanged evidence are held as `no_progress_or_handoff_missing`.

## 9. MVP limitations

- the adapter reads from exactly one Notion data source
- `branchName` is always `null`
- priority mapping is heuristic for select/status labels
- blocker hydration is best-effort and depends on relation access
- linked data sources are not supported by the Notion API; share the original source instead

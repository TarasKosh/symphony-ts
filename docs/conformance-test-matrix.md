# Symphony Conformance Test Matrix

This matrix maps `SPEC.upstream.md` Section 17 conformance requirements to the
current automated test suite in this repository.

## 17.1 Workflow and Config Parsing

- `tests/config/workflow-loader.test.ts`
- `tests/config/config-resolver.test.ts`
- `tests/config/workflow-watch.test.ts`
- `tests/agent/prompt-builder.test.ts`
- `tests/capabilities/external-command.test.ts`

Covered behaviors include workflow path precedence, missing and invalid
workflow errors, defaults, `$VAR` resolution, `~` expansion, strict prompt
rendering, and last-known-good reload behavior.
External-command coverage adds safe basename and closed-schema validation,
boundary descriptors, Windows executable/timeout behavior, and sanitized
deterministic/transient classification.

## 17.2 Workspace Manager and Safety

- `tests/workspace/path-safety.test.ts`
- `tests/workspace/workspace-manager.test.ts`
- `tests/workspace/hooks.test.ts`
- `tests/agent/runner.test.ts`

Covered behaviors include deterministic workspace paths, create/reuse rules,
safe rejection of invalid paths, hook lifecycle behavior, workspace cwd
validation, and cleanup of temporary workspace artifacts before each run.
Boundary preflight coverage proves same-invocation hook ordering, marker
ownership, launch-versus-timeout classification, byte-for-byte no-op scripts,
and newly-created empty-workspace recovery.

## 17.3 Issue Tracker Client

- `tests/tracker/linear-client.test.ts`
- `tests/tracker/linear-normalize.test.ts`
- `tests/tracker/notion-client.test.ts`
- `tests/tracker/notion-normalize.test.ts`
- `tests/tracker/adapters.test.ts`

Covered behaviors include active-state candidate fetch, `slugId` project
filtering, data-source query filtering, empty-state short-circuiting,
pagination, blockers and label normalization, state refresh by GraphQL ID list
and Notion page ID, typed request/payload error mapping, and adapter registry
selection across Linear and Notion. Notion lifecycle write-back tests cover
`status` and `select` status updates plus missing configured option errors.

## 17.4 Orchestrator Dispatch, Reconciliation, and Retry

- `tests/orchestrator/core.test.ts`
- `tests/orchestrator/runtime-host.test.ts`
- `tests/logging/runtime-snapshot.test.ts`
- `tests/logging/session-metrics.test.ts`

Covered behaviors include dispatch ordering, blocker eligibility, state
reconciliation, stop and cleanup rules, continuation and failure retry
behavior, lifecycle claim blocking before worker spawn, structured handoff
continuation suppression, no-progress holds, backoff capping, stall handling,
slot exhaustion, and runtime snapshot contents.
It also covers command capability holds and backoff, preflight claim deferral,
explicit retry isolation, concurrent-dispatch reservation, held-issue
reconciliation, and sanitized hold metadata.

## 17.5 Coding-Agent App-Server Client

- `tests/codex/app-server-client.test.ts`
- `tests/codex/linear-graphql-tool.test.ts`
- `tests/agent/runner.test.ts`

Covered behaviors include `bash -lc` launch semantics, startup handshake,
policy payloads, read and turn timeouts, stdout buffering, stderr handling,
approval and user-input flows, usage and rate-limit extraction, unsupported
tool handling, structured `symphony_handoff`, and the optional
`linear_graphql` dynamic tool extension.
Agent-boundary tests execute probes through the same fake app-server instance
and assert that failures close the server before `thread/start` or
`turn/start`.

## 17.6 Observability

- `tests/logging/structured-logger.test.ts`
- `tests/logging/fields.test.ts`
- `tests/logging/session-metrics.test.ts`
- `tests/logging/runtime-snapshot.test.ts`
- `tests/observability/dashboard-server.test.ts`

Covered behaviors include operator-visible validation failures via runtime
surfaces, structured log context fields, sink failure isolation, token and
rate-limit aggregation, and the operator dashboard APIs.

## 17.7 CLI and Host Lifecycle

- `tests/cli/main.test.ts`
- `tests/cli/runtime-integration.test.ts`
- `tests/orchestrator/runtime-host.test.ts`
- `tests/observability/dashboard-server.test.ts`

Covered behaviors include positional workflow path handling, default
`./WORKFLOW.md` loading, missing-path failures, startup failure surfacing,
normal shutdown success, abnormal exit handling, `--port` wiring, and refresh
driven host lifecycle behavior.
The runtime integration suite also covers an opt-in missing hook command from
workflow parsing through operator hold, structured diagnostics, and an
unexecuted hook body.

## Validation Command

Run the full matrix with:

```bash
pnpm test
pnpm lint
```

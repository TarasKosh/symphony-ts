import type {
  CodexRateLimits,
  CodexTotals,
  OrchestratorState,
} from "../domain/model.js";
import { getAggregateSecondsRunning } from "./session-metrics.js";

export interface RuntimeSnapshotRunningRow {
  issue_id: string;
  issue_identifier: string;
  state: string;
  session_id: string | null;
  turn_count: number;
  last_event: string | null;
  last_message: string | null;
  started_at: string;
  last_event_at: string | null;
  tokens: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

export interface RuntimeSnapshotRetryRow {
  issue_id: string;
  issue_identifier: string | null;
  attempt: number;
  due_at: string;
  error: string | null;
  capability_failure?: RuntimeSnapshotCapabilityFailure;
}

export interface RuntimeSnapshotHoldRow {
  issue_id: string;
  issue_identifier: string | null;
  attempt: number;
  held_at: string;
  error: string;
  capability_failure?: RuntimeSnapshotCapabilityFailure;
}

export interface RuntimeSnapshotCapabilityFailure {
  code: string;
  capability: string;
  command: string;
  boundary: string;
  remediation: string;
}

export interface RuntimeSnapshot {
  generated_at: string;
  counts: {
    running: number;
    retrying: number;
    held: number;
  };
  running: RuntimeSnapshotRunningRow[];
  retrying: RuntimeSnapshotRetryRow[];
  holds: RuntimeSnapshotHoldRow[];
  codex_totals: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    seconds_running: number;
  };
  rate_limits: CodexRateLimits;
}

export function buildRuntimeSnapshot(
  state: OrchestratorState,
  options?: {
    now?: Date;
  },
): RuntimeSnapshot {
  const now = options?.now ?? new Date();

  const running = Object.values(state.running)
    .slice()
    .sort((left, right) =>
      left.identifier.localeCompare(right.identifier, "en"),
    )
    .map((entry) => ({
      issue_id: entry.issue.id,
      issue_identifier: entry.identifier,
      state: entry.issue.state,
      session_id: entry.sessionId,
      turn_count: entry.turnCount,
      last_event: entry.lastCodexEvent,
      last_message: entry.lastCodexMessage,
      started_at: entry.startedAt,
      last_event_at: entry.lastCodexTimestamp,
      tokens: {
        input_tokens: entry.codexInputTokens,
        output_tokens: entry.codexOutputTokens,
        total_tokens: entry.codexTotalTokens,
      },
    }));

  const retrying = Object.values(state.retryAttempts)
    .slice()
    .sort((left, right) => left.dueAtMs - right.dueAtMs)
    .map((entry) => ({
      issue_id: entry.issueId,
      issue_identifier: entry.identifier,
      attempt: entry.attempt,
      due_at: new Date(entry.dueAtMs).toISOString(),
      error: entry.error,
      ...(entry.capabilityFailure === undefined
        ? {}
        : { capability_failure: { ...entry.capabilityFailure } }),
    }));

  const holds = Object.values(state.operatorHolds)
    .slice()
    .sort((left, right) => left.heldAtMs - right.heldAtMs)
    .map((entry) => ({
      issue_id: entry.issueId,
      issue_identifier: entry.identifier,
      attempt: entry.attempt,
      held_at: new Date(entry.heldAtMs).toISOString(),
      error: entry.error,
      ...(entry.capabilityFailure === undefined
        ? {}
        : { capability_failure: { ...entry.capabilityFailure } }),
    }));

  return {
    generated_at: now.toISOString(),
    counts: {
      running: running.length,
      retrying: retrying.length,
      held: holds.length,
    },
    running,
    retrying,
    holds,
    codex_totals: toSnapshotCodexTotals(
      state.codexTotals,
      getAggregateSecondsRunning(state, now),
    ),
    rate_limits: state.codexRateLimits,
  };
}

function toSnapshotCodexTotals(
  totals: CodexTotals,
  secondsRunning: number,
): RuntimeSnapshot["codex_totals"] {
  return {
    input_tokens: totals.inputTokens,
    output_tokens: totals.outputTokens,
    total_tokens: totals.totalTokens,
    seconds_running: secondsRunning,
  };
}

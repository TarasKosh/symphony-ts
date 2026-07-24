import { describe, expect, it } from "vitest";

import {
  type RunningEntry,
  createEmptyLiveSession,
  createInitialOrchestratorState,
} from "../../src/domain/model.js";
import { buildRuntimeSnapshot } from "../../src/logging/runtime-snapshot.js";

describe("runtime snapshot", () => {
  it("builds a sorted state snapshot with live runtime totals", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.codexTotals.inputTokens = 100;
    state.codexTotals.outputTokens = 50;
    state.codexTotals.totalTokens = 150;
    state.codexTotals.secondsRunning = 12.5;
    state.codexRateLimits = {
      requestsRemaining: 7,
      tokensRemaining: 700,
    };
    state.running["issue-2"] = createRunningEntry({
      issueId: "issue-2",
      identifier: "ZZZ-2",
      startedAt: "2026-03-06T10:00:03.000Z",
      sessionId: "thread-z-turn-1",
      lastCodexEvent: "notification",
      lastCodexTimestamp: "2026-03-06T10:00:04.000Z",
      lastCodexMessage: "Working",
      turnCount: 2,
      codexInputTokens: 12,
      codexOutputTokens: 8,
      codexTotalTokens: 20,
    });
    state.running["issue-1"] = createRunningEntry({
      issueId: "issue-1",
      identifier: "AAA-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Finished",
      turnCount: 1,
      codexInputTokens: 30,
      codexOutputTokens: 20,
      codexTotalTokens: 50,
    });
    state.retryAttempts["issue-3"] = {
      issueId: "issue-3",
      identifier: "MMM-3",
      attempt: 2,
      dueAtMs: Date.parse("2026-03-06T10:00:20.000Z"),
      timerHandle: null,
      error: "no available orchestrator slots",
      capabilityFailure: {
        code: "required_command_capability_transient",
        capability: "external_command",
        command: "rg",
        boundary: "agent",
        remediation:
          "Retry the issue after the command execution environment is available.",
      },
    };
    state.operatorHolds["issue-4"] = {
      issueId: "issue-4",
      identifier: "HOLD-4",
      attempt: 3,
      heldAtMs: Date.parse("2026-03-06T10:00:07.000Z"),
      error:
        "required_command_not_found: required command rg is unavailable at agent",
      capabilityFailure: {
        code: "required_command_not_found",
        capability: "external_command",
        command: "rg",
        boundary: "agent",
        remediation:
          "Install rg in the agent execution environment, then explicitly retry the held issue.",
      },
    };

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.generated_at).toBe("2026-03-06T10:00:10.000Z");
    expect(snapshot.counts).toEqual({
      running: 2,
      retrying: 1,
      held: 1,
    });
    expect(snapshot.running.map((row) => row.issue_identifier)).toEqual([
      "AAA-1",
      "ZZZ-2",
    ]);
    expect(snapshot.running[0]).toMatchObject({
      issue_id: "issue-1",
      issue_identifier: "AAA-1",
      state: "In Progress",
      session_id: "thread-a-turn-1",
      turn_count: 1,
      last_event: "turn_completed",
      last_message: "Finished",
      started_at: "2026-03-06T10:00:00.000Z",
      last_event_at: "2026-03-06T10:00:05.000Z",
      tokens: {
        input_tokens: 30,
        output_tokens: 20,
        total_tokens: 50,
      },
    });
    expect(snapshot.retrying).toEqual([
      {
        issue_id: "issue-3",
        issue_identifier: "MMM-3",
        attempt: 2,
        due_at: "2026-03-06T10:00:20.000Z",
        error: "no available orchestrator slots",
        capability_failure: {
          code: "required_command_capability_transient",
          capability: "external_command",
          command: "rg",
          boundary: "agent",
          remediation:
            "Retry the issue after the command execution environment is available.",
        },
      },
    ]);
    expect(snapshot.holds).toEqual([
      {
        issue_id: "issue-4",
        issue_identifier: "HOLD-4",
        attempt: 3,
        held_at: "2026-03-06T10:00:07.000Z",
        error:
          "required_command_not_found: required command rg is unavailable at agent",
        capability_failure: {
          code: "required_command_not_found",
          capability: "external_command",
          command: "rg",
          boundary: "agent",
          remediation:
            "Install rg in the agent execution environment, then explicitly retry the held issue.",
        },
      },
    ]);
    expect(snapshot.codex_totals).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      seconds_running: 29.5,
    });
    expect(snapshot.rate_limits).toEqual({
      requestsRemaining: 7,
      tokensRemaining: 700,
    });
  });
});

function createRunningEntry(input: {
  issueId: string;
  identifier: string;
  startedAt: string;
  sessionId: string;
  lastCodexEvent: string;
  lastCodexTimestamp: string;
  lastCodexMessage: string;
  turnCount: number;
  codexInputTokens: number;
  codexOutputTokens: number;
  codexTotalTokens: number;
}): RunningEntry {
  return {
    ...createEmptyLiveSession(),
    sessionId: input.sessionId,
    threadId: input.sessionId.split("-turn-")[0] ?? null,
    turnId: input.sessionId.split("-").at(-1) ?? null,
    lastCodexEvent: input.lastCodexEvent,
    lastCodexTimestamp: input.lastCodexTimestamp,
    lastCodexMessage: input.lastCodexMessage,
    turnCount: input.turnCount,
    codexInputTokens: input.codexInputTokens,
    codexOutputTokens: input.codexOutputTokens,
    codexTotalTokens: input.codexTotalTokens,
    issue: {
      id: input.issueId,
      identifier: input.identifier,
      title: input.identifier,
      description: null,
      priority: null,
      state: "In Progress",
      branchName: null,
      url: null,
      labels: [],
      blockedBy: [],
      createdAt: null,
      updatedAt: null,
    },
    identifier: input.identifier,
    retryAttempt: null,
    startedAt: input.startedAt,
    workerHandle: null,
    monitorHandle: null,
  };
}

import { describe, expect, it, vi } from "vitest";

import type { ResolvedWorkflowConfig } from "../../src/config/types.js";
import type { Issue } from "../../src/domain/model.js";
import { ERROR_CODES } from "../../src/errors/codes.js";
import {
  OrchestratorCore,
  type OrchestratorCoreOptions,
  computeFailureRetryDelayMs,
  sortIssuesForDispatch,
} from "../../src/orchestrator/core.js";
import type {
  IssueStateSnapshot,
  IssueTracker,
} from "../../src/tracker/tracker.js";

describe("orchestrator core", () => {
  it("sorts dispatch candidates by priority, age, and identifier", () => {
    const issues = sortIssuesForDispatch([
      createIssue({
        id: "3",
        identifier: "ISSUE-3",
        priority: 2,
        createdAt: "2026-03-05T00:00:00.000Z",
      }),
      createIssue({
        id: "2",
        identifier: "ISSUE-2",
        priority: 1,
        createdAt: "2026-03-04T00:00:00.000Z",
      }),
      createIssue({
        id: "1",
        identifier: "ISSUE-1",
        priority: 1,
        createdAt: "2026-03-03T00:00:00.000Z",
      }),
    ]);

    expect(issues.map((issue) => issue.id)).toEqual(["1", "2", "3"]);
  });

  it("rejects Todo issues with non-terminal blockers and allows terminal blockers", () => {
    const orchestrator = createOrchestrator();

    expect(
      orchestrator.isDispatchEligible(
        createIssue({
          id: "todo-1",
          identifier: "ISSUE-1",
          state: "Todo",
          blockedBy: [{ id: "b1", identifier: "B-1", state: "In Progress" }],
        }),
      ),
    ).toBe(false);

    expect(
      orchestrator.isDispatchEligible(
        createIssue({
          id: "todo-2",
          identifier: "ISSUE-2",
          state: "Todo",
          blockedBy: [{ id: "b2", identifier: "B-2", state: "Done" }],
        }),
      ),
    ).toBe(true);
  });

  it("dispatches eligible issues on poll tick until slots are exhausted", async () => {
    const orchestrator = createOrchestrator({
      tracker: createTracker({
        candidates: [
          createIssue({ id: "1", identifier: "ISSUE-1", priority: 1 }),
          createIssue({ id: "2", identifier: "ISSUE-2", priority: 2 }),
        ],
      }),
    });

    const result = await orchestrator.pollTick();

    expect(result.validation.ok).toBe(true);
    expect(result.dispatchedIssueIds).toEqual(["1", "2"]);
    expect(Object.keys(orchestrator.getState().running)).toEqual(["1", "2"]);
    expect([...orchestrator.getState().claimed]).toEqual(["1", "2"]);
  });

  it("updates running issue state during reconciliation", async () => {
    const tracker = createTracker({
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Review" }],
    });
    const orchestrator = createOrchestrator({ tracker });

    await orchestrator.pollTick();
    const result = await orchestrator.pollTick();

    expect(result.stopRequests).toEqual([]);
    expect(orchestrator.getState().running["1"]?.issue.state).toBe("In Review");
  });

  it("requests stop without cleanup when a running issue becomes non-active", async () => {
    const stopRequests: unknown[] = [];
    const tracker = createTracker({
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "Backlog" }],
    });
    const orchestrator = createOrchestrator({
      tracker,
      stopRunningIssue: async (input) => {
        stopRequests.push(input);
      },
    });

    await orchestrator.pollTick();
    const result = await orchestrator.pollTick();

    expect(result.stopRequests).toEqual([
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        cleanupWorkspace: false,
        reason: "inactive_state",
      },
    ]);
    expect(stopRequests).toHaveLength(1);
  });

  it("requests stop with cleanup when a running issue becomes terminal", async () => {
    const tracker = createTracker({
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "Done" }],
    });
    const orchestrator = createOrchestrator({ tracker });

    await orchestrator.pollTick();
    const result = await orchestrator.pollTick();

    expect(result.stopRequests).toEqual([
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        cleanupWorkspace: true,
        reason: "terminal_state",
      },
    ]);
  });

  it("requests stop when reconciliation no longer returns a running issue", async () => {
    const tracker = createTracker({
      statesById: [],
    });
    const orchestrator = createOrchestrator({ tracker });

    await orchestrator.pollTick();
    const result = await orchestrator.pollTick();

    expect(result.stopRequests).toEqual([
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        cleanupWorkspace: false,
        reason: "inactive_state",
      },
    ]);
  });

  it("treats reconciliation with no running issues as a no-op", async () => {
    const tracker = createTracker({
      candidates: [],
      statesById: [],
    });
    const orchestrator = createOrchestrator({ tracker });

    const result = await orchestrator.pollTick();

    expect(result.stopRequests).toEqual([]);
    expect(result.reconciliationFetchFailed).toBe(false);
  });

  it("schedules continuation retry after a normal worker exit", async () => {
    const timers = createFakeTimerScheduler();
    const orchestrator = createOrchestrator({ timerScheduler: timers });

    await orchestrator.pollTick();
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:00:05.000Z"),
    });

    expect(retryEntry).toMatchObject({
      issueId: "1",
      identifier: "ISSUE-1",
      attempt: 1,
      error: null,
      dueAtMs: Date.parse("2026-03-06T00:00:06.000Z"),
    });
    expect(timers.scheduled[0]?.delayMs).toBe(1_000);
  });

  it("blocks dispatch before worker spawn when tracker claim write-back fails", async () => {
    const timers = createFakeTimerScheduler();
    const spawnCalls: string[] = [];
    const tracker = {
      ...createTracker({
        candidates: [
          createIssue({ id: "1", identifier: "ISSUE-1", state: "Todo" }),
        ],
      }),
      claimIssue: async () => {
        throw new Error("Notion write denied");
      },
      handoffIssue: async () => {
        throw new Error("not used");
      },
    };
    const orchestrator = new OrchestratorCore({
      config: createConfig(),
      tracker,
      timerScheduler: timers,
      now: () => new Date("2026-03-06T00:00:05.000Z"),
      spawnWorker: async ({ issue }) => {
        spawnCalls.push(issue.id);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
    });

    const result = await orchestrator.pollTick();

    expect(result.dispatchedIssueIds).toEqual([]);
    expect(result.lifecycleWriteBlockers).toEqual([
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        operation: "claim",
        error: "tracker_claim_failed: Notion write denied",
      },
    ]);
    expect(spawnCalls).toEqual([]);
    expect(orchestrator.getState().retryAttempts["1"]?.error).toBe(
      "tracker_claim_failed: Notion write denied",
    );
    expect(timers.scheduled[0]?.delayMs).toBe(10_000);
  });

  it("suppresses continuation after successful structured handoff", async () => {
    const timers = createFakeTimerScheduler();
    const orchestrator = createOrchestrator({ timerScheduler: timers });

    await orchestrator.pollTick();
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      handoff: {
        status: "succeeded",
        metadata: {
          readyForReview: true,
          prUrl: "https://github.com/acme/repo/pull/12",
          prNumber: "12",
          headSha: "abc123",
          validationSummary: "pnpm test passed",
          risks: null,
        },
        result: {
          issue: { id: "1", identifier: "ISSUE-1", state: "In Review" },
          state: "In Review",
        },
      },
    });

    expect(retryEntry).toBeNull();
    expect(orchestrator.getState().retryAttempts).toEqual({});
    expect([...orchestrator.getState().claimed]).toEqual([]);
    expect(timers.scheduled).toEqual([]);
  });

  it("holds for operator action without scheduling continuation when handoff write-back fails", async () => {
    const timers = createFakeTimerScheduler();
    const orchestrator = createOrchestrator({ timerScheduler: timers });

    await orchestrator.pollTick();
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      handoff: {
        status: "failed",
        error: "Notion status write failed",
        metadata: {
          readyForReview: true,
          prUrl: "https://github.com/acme/repo/pull/12",
          prNumber: "12",
          headSha: "abc123",
          validationSummary: "pnpm test passed",
          risks: null,
        },
      },
    });

    expect(retryEntry).toMatchObject({
      issueId: "1",
      identifier: "ISSUE-1",
      attempt: 1,
      error: "tracker_handoff_failed: Notion status write failed",
      heldAtMs: Date.parse("2026-03-06T00:00:05.000Z"),
    });
    expect(orchestrator.getState().retryAttempts["1"]).toBeUndefined();
    expect(orchestrator.getState().operatorHolds["1"]).toEqual(retryEntry);
    expect(timers.scheduled).toEqual([]);
  });

  it("suppresses continuation after successful structured blocker write-back", async () => {
    const timers = createFakeTimerScheduler();
    const orchestrator = createOrchestrator({ timerScheduler: timers });

    await orchestrator.pollTick();
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      blocker: {
        status: "succeeded",
        metadata: {
          title: "Blocked: task needs implementation context",
          details: "Missing acceptance criteria.",
          questions: ["What should change?"],
        },
        result: {
          issue: { id: "1", identifier: "ISSUE-1", state: "Blocked" },
          state: "Blocked",
        },
      },
    });

    expect(retryEntry).toBeNull();
    expect(orchestrator.getState().retryAttempts).toEqual({});
    expect([...orchestrator.getState().claimed]).toEqual([]);
    expect(timers.scheduled).toEqual([]);
  });

  it("holds for operator action without scheduling continuation when blocker write-back fails", async () => {
    const timers = createFakeTimerScheduler();
    const orchestrator = createOrchestrator({ timerScheduler: timers });

    await orchestrator.pollTick();
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      blocker: {
        status: "failed",
        error: "Notion comment write failed",
        metadata: {
          title: "Blocked",
          details: null,
          questions: ["What should change?"],
        },
      },
    });

    expect(retryEntry).toMatchObject({
      issueId: "1",
      identifier: "ISSUE-1",
      attempt: 1,
      error: "tracker_block_failed: Notion comment write failed",
      heldAtMs: Date.parse("2026-03-06T00:00:05.000Z"),
    });
    expect(orchestrator.getState().retryAttempts["1"]).toBeUndefined();
    expect(orchestrator.getState().operatorHolds["1"]).toEqual(retryEntry);
    expect(timers.scheduled).toEqual([]);
  });

  it("holds for operator action when repeated normal exits make no progress and omit handoff", async () => {
    const timers = createFakeTimerScheduler();
    const orchestrator = createOrchestrator({ timerScheduler: timers });

    await orchestrator.pollTick();
    const firstRetry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      progressSignature: "same-status-no-pr",
    });
    expect(firstRetry?.error).toBeNull();

    await orchestrator.onRetryTimer("1");
    const secondRetry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      progressSignature: "same-status-no-pr",
    });

    expect(secondRetry).toMatchObject({
      issueId: "1",
      identifier: "ISSUE-1",
      attempt: 2,
      error:
        "no_progress_or_handoff_missing: worker exited normally without structured handoff and without new tracker or PR evidence",
      heldAtMs: Date.parse("2026-03-06T00:00:05.000Z"),
    });
    expect(orchestrator.getState().retryAttempts["1"]).toBeUndefined();
    expect(orchestrator.getState().operatorHolds["1"]).toEqual(secondRetry);
    expect(timers.scheduled).toHaveLength(1);
  });

  it("schedules exponential backoff retries for abnormal exits and caps the delay", async () => {
    const timers = createFakeTimerScheduler();
    const orchestrator = createOrchestrator({
      timerScheduler: timers,
      config: createConfig({
        agent: { maxRetryBackoffMs: 30_000 },
      }),
    });

    await orchestrator.pollTick();
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "turn failed",
    });

    expect(retryEntry).toMatchObject({
      issueId: "1",
      identifier: "ISSUE-1",
      attempt: 1,
      error: "worker exited: turn failed",
    });
    expect(timers.scheduled[0]?.delayMs).toBe(10_000);
    expect(computeFailureRetryDelayMs(3, 30_000)).toBe(30_000);
  });

  it("places deterministic GitHub capability failures on operator hold without a retry timer", async () => {
    const timers = createFakeTimerScheduler();
    const orchestrator = createOrchestrator({ timerScheduler: timers });

    await orchestrator.pollTick();
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      errorCode: ERROR_CODES.githubAuthInvalid,
      reason:
        "Required GitHub capability failed: gh authentication is invalid or expired.",
    });

    expect(retryEntry).toMatchObject({
      issueId: "1",
      attempt: 1,
      heldAtMs: Date.parse("2026-03-06T00:00:05.000Z"),
      error:
        "github_auth_invalid: worker exited: Required GitHub capability failed: gh authentication is invalid or expired.",
    });
    expect(orchestrator.getState().retryAttempts["1"]).toBeUndefined();
    expect(orchestrator.getState().operatorHolds["1"]).toEqual(retryEntry);
    expect(timers.scheduled).toEqual([]);
  });

  it("suppresses polling while held and retries only the selected issue on explicit request", async () => {
    const timers = createFakeTimerScheduler();
    const orchestrator = createOrchestrator({ timerScheduler: timers });

    await orchestrator.pollTick();
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      errorCode: ERROR_CODES.githubAuthInvalid,
      reason: "authentication failed",
    });

    const unchangedPoll = await orchestrator.pollTick();
    expect(unchangedPoll.dispatchedIssueIds).toEqual([]);
    expect(Object.keys(orchestrator.getState().running)).toEqual([]);

    const retry = await orchestrator.retryOperatorHold("1");
    expect(retry).toEqual({
      dispatched: true,
      released: false,
      hold: null,
    });
    expect(orchestrator.getState().operatorHolds["1"]).toBeUndefined();
    expect(orchestrator.getState().running["1"]?.retryAttempt).toBe(1);
    expect(timers.scheduled).toEqual([]);
  });

  it("uses normal failure backoff for transient GitHub capability failures", async () => {
    const timers = createFakeTimerScheduler();
    const orchestrator = createOrchestrator({ timerScheduler: timers });

    await orchestrator.pollTick();
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      errorCode: ERROR_CODES.githubCapabilityTransient,
      reason:
        "Required GitHub capability could not be verified due to a transient GitHub CLI or network failure.",
    });

    expect(retryEntry).toMatchObject({
      issueId: "1",
      attempt: 1,
      error: expect.stringContaining("github_capability_transient"),
    });
    expect(timers.scheduled).toEqual([
      expect.objectContaining({ delayMs: 10_000 }),
    ]);
  });

  it.each([
    ERROR_CODES.requiredCommandNotFound,
    ERROR_CODES.requiredCommandExecutionDenied,
  ])(
    "places deterministic external-command failure %s on a timer-free operator hold",
    async (code) => {
      const timers = createFakeTimerScheduler();
      const orchestrator = createOrchestrator({ timerScheduler: timers });
      const capabilityFailure = createCommandCapabilityFailure(code);

      await orchestrator.pollTick();
      const hold = orchestrator.onWorkerExit({
        issueId: "1",
        outcome: "abnormal",
        reason: `${code}: required command rg is unavailable at agent`,
        capabilityFailure,
      });

      expect(hold).toMatchObject({
        issueId: "1",
        identifier: "ISSUE-1",
        attempt: 1,
        capabilityFailure,
      });
      expect(orchestrator.getState().operatorHolds["1"]).toEqual(hold);
      expect(orchestrator.getState().retryAttempts["1"]).toBeUndefined();
      expect(timers.scheduled).toEqual([]);
    },
  );

  it("uses normal failure backoff and retains sanitized metadata for transient command checks", async () => {
    const timers = createFakeTimerScheduler();
    const orchestrator = createOrchestrator({ timerScheduler: timers });
    const capabilityFailure = createCommandCapabilityFailure(
      ERROR_CODES.requiredCommandCapabilityTransient,
    );

    await orchestrator.pollTick();
    const retry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason:
        "required_command_capability_transient: command availability could not be verified",
      capabilityFailure,
    });

    expect(retry).toMatchObject({
      issueId: "1",
      attempt: 1,
      capabilityFailure,
    });
    expect(orchestrator.getState().operatorHolds["1"]).toBeUndefined();
    expect(orchestrator.getState().retryAttempts["1"]).toEqual(retry);
    expect(timers.scheduled).toEqual([
      expect.objectContaining({ delayMs: 10_000 }),
    ]);
  });

  it("suppresses polling for held command failures and retries only the selected hold", async () => {
    const timers = createFakeTimerScheduler();
    const issues = [
      createIssue({ id: "1", identifier: "ISSUE-1" }),
      createIssue({ id: "2", identifier: "ISSUE-2" }),
    ];
    const orchestrator = createOrchestrator({
      timerScheduler: timers,
      tracker: createTracker({
        candidates: issues,
        statesById: issues.map((issue) => ({
          id: issue.id,
          identifier: issue.identifier,
          state: "In Progress",
        })),
      }),
      config: createConfig({
        commands: {
          rg: {
            hooks: [],
            agent: true,
            probeArgs: ["--version"],
          },
        },
      }),
    });

    await orchestrator.pollTick();
    for (const issue of issues) {
      orchestrator.onWorkerExit({
        issueId: issue.id,
        outcome: "abnormal",
        reason: "required command unavailable",
        capabilityFailure: createCommandCapabilityFailure(
          ERROR_CODES.requiredCommandNotFound,
        ),
      });
    }

    const holdTwo = orchestrator.getState().operatorHolds["2"];
    const unchangedPoll = await orchestrator.pollTick();
    expect(unchangedPoll.dispatchedIssueIds).toEqual([]);
    expect(Object.keys(orchestrator.getState().running)).toEqual([]);

    await expect(orchestrator.retryOperatorHold("1")).resolves.toEqual({
      dispatched: true,
      released: false,
      hold: null,
    });
    expect(orchestrator.getState().operatorHolds["1"]).toBeUndefined();
    expect(orchestrator.getState().operatorHolds["2"]).toEqual(holdTwo);
    expect(Object.keys(orchestrator.getState().running)).toEqual(["1"]);
    expect(timers.scheduled).toEqual([]);
  });

  it.each([
    ["afterCreate", { hooks: ["afterCreate"], agent: false }],
    ["beforeRun", { hooks: ["beforeRun"], agent: false }],
    ["agent", { hooks: [], agent: true }],
  ] as const)(
    "defers tracker claim until the worker for the %s command boundary",
    async (_boundary, requirement) => {
      const claimIssue = vi.fn(async ({ issue }: { issue: Issue }) => ({
        issue: { id: issue.id, identifier: issue.identifier, state: "Claimed" },
        state: "Claimed",
      }));
      const tracker: IssueTracker = {
        ...createTracker({
          candidates: [
            createIssue({ id: "1", identifier: "ISSUE-1", state: "Todo" }),
          ],
        }),
        claimIssue,
        handoffIssue: vi.fn(),
      };
      const spawnedStates: string[] = [];
      const orchestrator = createOrchestrator({
        tracker,
        config: createConfig({
          commands: {
            rg: {
              ...requirement,
              probeArgs: ["--version"],
            },
          },
        }),
        spawnWorker: async ({ issue }) => {
          spawnedStates.push(issue.state);
          return {
            workerHandle: { pid: 1001 },
            monitorHandle: { ref: "monitor-1" },
          };
        },
      });

      await orchestrator.pollTick();

      expect(claimIssue).not.toHaveBeenCalled();
      expect(spawnedStates).toEqual(["Todo"]);
    },
  );

  it("does not defer tracker claim for late best-effort command boundaries", async () => {
    const claimIssue = vi.fn(async ({ issue }: { issue: Issue }) => ({
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        state: "In Progress",
      },
      state: "In Progress",
    }));
    const tracker: IssueTracker = {
      ...createTracker({
        candidates: [
          createIssue({ id: "1", identifier: "ISSUE-1", state: "Todo" }),
        ],
      }),
      claimIssue,
      handoffIssue: vi.fn(),
    };
    const orchestrator = createOrchestrator({
      tracker,
      config: createConfig({
        commands: {
          rg: {
            hooks: ["afterRun", "beforeRemove"],
            agent: false,
            probeArgs: ["--version"],
          },
        },
      }),
    });

    await orchestrator.pollTick();

    expect(claimIssue).toHaveBeenCalledTimes(1);
  });

  it("reserves a local slot before asynchronous worker spawn completes", async () => {
    const spawnStarted = createDeferred<void>();
    const releaseSpawn = createDeferred<{
      workerHandle: unknown;
      monitorHandle: unknown;
    }>();
    const spawnWorker = vi.fn(async () => {
      spawnStarted.resolve(undefined);
      return await releaseSpawn.promise;
    });
    const orchestrator = createOrchestrator({
      spawnWorker,
      config: createConfig({
        commands: {
          rg: {
            hooks: [],
            agent: true,
            probeArgs: ["--version"],
          },
        },
      }),
    });

    const firstPoll = orchestrator.pollTick();
    await spawnStarted.promise;
    expect(orchestrator.getState().running["1"]).toBeDefined();

    const secondPoll = await orchestrator.pollTick();
    expect(secondPoll.dispatchedIssueIds).toEqual([]);
    expect(spawnWorker).toHaveBeenCalledTimes(1);

    releaseSpawn.resolve({
      workerHandle: { pid: 1001 },
      monitorHandle: { ref: "monitor-1" },
    });
    await firstPoll;
    expect(orchestrator.getState().running["1"]?.workerHandle).toEqual({
      pid: 1001,
    });
  });

  it.each([
    {
      label: "terminal",
      snapshots: [
        { id: "1", identifier: "ISSUE-1", state: "Done" },
      ] satisfies IssueStateSnapshot[],
      cleanup: true,
    },
    {
      label: "non-active",
      snapshots: [
        { id: "1", identifier: "ISSUE-1", state: "Backlog" },
      ] satisfies IssueStateSnapshot[],
      cleanup: false,
    },
    {
      label: "missing",
      snapshots: [] satisfies IssueStateSnapshot[],
      cleanup: false,
    },
  ])(
    "releases a held $label issue and applies terminal-only cleanup",
    async ({ snapshots, cleanup }) => {
      const trackerState = createMutableTracker();
      const cleanupHeldIssue = vi.fn();
      const orchestrator = createOrchestrator({
        tracker: trackerState.tracker,
        cleanupHeldIssue,
      });

      await orchestrator.pollTick();
      orchestrator.onWorkerExit({
        issueId: "1",
        outcome: "abnormal",
        reason: "required command unavailable",
        capabilityFailure: createCommandCapabilityFailure(
          ERROR_CODES.requiredCommandNotFound,
        ),
      });
      trackerState.setCandidates([]);
      trackerState.setSnapshots(snapshots);

      await orchestrator.pollTick();

      expect(orchestrator.getState().operatorHolds["1"]).toBeUndefined();
      expect(orchestrator.getState().claimed.has("1")).toBe(false);
      expect(cleanupHeldIssue).toHaveBeenCalledTimes(cleanup ? 1 : 0);
      if (cleanup) {
        expect(cleanupHeldIssue).toHaveBeenCalledWith({
          issueId: "1",
          issueIdentifier: "ISSUE-1",
        });
      }
    },
  );

  it("keeps an active held issue claimed without redispatch or re-probing", async () => {
    const trackerState = createMutableTracker();
    const spawnWorker = vi.fn(async () => ({
      workerHandle: { pid: 1001 },
      monitorHandle: { ref: "monitor-1" },
    }));
    const orchestrator = createOrchestrator({
      tracker: trackerState.tracker,
      spawnWorker,
    });

    await orchestrator.pollTick();
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "required command unavailable",
      capabilityFailure: createCommandCapabilityFailure(
        ERROR_CODES.requiredCommandNotFound,
      ),
    });
    await orchestrator.pollTick();

    expect(orchestrator.getState().operatorHolds["1"]).toBeDefined();
    expect(orchestrator.getState().claimed.has("1")).toBe(true);
    expect(spawnWorker).toHaveBeenCalledTimes(1);
  });

  it("preserves a selected command hold when explicit retry cannot refresh candidates", async () => {
    const holdTracker = createTracker();
    const tracker: IssueTracker = {
      ...holdTracker,
      fetchCandidateIssues: vi
        .fn()
        .mockResolvedValueOnce([
          createIssue({ id: "1", identifier: "ISSUE-1" }),
        ])
        .mockRejectedValueOnce(
          new Error("tracker response included secret=do-not-log"),
        ),
    };
    const orchestrator = createOrchestrator({ tracker });

    await orchestrator.pollTick();
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "required command unavailable",
      capabilityFailure: createCommandCapabilityFailure(
        ERROR_CODES.requiredCommandNotFound,
      ),
    });
    const originalHold = orchestrator.getState().operatorHolds["1"];

    await expect(orchestrator.retryOperatorHold("1")).resolves.toEqual({
      dispatched: false,
      released: false,
      hold: originalHold,
    });
    expect(orchestrator.getState().operatorHolds["1"]).toBe(originalHold);
    expect(orchestrator.getState().claimed.has("1")).toBe(true);
  });

  it("preserves a selected hold when config becomes invalid before explicit retry", async () => {
    const spawnWorker = vi.fn(async () => ({
      workerHandle: { pid: 1001 },
      monitorHandle: { ref: "monitor-1" },
    }));
    const orchestrator = createOrchestrator({ spawnWorker });

    await orchestrator.pollTick();
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "required command unavailable",
      capabilityFailure: createCommandCapabilityFailure(
        ERROR_CODES.requiredCommandNotFound,
      ),
    });
    const originalHold = orchestrator.getState().operatorHolds["1"];
    const invalidConfig = createConfig();
    invalidConfig.codex.command = " ";
    orchestrator.updateConfig(invalidConfig);

    await expect(orchestrator.retryOperatorHold("1")).resolves.toEqual({
      dispatched: false,
      released: false,
      hold: originalHold,
    });
    expect(orchestrator.getState().operatorHolds["1"]).toBe(originalHold);
    expect(orchestrator.getState().claimed.has("1")).toBe(true);
    expect(spawnWorker).toHaveBeenCalledTimes(1);
  });

  it("releases only the selected hold when it becomes ineligible at retry time", async () => {
    const first = createIssue({ id: "1", identifier: "ISSUE-1" });
    const second = createIssue({ id: "2", identifier: "ISSUE-2" });
    const trackerState = createMutableTracker({
      candidates: [first, second],
      snapshots: [
        { id: "1", identifier: "ISSUE-1", state: "In Progress" },
        { id: "2", identifier: "ISSUE-2", state: "In Progress" },
      ],
    });
    const orchestrator = createOrchestrator({
      tracker: trackerState.tracker,
    });

    await orchestrator.pollTick();
    for (const issue of [first, second]) {
      orchestrator.onWorkerExit({
        issueId: issue.id,
        outcome: "abnormal",
        reason: "required command unavailable",
        capabilityFailure: createCommandCapabilityFailure(
          ERROR_CODES.requiredCommandNotFound,
        ),
      });
    }
    const secondHold = orchestrator.getState().operatorHolds["2"];
    trackerState.setCandidates([
      createIssue({ id: "1", identifier: "ISSUE-1", state: "Backlog" }),
      second,
    ]);

    await expect(orchestrator.retryOperatorHold("1")).resolves.toEqual({
      dispatched: false,
      released: true,
      hold: null,
    });
    expect(orchestrator.getState().operatorHolds["1"]).toBeUndefined();
    expect(orchestrator.getState().claimed.has("1")).toBe(false);
    expect(orchestrator.getState().operatorHolds["2"]).toBe(secondHold);
    expect(orchestrator.getState().claimed.has("2")).toBe(true);
  });

  it("preserves the selected hold when explicit retry has no local slot", async () => {
    const heldIssue = createIssue({ id: "1", identifier: "ISSUE-1" });
    const occupyingIssue = createIssue({ id: "2", identifier: "ISSUE-2" });
    const trackerState = createMutableTracker({
      candidates: [heldIssue],
      snapshots: [
        { id: "1", identifier: "ISSUE-1", state: "In Progress" },
        { id: "2", identifier: "ISSUE-2", state: "In Progress" },
      ],
    });
    const orchestrator = createOrchestrator({
      tracker: trackerState.tracker,
      config: createConfig({
        agent: { maxConcurrentAgents: 1 },
      }),
    });

    await orchestrator.pollTick();
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "required command unavailable",
      capabilityFailure: createCommandCapabilityFailure(
        ERROR_CODES.requiredCommandNotFound,
      ),
    });
    const originalHold = orchestrator.getState().operatorHolds["1"];
    trackerState.setCandidates([occupyingIssue]);
    await orchestrator.pollTick();
    expect(Object.keys(orchestrator.getState().running)).toEqual(["2"]);
    trackerState.setCandidates([heldIssue, occupyingIssue]);

    await expect(orchestrator.retryOperatorHold("1")).resolves.toEqual({
      dispatched: false,
      released: false,
      hold: originalHold,
    });
    expect(orchestrator.getState().operatorHolds["1"]).toBe(originalHold);
    expect(orchestrator.getState().claimed.has("1")).toBe(true);
    expect(Object.keys(orchestrator.getState().running)).toEqual(["2"]);
  });

  it("prevents a poll from duplicating an explicit-retry preflight", async () => {
    const retrySpawnStarted = createDeferred<void>();
    const retrySpawn = createDeferred<{
      workerHandle: unknown;
      monitorHandle: unknown;
    }>();
    let spawnCount = 0;
    const spawnWorker = vi.fn(async () => {
      spawnCount += 1;
      if (spawnCount === 1) {
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      }
      retrySpawnStarted.resolve(undefined);
      return await retrySpawn.promise;
    });
    const orchestrator = createOrchestrator({
      spawnWorker,
      config: createConfig({
        commands: {
          rg: { hooks: [], agent: true, probeArgs: ["--version"] },
        },
      }),
    });

    await orchestrator.pollTick();
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "required command unavailable",
      capabilityFailure: createCommandCapabilityFailure(
        ERROR_CODES.requiredCommandNotFound,
      ),
    });

    const retry = orchestrator.retryOperatorHold("1");
    await retrySpawnStarted.promise;
    const concurrentPoll = await orchestrator.pollTick();
    expect(concurrentPoll.dispatchedIssueIds).toEqual([]);
    expect(spawnWorker).toHaveBeenCalledTimes(2);

    retrySpawn.resolve({
      workerHandle: { pid: 1002 },
      monitorHandle: { ref: "monitor-2" },
    });
    await expect(retry).resolves.toEqual({
      dispatched: true,
      released: false,
      hold: null,
    });
    expect(spawnWorker).toHaveBeenCalledTimes(2);
  });

  it("prevents concurrent explicit retries from duplicating a preflight", async () => {
    const retryCandidates = createDeferred<Issue[]>();
    const retrySpawn = createDeferred<{
      workerHandle: unknown;
      monitorHandle: unknown;
    }>();
    const candidateFetchesStarted = createDeferred<void>();
    let candidateFetchCount = 0;
    const issue = createIssue({ id: "1", identifier: "ISSUE-1" });
    const tracker: IssueTracker = {
      ...createTracker(),
      async fetchCandidateIssues() {
        candidateFetchCount += 1;
        if (candidateFetchCount === 1) {
          return [issue];
        }
        if (candidateFetchCount === 3) {
          candidateFetchesStarted.resolve(undefined);
        }
        return await retryCandidates.promise;
      },
    };
    let spawnCount = 0;
    const spawnWorker = vi.fn(async () => {
      spawnCount += 1;
      if (spawnCount === 1) {
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      }
      return await retrySpawn.promise;
    });
    const orchestrator = createOrchestrator({ tracker, spawnWorker });

    await orchestrator.pollTick();
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "required command unavailable",
      capabilityFailure: createCommandCapabilityFailure(
        ERROR_CODES.requiredCommandNotFound,
      ),
    });

    const firstRetry = orchestrator.retryOperatorHold("1");
    const secondRetry = orchestrator.retryOperatorHold("1");
    await candidateFetchesStarted.promise;
    retryCandidates.resolve([issue]);
    await vi.waitFor(() => {
      expect(spawnWorker).toHaveBeenCalledTimes(2);
    });

    retrySpawn.resolve({
      workerHandle: { pid: 1002 },
      monitorHandle: { ref: "monitor-2" },
    });
    const results = await Promise.all([firstRetry, secondRetry]);
    expect(results.filter((result) => result.dispatched)).toHaveLength(1);
    expect(spawnWorker).toHaveBeenCalledTimes(2);
    expect(orchestrator.getState().claimed.has("1")).toBe(true);
    expect(orchestrator.getState().running["1"]).toBeDefined();
  });

  it("preserves held state when reconciliation refresh fails", async () => {
    const tracker: IssueTracker = {
      ...createTracker(),
      fetchIssueStatesByIds: vi
        .fn()
        .mockRejectedValue(new Error("tracker temporarily unavailable")),
    };
    const orchestrator = createOrchestrator({ tracker });

    await orchestrator.pollTick();
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "required command unavailable",
      capabilityFailure: createCommandCapabilityFailure(
        ERROR_CODES.requiredCommandNotFound,
      ),
    });
    const hold = orchestrator.getState().operatorHolds["1"];

    const poll = await orchestrator.pollTick();
    expect(poll.reconciliationFetchFailed).toBe(true);
    expect(orchestrator.getState().operatorHolds["1"]).toBe(hold);
    expect(orchestrator.getState().claimed.has("1")).toBe(true);
  });

  it("applies codex session events to the running entry and aggregate counters", async () => {
    const orchestrator = createOrchestrator();

    await orchestrator.pollTick();
    const result = orchestrator.onCodexEvent({
      issueId: "1",
      event: {
        event: "turn_completed",
        timestamp: "2026-03-06T00:00:04.000Z",
        codexAppServerPid: "1001",
        sessionId: "thread-1-turn-1",
        threadId: "thread-1",
        turnId: "turn-1",
        usage: {
          inputTokens: 13,
          outputTokens: 8,
          totalTokens: 21,
        },
        rateLimits: {
          requestsRemaining: 9,
        },
        message: "turn completed",
      },
    });

    expect(result).toEqual({ applied: true });
    expect(orchestrator.getState().running["1"]).toMatchObject({
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexMessage: "turn completed",
      codexTotalTokens: 21,
    });
    expect(orchestrator.getState().codexTotals.totalTokens).toBe(21);
    expect(orchestrator.getState().codexRateLimits).toEqual({
      requestsRemaining: 9,
    });
  });

  it("requeues retry timers when slots are exhausted", async () => {
    const timers = createFakeTimerScheduler();
    const tracker = createTracker({
      candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
    });
    const orchestrator = createOrchestrator({
      tracker,
      timerScheduler: timers,
      config: createConfig({
        agent: { maxConcurrentAgents: 0 },
      }),
    });

    // Create a queued retry entry without dispatching the issue.
    orchestrator.getState().claimed.add("1");
    orchestrator.getState().retryAttempts["1"] = {
      issueId: "1",
      identifier: "ISSUE-1",
      attempt: 1,
      dueAtMs: Date.parse("2026-03-06T00:00:00.000Z"),
      timerHandle: null,
      error: "previous failure",
    };

    const result = await orchestrator.onRetryTimer("1");

    expect(result.dispatched).toBe(false);
    expect(result.released).toBe(false);
    expect(result.retryEntry).toMatchObject({
      issueId: "1",
      attempt: 2,
      identifier: "ISSUE-1",
      error: "no available orchestrator slots",
    });
  });

  it("requests stop for stalled sessions before tracker refresh", async () => {
    const stopCalls: Array<{ issueId: string; reason: string }> = [];
    const tracker = createTracker({
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
    });
    const orchestrator = createOrchestrator({
      tracker,
      now: () => new Date("2026-03-06T00:10:00.000Z"),
      config: createConfig({
        codex: { stallTimeoutMs: 60_000 },
      }),
      stopRunningIssue: async (input) => {
        stopCalls.push({ issueId: input.issueId, reason: input.reason });
      },
    });

    await orchestrator.pollTick();
    const runningEntry = orchestrator.getState().running["1"];
    if (runningEntry === undefined) {
      throw new Error("expected running entry for ISSUE-1");
    }
    runningEntry.startedAt = "2026-03-06T00:00:00.000Z";
    const result = await orchestrator.pollTick();

    expect(result.stopRequests).toContainEqual({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      cleanupWorkspace: false,
      reason: "stall_timeout",
    });
    expect(stopCalls).toContainEqual({
      issueId: "1",
      reason: "stall_timeout",
    });
  });
});

describe("orchestrator core integration flows", () => {
  it("redispatches a retried issue through a fake runner boundary after an abnormal exit", async () => {
    const harness = createIntegrationHarness();

    const initialTick = await harness.orchestrator.pollTick();

    expect(initialTick.dispatchedIssueIds).toEqual(["1"]);
    expect(harness.spawnCalls).toEqual([
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        attempt: null,
      },
    ]);
    expect([...harness.orchestrator.getState().claimed]).toEqual(["1"]);

    const retryEntry = harness.orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "turn failed",
    });

    expect(retryEntry).toMatchObject({
      issueId: "1",
      attempt: 1,
      error: "worker exited: turn failed",
    });
    expect(harness.orchestrator.getState().running).toEqual({});

    const retryResult = await harness.orchestrator.onRetryTimer("1");

    expect(retryResult).toEqual({
      dispatched: true,
      released: false,
      retryEntry: null,
    });
    expect(harness.spawnCalls).toEqual([
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        attempt: null,
      },
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        attempt: 1,
      },
    ]);
    expect(harness.orchestrator.getState().running["1"]?.retryAttempt).toBe(1);
    expect([...harness.orchestrator.getState().claimed]).toEqual(["1"]);
  });

  it("requests terminal cleanup through the fake runner boundary and releases the claim once the issue disappears", async () => {
    const harness = createIntegrationHarness();

    await harness.orchestrator.pollTick();
    harness.setStateSnapshots([
      { id: "1", identifier: "ISSUE-1", state: "Done" },
    ]);

    const reconcileTick = await harness.orchestrator.pollTick();

    expect(reconcileTick.stopRequests).toEqual([
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        cleanupWorkspace: true,
        reason: "terminal_state",
      },
    ]);
    expect(harness.stopCalls).toEqual([
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        cleanupWorkspace: true,
        reason: "terminal_state",
      },
    ]);

    harness.orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "stopped after terminal reconciliation",
    });
    harness.setCandidates([]);

    const retryResult = await harness.orchestrator.onRetryTimer("1");

    expect(retryResult).toEqual({
      dispatched: false,
      released: true,
      retryEntry: null,
    });
    expect([...harness.orchestrator.getState().claimed]).toEqual([]);
    expect(harness.orchestrator.getState().retryAttempts).toEqual({});
  });

  it("stops a stalled worker through the fake runner boundary and releases it when the issue is no longer active", async () => {
    const harness = createIntegrationHarness({
      now: "2026-03-06T00:10:00.000Z",
      config: createConfig({
        codex: { stallTimeoutMs: 60_000 },
      }),
    });

    await harness.orchestrator.pollTick();
    const runningEntry = harness.orchestrator.getState().running["1"];
    if (runningEntry === undefined) {
      throw new Error("expected running entry for ISSUE-1");
    }
    runningEntry.startedAt = "2026-03-06T00:00:00.000Z";

    const reconcileTick = await harness.orchestrator.pollTick();

    expect(reconcileTick.stopRequests).toContainEqual({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      cleanupWorkspace: false,
      reason: "stall_timeout",
    });
    expect(harness.stopCalls).toContainEqual({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      cleanupWorkspace: false,
      reason: "stall_timeout",
    });

    harness.orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "stalled",
    });
    harness.setCandidates([
      createIssue({
        id: "1",
        identifier: "ISSUE-1",
        state: "Backlog",
      }),
    ]);

    const retryResult = await harness.orchestrator.onRetryTimer("1");

    expect(retryResult).toEqual({
      dispatched: false,
      released: true,
      retryEntry: null,
    });
    expect([...harness.orchestrator.getState().claimed]).toEqual([]);
    expect(harness.orchestrator.getState().retryAttempts).toEqual({});
  });
});

function createOrchestrator(overrides?: {
  config?: ResolvedWorkflowConfig;
  tracker?: IssueTracker;
  timerScheduler?: ReturnType<typeof createFakeTimerScheduler>;
  stopRunningIssue?: OrchestratorCoreOptions["stopRunningIssue"];
  cleanupHeldIssue?: OrchestratorCoreOptions["cleanupHeldIssue"];
  spawnWorker?: OrchestratorCoreOptions["spawnWorker"];
  now?: () => Date;
}) {
  const tracker =
    overrides?.tracker ??
    createTracker({
      candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
    });
  const options: OrchestratorCoreOptions = {
    config: overrides?.config ?? createConfig(),
    tracker,
    spawnWorker:
      overrides?.spawnWorker ??
      (async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      })),
    now: overrides?.now ?? (() => new Date("2026-03-06T00:00:05.000Z")),
  };

  if (overrides?.stopRunningIssue !== undefined) {
    options.stopRunningIssue = overrides.stopRunningIssue;
  }

  if (overrides?.cleanupHeldIssue !== undefined) {
    options.cleanupHeldIssue = overrides.cleanupHeldIssue;
  }

  if (overrides?.timerScheduler !== undefined) {
    options.timerScheduler = overrides.timerScheduler;
  }

  return new OrchestratorCore(options);
}

function createTracker(input?: {
  candidates?: Issue[];
  statesById?: IssueStateSnapshot[];
}): IssueTracker {
  return {
    async fetchCandidateIssues() {
      return (
        input?.candidates ?? [createIssue({ id: "1", identifier: "ISSUE-1" })]
      );
    },
    async fetchIssuesByStates() {
      return [];
    },
    async fetchIssueStatesByIds() {
      return input?.statesById ?? [];
    },
  };
}

function createConfig(overrides?: {
  agent?: Partial<ResolvedWorkflowConfig["agent"]>;
  codex?: Partial<ResolvedWorkflowConfig["codex"]>;
  commands?: Record<
    string,
    {
      hooks: readonly (
        | "afterCreate"
        | "beforeRun"
        | "afterRun"
        | "beforeRemove"
      )[];
      agent: boolean;
      probeArgs: readonly string[];
    }
  >;
}): ResolvedWorkflowConfig {
  return {
    workflowPath: "/tmp/WORKFLOW.md",
    promptTemplate: "Prompt",
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "token",
      projectSlug: "project",
      activeStates: ["Todo", "In Progress", "In Review"],
      claimState: "In Progress",
      handoffStates: ["In Review", "Review"],
      blockedState: "Needs decision",
      requireClaimBeforeAgent: true,
      terminalStates: ["Done", "Canceled"],
      adapterOptions: {},
    },
    polling: {
      intervalMs: 30_000,
    },
    workspace: {
      root: "/tmp/workspaces",
    },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 30_000,
    },
    agent: {
      maxConcurrentAgents: 2,
      maxTurns: 5,
      maxRetryBackoffMs: 300_000,
      maxConcurrentAgentsByState: {},
      ...overrides?.agent,
    },
    codex: {
      command: "codex-app-server",
      approvalPolicy: "never",
      threadSandbox: null,
      turnSandboxPolicy: null,
      turnTimeoutMs: 300_000,
      readTimeoutMs: 30_000,
      stallTimeoutMs: 300_000,
      ...overrides?.codex,
    },
    capabilities: {
      github: {
        required: false,
        credentialSource: "environment",
      },
      commands: overrides?.commands ?? {},
    },
    server: {
      port: null,
    },
    observability: {
      dashboardEnabled: true,
      refreshMs: 1_000,
      renderIntervalMs: 16,
    },
  };
}

function createIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: overrides?.id ?? "1",
    identifier: overrides?.identifier ?? "ISSUE-1",
    title: overrides?.title ?? "Example issue",
    description: overrides?.description ?? null,
    priority: overrides?.priority ?? 1,
    state: overrides?.state ?? "In Progress",
    branchName: overrides?.branchName ?? null,
    url: overrides?.url ?? null,
    labels: overrides?.labels ?? [],
    blockedBy: overrides?.blockedBy ?? [],
    createdAt: overrides?.createdAt ?? "2026-03-01T00:00:00.000Z",
    updatedAt: overrides?.updatedAt ?? "2026-03-01T00:00:00.000Z",
  };
}

function createFakeTimerScheduler() {
  const scheduled: Array<{
    callback: () => void;
    delayMs: number;
  }> = [];
  return {
    scheduled,
    set(callback: () => void, delayMs: number) {
      scheduled.push({ callback, delayMs });
      return { callback, delayMs } as unknown as ReturnType<typeof setTimeout>;
    },
    clear() {},
  };
}

function createCommandCapabilityFailure(
  code:
    | typeof ERROR_CODES.requiredCommandNotFound
    | typeof ERROR_CODES.requiredCommandExecutionDenied
    | typeof ERROR_CODES.requiredCommandCapabilityTransient,
  boundary:
    | "agent"
    | "hook:after_create"
    | "hook:before_run"
    | "hook:after_run"
    | "hook:before_remove" = "agent",
) {
  return {
    code,
    capability: "external_command",
    command: "rg",
    boundary,
    remediation:
      "Install rg in the agent execution environment, then explicitly retry the held issue.",
  } as const;
}

function createDeferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function createMutableTracker(input?: {
  candidates?: Issue[];
  snapshots?: IssueStateSnapshot[];
}) {
  let candidates = input?.candidates ?? [
    createIssue({ id: "1", identifier: "ISSUE-1" }),
  ];
  let snapshots: IssueStateSnapshot[] = input?.snapshots ?? [
    { id: "1", identifier: "ISSUE-1", state: "In Progress" },
  ];
  const tracker: IssueTracker = {
    async fetchCandidateIssues() {
      return candidates;
    },
    async fetchIssuesByStates() {
      return [];
    },
    async fetchIssueStatesByIds() {
      return snapshots;
    },
  };

  return {
    tracker,
    setCandidates(next: Issue[]) {
      candidates = next;
    },
    setSnapshots(next: IssueStateSnapshot[]) {
      snapshots = next;
    },
  };
}

function createIntegrationHarness(input?: {
  config?: ResolvedWorkflowConfig;
  now?: string;
  candidates?: Issue[];
  statesById?: IssueStateSnapshot[];
}) {
  const trackerState = {
    candidates: input?.candidates ?? [
      createIssue({ id: "1", identifier: "ISSUE-1" }),
    ],
    statesById: input?.statesById ?? [
      { id: "1", identifier: "ISSUE-1", state: "In Progress" },
    ],
  };
  const spawnCalls: Array<{
    issueId: string;
    issueIdentifier: string;
    attempt: number | null;
  }> = [];
  const stopCalls: Array<{
    issueId: string;
    issueIdentifier: string;
    cleanupWorkspace: boolean;
    reason: string;
  }> = [];

  const tracker: IssueTracker = {
    async fetchCandidateIssues() {
      return trackerState.candidates.map((issue) => ({ ...issue }));
    },
    async fetchIssuesByStates() {
      return [];
    },
    async fetchIssueStatesByIds(issueIds) {
      return trackerState.statesById
        .filter((snapshot) => issueIds.includes(snapshot.id))
        .map((snapshot) => ({ ...snapshot }));
    },
  };

  const orchestrator = new OrchestratorCore({
    config: input?.config ?? createConfig(),
    tracker,
    now: () => new Date(input?.now ?? "2026-03-06T00:00:05.000Z"),
    spawnWorker: async ({ issue, attempt }) => {
      spawnCalls.push({
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        attempt,
      });
      return {
        workerHandle: { issueId: issue.id, attempt },
        monitorHandle: { issueId: issue.id, attempt },
      };
    },
    stopRunningIssue: async (stopRequest) => {
      stopCalls.push({
        issueId: stopRequest.issueId,
        issueIdentifier: stopRequest.runningEntry.identifier,
        cleanupWorkspace: stopRequest.cleanupWorkspace,
        reason: stopRequest.reason,
      });
    },
  });

  return {
    orchestrator,
    spawnCalls,
    stopCalls,
    setCandidates(candidates: Issue[]) {
      trackerState.candidates = candidates;
    },
    setStateSnapshots(statesById: IssueStateSnapshot[]) {
      trackerState.statesById = statesById;
    },
  };
}

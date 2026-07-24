import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  type AgentRunResult,
  AgentRunner,
  type AgentRunnerEvent,
} from "../../src/agent/runner.js";
import type { ResolvedWorkflowConfig } from "../../src/config/types.js";
import type { Issue } from "../../src/domain/model.js";
import { ERROR_CODES } from "../../src/errors/codes.js";
import {
  type StructuredLogEntry,
  StructuredLogger,
} from "../../src/logging/structured-logger.js";
import { OrchestratorRuntimeHost } from "../../src/orchestrator/runtime-host.js";
import type {
  IssueStateSnapshot,
  IssueTracker,
} from "../../src/tracker/tracker.js";

describe("OrchestratorRuntimeHost", () => {
  it("feeds codex events into orchestrator state and schedules continuation retry after a normal worker exit", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    const tick = await host.pollOnce();

    expect(tick.dispatchedIssueIds).toEqual(["1"]);
    fakeRunner.emit("1", {
      event: "session_started",
      timestamp: "2026-03-06T00:00:01.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    fakeRunner.emit("1", {
      event: "turn_completed",
      timestamp: "2026-03-06T00:00:02.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
      },
      rateLimits: {
        requestsRemaining: 9,
      },
      message: "turn completed",
    });
    await host.flushEvents();

    let snapshot = await host.getRuntimeSnapshot();
    expect(snapshot.running).toEqual([
      expect.objectContaining({
        issue_id: "1",
        session_id: "thread-1-turn-1",
        turn_count: 1,
        last_event: "turn_completed",
        last_message: "turn completed",
        tokens: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18,
        },
      }),
    ]);
    expect(snapshot.codex_totals.total_tokens).toBe(18);

    fakeRunner.resolve("1", {
      issue: createIssue({ state: "In Progress" }),
      workspace: {
        path: "/tmp/workspaces/1",
        workspaceKey: "1",
        createdNow: true,
      },
      runAttempt: {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        attempt: null,
        workspacePath: "/tmp/workspaces/1",
        startedAt: "2026-03-06T00:00:00.000Z",
        status: "succeeded",
      },
      liveSession: {
        sessionId: "thread-1-turn-1",
        threadId: "thread-1",
        turnId: "turn-1",
        codexAppServerPid: "1001",
        lastCodexEvent: "turn_completed",
        lastCodexTimestamp: "2026-03-06T00:00:02.000Z",
        lastCodexMessage: "turn completed",
        codexInputTokens: 11,
        codexOutputTokens: 7,
        codexTotalTokens: 18,
        lastReportedInputTokens: 11,
        lastReportedOutputTokens: 7,
        lastReportedTotalTokens: 18,
        turnCount: 1,
      },
      turnsCompleted: 1,
      lastTurn: null,
      rateLimits: {
        requestsRemaining: 9,
      },
      handoff: null,
      blocker: null,
    });
    await host.waitForIdle();

    snapshot = await host.getRuntimeSnapshot();
    expect(snapshot.running).toEqual([]);
    expect(snapshot.retrying).toEqual([
      expect.objectContaining({
        issue_id: "1",
        issue_identifier: "ISSUE-1",
        attempt: 1,
        error: null,
      }),
    ]);
  });

  it("cancels a reconciled worker and releases the claim when the issue is no longer eligible on retry", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    tracker.setStateSnapshots([
      { id: "1", identifier: "ISSUE-1", state: "Done" },
    ]);

    const reconcileTick = await host.pollOnce();
    expect(reconcileTick.stopRequests).toEqual([
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        cleanupWorkspace: true,
        reason: "terminal_state",
      },
    ]);
    await host.waitForIdle();

    expect(fakeRunner.abortReasons).toEqual(["Stopped due to terminal_state."]);
    expect(Object.keys(host.getState().retryAttempts)).toEqual(["1"]);

    tracker.setCandidates([]);
    const retryResult = await host.runRetryTimer("1");

    expect(retryResult).toEqual({
      dispatched: false,
      released: true,
      retryEntry: null,
    });
    expect([...host.getState().claimed]).toEqual([]);
  });

  it("coalesces manual refresh requests onto a single queued poll", async () => {
    const tracker = createTracker({
      candidates: [],
    });
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      agentRunner: new FakeAgentRunner(),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    const [first, second] = await Promise.all([
      host.requestRefresh(),
      host.requestRefresh(),
    ]);
    await host.waitForIdle();

    expect(first).toMatchObject({
      queued: true,
      coalesced: false,
      operations: ["poll", "reconcile"],
    });
    expect(second).toMatchObject({
      queued: true,
      coalesced: true,
    });
    expect(tracker.fetchCandidateIssues).toHaveBeenCalledTimes(1);
  });

  it("resolves running workspace details from issue id after identifier changes", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    tracker.setStateSnapshots([
      { id: "1", identifier: "RENAMED-2", state: "In Progress" },
    ]);
    await host.pollOnce();

    const details = await host.getIssueDetails("RENAMED-2");

    expect(details).toMatchObject({
      issue_identifier: "RENAMED-2",
      workspace: {
        path: resolve("/tmp/workspaces/1"),
      },
    });
  });

  it("emits issue and session context for agent lifecycle logs", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    fakeRunner.emit("1", {
      event: "session_started",
      timestamp: "2026-03-06T00:00:01.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await host.flushEvents();

    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "worker_spawned",
        issue_id: "1",
        issue_identifier: "ISSUE-1",
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "session_started",
        issue_id: "1",
        issue_identifier: "ISSUE-1",
        session_id: "thread-1-turn-1",
      }),
    );
  });

  it("surfaces a sanitized missing-remote diagnostic on a timer-free operator hold", async () => {
    const tracker = createTracker();
    const config = createConfig();
    config.capabilities.github.required = true;
    config.workspace.root = join(process.cwd(), ".test-workspaces");
    const workspacePath = join(config.workspace.root, "1");
    const hooks = {
      run: vi.fn().mockResolvedValue(true),
      runBestEffort: vi.fn(),
    };
    const workspaceManager = {
      createForIssue: vi.fn().mockResolvedValue({
        path: workspacePath,
        workspaceKey: "1",
        createdNow: true,
      }),
    };
    const startSession = vi.fn();
    const sanitizedDiagnostic =
      "none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login` [REDACTED]";
    const message = `Required GitHub capability failed: ticket workspace '1' has no GitHub-backed git remote. GitHub CLI diagnostic: ${sanitizedDiagnostic}`;
    const rawToken = ["ghp_", "a".repeat(36)].join("");
    const rawStdout = `stdout-only poison: HTTP 401; gh auth login; ${rawToken}`;
    const rawStderr = `none of the git remotes configured for this repository point to a known GitHub host.
To tell gh about a new GitHub host, please use \`gh auth login\`
GH_TOKEN=${rawToken}`;
    const createCodexClient = vi.fn(() => {
      const execCommand = vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "octocat\n",
          stderr: "",
        })
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: rawStdout,
          stderr: rawStderr,
          stack: `raw stack ${rawToken}`,
          errorPath: "C:\\private\\tools\\gh.exe",
          errorSyscall: "spawn gh.exe",
        });
      return {
        execCommand,
        configureDynamicTools: vi.fn(),
        startSession,
        continueTurn: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      };
    });
    const runner = new AgentRunner({
      config,
      tracker,
      workspaceManager: workspaceManager as never,
      hooks: hooks as never,
      createCodexClient,
    });
    const entries: StructuredLogEntry[] = [];
    const host = new OrchestratorRuntimeHost({
      config,
      tracker,
      agentRunner: runner,
      logger: new StructuredLogger([
        {
          write(entry) {
            entries.push(entry);
          },
        },
      ]),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    await host.waitForIdle();

    expect(hooks.run).toHaveBeenCalledWith({
      name: "beforeRun",
      workspacePath,
    });
    expect(createCodexClient).toHaveBeenCalledTimes(1);
    expect(startSession).not.toHaveBeenCalled();
    expect(host.getState().operatorHolds["1"]).toMatchObject({
      error: expect.stringContaining(ERROR_CODES.githubRemoteMissing),
    });
    expect(host.getState().operatorHolds["1"]?.error).toContain(
      sanitizedDiagnostic,
    );
    expect(host.getState().retryAttempts["1"]).toBeUndefined();
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "worker_exit_abnormal",
        error_code: ERROR_CODES.githubRemoteMissing,
        capability: "github",
        reason: message,
      }),
    );
    const snapshot = await host.getRuntimeSnapshot();
    const details = await host.getIssueDetails("ISSUE-1");
    const operatorSurfaces = JSON.stringify({
      entries,
      hold: host.getState().operatorHolds["1"],
      snapshot,
      details,
    });
    expect(operatorSurfaces).toContain(sanitizedDiagnostic);
    expect(operatorSurfaces).not.toContain(rawStdout);
    expect(operatorSurfaces).not.toContain(rawToken);
    expect(operatorSurfaces).not.toContain("Authorization");
    expect(operatorSurfaces).not.toContain("raw stack");
    expect(operatorSurfaces).not.toContain("C:\\private\\tools\\gh.exe");
    expect(operatorSurfaces).not.toContain('"stdout"');
    expect(operatorSurfaces).not.toContain('"stderr"');
    expect(operatorSurfaces).not.toContain('"stack"');
    expect(operatorSurfaces).not.toContain('"errorPath"');
    expect(operatorSurfaces).not.toContain('"errorSyscall"');

    await host.pollOnce();
    await host.waitForIdle();
    expect(createCodexClient).toHaveBeenCalledTimes(1);

    await expect(host.requestOperatorRetry("ISSUE-1")).resolves.toEqual({
      issue_id: "1",
      issue_identifier: "ISSUE-1",
      dispatched: true,
      released: false,
    });
    await host.waitForIdle();

    expect(createCodexClient).toHaveBeenCalledTimes(2);
    expect(startSession).not.toHaveBeenCalled();
    expect(host.getState().operatorHolds["1"]).toMatchObject({
      error: expect.stringContaining(ERROR_CODES.githubRemoteMissing),
    });
    expect(host.getState().retryAttempts["1"]).toBeUndefined();
  });

  it("preserves sanitized external-command diagnostics in worker logs, holds, snapshots, and details", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger: new StructuredLogger([
        {
          write(entry) {
            entries.push(entry);
          },
        },
      ]),
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });
    const secretPath =
      "PATH=C:\\Users\\operator\\.codex\\vendor\\rg;token=secret-token";
    const rawProbeOutput = `rg missing; ${secretPath}`;
    const remediation =
      "Install rg in the hook execution environment, then explicitly retry the held issue.";
    const error = Object.assign(
      new Error(
        "Required command rg is unavailable in the before_run hook boundary.",
      ),
      {
        code: ERROR_CODES.requiredCommandNotFound,
        capability: "external_command",
        command: "rg",
        boundary: "hook:before_run",
        remediation,
        rawPath: secretPath,
        stdout: rawProbeOutput,
        stderr: "Authorization: Bearer secret-token",
      },
    );

    await host.pollOnce();
    fakeRunner.reject("1", error);
    await host.waitForIdle();

    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "worker_exit_abnormal",
        error_code: ERROR_CODES.requiredCommandNotFound,
        capability: "external_command",
        command: "rg",
        boundary: "hook:before_run",
        remediation,
      }),
    );
    expect(host.getState().operatorHolds["1"]).toMatchObject({
      capabilityFailure: {
        code: ERROR_CODES.requiredCommandNotFound,
        capability: "external_command",
        command: "rg",
        boundary: "hook:before_run",
        remediation,
      },
    });
    expect(host.getState().retryAttempts["1"]).toBeUndefined();

    const snapshot = await host.getRuntimeSnapshot();
    expect(snapshot.holds).toEqual([
      expect.objectContaining({
        capability_failure: {
          code: ERROR_CODES.requiredCommandNotFound,
          capability: "external_command",
          command: "rg",
          boundary: "hook:before_run",
          remediation,
        },
      }),
    ]);
    await expect(host.getIssueDetails("ISSUE-1")).resolves.toMatchObject({
      hold: {
        capability_failure: {
          code: ERROR_CODES.requiredCommandNotFound,
          capability: "external_command",
          command: "rg",
          boundary: "hook:before_run",
          remediation,
        },
      },
    });

    const operatorSurfaces = JSON.stringify({
      entries,
      hold: host.getState().operatorHolds["1"],
      snapshot,
      details: await host.getIssueDetails("ISSUE-1"),
    });
    expect(operatorSurfaces).not.toContain(secretPath);
    expect(operatorSurfaces).not.toContain(rawProbeOutput);
    expect(operatorSurfaces).not.toContain("secret-token");
    expect(operatorSurfaces).not.toContain("Authorization");
  });

  it("cleans and releases a terminal held issue through the workspace manager", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const removeForIssue = vi.fn().mockResolvedValue(undefined);
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      workspaceManager: {
        removeForIssue,
        resolveForIssue: vi.fn(() => ({
          workspaceKey: "1",
          workspacePath: "/tmp/workspaces/1",
        })),
      } as never,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    fakeRunner.reject(
      "1",
      Object.assign(new Error("Required command rg is unavailable."), {
        code: ERROR_CODES.requiredCommandNotFound,
        capability: "external_command",
        command: "rg",
        boundary: "agent",
        remediation:
          "Install rg in the agent execution environment, then explicitly retry the held issue.",
      }),
    );
    await host.waitForIdle();
    tracker.setCandidates([]);
    tracker.setStateSnapshots([
      { id: "1", identifier: "ISSUE-1", state: "Done" },
    ]);

    await host.pollOnce();

    expect(removeForIssue).toHaveBeenCalledWith("1");
    expect(host.getState().operatorHolds["1"]).toBeUndefined();
    expect(host.getState().claimed.has("1")).toBe(false);
  });
});

class FakeAgentRunner {
  onEvent: ((event: AgentRunnerEvent) => void) | undefined;
  readonly runs = new Map<
    string,
    {
      resolve: (result: AgentRunResult) => void;
      reject: (error: Error) => void;
    }
  >();
  readonly abortReasons: string[] = [];

  async run(input: {
    issue: Issue;
    attempt: number | null;
    signal?: AbortSignal;
  }): Promise<AgentRunResult> {
    return await new Promise<AgentRunResult>((resolve, reject) => {
      this.runs.set(input.issue.id, { resolve, reject });
      input.signal?.addEventListener(
        "abort",
        () => {
          const reason =
            typeof input.signal?.reason === "string"
              ? input.signal.reason
              : "aborted";
          this.abortReasons.push(reason);
          reject(new Error(reason));
        },
        { once: true },
      );
    });
  }

  emit(
    issueId: string,
    event: Omit<
      AgentRunnerEvent,
      "issueId" | "issueIdentifier" | "attempt" | "workspacePath" | "turnCount"
    > &
      Partial<Pick<AgentRunnerEvent, "turnCount">>,
  ): void {
    this.onEvent?.({
      ...event,
      issueId,
      issueIdentifier: "ISSUE-1",
      attempt: null,
      workspacePath: "/tmp/workspaces/1",
      turnCount: event.turnCount ?? 0,
    });
  }

  resolve(issueId: string, result: AgentRunResult): void {
    const run = this.runs.get(issueId);
    if (run === undefined) {
      throw new Error(`No fake run registered for ${issueId}.`);
    }
    this.runs.delete(issueId);
    run.resolve(result);
  }

  reject(issueId: string, error: Error): void {
    const run = this.runs.get(issueId);
    if (run === undefined) {
      throw new Error(`No fake run registered for ${issueId}.`);
    }
    this.runs.delete(issueId);
    run.reject(error);
  }
}

function createTracker(input?: { candidates?: Issue[] }) {
  let candidates = input?.candidates ?? [createIssue()];
  let stateSnapshots: IssueStateSnapshot[] = [
    { id: "1", identifier: "ISSUE-1", state: "In Progress" },
  ];

  const tracker: IssueTracker & {
    setCandidates(next: Issue[]): void;
    setStateSnapshots(next: IssueStateSnapshot[]): void;
  } = {
    fetchCandidateIssues: vi.fn(async () => candidates),
    fetchIssuesByStates: vi.fn(async () => []),
    fetchIssueStatesByIds: vi.fn(async () => stateSnapshots),
    setCandidates(next) {
      candidates = next;
    },
    setStateSnapshots(next) {
      stateSnapshots = next;
    },
  };

  return tracker;
}

function createIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: "1",
    identifier: "ISSUE-1",
    title: "Issue 1",
    description: null,
    priority: 1,
    state: "In Progress",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

function createConfig(): ResolvedWorkflowConfig {
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
    },
    codex: {
      command: "codex-app-server",
      approvalPolicy: "never",
      threadSandbox: null,
      turnSandboxPolicy: null,
      turnTimeoutMs: 120_000,
      readTimeoutMs: 5_000,
      stallTimeoutMs: 60_000,
    },
    capabilities: {
      github: {
        required: false,
        credentialSource: "environment",
      },
      commands: {},
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

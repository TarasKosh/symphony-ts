import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResolvedWorkflowConfig } from "../../src/config/types.js";
import type { Issue } from "../../src/domain/model.js";
import { ERROR_CODES } from "../../src/errors/codes.js";
import {
  AgentRunner,
  type AgentRunnerCodexClientFactoryInput,
  type AgentRunnerError,
  WorkspaceHookError,
} from "../../src/index.js";
import type {
  IssueStateSnapshot,
  IssueTracker,
} from "../../src/tracker/tracker.js";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/codex-fake-server.mjs",
);

const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    roots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("AgentRunner", () => {
  it("runs a single issue through workspace setup, dynamic Linear tool injection, continuation turns, and state refresh", async () => {
    const root = await createRoot();
    const tracker = createTracker({
      refreshStates: [
        { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
        { id: "issue-1", identifier: "ABC-123", state: "Done" },
      ],
    });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          viewer: {
            id: "viewer-1",
            name: "Example User",
          },
        },
      }),
    );
    const events: Array<{
      event: string;
      workspacePath: string;
      turnCount: number;
    }> = [];
    const runner = new AgentRunner({
      config: createConfig(root, "linear-tool"),
      tracker,
      fetchFn,
      onEvent: (event) => {
        events.push({
          event: event.event,
          workspacePath: event.workspacePath,
          turnCount: event.turnCount,
        });
      },
    });

    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
    });

    expect(result.runAttempt.status).toBe("succeeded");
    expect(result.workspace.createdNow).toBe(true);
    expect(result.turnsCompleted).toBe(2);
    expect(result.issue.state).toBe("Done");
    expect(result.liveSession.threadId).toBe("thread-1");
    expect(result.liveSession.turnId).toBe("turn-2");
    expect(result.liveSession.turnCount).toBe(2);
    expect(result.rateLimits).toEqual({
      requests_remaining: 9,
      tokens_remaining: 999,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(tracker.fetchIssueStatesByIds).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.event)).toContain("turn_completed");
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        workspacePath: result.workspace.path,
        turnCount: 2,
      }),
    );
  });

  it("keeps the workspace path stable when the issue identifier changes", async () => {
    const root = await createRoot();
    const tracker = createTracker({
      refreshStates: [
        { id: "issue-1", identifier: "RENAMED-456", state: "Done" },
      ],
    });
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker,
      createCodexClient: (input) =>
        createStubCodexClient([], input, {
          statuses: ["completed"],
        }),
    });

    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
    });

    expect(result.issue.identifier).toBe("RENAMED-456");
    expect(result.workspace.path).toBe(join(root, "issue-1"));
    expect(result.runAttempt.workspacePath).toBe(join(root, "issue-1"));
  });

  it("sends the rendered workflow prompt first and continuation guidance afterwards", async () => {
    const root = await createRoot();
    const prompts: string[] = [];
    const tracker = createTracker({
      refreshStates: [
        { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
        { id: "issue-1", identifier: "ABC-123", state: "Human Review" },
      ],
    });
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker,
      createCodexClient: (input) =>
        createStubCodexClient(prompts, input, {
          statuses: ["completed", "completed"],
        }),
    });

    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: 2,
    });

    expect(result.turnsCompleted).toBe(2);
    expect(prompts[0]).toBe("Initial prompt for ABC-123 attempt=2");
    expect(prompts[1]).toContain("Continue working on issue ABC-123");
    expect(prompts[1]).toContain("continuation turn 2 of 3");
    expect(prompts[1]).not.toContain("Initial prompt for ABC-123 attempt=2");
  });

  it("fails immediately when before_run fails and still invokes after_run best-effort", async () => {
    const root = await createRoot();
    const hooks = {
      run: vi.fn(async ({ name }: { name: string }) => {
        if (name !== "beforeRun") {
          return false;
        }

        throw new WorkspaceHookError({
          code: ERROR_CODES.hookFailed,
          message: "before_run hook failed",
          hook: "beforeRun",
          workspacePath: join(root, "issue-1"),
          exitCode: 1,
        });
      }),
      runBestEffort: vi.fn(),
    };
    const createCodexClient = vi.fn();
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker: createTracker(),
      hooks: hooks as never,
      createCodexClient,
    });

    await expect(
      runner.run({
        issue: ISSUE_FIXTURE,
        attempt: null,
      }),
    ).rejects.toMatchObject({
      name: "AgentRunnerError",
      code: ERROR_CODES.hookFailed,
      status: "failed",
      failedPhase: "preparing_workspace",
    } satisfies Partial<AgentRunnerError>);

    expect(createCodexClient).not.toHaveBeenCalled();
    expect(hooks.runBestEffort).toHaveBeenCalledWith({
      name: "afterRun",
      workspacePath: join(root, "issue-1"),
    });
  });

  it("preserves existing startup behavior when the GitHub capability is not required", async () => {
    const root = await createRoot();
    const probe = {
      probe: vi.fn().mockRejectedValue(new Error("must not run")),
    };
    const startSession = vi.fn(async () => completedTurn());
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker: createTracker({
        refreshStates: [
          { id: "issue-1", identifier: "ABC-123", state: "Done" },
        ],
      }),
      githubCapabilityProbe: probe,
      createCodexClient: (input) =>
        createStubCodexClient([], input, { startSession }),
    });

    await runner.run({ issue: ISSUE_FIXTURE, attempt: null });

    expect(probe.probe).not.toHaveBeenCalled();
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it("allows turn/start after the same app-server command/exec GitHub probe succeeds", async () => {
    const root = await createRoot();
    const config = createConfig(root, "command-success");
    config.capabilities.github.required = true;
    const runner = new AgentRunner({
      config,
      tracker: createTracker({
        refreshStates: [
          { id: "issue-1", identifier: "ABC-123", state: "Done" },
        ],
      }),
      environment: {
        ...process.env,
        GH_TOKEN: "inherited-secret",
      },
    });

    const result = await runner.run({ issue: ISSUE_FIXTURE, attempt: null });

    expect(result.turnsCompleted).toBe(1);
    expect(result.lastTurn?.status).toBe("completed");
  });

  it("bridges the current gh auth token into the worker environment only when opted in", async () => {
    const root = await createRoot();
    const config = createConfig(root, "unused");
    config.capabilities.github.required = true;
    config.capabilities.github.credentialSource = "gh_auth_token";
    const environment: NodeJS.ProcessEnv = {
      PATH: "C:\\tools",
      GH_TOKEN: "  ",
      GITHUB_TOKEN: "",
    };
    const getToken = vi.fn().mockResolvedValue("keyring-secret");
    const probe = {
      probe: vi.fn().mockResolvedValue({
        identity: "octocat",
        repository: "example/project",
        canPush: true as const,
      }),
    };
    const createCodexClient = vi.fn((input) =>
      createStubCodexClient([], input, {
        statuses: ["completed"],
      }),
    );
    const runner = new AgentRunner({
      config,
      tracker: createTracker({
        refreshStates: [
          { id: "issue-1", identifier: "ABC-123", state: "Done" },
        ],
      }),
      environment,
      githubCredentialProvider: { getToken },
      githubCapabilityProbe: probe,
      createCodexClient,
    });

    await runner.run({ issue: ISSUE_FIXTURE, attempt: null });

    expect(getToken).toHaveBeenCalledWith({
      environment: {
        PATH: "C:\\tools",
      },
    });
    expect(environment).toEqual({
      PATH: "C:\\tools",
      GH_TOKEN: "  ",
      GITHUB_TOKEN: "",
    });
    expect(createCodexClient).toHaveBeenCalledTimes(1);
    expect(createCodexClient.mock.calls[0]?.[0].environment).toEqual({
      PATH: "C:\\tools",
      GH_TOKEN: "keyring-secret",
    });
    expect(probe.probe).toHaveBeenCalledTimes(1);
  });

  it.each(["GH_TOKEN", "GITHUB_TOKEN"] as const)(
    "preserves an explicit %s instead of reading the gh keyring",
    async (variable) => {
      const root = await createRoot();
      const config = createConfig(root, "unused");
      config.capabilities.github.required = true;
      config.capabilities.github.credentialSource = "gh_auth_token";
      const getToken = vi
        .fn()
        .mockRejectedValue(new Error("must not read the keyring"));
      const createCodexClient = vi.fn((input) =>
        createStubCodexClient([], input, {
          statuses: ["completed"],
        }),
      );
      const runner = new AgentRunner({
        config,
        tracker: createTracker({
          refreshStates: [
            { id: "issue-1", identifier: "ABC-123", state: "Done" },
          ],
        }),
        environment: {
          PATH: "C:\\tools",
          [variable]: "explicit-secret",
        },
        githubCredentialProvider: { getToken },
        githubCapabilityProbe: {
          probe: vi.fn().mockResolvedValue({
            identity: "octocat",
            repository: "example/project",
            canPush: true as const,
          }),
        },
        createCodexClient,
      });

      await runner.run({ issue: ISSUE_FIXTURE, attempt: null });

      expect(getToken).not.toHaveBeenCalled();
      expect(createCodexClient.mock.calls[0]?.[0].environment).toMatchObject({
        [variable]: "explicit-secret",
      });
      expect(
        createCodexClient.mock.calls[0]?.[0].environment,
      ).not.toHaveProperty(
        variable === "GH_TOKEN" ? "GITHUB_TOKEN" : "GH_TOKEN",
      );
    },
  );

  it("stops after a successful before_run when the effective GitHub probe returns HTTP 401", async () => {
    const root = await createRoot();
    const config = createConfig(root, "command-401");
    config.capabilities.github.required = true;
    config.capabilities.github.credentialSource = "gh_auth_token";
    const getToken = vi
      .fn()
      .mockRejectedValue(new Error("must not replace an explicit token"));
    const hooks = {
      run: vi.fn().mockResolvedValue(true),
      runBestEffort: vi.fn(),
    };
    const tracker = {
      ...createTracker(),
      claimIssue: vi.fn(),
      handoffIssue: vi.fn(),
    };
    const runner = new AgentRunner({
      config,
      tracker,
      hooks: hooks as never,
      environment: {
        ...process.env,
        GH_TOKEN: "inherited-secret",
      },
      githubCredentialProvider: { getToken },
    });

    await expect(
      runner.run({ issue: ISSUE_FIXTURE, attempt: null }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.githubAuthInvalid,
      capability: "github",
      failedPhase: "validating_capabilities",
    } satisfies Partial<AgentRunnerError>);

    expect(hooks.run).toHaveBeenCalledWith({
      name: "beforeRun",
      workspacePath: join(root, "issue-1"),
    });
    expect(tracker.claimIssue).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
    expect(hooks.runBestEffort).toHaveBeenCalledTimes(1);
  });

  it("claims write-capable tracker issues before creating a Codex client", async () => {
    const root = await createRoot();
    const createCodexClient = vi.fn((input) =>
      createStubCodexClient([], input, {
        statuses: ["completed"],
      }),
    );
    const tracker = {
      ...createTracker({
        refreshStates: [
          { id: "issue-1", identifier: "ABC-123", state: "Done" },
        ],
      }),
      claimIssue: vi.fn(async () => ({
        issue: { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
        state: "In Progress",
      })),
      handoffIssue: vi.fn(),
    };
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker,
      createCodexClient,
    });

    const result = await runner.run({
      issue: { ...ISSUE_FIXTURE, state: "Todo" },
      attempt: null,
    });

    expect(result.runAttempt.status).toBe("succeeded");
    expect(tracker.claimIssue).toHaveBeenCalledWith({
      issue: expect.objectContaining({ id: "issue-1", state: "Todo" }),
      lifecycle: expect.objectContaining({ claimState: "In Progress" }),
    });
    expect(createCodexClient).toHaveBeenCalledTimes(1);
  });

  it("does not create a Codex client when tracker claim write-back fails", async () => {
    const root = await createRoot();
    const createCodexClient = vi.fn();
    const tracker = {
      ...createTracker(),
      claimIssue: vi.fn(async () => {
        throw new Error("Notion status write failed");
      }),
      handoffIssue: vi.fn(),
    };
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker,
      createCodexClient,
    });

    await expect(
      runner.run({
        issue: { ...ISSUE_FIXTURE, state: "Todo" },
        attempt: null,
      }),
    ).rejects.toMatchObject({
      name: "AgentRunnerError",
      message: "Notion status write failed",
    } satisfies Partial<AgentRunnerError>);

    expect(createCodexClient).not.toHaveBeenCalled();
  });

  it("blocks underspecified tracker issues before starting Codex", async () => {
    const root = await createRoot();
    const createCodexClient = vi.fn();
    const tracker = {
      ...createTracker(),
      blockIssue: vi.fn(async () => ({
        issue: { id: "issue-1", identifier: "ABC-123", state: "Blocked" },
        state: "Blocked",
      })),
    };
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker,
      createCodexClient,
    });

    const result = await runner.run({
      issue: { ...ISSUE_FIXTURE, description: null },
      attempt: null,
    });

    expect(result.runAttempt.status).toBe("succeeded");
    expect(result.turnsCompleted).toBe(0);
    expect(result.lastTurn).toBeNull();
    expect(result.issue.state).toBe("Blocked");
    expect(result.blocker).toEqual({
      status: "succeeded",
      metadata: expect.objectContaining({
        title: "Blocked: task needs implementation context",
        questions: expect.arrayContaining([
          "What acceptance criteria or validation evidence should prove the task is complete?",
        ]),
      }),
      result: {
        issue: { id: "issue-1", identifier: "ABC-123", state: "Blocked" },
        state: "Blocked",
      },
    });
    expect(tracker.blockIssue).toHaveBeenCalledWith({
      issue: expect.objectContaining({
        id: "issue-1",
        description: null,
      }),
      lifecycle: expect.objectContaining({
        blockedState: "Needs decision",
      }),
      metadata: expect.objectContaining({
        details: expect.stringContaining("no usable description"),
      }),
    });
    expect(createCodexClient).not.toHaveBeenCalled();
    expect(tracker.fetchIssueStatesByIds).not.toHaveBeenCalled();
  });

  it("starts the agent with ticket tools when Notion body context answers an empty description", async () => {
    const root = await createRoot();
    const prompts: string[] = [];
    const toolResults: Record<string, unknown> = {};
    const tracker = {
      ...createTracker({
        refreshStates: [
          { id: "issue-1", identifier: "ABC-123", state: "Done" },
        ],
      }),
      blockIssue: vi.fn(),
      readIssueContext: vi.fn(async () => ({
        issue: { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
        entries: [
          {
            source: "body" as const,
            text: "Implement the workflow so Symphony reads ticket answers, asks any remaining blocker questions, and opens a PR when validation passes.",
            createdAt: "2026-07-02T08:00:00.000Z",
            author: "Operator",
          },
        ],
        unavailableSources: [],
      })),
      appendIssueNote: vi.fn(async ({ issue, metadata }) => ({
        issue: {
          id: issue.id,
          identifier: issue.identifier,
          state: issue.state,
        },
        destination: "body" as const,
        metadata,
      })),
    };
    const createCodexClient = vi.fn(
      (input: AgentRunnerCodexClientFactoryInput) =>
        createStubCodexClient(prompts, input, {
          startSession: async ({ prompt }) => {
            const readTool = input.dynamicTools.find(
              (tool) => tool.name === "symphony_ticket_read",
            );
            const noteTool = input.dynamicTools.find(
              (tool) => tool.name === "symphony_ticket_note",
            );
            if (readTool === undefined || noteTool === undefined) {
              throw new Error("Expected ticket read and note tools.");
            }

            toolResults.read = await readTool.execute({});
            toolResults.note = await noteTool.execute({
              title: "Implementation checkpoint",
              body: "Read the ticket context and started implementation.",
            });
            prompts.push(prompt);
            input.onEvent({
              event: "session_started",
              timestamp: new Date("2026-03-06T00:00:00.000Z").toISOString(),
              codexAppServerPid: "1001",
              sessionId: "thread-1-turn-1",
              threadId: "thread-1",
              turnId: "turn-1",
            });
            return {
              status: "completed" as const,
              threadId: "thread-1",
              turnId: "turn-1",
              sessionId: "thread-1-turn-1",
              usage: null,
              rateLimits: null,
              message: "ticket context read",
            };
          },
        }),
    );
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker,
      createCodexClient,
    });

    const result = await runner.run({
      issue: { ...ISSUE_FIXTURE, description: null },
      attempt: null,
    });

    expect(result.runAttempt.status).toBe("succeeded");
    expect(result.turnsCompleted).toBe(1);
    expect(result.issue.state).toBe("Done");
    expect(tracker.blockIssue).not.toHaveBeenCalled();
    expect(tracker.readIssueContext).toHaveBeenCalledTimes(2);
    expect(tracker.appendIssueNote).toHaveBeenCalledWith({
      issue: expect.objectContaining({ id: "issue-1" }),
      metadata: {
        title: "Implementation checkpoint",
        body: "Read the ticket context and started implementation.",
      },
    });
    expect(createCodexClient).toHaveBeenCalledTimes(1);
    const createdInput = createCodexClient.mock.calls[0]?.[0];
    expect(createdInput?.dynamicTools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "symphony_block",
        "symphony_ticket_read",
        "symphony_ticket_note",
      ]),
    );
    expect(toolResults.read).toEqual(
      expect.objectContaining({
        success: true,
        entries: expect.arrayContaining([
          expect.objectContaining({ source: "body", author: "Operator" }),
        ]),
      }),
    );
    expect(toolResults.note).toEqual(
      expect.objectContaining({
        success: true,
        destination: "body",
      }),
    );
  });

  it("does not preflight-block when tracker context sources are unavailable", async () => {
    const root = await createRoot();
    const tracker = {
      ...createTracker({
        refreshStates: [
          { id: "issue-1", identifier: "ABC-123", state: "Done" },
        ],
      }),
      blockIssue: vi.fn(),
      readIssueContext: vi.fn(async () => ({
        issue: { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
        entries: [],
        unavailableSources: [
          {
            source: "comments" as const,
            error: "Notion comments could not be read.",
          },
        ],
      })),
    };
    const createCodexClient = vi.fn(
      (input: AgentRunnerCodexClientFactoryInput) =>
        createStubCodexClient([], input, {
          statuses: ["completed"],
        }),
    );
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker,
      createCodexClient,
    });

    const result = await runner.run({
      issue: { ...ISSUE_FIXTURE, description: null },
      attempt: null,
    });

    expect(result.runAttempt.status).toBe("succeeded");
    expect(result.turnsCompleted).toBe(1);
    expect(result.issue.state).toBe("Done");
    expect(tracker.blockIssue).not.toHaveBeenCalled();
    expect(createCodexClient).toHaveBeenCalledTimes(1);
  });

  it("records structured handoff from the dynamic tool and stops refreshing active state", async () => {
    const root = await createRoot();
    const prompts: string[] = [];
    const tracker = {
      ...createTracker(),
      claimIssue: vi.fn(async () => ({
        issue: { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
        state: "In Progress",
      })),
      handoffIssue: vi.fn(async () => ({
        issue: { id: "issue-1", identifier: "ABC-123", state: "In Review" },
        state: "In Review",
      })),
    };
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker,
      createCodexClient: (input) =>
        createStubCodexClient(prompts, input, {
          startSession: async ({ prompt }) => {
            const handoffTool = input.dynamicTools.find(
              (tool) => tool.name === "symphony_handoff",
            );
            if (handoffTool === undefined) {
              throw new Error("Expected symphony_handoff dynamic tool.");
            }
            await handoffTool.execute({
              ready_for_review: true,
              pr_url: "https://github.com/acme/repo/pull/12",
              branch: "feature/abc-123",
              pr_number: 12,
              head_sha: "abc123",
              validation_summary: "pnpm test passed",
              risks: "",
            });
            prompts.push(prompt);
            return {
              status: "completed" as const,
              threadId: "thread-1",
              turnId: "turn-1",
              sessionId: "thread-1-turn-1",
              usage: null,
              rateLimits: null,
              message: "handoff complete",
            };
          },
        }),
    });

    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
    });

    expect(result.handoff).toEqual({
      status: "succeeded",
      metadata: {
        readyForReview: true,
        prUrl: "https://github.com/acme/repo/pull/12",
        branch: "feature/abc-123",
        prNumber: "12",
        headSha: "abc123",
        validationSummary: "pnpm test passed",
        risks: null,
      },
      result: {
        issue: { id: "issue-1", identifier: "ABC-123", state: "In Review" },
        state: "In Review",
      },
    });
    expect(result.issue.state).toBe("In Review");
    expect(tracker.fetchIssueStatesByIds).not.toHaveBeenCalled();
  });

  it("records structured blocker questions from the dynamic tool and stops refreshing active state", async () => {
    const root = await createRoot();
    const prompts: string[] = [];
    const tracker = {
      ...createTracker(),
      blockIssue: vi.fn(async () => ({
        issue: { id: "issue-1", identifier: "ABC-123", state: "Blocked" },
        state: "Blocked",
      })),
    };
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker,
      createCodexClient: (input) =>
        createStubCodexClient(prompts, input, {
          startSession: async ({ prompt }) => {
            const blockTool = input.dynamicTools.find(
              (tool) => tool.name === "symphony_block",
            );
            if (blockTool === undefined) {
              throw new Error("Expected symphony_block dynamic tool.");
            }
            await blockTool.execute({
              details: "The task lacks acceptance criteria.",
              questions: [
                "Which user flow should this change affect?",
                "What validation proves the task is done?",
              ],
            });
            prompts.push(prompt);
            return {
              status: "completed" as const,
              threadId: "thread-1",
              turnId: "turn-1",
              sessionId: "thread-1-turn-1",
              usage: null,
              rateLimits: null,
              message: "blocked",
            };
          },
        }),
    });

    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
    });

    expect(result.blocker).toEqual({
      status: "succeeded",
      metadata: {
        title: null,
        details: "The task lacks acceptance criteria.",
        questions: [
          "Which user flow should this change affect?",
          "What validation proves the task is done?",
        ],
      },
      result: {
        issue: { id: "issue-1", identifier: "ABC-123", state: "Blocked" },
        state: "Blocked",
      },
    });
    expect(result.issue.state).toBe("Blocked");
    expect(tracker.fetchIssueStatesByIds).not.toHaveBeenCalled();
  });

  it("adds the Symphony workspace and git metadata directory to workspace-write turn sandbox roots", async () => {
    const root = await createRoot();
    const createCodexClient = vi.fn((input) =>
      createStubCodexClient([], input, {
        statuses: ["completed"],
      }),
    );
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker: createTracker({
        refreshStates: [
          { id: "issue-1", identifier: "ABC-123", state: "Done" },
        ],
      }),
      createCodexClient,
    });

    await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
    });

    expect(createCodexClient).toHaveBeenCalledTimes(1);
    const sandboxPolicy = createCodexClient.mock.calls[0]?.[0]
      .turnSandboxPolicy as { writableRoots?: string[] };
    expect(sandboxPolicy.writableRoots).toEqual(
      expect.arrayContaining([
        join(root, "issue-1"),
        join(root, "issue-1", ".git"),
      ]),
    );
  });

  it("removes temporary workspace artifacts before each attempt starts", async () => {
    const root = await createRoot();
    const workspacePath = join(root, "issue-1");
    await mkdir(join(workspacePath, "tmp"), { recursive: true });

    const hooks = {
      run: vi.fn(
        async ({
          name,
          workspacePath,
        }: {
          name: string;
          workspacePath: string;
        }) => {
          if (name === "beforeRun") {
            await expect(
              stat(join(workspacePath, "tmp")),
            ).rejects.toMatchObject({ code: "ENOENT" });
          }
          return true;
        },
      ),
      runBestEffort: vi.fn().mockResolvedValue(true),
    };

    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker: createTracker({
        refreshStates: [
          { id: "issue-1", identifier: "ABC-123", state: "Done" },
        ],
      }),
      hooks: hooks as never,
      createCodexClient: (input) =>
        createStubCodexClient([], input, {
          statuses: ["completed"],
        }),
    });

    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
    });

    expect(result.runAttempt.status).toBe("succeeded");
    expect(hooks.run).toHaveBeenCalledWith({
      name: "beforeRun",
      workspacePath,
    });
  });

  it("closes the session and still runs after_run best-effort when refresh fails", async () => {
    const root = await createRoot();
    const close = vi.fn().mockResolvedValue(undefined);
    const hooks = {
      run: vi.fn().mockResolvedValue(true),
      runBestEffort: vi.fn().mockResolvedValue(false),
    };
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker: {
        fetchCandidateIssues: vi.fn(),
        fetchIssuesByStates: vi.fn(),
        fetchIssueStatesByIds: vi
          .fn()
          .mockRejectedValue(new Error("refresh failed")),
      },
      hooks: hooks as never,
      createCodexClient: (input) =>
        createStubCodexClient([], input, {
          close,
          statuses: ["completed"],
        }),
    });

    await expect(
      runner.run({
        issue: ISSUE_FIXTURE,
        attempt: null,
      }),
    ).rejects.toMatchObject({
      name: "AgentRunnerError",
      status: "failed",
      failedPhase: "finishing",
      message: "refresh failed",
    } satisfies Partial<AgentRunnerError>);

    expect(close).toHaveBeenCalledTimes(1);
    expect(hooks.runBestEffort).toHaveBeenCalledWith({
      name: "afterRun",
      workspacePath: expect.stringContaining("issue-1"),
    });
  });

  it("cancels the run when the orchestrator aborts the worker signal", async () => {
    const root = await createRoot();
    const close = vi.fn().mockResolvedValue(undefined);
    const controller = new AbortController();
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker: createTracker({
        refreshStates: [
          { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
        ],
      }),
      createCodexClient: (input) =>
        createStubCodexClient([], input, {
          close,
          startSession: async ({
            prompt,
          }: {
            prompt: string;
            title: string;
          }) =>
            await new Promise((resolve, reject) => {
              const timeout = setTimeout(() => {
                resolve({
                  status: "completed" as const,
                  threadId: "thread-1",
                  turnId: "turn-1",
                  sessionId: "thread-1-turn-1",
                  usage: null,
                  rateLimits: null,
                  message: prompt,
                });
              }, 500);
              controller.signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(timeout);
                  reject(new Error("Stopped due to terminal_state."));
                },
                { once: true },
              );
            }),
        }),
    });

    const pending = runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
      signal: controller.signal,
    });
    controller.abort("Stopped due to terminal_state.");

    await expect(pending).rejects.toMatchObject({
      name: "AgentRunnerError",
      status: "canceled_by_reconciliation",
      failedPhase: "launching_agent_process",
      message: "Stopped due to terminal_state.",
    } satisfies Partial<AgentRunnerError>);
    expect(close).toHaveBeenCalled();
  });
});

function createStubCodexClient(
  prompts: string[],
  input: AgentRunnerCodexClientFactoryInput,
  overrides?: Partial<{
    close: ReturnType<typeof vi.fn>;
    execCommand: ReturnType<typeof vi.fn>;
    configureDynamicTools: ReturnType<typeof vi.fn>;
    statuses: Array<"completed" | "failed" | "cancelled">;
    startSession: (input: { prompt: string; title: string }) => Promise<{
      status: "completed" | "failed" | "cancelled";
      threadId: string;
      turnId: string;
      sessionId: string;
      usage: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      } | null;
      rateLimits: Record<string, unknown> | null;
      message: string | null;
    }>;
  }>,
) {
  let turn = 0;
  const statuses = overrides?.statuses ?? ["completed"];

  return {
    execCommand:
      overrides?.execCommand ??
      vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
    configureDynamicTools: overrides?.configureDynamicTools ?? vi.fn(),
    async startSession({ prompt, title }: { prompt: string; title: string }) {
      if (overrides?.startSession) {
        return overrides.startSession({ prompt, title });
      }

      turn += 1;
      prompts.push(prompt);
      input.onEvent({
        event: "session_started",
        timestamp: new Date("2026-03-06T00:00:00.000Z").toISOString(),
        codexAppServerPid: "1001",
        sessionId: `thread-1-turn-${turn}`,
        threadId: "thread-1",
        turnId: `turn-${turn}`,
      });
      return {
        status: statuses[turn - 1] ?? "completed",
        threadId: "thread-1",
        turnId: `turn-${turn}`,
        sessionId: `thread-1-turn-${turn}`,
        usage: {
          inputTokens: 10 * turn,
          outputTokens: 5 * turn,
          totalTokens: 15 * turn,
        },
        rateLimits: {
          requestsRemaining: 10 - turn,
        },
        message: `turn ${turn}`,
      };
    },
    async continueTurn(prompt: string) {
      turn += 1;
      prompts.push(prompt);
      input.onEvent({
        event: "session_started",
        timestamp: new Date("2026-03-06T00:00:00.000Z").toISOString(),
        codexAppServerPid: "1001",
        sessionId: `thread-1-turn-${turn}`,
        threadId: "thread-1",
        turnId: `turn-${turn}`,
      });
      return {
        status: statuses[turn - 1] ?? "completed",
        threadId: "thread-1",
        turnId: `turn-${turn}`,
        sessionId: `thread-1-turn-${turn}`,
        usage: {
          inputTokens: 10 * turn,
          outputTokens: 5 * turn,
          totalTokens: 15 * turn,
        },
        rateLimits: {
          requestsRemaining: 10 - turn,
        },
        message: `turn ${turn}`,
      };
    },
    close: overrides?.close ?? vi.fn().mockResolvedValue(undefined),
  };
}

function completedTurn() {
  return {
    status: "completed" as const,
    threadId: "thread-1",
    turnId: "turn-1",
    sessionId: "thread-1-turn-1",
    usage: null,
    rateLimits: null,
    message: null,
  };
}

function createTracker(input?: {
  refreshStates?: IssueStateSnapshot[];
}): IssueTracker {
  const refreshStates = [...(input?.refreshStates ?? [])];

  return {
    fetchCandidateIssues: vi.fn(),
    fetchIssuesByStates: vi.fn(),
    fetchIssueStatesByIds: vi.fn(async () => {
      const next = refreshStates.shift();
      return next === undefined ? [] : [next];
    }),
  };
}

function createConfig(root: string, scenario: string): ResolvedWorkflowConfig {
  return {
    workflowPath: join(root, "WORKFLOW.md"),
    promptTemplate:
      "Initial prompt for {{ issue.identifier }} attempt={{ attempt }}",
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      projectSlug: "example",
      activeStates: ["In Progress"],
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
      root,
    },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 500,
    },
    agent: {
      maxConcurrentAgents: 2,
      maxTurns: 3,
      maxRetryBackoffMs: 300_000,
      maxConcurrentAgentsByState: {},
    },
    codex: {
      command: `"${toBashPath(process.execPath)}" "${toBashPath(fixturePath)}" ${scenario}`,
      approvalPolicy: "full-auto",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: {
        type: "workspace-write",
      },
      turnTimeoutMs: 1_000,
      readTimeoutMs: 3_000,
      stallTimeoutMs: 2_000,
    },
    capabilities: {
      github: {
        required: false,
        credentialSource: "environment",
      },
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

function toBashPath(value: string): string {
  return value.replaceAll("\\", "/");
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "symphony-task11-"));
  roots.push(root);
  return root;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

const ISSUE_FIXTURE: Issue = {
  id: "issue-1",
  identifier: "ABC-123",
  title: "Ship agent runner",
  description: "Implement the runner",
  priority: 1,
  state: "In Progress",
  branchName: null,
  url: "https://linear.app/example/issue/ABC-123",
  labels: ["automation"],
  blockedBy: [],
  createdAt: "2026-03-06T00:00:00.000Z",
  updatedAt: "2026-03-06T01:00:00.000Z",
};

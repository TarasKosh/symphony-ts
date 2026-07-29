import { describe, expect, it, vi } from "vitest";

import { createSymphonyHandoffDynamicTool } from "../../src/agent/handoff-tool.js";
import type { Issue } from "../../src/domain/model.js";
import type {
  TrackerLifecycleConfig,
  WriteCapableIssueTracker,
} from "../../src/tracker/tracker.js";

const ISSUE: Issue = {
  id: "issue-1",
  identifier: "ABC-123",
  title: "Report handoff metadata",
  description: null,
  priority: null,
  state: "In Progress",
  branchName: null,
  url: null,
  labels: [],
  blockedBy: [],
  createdAt: null,
  updatedAt: null,
};

const LIFECYCLE: TrackerLifecycleConfig = {
  claimState: "In Progress",
  handoffStates: ["In Review", "Review"],
  blockedState: "Blocked",
  requireClaimBeforeAgent: true,
};

describe("createSymphonyHandoffDynamicTool", () => {
  it("advertises and forwards the agent-reported branch", async () => {
    const { tracker, handoffIssue } = createTracker();
    const onHandoff = vi.fn();
    const tool = createSymphonyHandoffDynamicTool({
      issue: ISSUE,
      lifecycle: LIFECYCLE,
      tracker,
      onHandoff,
    });

    expect(tool.inputSchema).toMatchObject({
      properties: {
        branch: {
          type: ["string", "null"],
          description: "Branch the agent worked on, when available.",
        },
      },
      required: ["ready_for_review"],
    });

    await expect(
      tool.execute({
        ready_for_review: true,
        pr_url: "https://github.com/acme/repo/pull/12",
        branch: "  feature/abc-123  ",
      }),
    ).resolves.toMatchObject({
      success: true,
      state: "In Review",
    });

    expect(handoffIssue).toHaveBeenCalledWith({
      issue: ISSUE,
      lifecycle: LIFECYCLE,
      metadata: {
        readyForReview: true,
        prUrl: "https://github.com/acme/repo/pull/12",
        branch: "feature/abc-123",
        prNumber: null,
        headSha: null,
        validationSummary: null,
        risks: null,
      },
    });
    expect(onHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "succeeded",
        metadata: expect.objectContaining({
          branch: "feature/abc-123",
        }),
      }),
    );
  });

  it("keeps branch optional when the agent does not report one", async () => {
    const { tracker, handoffIssue } = createTracker();
    const tool = createSymphonyHandoffDynamicTool({
      issue: ISSUE,
      lifecycle: LIFECYCLE,
      tracker,
      onHandoff: vi.fn(),
    });

    await tool.execute({
      ready_for_review: true,
    });

    expect(handoffIssue).toHaveBeenCalledWith({
      issue: ISSUE,
      lifecycle: LIFECYCLE,
      metadata: {
        readyForReview: true,
        prUrl: null,
        branch: null,
        prNumber: null,
        headSha: null,
        validationSummary: null,
        risks: null,
      },
    });
  });
});

function createTracker(): {
  tracker: WriteCapableIssueTracker;
  handoffIssue: ReturnType<typeof vi.fn>;
} {
  const handoffIssue = vi.fn<WriteCapableIssueTracker["handoffIssue"]>(
    async () => ({
      issue: {
        id: ISSUE.id,
        identifier: ISSUE.identifier,
        state: "In Review",
      },
      state: "In Review",
    }),
  );
  const tracker: WriteCapableIssueTracker = {
    fetchCandidateIssues: async () => [],
    fetchIssuesByStates: async () => [],
    fetchIssueStatesByIds: async () => [],
    claimIssue: async () => ({
      issue: {
        id: ISSUE.id,
        identifier: ISSUE.identifier,
        state: "In Progress",
      },
      state: "In Progress",
    }),
    handoffIssue,
  };

  return { tracker, handoffIssue };
}

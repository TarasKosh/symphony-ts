import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Issue } from "../../src/domain/model.js";
import {
  GitWorkspaceRetentionInspector,
  cleanupStaleIssueWorkspaces,
} from "../../src/workspace/retention.js";
import { WorkspaceManager } from "../../src/workspace/workspace-manager.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    roots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("workspace retention", () => {
  it("removes only stale, inactive workspaces that pass safety inspection", async () => {
    const root = await createRoot();
    const manager = new WorkspaceManager({ root });
    const issues = [
      createIssue("remove", "2026-06-01T00:00:00.000Z"),
      createIssue("dirty", "2026-06-01T00:00:00.000Z"),
      createIssue("active", "2026-06-01T00:00:00.000Z"),
      {
        ...createIssue("state-changed", "2026-06-01T00:00:00.000Z"),
        state: "Todo",
      },
      createIssue("fresh", "2026-07-20T00:00:00.000Z"),
    ];
    await Promise.all(
      issues.map(async (issue) => manager.createForIssue(issue.id)),
    );
    const inspect = vi.fn(async (workspacePath: string) =>
      workspacePath.endsWith("dirty")
        ? { eligible: false as const, reason: "dirty" as const }
        : { eligible: true as const },
    );
    const logs: Array<{ event: string; reason?: string; issueId: string }> = [];

    const result = await cleanupStaleIssueWorkspaces({
      tracker: {
        fetchCandidateIssues: vi.fn(),
        fetchIssuesByStates: vi.fn(async () => issues),
        fetchIssueStatesByIds: vi.fn(),
      },
      retention: {
        states: ["Blocked", "In Review", "Human Review"],
        staleAfterMs: 30 * 86_400_000,
        checkIntervalMs: 86_400_000,
      },
      workspaceManager: manager,
      now: new Date("2026-08-01T00:00:00.000Z"),
      isIssueActive: (issueId) => issueId === "active",
      inspector: { inspect },
      log: (entry) => {
        logs.push(entry);
      },
    });

    expect(result.removed).toEqual(["remove"]);
    expect(result.skipped).toEqual([
      { issueId: "dirty", reason: "dirty" },
      { issueId: "active", reason: "active_run" },
      { issueId: "state-changed", reason: "state_not_eligible" },
    ]);
    await expect(stat(join(root, "remove"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(root, "dirty"))).resolves.toBeDefined();
    await expect(stat(join(root, "active"))).resolves.toBeDefined();
    await expect(stat(join(root, "state-changed"))).resolves.toBeDefined();
    await expect(stat(join(root, "fresh"))).resolves.toBeDefined();
    expect(inspect).toHaveBeenCalledTimes(3);
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "workspace_retention_removed",
          issueId: "remove",
        }),
        expect.objectContaining({
          event: "workspace_retention_skipped",
          issueId: "dirty",
          reason: "dirty",
        }),
        expect.objectContaining({
          event: "workspace_retention_skipped",
          issueId: "active",
          reason: "active_run",
        }),
      ]),
    );
  });

  it("requires a clean Git repository with a configured upstream and no ahead commits", async () => {
    const root = await createRoot();
    const remote = join(root, "remote.git");
    const workspace = join(root, "workspace");
    await runGit(root, ["init", "--bare", remote]);
    await runGit(root, ["init", workspace]);
    await runGit(workspace, ["config", "user.name", "Symphony Test"]);
    await runGit(workspace, ["config", "user.email", "symphony@example.test"]);
    await writeFile(join(workspace, "README.md"), "initial\n");
    await runGit(workspace, ["add", "README.md"]);
    await runGit(workspace, ["commit", "-m", "Initial commit"]);
    await runGit(workspace, ["remote", "add", "origin", remote]);
    await runGit(workspace, ["push", "-u", "origin", "HEAD:main"]);

    const inspector = new GitWorkspaceRetentionInspector();
    await expect(inspector.inspect(workspace)).resolves.toEqual({
      eligible: true,
    });

    await writeFile(join(workspace, "untracked.txt"), "dirty\n");
    await expect(inspector.inspect(workspace)).resolves.toMatchObject({
      eligible: false,
      reason: "dirty",
    });

    await runGit(workspace, ["add", "untracked.txt"]);
    await runGit(workspace, ["commit", "-m", "Local work"]);
    await expect(inspector.inspect(workspace)).resolves.toMatchObject({
      eligible: false,
      reason: "ahead_of_upstream",
    });
  });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "symphony-retention-"));
  roots.push(root);
  return root;
}

function createIssue(id: string, updatedAt: string | null): Issue {
  return {
    id,
    identifier: `SYM-${id}`,
    title: `Issue ${id}`,
    description: "Retention test",
    priority: null,
    state: "In Review",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
  };
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

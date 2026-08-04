import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { promisify } from "node:util";

import type { WorkflowWorkspaceRetentionConfig } from "../config/types.js";
import { type Issue, normalizeIssueState } from "../domain/model.js";
import type { IssueTracker } from "../tracker/tracker.js";
import type { WorkspaceManager } from "./workspace-manager.js";

const execFileAsync = promisify(execFile);
const GIT_INSPECTION_TIMEOUT_MS = 30_000;

export type WorkspaceRetentionSkipReason =
  | "active_run"
  | "ahead_of_upstream"
  | "dirty"
  | "inspection_failed"
  | "invalid_updated_at"
  | "no_upstream"
  | "not_git_repository"
  | "removal_failed"
  | "state_not_eligible";

export type WorkspaceRetentionInspection =
  | { eligible: true }
  | {
      eligible: false;
      reason: Exclude<
        WorkspaceRetentionSkipReason,
        | "active_run"
        | "invalid_updated_at"
        | "removal_failed"
        | "state_not_eligible"
      >;
      detail?: string;
    }
  | { eligible: false; reason: "missing" };

export interface WorkspaceRetentionLogEntry {
  level: "info" | "warn";
  event: "workspace_retention_removed" | "workspace_retention_skipped";
  issueId: string;
  issueIdentifier: string;
  workspacePath: string;
  reason?: WorkspaceRetentionSkipReason;
  detail?: string;
}

export interface WorkspaceRetentionSweepResult {
  removed: string[];
  skipped: Array<{ issueId: string; reason: WorkspaceRetentionSkipReason }>;
}

export interface WorkspaceRetentionInspector {
  inspect(workspacePath: string): Promise<WorkspaceRetentionInspection>;
}

export class GitWorkspaceRetentionInspector
  implements WorkspaceRetentionInspector
{
  async inspect(workspacePath: string): Promise<WorkspaceRetentionInspection> {
    try {
      const stats = await lstat(workspacePath);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        return { eligible: false, reason: "not_git_repository" };
      }
    } catch (error) {
      if (isMissingPathError(error)) {
        return { eligible: false, reason: "missing" };
      }
      return {
        eligible: false,
        reason: "inspection_failed",
        detail: toErrorMessage(error),
      };
    }

    try {
      const [workspaceRealPath, repositoryRoot] = await Promise.all([
        realpath(workspacePath),
        runGit(workspacePath, ["rev-parse", "--show-toplevel"]),
      ]);
      if ((await realpath(repositoryRoot.trim())) !== workspaceRealPath) {
        return { eligible: false, reason: "not_git_repository" };
      }

      const status = await runGit(workspacePath, [
        "status",
        "--porcelain=v1",
        "--untracked-files=normal",
      ]);
      if (status.trim() !== "") {
        return {
          eligible: false,
          reason: "dirty",
          detail: firstLine(status),
        };
      }

      try {
        await runGit(workspacePath, [
          "rev-parse",
          "--abbrev-ref",
          "--symbolic-full-name",
          "@{upstream}",
        ]);
      } catch (error) {
        return {
          eligible: false,
          reason: "no_upstream",
          detail: toErrorMessage(error),
        };
      }

      const aheadText = await runGit(workspacePath, [
        "rev-list",
        "--count",
        "@{upstream}..HEAD",
      ]);
      const ahead = Number.parseInt(aheadText.trim(), 10);
      if (!Number.isSafeInteger(ahead) || ahead < 0) {
        return {
          eligible: false,
          reason: "inspection_failed",
          detail: `Unexpected git ahead count: ${aheadText.trim()}`,
        };
      }
      if (ahead > 0) {
        return {
          eligible: false,
          reason: "ahead_of_upstream",
          detail: `${ahead} unpushed commit${ahead === 1 ? "" : "s"}`,
        };
      }

      return { eligible: true };
    } catch (error) {
      return {
        eligible: false,
        reason: isNotGitRepositoryError(error)
          ? "not_git_repository"
          : "inspection_failed",
        detail: toErrorMessage(error),
      };
    }
  }
}

export async function cleanupStaleIssueWorkspaces(input: {
  tracker: IssueTracker;
  retention: WorkflowWorkspaceRetentionConfig;
  workspaceManager: WorkspaceManager;
  now: Date;
  isIssueActive: (issueId: string) => boolean;
  inspector?: WorkspaceRetentionInspector;
  log?: (entry: WorkspaceRetentionLogEntry) => void | Promise<void>;
}): Promise<WorkspaceRetentionSweepResult> {
  const result: WorkspaceRetentionSweepResult = {
    removed: [],
    skipped: [],
  };
  if (
    input.retention.states.length === 0 ||
    input.retention.staleAfterMs === null
  ) {
    return result;
  }

  const inspector = input.inspector ?? new GitWorkspaceRetentionInspector();
  const eligibleStates = new Set(
    input.retention.states.map((state) => normalizeIssueState(state)),
  );
  const issues = await input.tracker.fetchIssuesByStates(
    input.retention.states,
  );
  for (const issue of issues) {
    const workspacePath = input.workspaceManager.resolveForIssue(
      issue.id,
    ).workspacePath;
    if (!eligibleStates.has(normalizeIssueState(issue.state))) {
      await recordSkip(
        input,
        result,
        issue,
        workspacePath,
        "state_not_eligible",
      );
      continue;
    }
    if (input.isIssueActive(issue.id)) {
      await recordSkip(input, result, issue, workspacePath, "active_run");
      continue;
    }

    const updatedAtMs = parseTimestamp(issue.updatedAt);
    if (updatedAtMs === null) {
      await recordSkip(
        input,
        result,
        issue,
        workspacePath,
        "invalid_updated_at",
      );
      continue;
    }
    if (input.now.getTime() - updatedAtMs < input.retention.staleAfterMs) {
      continue;
    }

    const inspection = await inspector.inspect(workspacePath);
    if (!inspection.eligible) {
      if (inspection.reason !== "missing") {
        await recordSkip(
          input,
          result,
          issue,
          workspacePath,
          inspection.reason,
          inspection.detail,
        );
      }
      continue;
    }

    if (input.isIssueActive(issue.id)) {
      await recordSkip(input, result, issue, workspacePath, "active_run");
      continue;
    }

    const finalInspection = await inspector.inspect(workspacePath);
    if (!finalInspection.eligible) {
      if (finalInspection.reason !== "missing") {
        await recordSkip(
          input,
          result,
          issue,
          workspacePath,
          finalInspection.reason,
          finalInspection.detail,
        );
      }
      continue;
    }

    try {
      await input.workspaceManager.removeForIssue(issue.id);
    } catch (error) {
      await recordSkip(
        input,
        result,
        issue,
        workspacePath,
        "removal_failed",
        toErrorMessage(error),
      );
      continue;
    }
    result.removed.push(issue.id);
    await input.log?.({
      level: "info",
      event: "workspace_retention_removed",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      workspacePath,
    });
  }

  return result;
}

async function recordSkip(
  input: {
    log?: (entry: WorkspaceRetentionLogEntry) => void | Promise<void>;
  },
  result: WorkspaceRetentionSweepResult,
  issue: Issue,
  workspacePath: string,
  reason: WorkspaceRetentionSkipReason,
  detail?: string,
): Promise<void> {
  result.skipped.push({ issueId: issue.id, reason });
  await input.log?.({
    level: "warn",
    event: "workspace_retention_skipped",
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    workspacePath,
    reason,
    ...(detail === undefined ? {} : { detail }),
  });
}

async function runGit(workspacePath: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: workspacePath,
    encoding: "utf8",
    timeout: GIT_INSPECTION_TIMEOUT_MS,
  });
  return result.stdout;
}

function parseTimestamp(timestamp: string | null): number | null {
  if (timestamp === null) {
    return null;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isNotGitRepositoryError(error: unknown): boolean {
  return toErrorMessage(error).toLowerCase().includes("not a git repository");
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] ?? value;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

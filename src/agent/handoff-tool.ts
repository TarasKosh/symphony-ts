import type { CodexDynamicTool } from "../codex/app-server-client.js";
import type { Issue } from "../domain/model.js";
import type {
  TrackerHandoffMetadata,
  TrackerHandoffRunResult,
  TrackerLifecycleConfig,
  WriteCapableIssueTracker,
} from "../tracker/tracker.js";

export interface SymphonyHandoffToolOptions {
  issue: Issue;
  lifecycle: TrackerLifecycleConfig;
  tracker: WriteCapableIssueTracker;
  onHandoff: (result: TrackerHandoffRunResult) => void;
}

export function createSymphonyHandoffDynamicTool(
  options: SymphonyHandoffToolOptions,
): CodexDynamicTool {
  return {
    name: "symphony_handoff",
    description:
      "Mark the current tracker ticket ready for review after the project workflow is genuinely ready to hand off.",
    inputSchema: {
      type: "object",
      properties: {
        ready_for_review: {
          type: "boolean",
          description:
            "Set true only after the project workflow says the PR is ready for review or merge.",
        },
        pr_url: {
          type: ["string", "null"],
          description: "Pull request URL, when available.",
        },
        branch: {
          type: ["string", "null"],
          description: "Branch the agent worked on, when available.",
        },
        pr_number: {
          type: ["string", "number", "null"],
          description: "Pull request number, when available.",
        },
        head_sha: {
          type: ["string", "null"],
          description:
            "Head commit SHA for the handed-off work, when available.",
        },
        validation_summary: {
          type: ["string", "null"],
          description: "Short summary of validation evidence.",
        },
        risks: {
          type: ["string", "null"],
          description:
            "Known residual risks or an empty string when none remain.",
        },
      },
      required: ["ready_for_review"],
      additionalProperties: true,
    },
    async execute(input) {
      const metadata = parseHandoffMetadata(input);
      try {
        const result = await options.tracker.handoffIssue({
          issue: options.issue,
          lifecycle: options.lifecycle,
          metadata,
        });
        options.onHandoff({
          status: "succeeded",
          result,
          metadata,
        });
        return {
          success: true,
          issue_id: result.issue.id,
          issue_identifier: result.issue.identifier,
          state: result.state,
          continuation: "suppressed",
        };
      } catch (error) {
        const message = toErrorMessage(error);
        options.onHandoff({
          status: "failed",
          error: message,
          metadata,
        });
        throw error;
      }
    },
  };
}

function parseHandoffMetadata(input: unknown): TrackerHandoffMetadata {
  const record = toRecord(input);
  return {
    readyForReview: readBoolean(record.ready_for_review, record.readyForReview),
    prUrl: readOptionalString(record.pr_url, record.prUrl),
    branch: readOptionalString(record.branch),
    prNumber: readOptionalString(record.pr_number, record.prNumber),
    headSha: readOptionalString(record.head_sha, record.headSha),
    validationSummary: readOptionalString(
      record.validation_summary,
      record.validationSummary,
    ),
    risks: readOptionalString(record.risks),
  };
}

function toRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  return input as Record<string, unknown>;
}

function readBoolean(...values: unknown[]): boolean {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
  }

  return false;
}

function readOptionalString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed !== "") {
        return trimmed;
      }
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return null;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "tracker handoff failed";
}

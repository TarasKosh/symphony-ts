import { Liquid } from "liquidjs";

import type { Issue, WorkflowDefinition } from "../domain/model.js";
import { ERROR_CODES } from "../errors/codes.js";
import type { TrackerIssueContextEntry } from "../tracker/tracker.js";

export const DEFAULT_WORKFLOW_PROMPT =
  "You are working on an issue from the configured tracker.";

const liquidEngine = new Liquid({
  strictVariables: true,
  strictFilters: true,
  ownPropertyOnly: true,
});

export class PromptTemplateError extends Error {
  readonly code: string;
  readonly kind: "template_parse_error" | "template_render_error";

  constructor(
    kind: "template_parse_error" | "template_render_error",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PromptTemplateError";
    this.code =
      kind === "template_parse_error"
        ? ERROR_CODES.templateParseError
        : ERROR_CODES.templateRenderError;
    this.kind = kind;
  }
}

export interface RenderPromptInput {
  workflow: Pick<WorkflowDefinition, "promptTemplate">;
  issue: Issue;
  attempt: number | null;
}

export interface BuildTurnPromptInput extends RenderPromptInput {
  turnNumber: number;
  maxTurns: number;
  trackerComments?: readonly TrackerIssueContextEntry[];
}

export function getEffectivePromptTemplate(promptTemplate: string): string {
  const trimmed = promptTemplate.trim();

  return trimmed.length > 0 ? trimmed : DEFAULT_WORKFLOW_PROMPT;
}

export async function renderPrompt(input: RenderPromptInput): Promise<string> {
  const template = getEffectivePromptTemplate(input.workflow.promptTemplate);

  try {
    const parsedTemplate = liquidEngine.parse(template);

    return await liquidEngine.render(parsedTemplate, {
      issue: toTemplateIssue(input.issue),
      attempt: input.attempt,
    });
  } catch (error) {
    throw toPromptTemplateError(error);
  }
}

export async function buildTurnPrompt(
  input: BuildTurnPromptInput,
): Promise<string> {
  if (input.turnNumber <= 1) {
    return await renderPrompt(input);
  }

  return buildContinuationPrompt({
    issue: input.issue,
    attempt: input.attempt,
    turnNumber: input.turnNumber,
    maxTurns: input.maxTurns,
    trackerComments: input.trackerComments ?? [],
  });
}

export function buildContinuationPrompt(input: {
  issue: Issue;
  attempt: number | null;
  turnNumber: number;
  maxTurns: number;
  trackerComments?: readonly TrackerIssueContextEntry[];
}): string {
  const attemptLine =
    input.attempt === null
      ? "This worker session started from the initial dispatch."
      : `This worker session is running retry/continuation attempt ${input.attempt}.`;

  const lines = [
    `Continue working on issue ${input.issue.identifier}: ${input.issue.title}.`,
    `This is continuation turn ${input.turnNumber} of ${input.maxTurns} in the current worker session.`,
    attemptLine,
    `Current tracker state: ${input.issue.state}.`,
    "Reuse the existing thread context and current workspace state.",
    "Do not restate the original task prompt unless it is strictly needed.",
    "Make the next best progress on the issue, then stop when this session has no further useful work to do.",
  ];

  const trackerComments = input.trackerComments ?? [];
  if (trackerComments.length > 0) {
    lines.push(
      "",
      "New tracker comments arrived since the previous turn. Treat them as current operator input:",
      ...trackerComments.flatMap(formatTrackerComment),
    );
  }

  return lines.join("\n");
}

function formatTrackerComment(entry: TrackerIssueContextEntry): string[] {
  const author = entry.author?.trim() || "unknown author";
  const createdAt = entry.createdAt?.trim() || "unknown time";
  return [
    `--- tracker comment from ${author} at ${createdAt} ---`,
    entry.text,
    "--- end tracker comment ---",
  ];
}

function toTemplateIssue(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    state: issue.state,
    branch_name: issue.branchName,
    url: issue.url,
    labels: [...issue.labels],
    blocked_by: issue.blockedBy.map((blocker) => ({
      id: blocker.id,
      identifier: blocker.identifier,
      state: blocker.state,
    })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function toPromptTemplateError(error: unknown): PromptTemplateError {
  if (error instanceof PromptTemplateError) {
    return error;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string"
  ) {
    if (getErrorMessage(error).includes("undefined filter")) {
      return new PromptTemplateError(
        "template_render_error",
        getErrorMessage(error),
        { cause: error },
      );
    }

    if (error.name === "ParseError" || error.name === "TokenizationError") {
      return new PromptTemplateError(
        "template_parse_error",
        getErrorMessage(error),
        { cause: error },
      );
    }
  }

  return new PromptTemplateError(
    "template_render_error",
    getErrorMessage(error),
    {
      cause: error,
    },
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Prompt rendering failed";
}

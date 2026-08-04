import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_LINEAR_ENDPOINT = "https://api.linear.app/graphql";
export const DEFAULT_NOTION_ENDPOINT = "https://api.notion.com/v1";
export const DEFAULT_NOTION_VERSION = "2026-03-11";
export const DEFAULT_TRACKER_KIND = "linear";
export const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"] as const;
export const DEFAULT_TRACKER_CLAIM_STATE = "In Progress";
export const DEFAULT_TRACKER_HANDOFF_STATES = ["In Review", "Review"] as const;
export const DEFAULT_TRACKER_BLOCKED_STATE = "Needs decision";
export const DEFAULT_REQUIRE_CLAIM_BEFORE_AGENT = true;
export const DEFAULT_TERMINAL_STATES = [
  "Closed",
  "Cancelled",
  "Canceled",
  "Duplicate",
  "Done",
] as const;

export const DEFAULT_POLL_INTERVAL_MS = 30_000;
export const DEFAULT_ISSUE_COMMENTS_BETWEEN_TURNS = false;
export const DEFAULT_ISSUE_COMMENT_IGNORED_AUTHORS = Object.freeze(
  [],
) as readonly string[];
export const DEFAULT_WORKSPACE_ROOT = join(tmpdir(), "symphony_workspaces");
export const DEFAULT_WORKSPACE_RETENTION_STATES = Object.freeze(
  [],
) as readonly string[];
export const DEFAULT_WORKSPACE_RETENTION_STALE_AFTER_MS = null;
export const DEFAULT_WORKSPACE_RETENTION_CHECK_INTERVAL_MS = 86_400_000;
export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

export const DEFAULT_MAX_CONCURRENT_AGENTS = 10;
export const DEFAULT_MAX_TURNS = 20;
export const DEFAULT_MAX_RETRY_BACKOFF_MS = 300_000;
export const DEFAULT_MAX_CONCURRENT_AGENTS_BY_STATE = Object.freeze(
  {},
) as Readonly<Record<string, number>>;

export const DEFAULT_CODEX_COMMAND = "codex app-server";
export const DEFAULT_TURN_TIMEOUT_MS = 3_600_000;
export const DEFAULT_READ_TIMEOUT_MS = 5_000;
export const DEFAULT_STALL_TIMEOUT_MS = 300_000;
export const DEFAULT_COMMAND_CAPABILITIES = Object.freeze({}) as Readonly<
  Record<string, never>
>;
export const DEFAULT_GITHUB_CAPABILITY_REQUIRED = false;
export const DEFAULT_GITHUB_CREDENTIAL_SOURCE = "environment" as const;
export const DEFAULT_OBSERVABILITY_ENABLED = true;
export const DEFAULT_OBSERVABILITY_REFRESH_MS = 1_000;
export const DEFAULT_OBSERVABILITY_RENDER_INTERVAL_MS = 16;

export const DEFAULT_LINEAR_PAGE_SIZE = 50;
export const DEFAULT_LINEAR_NETWORK_TIMEOUT_MS = 30_000;
export const DEFAULT_NOTION_PAGE_SIZE = 100;
export const DEFAULT_NOTION_NETWORK_TIMEOUT_MS = 30_000;

export const WORKFLOW_FILENAME = "WORKFLOW.md";

export const SPEC_DEFAULTS = Object.freeze({
  tracker: {
    kind: DEFAULT_TRACKER_KIND,
    endpoint: DEFAULT_LINEAR_ENDPOINT,
    activeStates: DEFAULT_ACTIVE_STATES,
    claimState: DEFAULT_TRACKER_CLAIM_STATE,
    handoffStates: DEFAULT_TRACKER_HANDOFF_STATES,
    blockedState: DEFAULT_TRACKER_BLOCKED_STATE,
    requireClaimBeforeAgent: DEFAULT_REQUIRE_CLAIM_BEFORE_AGENT,
    terminalStates: DEFAULT_TERMINAL_STATES,
    adapterOptions: {},
    pageSize: DEFAULT_LINEAR_PAGE_SIZE,
    networkTimeoutMs: DEFAULT_LINEAR_NETWORK_TIMEOUT_MS,
  },
  polling: {
    intervalMs: DEFAULT_POLL_INTERVAL_MS,
    issueCommentsBetweenTurns: DEFAULT_ISSUE_COMMENTS_BETWEEN_TURNS,
    issueCommentIgnoredAuthors: DEFAULT_ISSUE_COMMENT_IGNORED_AUTHORS,
  },
  workspace: {
    root: DEFAULT_WORKSPACE_ROOT,
    retention: {
      states: DEFAULT_WORKSPACE_RETENTION_STATES,
      staleAfterMs: DEFAULT_WORKSPACE_RETENTION_STALE_AFTER_MS,
      checkIntervalMs: DEFAULT_WORKSPACE_RETENTION_CHECK_INTERVAL_MS,
    },
  },
  hooks: {
    timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
  },
  agent: {
    maxConcurrentAgents: DEFAULT_MAX_CONCURRENT_AGENTS,
    maxTurns: DEFAULT_MAX_TURNS,
    maxRetryBackoffMs: DEFAULT_MAX_RETRY_BACKOFF_MS,
    maxConcurrentAgentsByState: DEFAULT_MAX_CONCURRENT_AGENTS_BY_STATE,
  },
  codex: {
    command: DEFAULT_CODEX_COMMAND,
    turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS,
    readTimeoutMs: DEFAULT_READ_TIMEOUT_MS,
    stallTimeoutMs: DEFAULT_STALL_TIMEOUT_MS,
  },
  capabilities: {
    commands: DEFAULT_COMMAND_CAPABILITIES,
    github: {
      required: DEFAULT_GITHUB_CAPABILITY_REQUIRED,
      credentialSource: DEFAULT_GITHUB_CREDENTIAL_SOURCE,
    },
  },
  observability: {
    dashboardEnabled: DEFAULT_OBSERVABILITY_ENABLED,
    refreshMs: DEFAULT_OBSERVABILITY_REFRESH_MS,
    renderIntervalMs: DEFAULT_OBSERVABILITY_RENDER_INTERVAL_MS,
  },
} as const);

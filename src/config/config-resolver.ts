import { homedir } from "node:os";
import { isAbsolute, normalize, resolve, sep } from "node:path";

import type { WorkflowDefinition } from "../domain/model.js";
import { normalizeIssueState } from "../domain/model.js";
import { ERROR_CODES } from "../errors/codes.js";
import {
  getTrackerAdapterApiKeyEnv,
  validateTrackerAdapterConfig,
} from "../tracker/adapters.js";
import {
  DEFAULT_ACTIVE_STATES,
  DEFAULT_CODEX_COMMAND,
  DEFAULT_GITHUB_CAPABILITY_REQUIRED,
  DEFAULT_GITHUB_CREDENTIAL_SOURCE,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_ISSUE_COMMENTS_BETWEEN_TURNS,
  DEFAULT_ISSUE_COMMENT_IGNORED_AUTHORS,
  DEFAULT_LINEAR_ENDPOINT,
  DEFAULT_LINEAR_NETWORK_TIMEOUT_MS,
  DEFAULT_LINEAR_PAGE_SIZE,
  DEFAULT_MAX_CONCURRENT_AGENTS,
  DEFAULT_MAX_CONCURRENT_AGENTS_BY_STATE,
  DEFAULT_MAX_RETRY_BACKOFF_MS,
  DEFAULT_MAX_TURNS,
  DEFAULT_NOTION_ENDPOINT,
  DEFAULT_OBSERVABILITY_ENABLED,
  DEFAULT_OBSERVABILITY_REFRESH_MS,
  DEFAULT_OBSERVABILITY_RENDER_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_READ_TIMEOUT_MS,
  DEFAULT_REQUIRE_CLAIM_BEFORE_AGENT,
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_TERMINAL_STATES,
  DEFAULT_TRACKER_BLOCKED_STATE,
  DEFAULT_TRACKER_CLAIM_STATE,
  DEFAULT_TRACKER_HANDOFF_STATES,
  DEFAULT_TRACKER_KIND,
  DEFAULT_TURN_TIMEOUT_MS,
  DEFAULT_WORKSPACE_RETENTION_CHECK_INTERVAL_MS,
  DEFAULT_WORKSPACE_RETENTION_STALE_AFTER_MS,
  DEFAULT_WORKSPACE_RETENTION_STATES,
  DEFAULT_WORKSPACE_ROOT,
} from "./defaults.js";
import type {
  DispatchValidationResult,
  GithubCredentialSource,
  ResolvedWorkflowConfig,
} from "./types.js";

const TRACKER_COMMON_CONFIG_KEYS = new Set([
  "kind",
  "endpoint",
  "api_key",
  "project_slug",
  "active_states",
  "claim_state",
  "handoff_states",
  "blocked_state",
  "require_claim_before_agent",
  "terminal_states",
]);

const DAY_MS = 86_400_000;
export function resolveWorkflowConfig(
  workflow: WorkflowDefinition & { workflowPath: string },
  environment: NodeJS.ProcessEnv = process.env,
): ResolvedWorkflowConfig {
  const config = workflow.config;
  const tracker = asRecord(config.tracker);
  const polling = asRecord(config.polling);
  const workspace = asRecord(config.workspace);
  const workspaceRetention = asRecord(workspace.retention);
  const hooks = asRecord(config.hooks);
  const agent = asRecord(config.agent);
  const codex = asRecord(config.codex);
  const capabilities = asRecord(config.capabilities);
  const githubCapability = asRecord(capabilities.github);
  const server = asRecord(config.server);
  const observability = asRecord(config.observability);
  const trackerKind = readString(tracker.kind) ?? DEFAULT_TRACKER_KIND;
  const trackerApiKeyEnv = getTrackerAdapterApiKeyEnv(trackerKind);

  return {
    workflowPath: workflow.workflowPath,
    promptTemplate: workflow.promptTemplate,
    tracker: {
      kind: trackerKind,
      endpoint:
        readString(tracker.endpoint) ?? defaultTrackerEndpoint(trackerKind),
      apiKey:
        resolveEnvReference(readString(tracker.api_key), environment) ??
        (trackerApiKeyEnv === null ? null : environment[trackerApiKeyEnv]) ??
        null,
      projectSlug: readString(tracker.project_slug),
      activeStates: readStringList(
        tracker.active_states,
        DEFAULT_ACTIVE_STATES,
      ),
      claimState:
        readNullableString(tracker.claim_state) ?? DEFAULT_TRACKER_CLAIM_STATE,
      handoffStates: readStringList(
        tracker.handoff_states,
        DEFAULT_TRACKER_HANDOFF_STATES,
      ),
      blockedState:
        readNullableString(tracker.blocked_state) ??
        DEFAULT_TRACKER_BLOCKED_STATE,
      requireClaimBeforeAgent:
        readBoolean(tracker.require_claim_before_agent) ??
        DEFAULT_REQUIRE_CLAIM_BEFORE_AGENT,
      terminalStates: readStringList(
        tracker.terminal_states,
        DEFAULT_TERMINAL_STATES,
      ),
      adapterOptions: readAdapterOptions(tracker, environment),
    },
    polling: {
      intervalMs: readInteger(polling.interval_ms) ?? DEFAULT_POLL_INTERVAL_MS,
      issueCommentsBetweenTurns:
        readBoolean(polling.issue_comments_between_turns) ??
        DEFAULT_ISSUE_COMMENTS_BETWEEN_TURNS,
      issueCommentIgnoredAuthors: readStringList(
        polling.issue_comment_ignored_authors,
        DEFAULT_ISSUE_COMMENT_IGNORED_AUTHORS,
      ),
    },
    workspace: {
      root:
        resolvePathValue(
          readString(workspace.root),
          workflow.workflowPath,
          environment,
        ) ?? DEFAULT_WORKSPACE_ROOT,
      retention: {
        states: readStringList(
          workspaceRetention.states,
          DEFAULT_WORKSPACE_RETENTION_STATES,
        ),
        staleAfterMs:
          multiplyPositiveInteger(
            workspaceRetention.stale_after_days,
            DAY_MS,
          ) ?? DEFAULT_WORKSPACE_RETENTION_STALE_AFTER_MS,
        checkIntervalMs:
          readPositiveInteger(workspaceRetention.check_interval_ms) ??
          DEFAULT_WORKSPACE_RETENTION_CHECK_INTERVAL_MS,
      },
    },
    hooks: {
      afterCreate: readScript(hooks.after_create),
      beforeRun: readScript(hooks.before_run),
      afterRun: readScript(hooks.after_run),
      beforeRemove: readScript(hooks.before_remove),
      timeoutMs:
        readPositiveInteger(hooks.timeout_ms) ?? DEFAULT_HOOK_TIMEOUT_MS,
    },
    agent: {
      maxConcurrentAgents:
        readPositiveInteger(agent.max_concurrent_agents) ??
        DEFAULT_MAX_CONCURRENT_AGENTS,
      maxTurns: readPositiveInteger(agent.max_turns) ?? DEFAULT_MAX_TURNS,
      maxRetryBackoffMs:
        readPositiveInteger(agent.max_retry_backoff_ms) ??
        DEFAULT_MAX_RETRY_BACKOFF_MS,
      maxConcurrentAgentsByState: readStateConcurrencyMap(
        agent.max_concurrent_agents_by_state,
      ),
    },
    codex: {
      command: readString(codex.command) ?? DEFAULT_CODEX_COMMAND,
      approvalPolicy: codex.approval_policy,
      threadSandbox: codex.thread_sandbox,
      turnSandboxPolicy: codex.turn_sandbox_policy,
      turnTimeoutMs:
        readPositiveInteger(codex.turn_timeout_ms) ?? DEFAULT_TURN_TIMEOUT_MS,
      readTimeoutMs:
        readPositiveInteger(codex.read_timeout_ms) ?? DEFAULT_READ_TIMEOUT_MS,
      stallTimeoutMs:
        readInteger(codex.stall_timeout_ms) ?? DEFAULT_STALL_TIMEOUT_MS,
    },
    capabilities: {
      github: {
        required:
          readBoolean(githubCapability.required) ??
          DEFAULT_GITHUB_CAPABILITY_REQUIRED,
        credentialSource: readGithubCredentialSource(
          githubCapability.credential_source,
        ),
      },
    },
    server: {
      port: readNonNegativeInteger(server.port),
    },
    observability: {
      dashboardEnabled:
        readBoolean(observability.dashboard_enabled) ??
        DEFAULT_OBSERVABILITY_ENABLED,
      refreshMs:
        readPositiveInteger(observability.refresh_ms) ??
        DEFAULT_OBSERVABILITY_REFRESH_MS,
      renderIntervalMs:
        readPositiveInteger(observability.render_interval_ms) ??
        DEFAULT_OBSERVABILITY_RENDER_INTERVAL_MS,
    },
  };
}

export function validateDispatchConfig(
  config: ResolvedWorkflowConfig,
): DispatchValidationResult {
  const trackerValidation = validateTrackerAdapterConfig(config);
  if (trackerValidation !== null) {
    return invalid(trackerValidation.code, trackerValidation.message);
  }

  if (config.codex.command.trim() === "") {
    return invalid(
      ERROR_CODES.configInvalid,
      "codex.command must be present and non-empty before dispatch.",
    );
  }

  const retention = config.workspace.retention;
  if (retention !== undefined) {
    const configuredStates = retention.states.length > 0;
    const configuredAge = retention.staleAfterMs !== null;
    if (configuredStates !== configuredAge) {
      return invalid(
        ERROR_CODES.configInvalid,
        "workspace.retention.states and workspace.retention.stale_after_days must be configured together.",
      );
    }

    const forbiddenStates = new Set(
      [...config.tracker.activeStates, ...config.tracker.terminalStates].map(
        normalizeIssueState,
      ),
    );
    if (
      retention.states.some((state) =>
        forbiddenStates.has(normalizeIssueState(state)),
      )
    ) {
      return invalid(
        ERROR_CODES.configInvalid,
        "workspace.retention.states must not overlap active or terminal tracker states.",
      );
    }
  }

  return { ok: true };
}

function invalid(code: string, message: string): DispatchValidationResult {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  return value;
}

function readNullableString(value: unknown): string | null {
  const text = readString(value);
  if (text === null) {
    return null;
  }

  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readScript(value: unknown): string | null {
  const script = readString(value);
  if (script === null) {
    return null;
  }

  return script === "" ? null : script;
}

function readAdapterOptions(
  tracker: Record<string, unknown>,
  environment: NodeJS.ProcessEnv,
): Readonly<Record<string, unknown>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(tracker)
        .filter(([key]) => !TRACKER_COMMON_CONFIG_KEYS.has(key))
        .map(([key, value]) => [
          key,
          resolveTrackerAdapterOptionValue(value, environment),
        ]),
    ),
  );
}

function readInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }

  return null;
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }

  return null;
}

function readGithubCredentialSource(value: unknown): GithubCredentialSource {
  if (typeof value !== "string") {
    return DEFAULT_GITHUB_CREDENTIAL_SOURCE;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "gh_auth_token"
    ? "gh_auth_token"
    : DEFAULT_GITHUB_CREDENTIAL_SOURCE;
}

function readPositiveInteger(value: unknown): number | null {
  const parsed = readInteger(value);
  if (parsed === null || parsed <= 0) {
    return null;
  }

  return parsed;
}

function multiplyPositiveInteger(
  value: unknown,
  multiplier: number,
): number | null {
  const parsed = readPositiveInteger(value);
  if (parsed === null) {
    return null;
  }

  const result = parsed * multiplier;
  return Number.isSafeInteger(result) ? result : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  const parsed = readInteger(value);
  if (parsed === null || parsed < 0) {
    return null;
  }

  return parsed;
}

function readStringList(value: unknown, fallback: readonly string[]): string[] {
  if (Array.isArray(value)) {
    const items = value.filter(
      (entry): entry is string => typeof entry === "string",
    );
    if (items.length > 0) {
      return items.map((entry) => entry.trim()).filter((entry) => entry !== "");
    }
  }

  if (typeof value === "string") {
    const items = value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    if (items.length > 0) {
      return items;
    }
  }

  return [...fallback];
}

function defaultTrackerEndpoint(trackerKind: string): string {
  return normalizeIssueState(trackerKind) === "notion"
    ? DEFAULT_NOTION_ENDPOINT
    : DEFAULT_LINEAR_ENDPOINT;
}

function resolveTrackerAdapterOptionValue(
  value: unknown,
  environment: NodeJS.ProcessEnv,
): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const resolved = resolveEnvReference(value, environment);
  if (resolved !== null) {
    return resolved;
  }

  return value.startsWith("$") ? null : value;
}

function readStateConcurrencyMap(
  value: unknown,
): Readonly<Record<string, number>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_MAX_CONCURRENT_AGENTS_BY_STATE;
  }

  const normalizedEntries = Object.entries(value).flatMap(([state, limit]) => {
    const parsedLimit = readPositiveInteger(limit);
    if (parsedLimit === null) {
      return [];
    }

    return [[normalizeIssueState(state), parsedLimit] as const];
  });

  return Object.freeze(Object.fromEntries(normalizedEntries));
}

function resolveEnvReference(
  value: string | null,
  environment: NodeJS.ProcessEnv,
): string | null {
  if (!value) {
    return null;
  }

  if (!value.startsWith("$")) {
    return value;
  }

  const envName = value.slice(1);
  const resolvedValue = environment[envName];
  if (!resolvedValue || resolvedValue.trim() === "") {
    return null;
  }

  return resolvedValue;
}

function resolvePathValue(
  value: string | null,
  workflowPath: string,
  environment: NodeJS.ProcessEnv,
): string | null {
  const rawPath = resolveEnvReference(value, environment);
  if (!rawPath) {
    return null;
  }

  let expanded = rawPath.startsWith("~")
    ? `${homedir()}${rawPath.slice(1)}`
    : rawPath;

  if (
    !expanded.includes(sep) &&
    !expanded.includes("/") &&
    !expanded.includes("\\")
  ) {
    return expanded;
  }

  if (isAbsolute(expanded)) {
    return normalize(expanded);
  }

  expanded = resolve(resolve(workflowPath, ".."), expanded);
  return normalize(expanded);
}

export const LINEAR_DEFAULTS = Object.freeze({
  endpoint: DEFAULT_LINEAR_ENDPOINT,
  pageSize: DEFAULT_LINEAR_PAGE_SIZE,
  networkTimeoutMs: DEFAULT_LINEAR_NETWORK_TIMEOUT_MS,
});

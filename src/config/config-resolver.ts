import { homedir } from "node:os";
import { isAbsolute, normalize, resolve, sep } from "node:path";

import { isSafeExecutableBasename } from "../capabilities/external-command.js";
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
  DEFAULT_COMMAND_CAPABILITIES,
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
  WorkflowCommandCapabilities,
  WorkflowCommandHook,
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

const COMMAND_DECLARATION_KEYS = new Set(["hooks", "agent", "probe_args"]);
const COMMAND_HOOKS = new Map<string, WorkflowCommandHook>([
  ["after_create", "afterCreate"],
  ["before_run", "beforeRun"],
  ["after_run", "afterRun"],
  ["before_remove", "beforeRemove"],
]);
const RESOLVED_COMMAND_HOOKS = new Set(COMMAND_HOOKS.values());
const RESOLVED_COMMAND_DECLARATION_KEYS = new Set([
  "hooks",
  "agent",
  "probeArgs",
]);
const COMMAND_CAPABILITY_VALIDATION_ERROR = Symbol(
  "commandCapabilityValidationError",
);
const DAY_MS = 86_400_000;
type ResolvedConfigWithCommandValidation = ResolvedWorkflowConfig & {
  [COMMAND_CAPABILITY_VALIDATION_ERROR]?: string;
};

export function resolveWorkflowConfig(
  workflow: WorkflowDefinition & { workflowPath: string },
  environment: NodeJS.ProcessEnv = process.env,
): ResolvedWorkflowConfig {
  const config = workflow.config;
  const commandCapabilities = readCommandCapabilities(config);
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

  const resolved: ResolvedWorkflowConfig = {
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
      commands: commandCapabilities.commands,
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

  if (commandCapabilities.error !== null) {
    Object.defineProperty(resolved, COMMAND_CAPABILITY_VALIDATION_ERROR, {
      value: commandCapabilities.error,
      enumerable: true,
    });
  }

  return resolved;
}

export function validateDispatchConfig(
  config: ResolvedWorkflowConfig,
): DispatchValidationResult {
  const commandCapabilityError =
    (config as ResolvedConfigWithCommandValidation)[
      COMMAND_CAPABILITY_VALIDATION_ERROR
    ] ?? null;
  if (commandCapabilityError !== null) {
    return invalid(ERROR_CODES.configInvalid, commandCapabilityError);
  }
  const resolvedCommandError = validateResolvedCommandCapabilities(
    config.capabilities.commands,
  );
  if (resolvedCommandError !== null) {
    return invalid(ERROR_CODES.configInvalid, resolvedCommandError);
  }

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

function validateResolvedCommandCapabilities(
  value: WorkflowCommandCapabilities | undefined,
): string | null {
  if (value === undefined) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "capabilities.commands must be an executable-basename map.";
  }

  for (const [command, requirement] of Object.entries(value)) {
    if (!isSafeExecutableBasename(command)) {
      return "capabilities.commands contains an unsafe executable basename.";
    }
    if (
      !requirement ||
      typeof requirement !== "object" ||
      !Array.isArray(requirement.hooks) ||
      typeof requirement.agent !== "boolean" ||
      !Array.isArray(requirement.probeArgs)
    ) {
      return "capabilities.commands contains a malformed resolved declaration.";
    }
    if (
      Object.keys(requirement).some(
        (key) => !RESOLVED_COMMAND_DECLARATION_KEYS.has(key),
      )
    ) {
      return "A capabilities.commands declaration contains an unknown field.";
    }

    const seenHooks = new Set<WorkflowCommandHook>();
    for (const hook of requirement.hooks) {
      if (!RESOLVED_COMMAND_HOOKS.has(hook) || seenHooks.has(hook)) {
        return "capabilities.commands hooks must be a unique list of supported hook names.";
      }
      seenHooks.add(hook);
    }
    if (
      requirement.probeArgs.some(
        (argument) =>
          typeof argument !== "string" || containsAsciiControl(argument),
      )
    ) {
      return "capabilities.commands probe_args must be a list of control-character-free strings.";
    }
    if (requirement.hooks.length === 0 && !requirement.agent) {
      return "Each capabilities.commands declaration must enable a hook or agent boundary.";
    }
  }

  return null;
}

function readCommandCapabilities(config: Record<string, unknown>): {
  commands: WorkflowCommandCapabilities;
  error: string | null;
} {
  if (!hasOwn(config, "capabilities")) {
    return { commands: DEFAULT_COMMAND_CAPABILITIES, error: null };
  }

  const capabilities = strictRecord(config.capabilities);
  if (capabilities === null) {
    return invalidCommandCapabilities(
      "capabilities must be an object when provided.",
    );
  }
  if (!hasOwn(capabilities, "commands")) {
    return { commands: DEFAULT_COMMAND_CAPABILITIES, error: null };
  }

  const commandMap = strictRecord(capabilities.commands);
  if (commandMap === null) {
    return invalidCommandCapabilities(
      "capabilities.commands must be an executable-basename map.",
    );
  }
  if (Object.keys(commandMap).length === 0) {
    return { commands: DEFAULT_COMMAND_CAPABILITIES, error: null };
  }

  const normalized: Record<string, WorkflowCommandCapabilities[string]> = {};
  for (const [command, rawDeclaration] of Object.entries(commandMap)) {
    if (!isSafeExecutableBasename(command)) {
      return invalidCommandCapabilities(
        "capabilities.commands contains an unsafe executable basename.",
      );
    }

    const declaration = strictRecord(rawDeclaration);
    if (declaration === null) {
      return invalidCommandCapabilities(
        "Each capabilities.commands declaration must be an object.",
      );
    }
    if (
      Object.keys(declaration).some((key) => !COMMAND_DECLARATION_KEYS.has(key))
    ) {
      return invalidCommandCapabilities(
        "A capabilities.commands declaration contains an unknown field.",
      );
    }

    const hooks = readCommandHooks(declaration);
    if (hooks === null) {
      return invalidCommandCapabilities(
        "capabilities.commands hooks must be a unique list of supported hook names.",
      );
    }
    const agent =
      declaration.agent === undefined
        ? false
        : typeof declaration.agent === "boolean"
          ? declaration.agent
          : null;
    if (agent === null) {
      return invalidCommandCapabilities(
        "capabilities.commands agent must be a boolean.",
      );
    }
    const probeArgs = readProbeArgs(declaration.probe_args);
    if (probeArgs === null) {
      return invalidCommandCapabilities(
        "capabilities.commands probe_args must be a list of control-character-free strings.",
      );
    }
    if (hooks.length === 0 && !agent) {
      return invalidCommandCapabilities(
        "Each capabilities.commands declaration must enable a hook or agent boundary.",
      );
    }

    normalized[command] = Object.freeze({
      hooks: Object.freeze(hooks),
      agent,
      probeArgs: Object.freeze(probeArgs),
    });
  }

  return {
    commands: Object.freeze(normalized),
    error: null,
  };
}

function readCommandHooks(
  declaration: Record<string, unknown>,
): WorkflowCommandHook[] | null {
  if (declaration.hooks === undefined) {
    return [];
  }
  if (!Array.isArray(declaration.hooks)) {
    return null;
  }

  const hooks: WorkflowCommandHook[] = [];
  const seen = new Set<WorkflowCommandHook>();
  for (const rawHook of declaration.hooks) {
    if (typeof rawHook !== "string") {
      return null;
    }
    const hook = COMMAND_HOOKS.get(rawHook);
    if (hook === undefined || seen.has(hook)) {
      return null;
    }
    hooks.push(hook);
    seen.add(hook);
  }
  return hooks;
}

function readProbeArgs(value: unknown): string[] | null {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const args: string[] = [];
  for (const argument of value) {
    if (typeof argument !== "string" || containsAsciiControl(argument)) {
      return null;
    }
    args.push(argument);
  }
  return args;
}

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }

  return false;
}

function invalidCommandCapabilities(error: string): {
  commands: WorkflowCommandCapabilities;
  error: string;
} {
  return {
    commands: DEFAULT_COMMAND_CAPABILITIES,
    error,
  };
}

function strictRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
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

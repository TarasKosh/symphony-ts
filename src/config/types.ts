export interface WorkflowHooksConfig {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
  timeoutMs: number;
}

export interface WorkflowTrackerConfig {
  kind: string | null;
  endpoint: string;
  apiKey: string | null;
  projectSlug: string | null;
  activeStates: string[];
  claimState: string | null;
  handoffStates: string[];
  blockedState: string | null;
  requireClaimBeforeAgent: boolean;
  terminalStates: string[];
  adapterOptions: Readonly<Record<string, unknown>>;
}

export interface WorkflowPollingConfig {
  intervalMs: number;
  /** Optional for backwards-compatible programmatic construction. */
  issueCommentsBetweenTurns?: boolean;
  /** Optional for backwards-compatible programmatic construction. */
  issueCommentIgnoredAuthors?: string[];
}

export interface WorkflowWorkspaceRetentionConfig {
  states: string[];
  staleAfterMs: number | null;
  checkIntervalMs: number;
}

export interface WorkflowWorkspaceConfig {
  root: string;
  /** Optional for backwards-compatible programmatic construction. */
  retention?: WorkflowWorkspaceRetentionConfig;
}

export interface WorkflowAgentConfig {
  maxConcurrentAgents: number;
  maxTurns: number;
  maxRetryBackoffMs: number;
  maxConcurrentAgentsByState: Readonly<Record<string, number>>;
}

export interface WorkflowCodexConfig {
  command: string;
  approvalPolicy: unknown;
  threadSandbox: unknown;
  turnSandboxPolicy: unknown;
  turnTimeoutMs: number;
  readTimeoutMs: number;
  stallTimeoutMs: number;
}

export type WorkflowCommandHook =
  | "afterCreate"
  | "beforeRun"
  | "afterRun"
  | "beforeRemove";

export interface WorkflowCommandCapability {
  hooks: readonly WorkflowCommandHook[];
  agent: boolean;
  probeArgs: readonly string[];
}

export type WorkflowCommandCapabilities = Readonly<
  Record<string, WorkflowCommandCapability>
>;

export interface WorkflowCapabilitiesConfig {
  /**
   * Optional only for backwards-compatible programmatic construction.
   * The workflow resolver always supplies the frozen empty default.
   */
  commands?: WorkflowCommandCapabilities;
  github: {
    required: boolean;
    credentialSource: GithubCredentialSource;
  };
}

export type GithubCredentialSource = "environment" | "gh_auth_token";

export interface WorkflowServerConfig {
  port: number | null;
}

export interface WorkflowObservabilityConfig {
  dashboardEnabled: boolean;
  refreshMs: number;
  renderIntervalMs: number;
}

export interface ResolvedWorkflowConfig {
  workflowPath: string;
  promptTemplate: string;
  tracker: WorkflowTrackerConfig;
  polling: WorkflowPollingConfig;
  workspace: WorkflowWorkspaceConfig;
  hooks: WorkflowHooksConfig;
  agent: WorkflowAgentConfig;
  codex: WorkflowCodexConfig;
  capabilities: WorkflowCapabilitiesConfig;
  server: WorkflowServerConfig;
  observability: WorkflowObservabilityConfig;
}

export interface DispatchValidationFailure {
  code: string;
  message: string;
}

export type DispatchValidationResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      error: DispatchValidationFailure;
    };

export interface WorkflowSnapshot {
  definition: {
    workflowPath: string;
    config: Record<string, unknown>;
    promptTemplate: string;
  };
  config: ResolvedWorkflowConfig;
  dispatchValidation: DispatchValidationResult;
  loadedAt: string;
}

export type WorkflowReloadReason = "manual" | "filesystem_event";

export type WorkflowReloadResult =
  | {
      ok: true;
      reason: WorkflowReloadReason;
      previousSnapshot: WorkflowSnapshot;
      snapshot: WorkflowSnapshot;
    }
  | {
      ok: false;
      reason: WorkflowReloadReason;
      currentSnapshot: WorkflowSnapshot;
      error: unknown;
    };

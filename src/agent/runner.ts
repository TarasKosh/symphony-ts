import { rm } from "node:fs/promises";

import {
  type CapabilityFailureMetadata,
  CodexExternalCommandProbe,
  type ExternalCommandProbe,
  getCommandCapabilities,
} from "../capabilities/external-command.js";
import {
  CodexAppServerClient,
  type CodexClientEvent,
  type CodexCommandExecInput,
  type CodexCommandExecResult,
  type CodexDynamicTool,
  type CodexTurnResult,
} from "../codex/app-server-client.js";
import type { ResolvedWorkflowConfig } from "../config/types.js";
import {
  type Issue,
  type LiveSession,
  type RunAttempt,
  type RunAttemptPhase,
  type Workspace,
  createEmptyLiveSession,
  normalizeIssueState,
} from "../domain/model.js";
import { applyCodexEventToSession } from "../logging/session-metrics.js";
import { createTrackerDynamicTools } from "../tracker/adapters.js";
import {
  type IssueTracker,
  type TrackerBlockerRunResult,
  type TrackerHandoffRunResult,
  type TrackerIssueContext,
  type TrackerIssueContextEntry,
  type TrackerLifecycleConfig,
  supportsTrackerBlockWrite,
  supportsTrackerIssueContextRead,
  supportsTrackerIssueNoteWrite,
  supportsTrackerLifecycleWrite,
} from "../tracker/tracker.js";
import { WorkspaceHookRunner } from "../workspace/hooks.js";
import { validateWorkspaceCwd } from "../workspace/path-safety.js";
import { WorkspaceManager } from "../workspace/workspace-manager.js";
import { createSymphonyBlockDynamicTool } from "./block-tool.js";
import {
  GhGithubCapabilityProbe,
  type GithubCapabilityProbe,
} from "./github-capability.js";
import {
  GhAuthTokenCredentialProvider,
  type GithubCredentialProvider,
} from "./github-credential.js";
import { createSymphonyHandoffDynamicTool } from "./handoff-tool.js";
import {
  type BuildTurnPromptInput,
  buildTurnPrompt,
} from "./prompt-builder.js";
import { prepareTurnSandboxPolicy } from "./sandbox-policy.js";
import {
  createSymphonyTicketNoteDynamicTool,
  createSymphonyTicketReadDynamicTool,
} from "./ticket-tools.js";

export interface AgentRunnerEvent extends CodexClientEvent {
  issueId: string;
  issueIdentifier: string;
  attempt: number | null;
  workspacePath: string;
  turnCount: number;
}

export interface AgentRunnerCodexClient {
  execCommand(input: CodexCommandExecInput): Promise<CodexCommandExecResult>;
  configureDynamicTools(dynamicTools: CodexDynamicTool[]): void;
  startSession(input: {
    prompt: string;
    title: string;
  }): Promise<CodexTurnResult>;
  continueTurn(prompt: string, title: string): Promise<CodexTurnResult>;
  close(): Promise<void>;
}

export interface AgentRunnerCodexClientFactoryInput {
  command: string;
  cwd: string;
  approvalPolicy: unknown;
  threadSandbox: unknown;
  turnSandboxPolicy: unknown;
  readTimeoutMs: number;
  turnTimeoutMs: number;
  stallTimeoutMs: number;
  dynamicTools: CodexDynamicTool[];
  environment: NodeJS.ProcessEnv;
  onEvent: (event: CodexClientEvent) => void;
}

export interface AgentRunnerOptions {
  config: ResolvedWorkflowConfig;
  tracker: IssueTracker;
  workspaceManager?: WorkspaceManager;
  hooks?: WorkspaceHookRunner;
  createCodexClient?: (
    input: AgentRunnerCodexClientFactoryInput,
  ) => AgentRunnerCodexClient;
  fetchFn?: typeof fetch;
  environment?: NodeJS.ProcessEnv;
  githubCapabilityProbe?: GithubCapabilityProbe;
  githubCredentialProvider?: GithubCredentialProvider;
  externalCommandCapabilityProbe?: ExternalCommandProbe;
  onEvent?: (event: AgentRunnerEvent) => void;
}

export interface AgentRunInput {
  issue: Issue;
  attempt: number | null;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  issue: Issue;
  workspace: Workspace;
  runAttempt: RunAttempt;
  liveSession: LiveSession;
  turnsCompleted: number;
  lastTurn: CodexTurnResult | null;
  rateLimits: Record<string, unknown> | null;
  handoff: TrackerHandoffRunResult | null;
  blocker: TrackerBlockerRunResult | null;
}

export class AgentRunnerError extends Error {
  readonly code: string | undefined;
  readonly status: RunAttemptPhase;
  readonly failedPhase: RunAttemptPhase;
  readonly issue: Issue;
  readonly workspace: Workspace | null;
  readonly runAttempt: RunAttempt;
  readonly liveSession: LiveSession;
  readonly capability: string | undefined;
  readonly capabilityFailure: CapabilityFailureMetadata | undefined;

  constructor(input: {
    message: string;
    code?: string;
    status: RunAttemptPhase;
    failedPhase: RunAttemptPhase;
    issue: Issue;
    workspace: Workspace | null;
    runAttempt: RunAttempt;
    liveSession: LiveSession;
    capability?: string;
    capabilityFailure?: CapabilityFailureMetadata;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "AgentRunnerError";
    this.code = input.code;
    this.status = input.status;
    this.failedPhase = input.failedPhase;
    this.issue = input.issue;
    this.workspace = input.workspace;
    this.runAttempt = input.runAttempt;
    this.liveSession = input.liveSession;
    this.capability = input.capability;
    this.capabilityFailure = input.capabilityFailure;
  }
}

export class AgentRunner {
  private readonly config: ResolvedWorkflowConfig;

  private readonly tracker: IssueTracker;

  private readonly workspaceManager: WorkspaceManager;

  private readonly hooks: WorkspaceHookRunner;

  private readonly createCodexClient: (
    input: AgentRunnerCodexClientFactoryInput,
  ) => AgentRunnerCodexClient;

  private readonly fetchFn: typeof fetch | undefined;

  private readonly environment: NodeJS.ProcessEnv;

  private readonly githubCapabilityProbe: GithubCapabilityProbe;

  private readonly githubCredentialProvider: GithubCredentialProvider;

  private readonly externalCommandCapabilityProbe: ExternalCommandProbe;

  private readonly onEvent: ((event: AgentRunnerEvent) => void) | undefined;

  constructor(options: AgentRunnerOptions) {
    this.config = options.config;
    this.tracker = options.tracker;
    this.environment = options.environment ?? process.env;
    this.hooks =
      options.hooks ??
      options.workspaceManager?.hookRunner ??
      new WorkspaceHookRunner({
        config: options.config.hooks,
        commands: getCommandCapabilities(options.config),
        environment: this.environment,
      });
    this.workspaceManager =
      options.workspaceManager ??
      new WorkspaceManager({
        root: options.config.workspace.root,
        hooks: this.hooks,
      });
    this.createCodexClient =
      options.createCodexClient ?? createDefaultCodexClient;
    this.fetchFn = options.fetchFn;
    this.githubCapabilityProbe =
      options.githubCapabilityProbe ?? new GhGithubCapabilityProbe();
    this.githubCredentialProvider =
      options.githubCredentialProvider ?? new GhAuthTokenCredentialProvider();
    this.externalCommandCapabilityProbe =
      options.externalCommandCapabilityProbe ?? new CodexExternalCommandProbe();
    this.onEvent = options.onEvent;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    let issue = cloneIssue(input.issue);
    let workspace: Workspace | null = null;
    let client: AgentRunnerCodexClient | null = null;
    let lastTurn: CodexTurnResult | null = null;
    let rateLimits: Record<string, unknown> | null = null;
    const handoffRef: { current: TrackerHandoffRunResult | null } = {
      current: null,
    };
    const blockerRef: { current: TrackerBlockerRunResult | null } = {
      current: null,
    };
    const liveSession = createEmptyLiveSession();
    const runAttempt: RunAttempt = {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      attempt: input.attempt,
      workspacePath: "",
      startedAt: new Date().toISOString(),
      status: "preparing_workspace",
    };
    const abortController = createAgentAbortController(input.signal);

    try {
      abortController.throwIfAborted({
        issue,
        workspace,
        runAttempt,
        liveSession,
      });

      workspace = await this.workspaceManager.createForIssue(issue.id);
      runAttempt.workspacePath = validateWorkspaceCwd({
        cwd: workspace.path,
        workspacePath: workspace.path,
        workspaceRoot: this.config.workspace.root,
      });
      await cleanupWorkspaceArtifacts(workspace.path);
      const workspacePath = workspace.path;

      await this.hooks.run({
        name: "beforeRun",
        workspacePath: workspace.path,
      });

      const turnSandboxPolicy = prepareTurnSandboxPolicy(
        this.config.codex.turnSandboxPolicy,
        workspace.path,
      );
      let codexEnvironment = this.environment;
      const agentCommands = Object.entries(
        getCommandCapabilities(this.config),
      ).filter(([, requirement]) => requirement.agent);

      if (this.config.capabilities.github.required) {
        codexEnvironment = await this.resolveGithubEnvironment();
      }

      if (
        agentCommands.length > 0 ||
        this.config.capabilities.github.required
      ) {
        runAttempt.status = "validating_capabilities";
        client = this.createCodexClient({
          command: this.config.codex.command,
          cwd: workspace.path,
          approvalPolicy: this.config.codex.approvalPolicy,
          threadSandbox: this.config.codex.threadSandbox,
          turnSandboxPolicy,
          readTimeoutMs: this.config.codex.readTimeoutMs,
          turnTimeoutMs: this.config.codex.turnTimeoutMs,
          stallTimeoutMs: this.config.codex.stallTimeoutMs,
          dynamicTools: [],
          environment: codexEnvironment,
          onEvent: (event) => {
            applyCodexEventToSession(liveSession, event);
            this.onEvent?.({
              ...event,
              issueId: issue.id,
              issueIdentifier: issue.identifier,
              attempt: input.attempt,
              workspacePath,
              turnCount: liveSession.turnCount,
            });
          },
        });
        abortController.bindClient(client);
        for (const [command, requirement] of agentCommands) {
          await this.externalCommandCapabilityProbe.probe({
            command,
            probeArgs: requirement.probeArgs,
            workspacePath: workspace.path,
            sandboxPolicy: turnSandboxPolicy,
            executor: client,
          });
        }

        if (this.config.capabilities.github.required) {
          await this.githubCapabilityProbe.probe({
            workspacePath: workspace.path,
            sandboxPolicy: turnSandboxPolicy,
            executor: client,
          });
        }
      }

      issue = await this.claimIssueBeforeAgent(issue);
      runAttempt.status = "blocking_issue";
      const preflightBlocker = await this.blockIssueBeforeAgentIfUnready(issue);
      if (preflightBlocker !== null) {
        blockerRef.current = preflightBlocker;
        if (preflightBlocker.status === "succeeded") {
          issue = {
            ...issue,
            identifier:
              preflightBlocker.result.issue.identifier.trim().length > 0
                ? preflightBlocker.result.issue.identifier
                : issue.identifier,
            state: preflightBlocker.result.issue.state,
          };
          runAttempt.status = "succeeded";
        } else {
          runAttempt.status = "failed";
          runAttempt.error = preflightBlocker.error;
        }

        return {
          issue,
          workspace,
          runAttempt,
          liveSession,
          turnsCompleted: 0,
          lastTurn,
          rateLimits,
          handoff: handoffRef.current,
          blocker: blockerRef.current,
        };
      }

      runAttempt.status = "launching_agent_process";
      const dynamicTools = this.createDynamicTools(
        issue,
        (result) => {
          handoffRef.current = result;
        },
        (result) => {
          blockerRef.current = result;
        },
      );
      if (client === null) {
        client = this.createCodexClient({
          command: this.config.codex.command,
          cwd: workspace.path,
          approvalPolicy: this.config.codex.approvalPolicy,
          threadSandbox: this.config.codex.threadSandbox,
          turnSandboxPolicy,
          readTimeoutMs: this.config.codex.readTimeoutMs,
          turnTimeoutMs: this.config.codex.turnTimeoutMs,
          stallTimeoutMs: this.config.codex.stallTimeoutMs,
          dynamicTools,
          environment: codexEnvironment,
          onEvent: (event) => {
            applyCodexEventToSession(liveSession, event);
            this.onEvent?.({
              ...event,
              issueId: issue.id,
              issueIdentifier: issue.identifier,
              attempt: input.attempt,
              workspacePath,
              turnCount: liveSession.turnCount,
            });
          },
        });
        abortController.bindClient(client);
      } else {
        client.configureDynamicTools(dynamicTools);
      }

      const trackerCommentCursor =
        await this.initializeTrackerCommentCursor(issue);
      let trackerCommentsForTurn: TrackerIssueContextEntry[] = [];

      for (
        let turnNumber = 1;
        turnNumber <= this.config.agent.maxTurns;
        turnNumber += 1
      ) {
        abortController.throwIfAborted({
          issue,
          workspace,
          runAttempt,
          liveSession,
        });
        runAttempt.status = "building_prompt";
        const prompt = await buildTurnPrompt({
          workflow: {
            promptTemplate: this.config.promptTemplate,
          },
          issue,
          attempt: input.attempt,
          turnNumber,
          maxTurns: this.config.agent.maxTurns,
          trackerComments: trackerCommentsForTurn,
        });
        const title = `${issue.identifier}: ${issue.title}`;

        runAttempt.status =
          turnNumber === 1 ? "initializing_session" : "streaming_turn";
        lastTurn =
          turnNumber === 1
            ? await client.startSession({ prompt, title })
            : await client.continueTurn(prompt, title);
        rateLimits = lastTurn.rateLimits;

        applyCodexEventToSession(liveSession, {
          event:
            lastTurn.status === "completed"
              ? "turn_completed"
              : lastTurn.status === "failed"
                ? "turn_failed"
                : "turn_cancelled",
          timestamp: new Date().toISOString(),
          codexAppServerPid: liveSession.codexAppServerPid,
          sessionId: lastTurn.sessionId,
          threadId: lastTurn.threadId,
          turnId: lastTurn.turnId,
          ...(lastTurn.usage === null ? {} : { usage: lastTurn.usage }),
          ...(lastTurn.rateLimits === null
            ? {}
            : { rateLimits: lastTurn.rateLimits }),
          ...(lastTurn.message === null ? {} : { message: lastTurn.message }),
        });

        runAttempt.status = "finishing";
        const handoff = handoffRef.current;
        if (handoff?.status === "succeeded") {
          issue = {
            ...issue,
            identifier:
              handoff.result.issue.identifier.trim().length > 0
                ? handoff.result.issue.identifier
                : issue.identifier,
            state: handoff.result.issue.state,
          };
          break;
        }
        const blocker = blockerRef.current;
        if (blocker?.status === "succeeded") {
          issue = {
            ...issue,
            identifier:
              blocker.result.issue.identifier.trim().length > 0
                ? blocker.result.issue.identifier
                : issue.identifier,
            state: blocker.result.issue.state,
          };
          break;
        }
        if (handoff?.status === "failed") {
          break;
        }
        if (blocker?.status === "failed") {
          break;
        }

        issue = await this.refreshIssueState(issue);
        if (!this.isIssueStillActive(issue)) {
          break;
        }

        trackerCommentsForTurn = await this.pollNewTrackerComments(
          issue,
          trackerCommentCursor,
        );
      }

      if (handoffRef.current?.status === "failed") {
        runAttempt.status = "failed";
        runAttempt.error = handoffRef.current.error;
      } else if (blockerRef.current?.status === "failed") {
        runAttempt.status = "failed";
        runAttempt.error = blockerRef.current.error;
      } else {
        runAttempt.status = "succeeded";
      }

      return {
        issue,
        workspace,
        runAttempt,
        liveSession,
        turnsCompleted: liveSession.turnCount,
        lastTurn,
        rateLimits,
        handoff: handoffRef.current,
        blocker: blockerRef.current,
      };
    } catch (error) {
      const wrapped = this.toAgentRunnerError({
        error,
        issue,
        workspace,
        runAttempt,
        liveSession,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      runAttempt.status = wrapped.status;
      runAttempt.error = wrapped.message;
      throw wrapped;
    } finally {
      abortController.dispose();

      if (client !== null) {
        await closeBestEffort(client);
      }

      if (workspace !== null) {
        await this.hooks.runBestEffort({
          name: "afterRun",
          workspacePath: workspace.path,
        });
      }
    }
  }

  private createDynamicTools(
    issue: Issue,
    onHandoff: (result: TrackerHandoffRunResult) => void,
    onBlock: (result: TrackerBlockerRunResult) => void,
  ): CodexDynamicTool[] {
    const tools = createTrackerDynamicTools(this.config, {
      ...(this.fetchFn === undefined ? {} : { fetchFn: this.fetchFn }),
    });

    if (supportsTrackerLifecycleWrite(this.tracker)) {
      tools.push(
        createSymphonyHandoffDynamicTool({
          issue,
          lifecycle: this.lifecycleConfig(),
          tracker: this.tracker,
          onHandoff,
        }),
      );
    }

    if (supportsTrackerBlockWrite(this.tracker)) {
      tools.push(
        createSymphonyBlockDynamicTool({
          issue,
          lifecycle: this.lifecycleConfig(),
          tracker: this.tracker,
          onBlock,
        }),
      );
    }

    if (supportsTrackerIssueContextRead(this.tracker)) {
      tools.push(
        createSymphonyTicketReadDynamicTool({
          issue,
          tracker: this.tracker,
        }),
      );
    }

    if (supportsTrackerIssueNoteWrite(this.tracker)) {
      tools.push(
        createSymphonyTicketNoteDynamicTool({
          issue,
          tracker: this.tracker,
        }),
      );
    }

    return tools;
  }

  private async resolveGithubEnvironment(): Promise<NodeJS.ProcessEnv> {
    const environment = { ...this.environment };
    if (
      this.config.capabilities.github.credentialSource !== "gh_auth_token" ||
      hasExplicitGithubToken(environment)
    ) {
      return environment;
    }

    const credentialEnvironment = Object.fromEntries(
      Object.entries(environment).filter(
        ([name]) => name !== "GH_TOKEN" && name !== "GITHUB_TOKEN",
      ),
    );
    const token = await this.githubCredentialProvider.getToken({
      environment: credentialEnvironment,
    });
    return {
      ...credentialEnvironment,
      GH_TOKEN: token,
    };
  }

  private async claimIssueBeforeAgent(issue: Issue): Promise<Issue> {
    if (
      !this.config.tracker.requireClaimBeforeAgent ||
      !supportsTrackerLifecycleWrite(this.tracker)
    ) {
      return issue;
    }

    const result = await this.tracker.claimIssue({
      issue,
      lifecycle: this.lifecycleConfig(),
    });

    return {
      ...issue,
      identifier:
        result.issue.identifier.trim().length > 0
          ? result.issue.identifier
          : issue.identifier,
      state: result.issue.state,
    };
  }

  private lifecycleConfig(): TrackerLifecycleConfig {
    return {
      claimState: this.config.tracker.claimState,
      handoffStates: this.config.tracker.handoffStates,
      blockedState: this.config.tracker.blockedState,
      requireClaimBeforeAgent: this.config.tracker.requireClaimBeforeAgent,
    };
  }

  private async blockIssueBeforeAgentIfUnready(
    issue: Issue,
  ): Promise<TrackerBlockerRunResult | null> {
    if (
      this.config.tracker.blockedState === null ||
      !supportsTrackerBlockWrite(this.tracker)
    ) {
      return null;
    }

    const context = await this.readIssueContextBestEffort(issue);
    const metadata = buildMissingDescriptionBlocker(issue, context);
    if (metadata === null) {
      return null;
    }

    try {
      const result = await this.tracker.blockIssue({
        issue,
        lifecycle: this.lifecycleConfig(),
        metadata,
      });
      return {
        status: "succeeded",
        result,
        metadata,
      };
    } catch (error) {
      return {
        status: "failed",
        error: toErrorMessage(error),
        metadata,
      };
    }
  }

  private async readIssueContextBestEffort(
    issue: Issue,
  ): Promise<TrackerIssueContext | null> {
    if (!supportsTrackerIssueContextRead(this.tracker)) {
      return null;
    }

    try {
      return await this.tracker.readIssueContext({ issue });
    } catch {
      return null;
    }
  }

  private async initializeTrackerCommentCursor(
    issue: Issue,
  ): Promise<TrackerCommentCursor | null> {
    if (
      this.config.polling.issueCommentsBetweenTurns !== true ||
      !supportsTrackerIssueContextRead(this.tracker)
    ) {
      return null;
    }

    const context = await this.readIssueContextBestEffort(issue);
    const cursor: TrackerCommentCursor = {
      baselineEstablished: commentsWereAvailable(context),
      seen: new Set<string>(),
    };
    if (cursor.baselineEstablished && context !== null) {
      for (const entry of context.entries) {
        if (entry.source === "comment") {
          cursor.seen.add(trackerCommentKey(entry));
        }
      }
    }

    return cursor;
  }

  private async pollNewTrackerComments(
    issue: Issue,
    cursor: TrackerCommentCursor | null,
  ): Promise<TrackerIssueContextEntry[]> {
    if (cursor === null) {
      return [];
    }

    const context = await this.readIssueContextBestEffort(issue);
    if (!commentsWereAvailable(context) || context === null) {
      return [];
    }

    const ignoredAuthors = new Set(
      (this.config.polling.issueCommentIgnoredAuthors ?? []).map((author) =>
        normalizeTrackerAuthor(author),
      ),
    );
    const newComments: TrackerIssueContextEntry[] = [];
    for (const entry of context.entries) {
      if (entry.source !== "comment") {
        continue;
      }

      const key = trackerCommentKey(entry);
      if (cursor.seen.has(key)) {
        continue;
      }
      cursor.seen.add(key);

      const author = normalizeTrackerAuthor(entry.author ?? "");
      if (author !== "" && ignoredAuthors.has(author)) {
        continue;
      }

      newComments.push(entry);
    }
    cursor.baselineEstablished = true;
    return newComments;
  }

  private async refreshIssueState(issue: Issue): Promise<Issue> {
    const refreshed = await this.tracker.fetchIssueStatesByIds([issue.id]);
    const next = refreshed[0];

    if (next === undefined) {
      return issue;
    }

    return {
      ...issue,
      identifier:
        next.identifier.trim().length > 0 ? next.identifier : issue.identifier,
      state: next.state,
    };
  }

  private isIssueStillActive(issue: Issue): boolean {
    const activeStates = new Set(
      this.config.tracker.activeStates.map((state) =>
        normalizeIssueState(state),
      ),
    );
    return activeStates.has(normalizeIssueState(issue.state));
  }

  private toAgentRunnerError(input: {
    error: unknown;
    issue: Issue;
    workspace: Workspace | null;
    runAttempt: RunAttempt;
    liveSession: LiveSession;
    signal?: AbortSignal;
  }): AgentRunnerError {
    if (input.error instanceof AgentRunnerError) {
      return input.error;
    }

    if (input.signal?.aborted) {
      return new AgentRunnerError({
        message: toAbortMessage(input.signal.reason),
        status: "canceled_by_reconciliation",
        failedPhase: input.runAttempt.status,
        issue: input.issue,
        workspace: input.workspace,
        runAttempt: { ...input.runAttempt },
        liveSession: { ...input.liveSession },
        cause: input.error,
      });
    }

    const message =
      input.error instanceof Error ? input.error.message : "Agent run failed.";
    const code =
      typeof input.error === "object" &&
      input.error !== null &&
      "code" in input.error &&
      typeof input.error.code === "string"
        ? input.error.code
        : undefined;
    const capabilityFailure = extractCapabilityFailure(input.error);
    const capability =
      capabilityFailure?.capability ??
      (typeof input.error === "object" &&
      input.error !== null &&
      "capability" in input.error &&
      typeof input.error.capability === "string"
        ? input.error.capability
        : undefined);

    return new AgentRunnerError({
      message,
      ...(code === undefined ? {} : { code }),
      ...(capability === undefined ? {} : { capability }),
      ...(capabilityFailure === undefined ? {} : { capabilityFailure }),
      status: classifyFailureStatus(code),
      failedPhase: input.runAttempt.status,
      issue: input.issue,
      workspace: input.workspace,
      runAttempt: { ...input.runAttempt },
      liveSession: { ...input.liveSession },
      cause: input.error,
    });
  }
}

interface TrackerCommentCursor {
  baselineEstablished: boolean;
  seen: Set<string>;
}

function commentsWereAvailable(context: TrackerIssueContext | null): boolean {
  return (
    context !== null &&
    !context.unavailableSources.some((source) => source.source === "comments")
  );
}

function trackerCommentKey(entry: TrackerIssueContextEntry): string {
  const id = entry.id?.trim();
  if (id) {
    return `id:${id}`;
  }

  return JSON.stringify([entry.createdAt, entry.author, entry.text]);
}

function normalizeTrackerAuthor(author: string): string {
  return author.trim().toLowerCase();
}

function extractCapabilityFailure(
  error: unknown,
): CapabilityFailureMetadata | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("capabilityFailure" in error) ||
    typeof error.capabilityFailure !== "object" ||
    error.capabilityFailure === null
  ) {
    return undefined;
  }

  const failure = error.capabilityFailure;
  if (
    !("code" in failure) ||
    typeof failure.code !== "string" ||
    !("capability" in failure) ||
    typeof failure.capability !== "string" ||
    !("command" in failure) ||
    typeof failure.command !== "string" ||
    !("boundary" in failure) ||
    typeof failure.boundary !== "string" ||
    !("remediation" in failure) ||
    typeof failure.remediation !== "string"
  ) {
    return undefined;
  }

  return {
    code: failure.code,
    capability: failure.capability,
    command: failure.command,
    boundary: failure.boundary as CapabilityFailureMetadata["boundary"],
    remediation: failure.remediation,
  };
}

async function cleanupWorkspaceArtifacts(workspacePath: string): Promise<void> {
  await rm(`${workspacePath}/tmp`, {
    force: true,
    recursive: true,
  });
}

function hasExplicitGithubToken(environment: NodeJS.ProcessEnv): boolean {
  return [environment.GH_TOKEN, environment.GITHUB_TOKEN].some(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
}

function createDefaultCodexClient(
  input: AgentRunnerCodexClientFactoryInput,
): AgentRunnerCodexClient {
  return new CodexAppServerClient({
    command: input.command,
    cwd: input.cwd,
    approvalPolicy: input.approvalPolicy,
    threadSandbox: input.threadSandbox,
    turnSandboxPolicy: input.turnSandboxPolicy,
    readTimeoutMs: input.readTimeoutMs,
    turnTimeoutMs: input.turnTimeoutMs,
    stallTimeoutMs: input.stallTimeoutMs,
    dynamicTools: input.dynamicTools,
    environment: input.environment,
    onEvent: input.onEvent,
  });
}

function classifyFailureStatus(code: string | undefined): RunAttemptPhase {
  if (code === "codex_turn_timeout" || code === "hook_timed_out") {
    return "timed_out";
  }

  if (code === "codex_session_stalled") {
    return "stalled";
  }

  return "failed";
}

function buildMissingDescriptionBlocker(
  issue: Issue,
  context: TrackerIssueContext | null,
): TrackerBlockerRunResult["metadata"] | null {
  if (!isMissingIssueDescription(issue.description)) {
    return null;
  }

  if (hasUsableTrackerContext(context)) {
    return null;
  }

  if (hasUnavailableTrackerContextSources(context)) {
    return null;
  }

  return {
    title: "Blocked: task needs implementation context",
    details:
      "Symphony cannot safely start an implementation run because this tracker ticket has no usable description or acceptance criteria.",
    questions: [
      `What exact product or workflow behavior should ${issue.identifier} change or add?`,
      "What acceptance criteria or validation evidence should prove the task is complete?",
      "Are there required files, branches, prior discussions, or constraints that must be followed before opening a PR?",
    ],
  };
}

function isMissingIssueDescription(description: string | null): boolean {
  if (description === null) {
    return true;
  }

  const normalized = description.replaceAll(/\s+/g, " ").trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "no description" ||
    normalized === "no description provided"
  );
}

function hasUsableTrackerContext(context: TrackerIssueContext | null): boolean {
  if (context === null) {
    return false;
  }

  return context.entries.some((entry) => hasUsableNonBlockerText(entry.text));
}

function hasUnavailableTrackerContextSources(
  context: TrackerIssueContext | null,
): boolean {
  return context !== null && context.unavailableSources.length > 0;
}

function hasUsableNonBlockerText(text: string): boolean {
  const stripped = stripKnownSymphonyBlockerText(text)
    .replaceAll(/\s+/g, " ")
    .trim();
  return stripped.length >= 20;
}

function stripKnownSymphonyBlockerText(text: string): string {
  return text
    .replaceAll(/Blocked: task needs implementation context/gi, "")
    .replaceAll(/Blocked: clarification needed/gi, "")
    .replaceAll(
      /Symphony cannot safely start an implementation run because this tracker ticket has no usable description or acceptance criteria\./gi,
      "",
    )
    .replaceAll(
      /What exact product or workflow behavior should .* change or add\?/gi,
      "",
    )
    .replaceAll(
      /What acceptance criteria or validation evidence should prove the task is complete\?/gi,
      "",
    )
    .replaceAll(
      /Are there required files, branches, prior discussions, or constraints that must be followed before opening a PR\?/gi,
      "",
    )
    .replaceAll(/^\s*\d+\.\s*/gm, "");
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "tracker block failed";
}

async function closeBestEffort(client: AgentRunnerCodexClient): Promise<void> {
  try {
    await client.close();
  } catch {
    // Closing is cleanup-only here; preserve the primary failure cause.
  }
}

function cloneIssue(issue: Issue): Issue {
  return {
    ...issue,
    labels: [...issue.labels],
    blockedBy: issue.blockedBy.map((blocker) => ({ ...blocker })),
  };
}

function createAgentAbortController(signal: AbortSignal | undefined): {
  bindClient(client: AgentRunnerCodexClient): void;
  dispose(): void;
  throwIfAborted(input: {
    issue: Issue;
    workspace: Workspace | null;
    runAttempt: RunAttempt;
    liveSession: LiveSession;
  }): void;
} {
  let client: AgentRunnerCodexClient | null = null;
  let listener: (() => void) | null = null;

  const closeClient = () => {
    if (client === null) {
      return;
    }

    void closeBestEffort(client);
  };

  if (signal !== undefined) {
    listener = () => {
      closeClient();
    };
    signal.addEventListener("abort", listener, { once: true });
  }

  return {
    bindClient(nextClient) {
      client = nextClient;
      if (signal?.aborted) {
        closeClient();
      }
    },
    dispose() {
      if (signal !== undefined && listener !== null) {
        signal.removeEventListener("abort", listener);
      }
      listener = null;
      client = null;
    },
    throwIfAborted(input) {
      if (!signal?.aborted) {
        return;
      }

      throw new AgentRunnerError({
        message: toAbortMessage(signal.reason),
        status: "canceled_by_reconciliation",
        failedPhase: input.runAttempt.status,
        issue: input.issue,
        workspace: input.workspace,
        runAttempt: { ...input.runAttempt },
        liveSession: { ...input.liveSession },
      });
    },
  };
}

function toAbortMessage(reason: unknown): string {
  if (typeof reason === "string" && reason.trim().length > 0) {
    return reason.trim();
  }

  if (
    typeof reason === "object" &&
    reason !== null &&
    "message" in reason &&
    typeof reason.message === "string" &&
    reason.message.trim().length > 0
  ) {
    return reason.message.trim();
  }

  return "Agent run cancelled.";
}

export type { BuildTurnPromptInput };

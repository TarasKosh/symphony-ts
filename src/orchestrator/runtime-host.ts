import { createWriteStream } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";

import type { AgentRunResult, AgentRunnerEvent } from "../agent/runner.js";
import { AgentRunner } from "../agent/runner.js";
import { validateDispatchConfig } from "../config/config-resolver.js";
import type { ResolvedWorkflowConfig } from "../config/types.js";
import { WorkflowWatcher } from "../config/workflow-watch.js";
import type {
  Issue,
  OperatorHoldEntry,
  RetryEntry,
  RunningEntry,
} from "../domain/model.js";
import { ERROR_CODES } from "../errors/codes.js";
import {
  type RuntimeSnapshot,
  buildRuntimeSnapshot,
} from "../logging/runtime-snapshot.js";
import {
  StructuredLogger,
  createJsonLineSink,
} from "../logging/structured-logger.js";
import {
  type DashboardServerHost,
  type DashboardServerInstance,
  type IssueDetailResponse,
  type OperatorRetryResponse,
  type RefreshResponse,
  startDashboardServer,
} from "../observability/dashboard-server.js";
import { createTrackerFromConfig } from "../tracker/adapters.js";
import type { IssueTracker } from "../tracker/tracker.js";
import { WorkspaceHookRunner } from "../workspace/hooks.js";
import { cleanupStaleIssueWorkspaces } from "../workspace/retention.js";
import { WorkspaceManager } from "../workspace/workspace-manager.js";
import type {
  OrchestratorCoreOptions,
  StopRequest,
  TimerScheduler,
} from "./core.js";
import { OrchestratorCore } from "./core.js";

export interface AgentRunnerLike {
  run(input: {
    issue: Issue;
    attempt: number | null;
    signal?: AbortSignal;
  }): Promise<AgentRunResult>;
}

export interface RuntimeHostOptions {
  config: ResolvedWorkflowConfig;
  tracker: IssueTracker;
  agentRunner?: AgentRunnerLike;
  createAgentRunner?: (input: {
    onEvent: (event: AgentRunnerEvent) => void;
  }) => AgentRunnerLike;
  logger?: StructuredLogger;
  workspaceManager?: WorkspaceManager;
  now?: () => Date;
}

export interface RuntimeServiceOptions {
  config: ResolvedWorkflowConfig;
  logsRoot?: string | null;
  tracker?: IssueTracker;
  runtimeHost?: OrchestratorRuntimeHost;
  workspaceManager?: WorkspaceManager;
  workflowWatcher?: WorkflowWatcher | null;
  now?: () => Date;
  logger?: StructuredLogger;
  stdout?: Writable;
}

export interface RuntimeServiceHandle {
  readonly runtimeHost: OrchestratorRuntimeHost;
  readonly logger: StructuredLogger;
  readonly dashboard: DashboardServerInstance | null;
  waitForExit(): Promise<number>;
  shutdown(): Promise<void>;
}

interface WorkerExecution {
  issueId: string;
  issueIdentifier: string;
  controller: AbortController;
  completion: Promise<void>;
  stopRequest: StopRequest | null;
  lastResult: AgentRunResult | null;
  lastError: unknown;
}

export class RuntimeHostStartupError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RuntimeHostStartupError";
    this.code = code;
  }
}

export class OrchestratorRuntimeHost implements DashboardServerHost {
  private config: ResolvedWorkflowConfig;

  private tracker: IssueTracker;

  private workspaceManager: WorkspaceManager;

  private agentRunner: AgentRunnerLike;

  private readonly now: () => Date;

  private readonly logger: StructuredLogger | null;

  private readonly workers = new Map<string, WorkerExecution>();

  private readonly orchestrator: OrchestratorCore;

  private readonly managesAgentRunner: boolean;

  private readonly agentEventSink: (event: AgentRunnerEvent) => void;

  private eventQueue: Promise<unknown> = Promise.resolve();

  private refreshQueued = false;

  private readonly snapshotListeners = new Set<() => void>();

  constructor(options: RuntimeHostOptions) {
    this.config = options.config;
    this.tracker = options.tracker;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? null;
    this.workspaceManager =
      options.workspaceManager ??
      createWorkspaceManagerFromConfig(options.config, this.logger);
    this.agentEventSink = (event) => {
      void this.enqueue(async () => {
        this.orchestrator.onCodexEvent({
          issueId: event.issueId,
          event,
        });
        await logAgentEvent(this.logger, event);
      });
    };
    this.managesAgentRunner =
      options.agentRunner === undefined &&
      options.createAgentRunner === undefined;
    this.agentRunner =
      options.agentRunner ??
      options.createAgentRunner?.({
        onEvent: this.agentEventSink,
      }) ??
      this.createManagedAgentRunner({
        config: options.config,
        tracker: options.tracker,
        workspaceManager: this.workspaceManager,
      });

    const timerScheduler = createQueuedTimerScheduler({
      run: (callback) => {
        void this.enqueue(async () => {
          callback();
        });
      },
    });

    const orchestratorOptions: OrchestratorCoreOptions = {
      config: options.config,
      tracker: options.tracker,
      now: this.now,
      timerScheduler,
      spawnWorker: async ({ issue, attempt }) =>
        this.spawnWorkerExecution(issue, attempt),
      stopRunningIssue: async (input) => {
        await this.stopWorkerExecution(input.issueId, {
          issueId: input.issueId,
          issueIdentifier: input.runningEntry.identifier,
          cleanupWorkspace: input.cleanupWorkspace,
          reason: input.reason,
        });
      },
    };

    this.orchestrator = new OrchestratorCore(orchestratorOptions);
  }

  getState() {
    return this.orchestrator.getState();
  }

  updateConfig(input: {
    config: ResolvedWorkflowConfig;
    tracker?: IssueTracker;
    workspaceManager?: WorkspaceManager;
  }): void {
    this.config = input.config;

    if (input.tracker !== undefined) {
      this.tracker = input.tracker;
      this.orchestrator.updateTracker(input.tracker);
    }

    if (input.workspaceManager !== undefined) {
      this.workspaceManager = input.workspaceManager;
    }

    this.orchestrator.updateConfig(input.config);

    if (this.managesAgentRunner) {
      this.agentRunner = this.createManagedAgentRunner({
        config: this.config,
        tracker: this.tracker,
        workspaceManager: this.workspaceManager,
      });
      return;
    }

    if (supportsConfigUpdate(this.agentRunner)) {
      this.agentRunner.updateConfig({
        config: this.config,
        ...(input.tracker === undefined ? {} : { tracker: this.tracker }),
        ...(input.workspaceManager === undefined
          ? {}
          : { workspaceManager: this.workspaceManager }),
      });
    }

    this.notifySnapshotListeners();
  }

  async pollOnce() {
    return this.enqueue(async () => this.orchestrator.pollTick());
  }

  async runRetryTimer(issueId: string) {
    return this.enqueue(async () => this.orchestrator.onRetryTimer(issueId));
  }

  async requestOperatorRetry(
    issueIdentifier: string,
  ): Promise<OperatorRetryResponse | null> {
    return this.enqueue(async () => {
      const hold = Object.values(
        this.orchestrator.getState().operatorHolds,
      ).find((entry) => entry.identifier === issueIdentifier);
      if (hold === undefined) {
        return null;
      }

      const result = await this.orchestrator.retryOperatorHold(hold.issueId);
      return {
        issue_id: hold.issueId,
        issue_identifier: issueIdentifier,
        dispatched: result.dispatched,
        released: result.released,
      };
    });
  }

  async flushEvents(): Promise<void> {
    await this.eventQueue;
  }

  async waitForIdle(): Promise<void> {
    await this.eventQueue;
    await Promise.allSettled(
      [...this.workers.values()].map((worker) => worker.completion),
    );
    await this.eventQueue;
  }

  async getRuntimeSnapshot(): Promise<RuntimeSnapshot> {
    return buildRuntimeSnapshot(this.orchestrator.getState(), {
      now: this.now(),
    });
  }

  async getIssueDetails(
    issueIdentifier: string,
  ): Promise<IssueDetailResponse | null> {
    const running = Object.values(this.orchestrator.getState().running).find(
      (entry) => entry.identifier === issueIdentifier,
    );
    if (running !== undefined) {
      return toRunningIssueDetail(running, this.workspaceManager);
    }

    const retry = Object.values(
      this.orchestrator.getState().retryAttempts,
    ).find((entry) => entry.identifier === issueIdentifier);
    if (retry !== undefined) {
      return toRetryIssueDetail(issueIdentifier, retry);
    }

    const hold = Object.values(this.orchestrator.getState().operatorHolds).find(
      (entry) => entry.identifier === issueIdentifier,
    );
    if (hold !== undefined) {
      return toHoldIssueDetail(issueIdentifier, hold);
    }

    return null;
  }

  async requestRefresh(): Promise<RefreshResponse> {
    const requestedAt = this.now().toISOString();
    const coalesced = this.refreshQueued;
    this.refreshQueued = true;

    if (!coalesced) {
      void this.enqueue(async () => {
        this.refreshQueued = false;
        await this.orchestrator.pollTick();
      });
    }

    return {
      queued: true,
      coalesced,
      requested_at: requestedAt,
      operations: ["poll", "reconcile"],
    };
  }

  subscribeToSnapshots(listener: () => void): () => void {
    this.snapshotListeners.add(listener);
    return () => {
      this.snapshotListeners.delete(listener);
    };
  }

  private async spawnWorkerExecution(
    issue: Issue,
    attempt: number | null,
  ): Promise<{
    workerHandle: WorkerExecution;
    monitorHandle: Promise<void>;
  }> {
    await this.logger?.info("worker_spawned", "Worker spawned for issue.", {
      outcome: "started",
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      attempt,
      state: issue.state,
    });

    const controller = new AbortController();
    const execution: WorkerExecution = {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      controller,
      stopRequest: null,
      lastResult: null,
      lastError: null,
      completion: Promise.resolve(),
    };

    const completion = this.agentRunner
      .run({
        issue,
        attempt,
        signal: controller.signal,
      })
      .then(async (result) => {
        execution.lastResult = result;
        await this.enqueue(async () => {
          await this.finalizeWorkerExecution(execution, {
            outcome: "normal",
            endedAt: this.now(),
          });
        });
      })
      .catch(async (error) => {
        execution.lastError = error;
        await this.enqueue(async () => {
          await this.finalizeWorkerExecution(execution, {
            outcome: "abnormal",
            reason:
              execution.stopRequest === null
                ? toErrorMessage(error)
                : `stopped after ${execution.stopRequest.reason}`,
          });
        });
      });

    execution.completion = completion;
    this.workers.set(issue.id, execution);

    return {
      workerHandle: execution,
      monitorHandle: completion,
    };
  }

  private async stopWorkerExecution(
    issueId: string,
    input: StopRequest,
  ): Promise<void> {
    const execution = this.workers.get(issueId);
    if (execution === undefined) {
      return;
    }

    execution.stopRequest = input;
    execution.controller.abort(`Stopped due to ${input.reason}.`);
  }

  private async finalizeWorkerExecution(
    execution: WorkerExecution,
    input: {
      outcome: "normal" | "abnormal";
      reason?: string;
      endedAt?: Date;
    },
  ): Promise<void> {
    this.workers.delete(execution.issueId);
    const lifecycleFailure = getLifecycleFailure(execution.lastResult);
    const errorCode = extractErrorCode(execution.lastError);
    const capability = extractCapability(execution.lastError);

    await this.logger?.log(
      lifecycleFailure !== null
        ? "warn"
        : input.outcome === "normal"
          ? "info"
          : "error",
      lifecycleFailure !== null
        ? lifecycleFailure.event
        : input.outcome === "normal"
          ? "worker_exit_normal"
          : "worker_exit_abnormal",
      lifecycleFailure !== null
        ? lifecycleFailure.message
        : input.outcome === "normal"
          ? "Worker completed normally."
          : "Worker completed abnormally.",
      {
        outcome:
          lifecycleFailure !== null
            ? "blocked"
            : input.outcome === "normal"
              ? "completed"
              : "failed",
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(errorCode === null ? {} : { error_code: errorCode }),
        ...(capability === null ? {} : { capability }),
        ...(lifecycleFailure === null
          ? {}
          : {
              reason: lifecycleFailure.reason,
              error_code: lifecycleFailure.errorCode,
              error: lifecycleFailure.error,
            }),
        issue_id: execution.issueId,
        issue_identifier: execution.issueIdentifier,
        session_id: execution.lastResult?.liveSession.sessionId ?? null,
      },
    );

    if (execution.stopRequest?.cleanupWorkspace === true) {
      await this.workspaceManager.removeForIssue(execution.issueId);
    }

    this.orchestrator.onWorkerExit({
      issueId: execution.issueId,
      outcome: input.outcome,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(errorCode === null ? {} : { errorCode }),
      endedAt: input.endedAt ?? this.now(),
      handoff: execution.lastResult?.handoff ?? null,
      blocker: execution.lastResult?.blocker ?? null,
      progressSignature:
        execution.lastResult === null
          ? null
          : buildWorkerProgressSignature(execution.lastResult),
    });
  }

  private enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    const next = this.eventQueue.then(task, task);
    this.eventQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next.finally(() => {
      this.notifySnapshotListeners();
    });
  }

  private notifySnapshotListeners(): void {
    for (const listener of this.snapshotListeners) {
      try {
        listener();
      } catch {
        // Observability listeners must not affect runtime correctness.
      }
    }
  }

  private createManagedAgentRunner(input: {
    config: ResolvedWorkflowConfig;
    tracker: IssueTracker;
    workspaceManager: WorkspaceManager;
  }): AgentRunnerLike {
    return new AgentRunner({
      config: input.config,
      tracker: input.tracker,
      workspaceManager: input.workspaceManager,
      onEvent: this.agentEventSink,
    });
  }
}

export async function startRuntimeService(
  options: RuntimeServiceOptions,
): Promise<RuntimeServiceHandle> {
  const validation = validateDispatchConfig(options.config);
  if (!validation.ok) {
    throw new RuntimeHostStartupError(
      validation.error.message,
      validation.error.code,
    );
  }

  const logger =
    options.logger ??
    (await createRuntimeLogger({
      logsRoot: options.logsRoot ?? null,
      ...(options.stdout === undefined ? {} : { stdout: options.stdout }),
    }));
  let currentConfig = options.config;
  let tracker = options.tracker ?? createTrackerFromConfig(currentConfig);
  let workspaceManager =
    options.workspaceManager ??
    createWorkspaceManagerFromConfig(currentConfig, logger);
  const runtimeHost =
    options.runtimeHost ??
    new OrchestratorRuntimeHost({
      config: currentConfig,
      tracker,
      logger,
      workspaceManager,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  const usesManagedTracker = options.tracker === undefined;
  const usesManagedWorkspaceManager = options.workspaceManager === undefined;

  await cleanupTerminalIssueWorkspaces({
    tracker,
    terminalStates: currentConfig.tracker.terminalStates,
    workspaceManager,
    logger,
  });
  await cleanupConfiguredStaleIssueWorkspaces({
    config: currentConfig,
    tracker,
    workspaceManager,
    runtimeHost,
    logger,
    now: options.now?.() ?? new Date(),
  });

  const dashboard =
    currentConfig.server.port === null
      ? null
      : await startDashboardServer({
          host: runtimeHost,
          port: currentConfig.server.port,
          refreshMs: currentConfig.observability.refreshMs,
          renderIntervalMs: currentConfig.observability.renderIntervalMs,
          liveUpdatesEnabled: currentConfig.observability.dashboardEnabled,
        });

  const stopController = new AbortController();
  const exitPromise = createExitPromise();
  let pollTimer: NodeJS.Timeout | null = null;
  let shuttingDown = false;
  let nextWorkspaceRetentionSweepAtMs = nextRetentionSweepAtMs(
    currentConfig,
    options.now?.() ?? new Date(),
  );

  const scheduleNextPoll = () => {
    if (stopController.signal.aborted) {
      return;
    }

    pollTimer = setTimeout(() => {
      void runPollCycle();
    }, currentConfig.polling.intervalMs);
  };

  const runPollCycle = async () => {
    try {
      const result = await runtimeHost.pollOnce();
      await logPollCycleResult(logger, result);
      const cycleNow = options.now?.() ?? new Date();
      if (cycleNow.getTime() >= nextWorkspaceRetentionSweepAtMs) {
        await cleanupConfiguredStaleIssueWorkspaces({
          config: currentConfig,
          tracker,
          workspaceManager,
          runtimeHost,
          logger,
          now: cycleNow,
        });
        nextWorkspaceRetentionSweepAtMs = nextRetentionSweepAtMs(
          currentConfig,
          cycleNow,
        );
      }
      scheduleNextPoll();
    } catch (error) {
      await logger.error("runtime_poll_failed", toErrorMessage(error), {
        error_code: ERROR_CODES.cliStartupFailed,
      });
      resolveExit(exitPromise, 1);
      void shutdown();
    }
  };

  const onSignal = (signal: NodeJS.Signals) => {
    void logger.info("runtime_shutdown_signal", `received ${signal}`, {
      reason: signal,
    });
    resolveExit(exitPromise, 0);
    void shutdown();
  };

  const removeSignalHandlers = installSignalHandlers(onSignal);
  const workflowWatcher =
    options.workflowWatcher === undefined
      ? await createRuntimeWorkflowWatcher({
          config: currentConfig,
          logger,
          onReload: async (nextConfig) => {
            const previousConfig = currentConfig;
            currentConfig = nextConfig;

            if (usesManagedTracker) {
              tracker = createTrackerFromConfig(nextConfig);
            }

            if (usesManagedWorkspaceManager) {
              workspaceManager = createWorkspaceManagerFromConfig(
                nextConfig,
                logger,
              );
            }

            runtimeHost.updateConfig({
              config: nextConfig,
              ...(usesManagedTracker ? { tracker } : {}),
              ...(usesManagedWorkspaceManager ? { workspaceManager } : {}),
            });
            nextWorkspaceRetentionSweepAtMs = nextRetentionSweepAtMs(
              currentConfig,
              options.now?.() ?? new Date(),
            );

            if (pollTimer !== null) {
              clearTimeout(pollTimer);
              pollTimer = null;
              scheduleNextPoll();
            }

            if (
              dashboard !== null &&
              previousConfig.server.port !== nextConfig.server.port
            ) {
              await logger.warn(
                "workflow_reload_port_ignored",
                "Ignoring server.port change until runtime restart.",
                {
                  outcome: "degraded",
                  reason: "server_port_reload_requires_restart",
                  port: dashboard.port,
                },
              );
            }

            if (
              dashboard !== null &&
              previousConfig.observability.dashboardEnabled !==
                nextConfig.observability.dashboardEnabled
            ) {
              await logger.warn(
                "workflow_reload_observability_ignored",
                "Ignoring observability.dashboard_enabled change until runtime restart.",
                {
                  outcome: "degraded",
                  reason: "observability_reload_requires_restart",
                  port: dashboard.port,
                },
              );
            }
          },
        })
      : options.workflowWatcher;
  workflowWatcher?.start();

  const shutdown = async () => {
    if (shuttingDown) {
      await exitPromise.closed;
      return;
    }
    shuttingDown = true;
    resolveExit(exitPromise, 0);
    stopController.abort();

    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }

    removeSignalHandlers();

    await Promise.allSettled([
      runtimeHost.waitForIdle(),
      dashboard?.close() ?? Promise.resolve(),
      workflowWatcher?.close() ?? Promise.resolve(),
    ]);

    resolveClosed(exitPromise);
  };

  await logger.info("runtime_starting", "Symphony runtime started.", {
    poll_interval_ms: currentConfig.polling.intervalMs,
    max_concurrent_agents: currentConfig.agent.maxConcurrentAgents,
    ...(dashboard === null ? {} : { port: dashboard.port }),
  });

  void runPollCycle();

  return {
    runtimeHost,
    logger,
    dashboard,
    async waitForExit() {
      return exitPromise.exitCode;
    },
    shutdown,
  };
}

async function logPollCycleResult(
  logger: StructuredLogger,
  result: Awaited<ReturnType<OrchestratorRuntimeHost["pollOnce"]>>,
): Promise<void> {
  if (!result.validation.ok) {
    await logger.error(
      "dispatch_validation_failed",
      result.validation.error.message,
      {
        error_code: result.validation.error.code,
      },
    );
  }

  if (result.reconciliationFetchFailed) {
    await logger.warn(
      "reconciliation_state_refresh_failed",
      "Issue state reconciliation failed; keeping current workers running.",
      {
        outcome: "degraded",
        reason: "tracker_state_refresh_failed",
      },
    );
  }

  if (result.trackerFetchFailed) {
    await logger.warn(
      "candidate_issue_fetch_failed",
      "Tracker candidate fetch failed; dispatch skipped for this tick.",
      {
        outcome: "degraded",
        reason: "tracker_candidate_fetch_failed",
      },
    );
  }

  for (const blocker of result.lifecycleWriteBlockers) {
    await logger.warn("tracker_lifecycle_write_blocked", blocker.error, {
      outcome: "blocked",
      reason: blocker.operation,
      issue_id: blocker.issueId,
      issue_identifier: blocker.issueIdentifier,
    });
  }
}

async function createRuntimeWorkflowWatcher(input: {
  config: ResolvedWorkflowConfig;
  logger: StructuredLogger;
  onReload: (config: ResolvedWorkflowConfig) => Promise<void>;
}): Promise<WorkflowWatcher | null> {
  try {
    await access(input.config.workflowPath);
  } catch {
    return null;
  }

  return await WorkflowWatcher.create({
    workflowPath: input.config.workflowPath,
    onReload: async ({ snapshot }) => {
      if (!snapshot.dispatchValidation.ok) {
        await input.logger.error(
          "workflow_reload_rejected",
          snapshot.dispatchValidation.error.message,
          {
            error_code: ERROR_CODES.workflowReloadRejected,
            reason: snapshot.dispatchValidation.error.code,
          },
        );
        return;
      }

      await input.onReload(snapshot.config);
      await input.logger.info(
        "workflow_reloaded",
        "Applied updated workflow configuration.",
        {
          poll_interval_ms: snapshot.config.polling.intervalMs,
          max_concurrent_agents: snapshot.config.agent.maxConcurrentAgents,
        },
      );
    },
    onError: async ({ error }) => {
      await input.logger.error(
        "workflow_reload_failed",
        toErrorMessage(error),
        {
          error_code:
            extractErrorCode(error) ?? ERROR_CODES.workflowReloadRejected,
        },
      );
    },
  });
}

async function cleanupTerminalIssueWorkspaces(input: {
  tracker: IssueTracker;
  terminalStates: string[];
  workspaceManager: WorkspaceManager;
  logger: StructuredLogger;
}): Promise<void> {
  try {
    const issues = await input.tracker.fetchIssuesByStates(
      input.terminalStates,
    );
    await Promise.all(
      issues.map(async (issue) => {
        await input.workspaceManager.removeForIssue(issue.id);
      }),
    );
  } catch (error) {
    await input.logger.warn(
      "startup_terminal_cleanup_failed",
      toErrorMessage(error),
      {
        outcome: "degraded",
        reason: "startup_terminal_cleanup_failed",
      },
    );
  }
}

async function cleanupConfiguredStaleIssueWorkspaces(input: {
  config: ResolvedWorkflowConfig;
  tracker: IssueTracker;
  workspaceManager: WorkspaceManager;
  runtimeHost: OrchestratorRuntimeHost;
  logger: StructuredLogger;
  now: Date;
}): Promise<void> {
  const retention = input.config.workspace.retention;
  if (
    retention === undefined ||
    retention.states.length === 0 ||
    retention.staleAfterMs === null
  ) {
    return;
  }

  try {
    await cleanupStaleIssueWorkspaces({
      tracker: input.tracker,
      retention,
      workspaceManager: input.workspaceManager,
      now: input.now,
      isIssueActive: (issueId) =>
        input.runtimeHost.getState().running[issueId] !== undefined,
      log: async (entry) => {
        await input.logger.log(
          entry.level,
          entry.event,
          entry.event === "workspace_retention_removed"
            ? "Removed stale inactive workspace after Git safety checks."
            : "Preserved stale inactive workspace because a safety check did not pass.",
          {
            outcome:
              entry.event === "workspace_retention_removed"
                ? "completed"
                : "blocked",
            issue_id: entry.issueId,
            issue_identifier: entry.issueIdentifier,
            workspace_path: entry.workspacePath,
            ...(entry.reason === undefined ? {} : { reason: entry.reason }),
            ...(entry.detail === undefined ? {} : { detail: entry.detail }),
          },
        );
      },
    });
  } catch (error) {
    await input.logger.warn(
      "workspace_retention_sweep_failed",
      toErrorMessage(error),
      {
        outcome: "degraded",
        reason: "workspace_retention_sweep_failed",
      },
    );
  }
}

function nextRetentionSweepAtMs(
  config: ResolvedWorkflowConfig,
  now: Date,
): number {
  const retention = config.workspace.retention;
  if (
    retention === undefined ||
    retention.states.length === 0 ||
    retention.staleAfterMs === null
  ) {
    return Number.POSITIVE_INFINITY;
  }

  return now.getTime() + retention.checkIntervalMs;
}

function createWorkspaceManagerFromConfig(
  config: ResolvedWorkflowConfig,
  logger?: StructuredLogger | null,
): WorkspaceManager {
  return new WorkspaceManager({
    root: config.workspace.root,
    hooks: new WorkspaceHookRunner({
      config: config.hooks,
      ...(logger === undefined || logger === null
        ? {}
        : {
            log: createWorkspaceHookLogger(logger),
          }),
    }),
  });
}

async function createRuntimeLogger(input: {
  logsRoot: string | null;
  stdout?: Writable;
}): Promise<StructuredLogger> {
  const sinks = [createJsonLineSink(input.stdout ?? process.stdout)];

  if (input.logsRoot !== null) {
    await mkdir(input.logsRoot, { recursive: true });
    sinks.push(
      createJsonLineSink(
        createWriteStream(join(input.logsRoot, "symphony.jsonl"), {
          flags: "a",
        }),
      ),
    );
  }

  return new StructuredLogger(sinks);
}

function createQueuedTimerScheduler(input: {
  run: (callback: () => void) => void;
}): TimerScheduler {
  return {
    set(callback, delayMs) {
      return setTimeout(() => {
        input.run(callback);
      }, delayMs);
    },
    clear(handle) {
      if (handle !== null) {
        clearTimeout(handle);
      }
    },
  };
}

function createWorkspaceHookLogger(logger: StructuredLogger): (entry: {
  level: "info" | "warn" | "error";
  event:
    | "workspace_hook_started"
    | "workspace_hook_completed"
    | "workspace_hook_failed"
    | "workspace_hook_timed_out";
  hook: string;
  workspacePath: string;
  durationMs?: number;
  exitCode?: number | null;
  errorCode?: string;
  stdout?: string;
  stderr?: string;
}) => void {
  return (entry) => {
    void logger.log(
      entry.level,
      entry.event,
      `Workspace hook ${entry.hook} ${toHookMessageSuffix(entry.event)}.`,
      {
        ...(entry.event === "workspace_hook_completed"
          ? { outcome: "completed" }
          : entry.event === "workspace_hook_started"
            ? { outcome: "started" }
            : { outcome: "failed" }),
        hook: entry.hook,
        workspace_path: entry.workspacePath,
        ...(entry.durationMs === undefined
          ? {}
          : { duration_ms: entry.durationMs }),
        ...(entry.exitCode === undefined ? {} : { exit_code: entry.exitCode }),
        ...(entry.errorCode === undefined
          ? {}
          : { error_code: entry.errorCode }),
      },
    );
  };
}

async function logAgentEvent(
  logger: StructuredLogger | null,
  event: AgentRunnerEvent,
): Promise<void> {
  if (logger === null) {
    return;
  }

  const level =
    event.event === "turn_failed" ||
    event.event === "turn_ended_with_error" ||
    event.event === "startup_failed" ||
    event.event === "turn_input_required" ||
    event.event === "malformed"
      ? "error"
      : event.event === "unsupported_tool_call"
        ? "warn"
        : "info";

  const outcome =
    event.event === "session_started"
      ? "started"
      : event.event === "turn_completed"
        ? "completed"
        : event.event === "approval_auto_approved"
          ? "approved"
          : event.event === "turn_failed" ||
              event.event === "turn_cancelled" ||
              event.event === "turn_ended_with_error" ||
              event.event === "startup_failed" ||
              event.event === "turn_input_required" ||
              event.event === "malformed"
            ? "failed"
            : undefined;

  await logger.log(level, event.event, event.message ?? event.event, {
    ...(outcome === undefined ? {} : { outcome }),
    ...(event.errorCode === undefined ? {} : { error_code: event.errorCode }),
    issue_id: event.issueId,
    issue_identifier: event.issueIdentifier,
    session_id: event.sessionId ?? null,
    thread_id: event.threadId ?? null,
    turn_id: event.turnId ?? null,
    attempt: event.attempt,
    workspace_path: event.workspacePath,
    ...(event.usage === undefined
      ? {}
      : {
          input_tokens: event.usage.inputTokens,
          output_tokens: event.usage.outputTokens,
          total_tokens: event.usage.totalTokens,
        }),
  });
}

function toHookMessageSuffix(
  event:
    | "workspace_hook_started"
    | "workspace_hook_completed"
    | "workspace_hook_failed"
    | "workspace_hook_timed_out",
): string {
  switch (event) {
    case "workspace_hook_started":
      return "started";
    case "workspace_hook_completed":
      return "completed";
    case "workspace_hook_failed":
      return "failed";
    case "workspace_hook_timed_out":
      return "timed out";
  }
}

function toRunningIssueDetail(
  running: RunningEntry,
  workspaceManager: WorkspaceManager,
): IssueDetailResponse {
  return {
    issue_identifier: running.identifier,
    issue_id: running.issue.id,
    status: "running",
    workspace: {
      path: workspaceManager.resolveForIssue(running.issue.id).workspacePath,
    },
    attempts: {
      restart_count: running.retryAttempt ?? 0,
      current_retry_attempt: running.retryAttempt,
    },
    running: {
      session_id: running.sessionId,
      turn_count: running.turnCount,
      state: running.issue.state,
      started_at: running.startedAt,
      last_event: running.lastCodexEvent,
      last_message: running.lastCodexMessage,
      last_event_at: running.lastCodexTimestamp,
      tokens: {
        input_tokens: running.codexInputTokens,
        output_tokens: running.codexOutputTokens,
        total_tokens: running.codexTotalTokens,
      },
    },
    retry: null,
    hold: null,
    logs: {
      codex_session_logs: [],
    },
    recent_events: [],
    last_error: null,
    tracked: {},
  };
}

function toRetryIssueDetail(
  issueIdentifier: string,
  retry: RetryEntry,
): IssueDetailResponse {
  return {
    issue_identifier: issueIdentifier,
    issue_id: retry.issueId,
    status: "retry_queued",
    workspace: null,
    attempts: {
      restart_count: retry.attempt,
      current_retry_attempt: retry.attempt,
    },
    running: null,
    retry: {
      attempt: retry.attempt,
      due_at: new Date(retry.dueAtMs).toISOString(),
      error: retry.error,
    },
    hold: null,
    logs: {
      codex_session_logs: [],
    },
    recent_events: [],
    last_error: retry.error,
    tracked: {},
  };
}

function toHoldIssueDetail(
  issueIdentifier: string,
  hold: OperatorHoldEntry,
): IssueDetailResponse {
  return {
    issue_identifier: issueIdentifier,
    issue_id: hold.issueId,
    status: "operator_hold",
    workspace: null,
    attempts: {
      restart_count: hold.attempt,
      current_retry_attempt: hold.attempt,
    },
    running: null,
    retry: null,
    hold: {
      attempt: hold.attempt,
      held_at: new Date(hold.heldAtMs).toISOString(),
      error: hold.error,
    },
    logs: {
      codex_session_logs: [],
    },
    recent_events: [],
    last_error: hold.error,
    tracked: {},
  };
}

function buildWorkerProgressSignature(result: AgentRunResult): string {
  return JSON.stringify({
    issueId: result.issue.id,
    identifier: result.issue.identifier,
    state: result.issue.state,
    lastTurnMessage: result.lastTurn?.message ?? null,
    handoff:
      result.handoff?.status === "succeeded"
        ? {
            state: result.handoff.result.state,
            prUrl: result.handoff.metadata.prUrl,
            prNumber: result.handoff.metadata.prNumber,
            headSha: result.handoff.metadata.headSha,
          }
        : null,
  });
}

function installSignalHandlers(
  onSignal: (signal: NodeJS.Signals) => void,
): () => void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  for (const signal of signals) {
    process.on(signal, onSignal);
  }

  return () => {
    for (const signal of signals) {
      process.off(signal, onSignal);
    }
  };
}

function createExitPromise(): {
  exitCode: Promise<number>;
  closed: Promise<void>;
  resolveExit: (code: number) => void;
  resolveClosed: () => void;
} {
  let resolveExitCode: ((code: number) => void) | null = null;
  let resolveClosedPromise: (() => void) | null = null;

  return {
    exitCode: new Promise<number>((resolve) => {
      resolveExitCode = resolve;
    }),
    closed: new Promise<void>((resolve) => {
      resolveClosedPromise = resolve;
    }),
    resolveExit(code) {
      resolveExitCode?.(code);
      resolveExitCode = null;
    },
    resolveClosed() {
      resolveClosedPromise?.();
      resolveClosedPromise = null;
    },
  };
}

function resolveExit(
  exitPromise: ReturnType<typeof createExitPromise>,
  code: number,
): void {
  exitPromise.resolveExit(code);
}

function resolveClosed(
  exitPromise: ReturnType<typeof createExitPromise>,
): void {
  exitPromise.resolveClosed();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "worker failed";
}

function getLifecycleFailure(result: AgentRunResult | null): {
  event: "tracker_handoff_failed" | "tracker_block_failed";
  reason: "tracker_handoff_failed" | "tracker_block_failed";
  errorCode: string;
  error: string;
  message: string;
} | null {
  if (result?.handoff?.status === "failed") {
    return {
      event: "tracker_handoff_failed",
      reason: "tracker_handoff_failed",
      errorCode: ERROR_CODES.trackerHandoffFailed,
      error: result.handoff.error,
      message:
        "Tracker handoff failed; automatic continuation is paused for operator action.",
    };
  }

  if (result?.blocker?.status === "failed") {
    return {
      event: "tracker_block_failed",
      reason: "tracker_block_failed",
      errorCode: ERROR_CODES.trackerBlockFailed,
      error: result.blocker.error,
      message:
        "Tracker blocker write failed; automatic continuation is paused for operator action.",
    };
  }

  return null;
}

function extractErrorCode(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }

  return null;
}

function extractCapability(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "capability" in error &&
    typeof error.capability === "string"
  ) {
    return error.capability;
  }

  return null;
}

function supportsConfigUpdate(
  value: AgentRunnerLike,
): value is AgentRunnerLike & {
  updateConfig(input: {
    config: ResolvedWorkflowConfig;
    tracker?: IssueTracker;
    workspaceManager?: WorkspaceManager;
  }): void;
} {
  return "updateConfig" in value && typeof value.updateConfig === "function";
}

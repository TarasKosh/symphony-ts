import {
  type CapabilityFailureMetadata,
  isCapabilityErrorCode,
  isDeterministicCapabilityErrorCode,
  requiresPredispatchCapability,
} from "../capabilities/external-command.js";
import type { CodexClientEvent } from "../codex/app-server-client.js";
import { validateDispatchConfig } from "../config/config-resolver.js";
import type {
  DispatchValidationResult,
  ResolvedWorkflowConfig,
} from "../config/types.js";
import {
  type Issue,
  type OperatorHoldEntry,
  type OrchestratorState,
  type RetryEntry,
  type RunningEntry,
  createEmptyLiveSession,
  createInitialOrchestratorState,
  normalizeIssueState,
} from "../domain/model.js";
import { ERROR_CODES } from "../errors/codes.js";
import {
  addEndedSessionRuntime,
  applyCodexEventToOrchestratorState,
} from "../logging/session-metrics.js";
import {
  type IssueStateSnapshot,
  type IssueTracker,
  type TrackerBlockerRunResult,
  type TrackerHandoffRunResult,
  type TrackerLifecycleConfig,
  supportsTrackerLifecycleWrite,
} from "../tracker/tracker.js";

const CONTINUATION_RETRY_DELAY_MS = 1_000;
const FAILURE_RETRY_BASE_DELAY_MS = 10_000;

export type WorkerExitOutcome = "normal" | "abnormal";

export type StopReason = "terminal_state" | "inactive_state" | "stall_timeout";

export interface SpawnWorkerResult {
  workerHandle: unknown;
  monitorHandle: unknown;
}

export interface StopRequest {
  issueId: string;
  issueIdentifier: string;
  cleanupWorkspace: boolean;
  reason: StopReason;
}

export interface PollTickResult {
  validation: DispatchValidationResult;
  dispatchedIssueIds: string[];
  stopRequests: StopRequest[];
  trackerFetchFailed: boolean;
  reconciliationFetchFailed: boolean;
  lifecycleWriteBlockers: TrackerLifecycleBlocker[];
}

export interface RetryTimerResult {
  dispatched: boolean;
  released: boolean;
  retryEntry: RetryEntry | null;
}

export interface OperatorRetryResult {
  dispatched: boolean;
  released: boolean;
  hold: OperatorHoldEntry | null;
}

export interface TrackerLifecycleBlocker {
  issueId: string;
  issueIdentifier: string;
  operation: "claim" | "handoff" | "no_progress";
  error: string;
}

export interface CodexEventResult {
  applied: boolean;
}

export interface TimerScheduler {
  set(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout> | null;
  clear(handle: ReturnType<typeof setTimeout> | null): void;
}

export interface OrchestratorCoreOptions {
  config: ResolvedWorkflowConfig;
  tracker: IssueTracker;
  spawnWorker: (input: {
    issue: Issue;
    attempt: number | null;
  }) => Promise<SpawnWorkerResult> | SpawnWorkerResult;
  stopRunningIssue?: (input: {
    issueId: string;
    runningEntry: RunningEntry;
    cleanupWorkspace: boolean;
    reason: StopReason;
  }) => Promise<void> | void;
  cleanupHeldIssue?: (input: {
    issueId: string;
    issueIdentifier: string | null;
  }) => Promise<void> | void;
  timerScheduler?: TimerScheduler;
  now?: () => Date;
}

export class OrchestratorCore {
  private config: ResolvedWorkflowConfig;

  private tracker: IssueTracker;

  private readonly spawnWorker: OrchestratorCoreOptions["spawnWorker"];

  private readonly stopRunningIssue?: OrchestratorCoreOptions["stopRunningIssue"];

  private readonly cleanupHeldIssue?: OrchestratorCoreOptions["cleanupHeldIssue"];

  private readonly timerScheduler: TimerScheduler;

  private readonly now: () => Date;

  private readonly state: OrchestratorState;

  constructor(options: OrchestratorCoreOptions) {
    this.config = options.config;
    this.tracker = options.tracker;
    this.spawnWorker = options.spawnWorker;
    this.stopRunningIssue = options.stopRunningIssue;
    this.cleanupHeldIssue = options.cleanupHeldIssue;
    this.timerScheduler = options.timerScheduler ?? defaultTimerScheduler();
    this.now = options.now ?? (() => new Date());
    this.state = createInitialOrchestratorState({
      pollIntervalMs: options.config.polling.intervalMs,
      maxConcurrentAgents: options.config.agent.maxConcurrentAgents,
    });
  }

  getState(): OrchestratorState {
    return this.state;
  }

  updateConfig(config: ResolvedWorkflowConfig): void {
    this.config = config;
    this.syncStateFromConfig();
  }

  updateTracker(tracker: IssueTracker): void {
    this.tracker = tracker;
  }

  isDispatchEligible(
    issue: Issue,
    options?: {
      allowClaimedIssueId?: string;
    },
  ): boolean {
    if (
      issue.id.trim() === "" ||
      issue.identifier.trim() === "" ||
      issue.title.trim() === "" ||
      issue.state.trim() === ""
    ) {
      return false;
    }

    const normalizedState = normalizeIssueState(issue.state);
    const activeStates = toNormalizedStateSet(this.config.tracker.activeStates);
    const terminalStates = toNormalizedStateSet(
      this.config.tracker.terminalStates,
    );
    if (
      !activeStates.has(normalizedState) ||
      terminalStates.has(normalizedState) ||
      this.state.running[issue.id] !== undefined
    ) {
      return false;
    }

    const allowClaimedIssueId = options?.allowClaimedIssueId;
    if (
      this.state.claimed.has(issue.id) &&
      (allowClaimedIssueId === undefined || allowClaimedIssueId !== issue.id)
    ) {
      return false;
    }

    if (
      this.availableSlots() <= 0 ||
      this.availableSlotsForState(issue.state) <= 0
    ) {
      return false;
    }

    if (normalizedState !== "todo") {
      return true;
    }

    return issue.blockedBy.every((blocker) => {
      const blockerState =
        blocker.state === null ? null : normalizeIssueState(blocker.state);
      return blockerState !== null && terminalStates.has(blockerState);
    });
  }

  async pollTick(): Promise<PollTickResult> {
    this.syncStateFromConfig();

    const reconcileResult = await this.reconcileRunningIssues();
    const validation = validateDispatchConfig(this.config);
    if (!validation.ok) {
      return {
        validation,
        dispatchedIssueIds: [],
        stopRequests: reconcileResult.stopRequests,
        trackerFetchFailed: false,
        reconciliationFetchFailed: reconcileResult.reconciliationFetchFailed,
        lifecycleWriteBlockers: [],
      };
    }

    let issues: Issue[];
    try {
      issues = await this.tracker.fetchCandidateIssues();
    } catch {
      return {
        validation,
        dispatchedIssueIds: [],
        stopRequests: reconcileResult.stopRequests,
        trackerFetchFailed: true,
        reconciliationFetchFailed: reconcileResult.reconciliationFetchFailed,
        lifecycleWriteBlockers: [],
      };
    }

    const dispatchedIssueIds: string[] = [];
    const lifecycleWriteBlockers: TrackerLifecycleBlocker[] = [];
    for (const issue of sortIssuesForDispatch(issues)) {
      if (this.availableSlots() <= 0) {
        break;
      }

      if (!this.isDispatchEligible(issue)) {
        continue;
      }

      const result = await this.dispatchIssue(issue, null);
      if (result.lifecycleWriteBlocker !== null) {
        lifecycleWriteBlockers.push(result.lifecycleWriteBlocker);
      }
      if (result.dispatched) {
        dispatchedIssueIds.push(issue.id);
      }
    }

    return {
      validation,
      dispatchedIssueIds,
      stopRequests: reconcileResult.stopRequests,
      trackerFetchFailed: false,
      reconciliationFetchFailed: reconcileResult.reconciliationFetchFailed,
      lifecycleWriteBlockers,
    };
  }

  async onRetryTimer(issueId: string): Promise<RetryTimerResult> {
    const retryEntry = this.state.retryAttempts[issueId];
    if (retryEntry === undefined) {
      return {
        dispatched: false,
        released: false,
        retryEntry: null,
      };
    }

    this.clearRetryEntry(issueId);
    if (!validateDispatchConfig(this.config).ok) {
      return {
        dispatched: false,
        released: false,
        retryEntry: this.scheduleRetry(issueId, retryEntry.attempt + 1, {
          identifier: retryEntry.identifier,
          error: `${ERROR_CODES.configInvalid}: dispatch configuration is invalid`,
          delayType: "failure",
          ...(retryEntry.capabilityFailure === undefined
            ? {}
            : { capabilityFailure: retryEntry.capabilityFailure }),
        }),
      };
    }

    let candidates: Issue[];
    try {
      candidates = await this.tracker.fetchCandidateIssues();
    } catch {
      return {
        dispatched: false,
        released: false,
        retryEntry: this.scheduleRetry(issueId, retryEntry.attempt + 1, {
          identifier: retryEntry.identifier,
          error: "retry poll failed",
          delayType: "failure",
          ...(retryEntry.capabilityFailure === undefined
            ? {}
            : { capabilityFailure: retryEntry.capabilityFailure }),
        }),
      };
    }

    const issue =
      candidates.find((candidate) => candidate.id === issueId) ?? null;
    if (issue === null) {
      this.releaseClaim(issueId);
      return {
        dispatched: false,
        released: true,
        retryEntry: null,
      };
    }

    if (!this.isRetryCandidateEligible(issue)) {
      this.releaseClaim(issueId);
      return {
        dispatched: false,
        released: true,
        retryEntry: null,
      };
    }

    if (
      this.availableSlots() <= 0 ||
      this.availableSlotsForState(issue.state) <= 0
    ) {
      return {
        dispatched: false,
        released: false,
        retryEntry: this.scheduleRetry(issueId, retryEntry.attempt + 1, {
          identifier: issue.identifier,
          error: "no available orchestrator slots",
          delayType: "failure",
          ...(retryEntry.capabilityFailure === undefined
            ? {}
            : { capabilityFailure: retryEntry.capabilityFailure }),
        }),
      };
    }

    const result = await this.dispatchIssue(issue, retryEntry.attempt);
    return {
      dispatched: result.dispatched,
      released: false,
      retryEntry:
        result.lifecycleWriteBlocker === null
          ? null
          : (this.state.retryAttempts[issueId] ?? null),
    };
  }

  async retryOperatorHold(issueId: string): Promise<OperatorRetryResult> {
    const hold = this.state.operatorHolds[issueId];
    if (hold === undefined) {
      return { dispatched: false, released: false, hold: null };
    }
    if (!validateDispatchConfig(this.config).ok) {
      return { dispatched: false, released: false, hold };
    }

    let candidates: Issue[];
    try {
      candidates = await this.tracker.fetchCandidateIssues();
    } catch {
      return { dispatched: false, released: false, hold };
    }

    if (this.state.operatorHolds[issueId] !== hold) {
      return {
        dispatched: false,
        released: false,
        hold: this.state.operatorHolds[issueId] ?? null,
      };
    }

    const issue = candidates.find((candidate) => candidate.id === issueId);
    if (issue === undefined || !this.isRetryCandidateEligible(issue)) {
      this.releaseClaim(issueId);
      return { dispatched: false, released: true, hold: null };
    }

    if (
      this.availableSlots() <= 0 ||
      this.availableSlotsForState(issue.state) <= 0
    ) {
      return { dispatched: false, released: false, hold };
    }

    delete this.state.operatorHolds[issueId];
    const result = await this.dispatchIssue(issue, hold.attempt);
    return {
      dispatched: result.dispatched,
      released: false,
      hold: this.state.operatorHolds[issueId] ?? null,
    };
  }

  onWorkerExit(input: {
    issueId: string;
    outcome: WorkerExitOutcome;
    reason?: string;
    errorCode?: string;
    endedAt?: Date;
    handoff?: TrackerHandoffRunResult | null;
    blocker?: TrackerBlockerRunResult | null;
    progressSignature?: string | null;
    capabilityFailure?: CapabilityFailureMetadata;
  }): RetryEntry | OperatorHoldEntry | null {
    const runningEntry = this.state.running[input.issueId];
    if (runningEntry === undefined) {
      return null;
    }

    delete this.state.running[input.issueId];
    addEndedSessionRuntime(
      this.state,
      runningEntry.startedAt,
      input.endedAt ?? this.now(),
    );

    if (input.outcome === "normal") {
      if (input.handoff?.status === "succeeded") {
        this.state.completed.add(input.issueId);
        this.releaseClaim(input.issueId);
        delete this.state.progressSignatures[input.issueId];
        return null;
      }

      if (input.handoff?.status === "failed") {
        return this.holdForOperatorAction(input.issueId, {
          attempt: nextRetryAttempt(runningEntry.retryAttempt),
          identifier: runningEntry.identifier,
          error: `${ERROR_CODES.trackerHandoffFailed}: ${input.handoff.error}`,
        });
      }

      if (input.blocker?.status === "succeeded") {
        this.state.completed.add(input.issueId);
        this.releaseClaim(input.issueId);
        delete this.state.progressSignatures[input.issueId];
        return null;
      }

      if (input.blocker?.status === "failed") {
        return this.holdForOperatorAction(input.issueId, {
          attempt: nextRetryAttempt(runningEntry.retryAttempt),
          identifier: runningEntry.identifier,
          error: `${ERROR_CODES.trackerBlockFailed}: ${input.blocker.error}`,
        });
      }

      const signature =
        input.progressSignature ?? buildNoProgressSignature(runningEntry);
      if (this.state.progressSignatures[input.issueId] === signature) {
        return this.holdForOperatorAction(input.issueId, {
          attempt: nextRetryAttempt(runningEntry.retryAttempt),
          identifier: runningEntry.identifier,
          error: `${ERROR_CODES.trackerNoProgressOrHandoffMissing}: worker exited normally without structured handoff and without new tracker or PR evidence`,
        });
      }

      this.state.progressSignatures[input.issueId] = signature;
      this.state.completed.add(input.issueId);
      return this.scheduleRetry(input.issueId, 1, {
        identifier: runningEntry.identifier,
        error: null,
        delayType: "continuation",
      });
    }

    const errorCode = input.capabilityFailure?.code ?? input.errorCode;
    if (isDeterministicCapabilityErrorCode(errorCode)) {
      return this.holdForOperatorAction(input.issueId, {
        attempt: nextRetryAttempt(runningEntry.retryAttempt),
        identifier: runningEntry.identifier,
        error:
          input.capabilityFailure === undefined
            ? formatCapabilityFailure(
                errorCode ?? ERROR_CODES.requiredCommandCapabilityTransient,
                input.reason,
              )
            : formatStructuredCapabilityFailure(input.capabilityFailure),
        ...(input.capabilityFailure === undefined
          ? {}
          : { capabilityFailure: input.capabilityFailure }),
      });
    }

    return this.scheduleRetry(
      input.issueId,
      nextRetryAttempt(runningEntry.retryAttempt),
      {
        identifier: runningEntry.identifier,
        error: isCapabilityErrorCode(errorCode)
          ? input.capabilityFailure === undefined
            ? formatCapabilityFailure(
                errorCode ?? ERROR_CODES.requiredCommandCapabilityTransient,
                input.reason,
              )
            : formatStructuredCapabilityFailure(input.capabilityFailure)
          : formatWorkerExitReason(input.reason),
        delayType: "failure",
        ...(input.capabilityFailure === undefined
          ? {}
          : { capabilityFailure: input.capabilityFailure }),
      },
    );
  }

  onCodexEvent(input: {
    issueId: string;
    event: CodexClientEvent;
  }): CodexEventResult {
    const runningEntry = this.state.running[input.issueId];
    if (runningEntry === undefined) {
      return { applied: false };
    }

    applyCodexEventToOrchestratorState(this.state, runningEntry, input.event);
    return { applied: true };
  }

  private syncStateFromConfig(): void {
    this.state.pollIntervalMs = this.config.polling.intervalMs;
    this.state.maxConcurrentAgents = this.config.agent.maxConcurrentAgents;
  }

  private availableSlots(): number {
    return Math.max(
      this.state.maxConcurrentAgents - Object.keys(this.state.running).length,
      0,
    );
  }

  private availableSlotsForState(issueState: string): number {
    const normalizedState = normalizeIssueState(issueState);
    const limit =
      this.config.agent.maxConcurrentAgentsByState[normalizedState] ??
      this.state.maxConcurrentAgents;
    const runningForState = Object.values(this.state.running).filter(
      (entry) => normalizeIssueState(entry.issue.state) === normalizedState,
    ).length;
    return Math.max(limit - runningForState, 0);
  }

  private isRetryCandidateEligible(issue: Issue): boolean {
    if (
      issue.id.trim() === "" ||
      issue.identifier.trim() === "" ||
      issue.title.trim() === "" ||
      issue.state.trim() === ""
    ) {
      return false;
    }

    const normalizedState = normalizeIssueState(issue.state);
    const activeStates = toNormalizedStateSet(this.config.tracker.activeStates);
    const terminalStates = toNormalizedStateSet(
      this.config.tracker.terminalStates,
    );
    if (
      !activeStates.has(normalizedState) ||
      terminalStates.has(normalizedState) ||
      this.state.running[issue.id] !== undefined
    ) {
      return false;
    }

    if (normalizedState !== "todo") {
      return true;
    }

    return issue.blockedBy.every((blocker) => {
      const blockerState =
        blocker.state === null ? null : normalizeIssueState(blocker.state);
      return blockerState !== null && terminalStates.has(blockerState);
    });
  }

  private async dispatchIssue(
    issue: Issue,
    attempt: number | null,
  ): Promise<{
    dispatched: boolean;
    lifecycleWriteBlocker: TrackerLifecycleBlocker | null;
  }> {
    let issueForDispatch = issue;
    if (
      !requiresPredispatchCapability(this.config) &&
      this.config.tracker.requireClaimBeforeAgent &&
      supportsTrackerLifecycleWrite(this.tracker)
    ) {
      try {
        issueForDispatch = await this.claimIssueBeforeDispatch(issue);
      } catch (error) {
        const message = `${ERROR_CODES.trackerClaimFailed}: ${toErrorMessage(error)}`;
        this.scheduleRetry(issue.id, nextRetryAttempt(attempt), {
          identifier: issue.identifier,
          error: message,
          delayType: "failure",
        });
        return {
          dispatched: false,
          lifecycleWriteBlocker: {
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            operation: "claim",
            error: message,
          },
        };
      }
    }

    const reservation: RunningEntry = {
      ...createEmptyLiveSession(),
      issue: issueForDispatch,
      identifier: issueForDispatch.identifier,
      retryAttempt: normalizeRetryAttempt(attempt),
      startedAt: this.now().toISOString(),
      workerHandle: null,
      monitorHandle: null,
    };
    this.state.running[issueForDispatch.id] = reservation;
    this.state.claimed.add(issueForDispatch.id);
    this.clearRetryEntry(issueForDispatch.id);

    try {
      const spawned = await this.spawnWorker({
        issue: issueForDispatch,
        attempt,
      });
      reservation.workerHandle = spawned.workerHandle;
      reservation.monitorHandle = spawned.monitorHandle;
      return {
        dispatched: true,
        lifecycleWriteBlocker: null,
      };
    } catch {
      if (this.state.running[issueForDispatch.id] === reservation) {
        delete this.state.running[issueForDispatch.id];
      }
      this.state.claimed.delete(issueForDispatch.id);
      this.scheduleRetry(issueForDispatch.id, nextRetryAttempt(attempt), {
        identifier: issueForDispatch.identifier,
        error: "failed to spawn agent",
        delayType: "failure",
      });
      return {
        dispatched: false,
        lifecycleWriteBlocker: null,
      };
    }
  }

  private async claimIssueBeforeDispatch(issue: Issue): Promise<Issue> {
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

  private async reconcileRunningIssues(): Promise<{
    stopRequests: StopRequest[];
    reconciliationFetchFailed: boolean;
  }> {
    const stopRequests = await this.reconcileStalledRuns();
    const runningIds = Object.keys(this.state.running);
    const heldIds = Object.keys(this.state.operatorHolds);
    const reconciledIds = [...new Set([...runningIds, ...heldIds])];
    if (reconciledIds.length === 0) {
      return {
        stopRequests,
        reconciliationFetchFailed: false,
      };
    }

    let refreshed: IssueStateSnapshot[];
    try {
      refreshed = await this.tracker.fetchIssueStatesByIds(reconciledIds);
    } catch {
      return {
        stopRequests,
        reconciliationFetchFailed: true,
      };
    }

    const activeStates = toNormalizedStateSet(this.config.tracker.activeStates);
    const terminalStates = toNormalizedStateSet(
      this.config.tracker.terminalStates,
    );
    const refreshedIds = new Set(refreshed.map((snapshot) => snapshot.id));

    for (const snapshot of refreshed) {
      const runningEntry = this.state.running[snapshot.id];
      const hold = this.state.operatorHolds[snapshot.id];
      if (runningEntry === undefined && hold === undefined) {
        continue;
      }

      const normalizedState = normalizeIssueState(snapshot.state);
      if (hold !== undefined) {
        if (terminalStates.has(normalizedState)) {
          try {
            await this.cleanupHeldIssue?.({
              issueId: snapshot.id,
              issueIdentifier: hold.identifier,
            });
          } finally {
            this.releaseClaim(snapshot.id);
          }
          continue;
        }

        if (activeStates.has(normalizedState)) {
          hold.identifier = snapshot.identifier;
          continue;
        }

        this.releaseClaim(snapshot.id);
        continue;
      }

      if (runningEntry === undefined) {
        continue;
      }

      if (terminalStates.has(normalizedState)) {
        stopRequests.push(
          await this.requestStop(runningEntry, true, "terminal_state"),
        );
        continue;
      }

      if (activeStates.has(normalizedState)) {
        runningEntry.issue = {
          ...runningEntry.issue,
          identifier: snapshot.identifier,
          state: snapshot.state,
        };
        runningEntry.identifier = snapshot.identifier;
        continue;
      }

      stopRequests.push(
        await this.requestStop(runningEntry, false, "inactive_state"),
      );
    }

    for (const runningId of runningIds) {
      if (refreshedIds.has(runningId)) {
        continue;
      }

      const runningEntry = this.state.running[runningId];
      if (runningEntry === undefined) {
        continue;
      }

      stopRequests.push(
        await this.requestStop(runningEntry, false, "inactive_state"),
      );
    }

    for (const heldId of heldIds) {
      if (refreshedIds.has(heldId)) {
        continue;
      }

      this.releaseClaim(heldId);
    }

    return {
      stopRequests,
      reconciliationFetchFailed: false,
    };
  }

  private async reconcileStalledRuns(): Promise<StopRequest[]> {
    if (this.config.codex.stallTimeoutMs <= 0) {
      return [];
    }

    const nowMs = this.now().getTime();
    const stopRequests: StopRequest[] = [];
    for (const runningEntry of Object.values(this.state.running)) {
      const baselineTimestamp = parseEventTimestamp(
        runningEntry.lastCodexTimestamp,
        runningEntry.startedAt,
      );
      if (baselineTimestamp === null) {
        continue;
      }

      if (nowMs - baselineTimestamp > this.config.codex.stallTimeoutMs) {
        stopRequests.push(
          await this.requestStop(runningEntry, false, "stall_timeout"),
        );
      }
    }

    return stopRequests;
  }

  private async requestStop(
    runningEntry: RunningEntry,
    cleanupWorkspace: boolean,
    reason: StopReason,
  ): Promise<StopRequest> {
    const stopRequest: StopRequest = {
      issueId: runningEntry.issue.id,
      issueIdentifier: runningEntry.identifier,
      cleanupWorkspace,
      reason,
    };

    await this.stopRunningIssue?.({
      issueId: runningEntry.issue.id,
      runningEntry,
      cleanupWorkspace,
      reason,
    });

    return stopRequest;
  }

  private scheduleRetry(
    issueId: string,
    attempt: number,
    input: {
      identifier: string | null;
      error: string | null;
      delayType: "continuation" | "failure";
      capabilityFailure?: CapabilityFailureMetadata;
    },
  ): RetryEntry {
    this.clearRetryEntry(issueId);

    const delayMs =
      input.delayType === "continuation"
        ? CONTINUATION_RETRY_DELAY_MS
        : computeFailureRetryDelayMs(
            attempt,
            this.config.agent.maxRetryBackoffMs,
          );
    const dueAtMs = this.now().getTime() + delayMs;
    const timerHandle = this.timerScheduler.set(() => {
      void this.onRetryTimer(issueId);
    }, delayMs);

    const retryEntry: RetryEntry = {
      issueId,
      identifier: input.identifier,
      attempt,
      dueAtMs,
      timerHandle,
      error: input.error,
      ...(input.capabilityFailure === undefined
        ? {}
        : { capabilityFailure: input.capabilityFailure }),
    };

    this.state.claimed.add(issueId);
    this.state.retryAttempts[issueId] = retryEntry;
    return retryEntry;
  }

  private holdForOperatorAction(
    issueId: string,
    input: {
      attempt: number;
      identifier: string | null;
      error: string;
      capabilityFailure?: CapabilityFailureMetadata;
    },
  ): OperatorHoldEntry {
    this.clearRetryEntry(issueId);

    const hold: OperatorHoldEntry = {
      issueId,
      identifier: input.identifier,
      attempt: input.attempt,
      heldAtMs: this.now().getTime(),
      error: input.error,
      ...(input.capabilityFailure === undefined
        ? {}
        : { capabilityFailure: input.capabilityFailure }),
    };

    this.state.claimed.add(issueId);
    this.state.operatorHolds[issueId] = hold;
    return hold;
  }

  private clearRetryEntry(issueId: string): void {
    const current = this.state.retryAttempts[issueId];
    if (current !== undefined) {
      this.timerScheduler.clear(current.timerHandle);
      delete this.state.retryAttempts[issueId];
    }
  }

  private releaseClaim(issueId: string): void {
    this.clearRetryEntry(issueId);
    delete this.state.operatorHolds[issueId];
    this.state.claimed.delete(issueId);
    delete this.state.progressSignatures[issueId];
  }
}

export function sortIssuesForDispatch(issues: readonly Issue[]): Issue[] {
  return issues.slice().sort((left, right) => {
    const priorityDelta =
      toSortablePriority(left.priority) - toSortablePriority(right.priority);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    const createdAtDelta =
      toSortableDate(left.createdAt) - toSortableDate(right.createdAt);
    if (createdAtDelta !== 0) {
      return createdAtDelta;
    }

    return left.identifier.localeCompare(right.identifier, "en");
  });
}

export function computeFailureRetryDelayMs(
  attempt: number,
  maxRetryBackoffMs: number,
): number {
  const normalizedAttempt = Math.max(attempt, 1);
  const exponentialDelay =
    FAILURE_RETRY_BASE_DELAY_MS * 2 ** (normalizedAttempt - 1);
  return Math.min(exponentialDelay, maxRetryBackoffMs);
}

export function nextRetryAttempt(attempt: number | null): number {
  return attempt === null ? 1 : attempt + 1;
}

function normalizeRetryAttempt(attempt: number | null): number | null {
  return attempt === null ? null : Math.max(1, Math.floor(attempt));
}

function formatWorkerExitReason(reason: string | undefined): string {
  const normalized = reason?.trim();
  return normalized && normalized.length > 0
    ? `worker exited: ${normalized}`
    : "worker exited: abnormal";
}

function formatCapabilityFailure(
  errorCode: string,
  reason: string | undefined,
): string {
  return `${errorCode}: ${formatWorkerExitReason(reason)}`;
}

function formatStructuredCapabilityFailure(
  failure: CapabilityFailureMetadata,
): string {
  return `${failure.code}: ${failure.capability} command '${failure.command}' failed in ${failure.boundary}. ${failure.remediation}`;
}

function buildNoProgressSignature(runningEntry: RunningEntry): string {
  return JSON.stringify({
    issueId: runningEntry.issue.id,
    identifier: runningEntry.identifier,
    state: runningEntry.issue.state,
    threadId: runningEntry.threadId,
    lastMessage: runningEntry.lastCodexMessage,
  });
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "tracker lifecycle write failed";
}

function toSortablePriority(priority: number | null): number {
  return priority === null ? Number.POSITIVE_INFINITY : priority;
}

function toSortableDate(timestamp: string | null): number {
  if (timestamp === null) {
    return Number.POSITIVE_INFINITY;
  }

  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function parseEventTimestamp(
  lastCodexTimestamp: string | null,
  startedAt: string,
): number | null {
  if (lastCodexTimestamp !== null) {
    const parsed = Date.parse(lastCodexTimestamp);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  const startedAtMs = Date.parse(startedAt);
  return Number.isFinite(startedAtMs) ? startedAtMs : null;
}

function toNormalizedStateSet(states: readonly string[]): Set<string> {
  return new Set(states.map((state) => normalizeIssueState(state)));
}

function defaultTimerScheduler(): TimerScheduler {
  return {
    set(callback, delayMs) {
      return setTimeout(callback, delayMs);
    },
    clear(handle) {
      if (handle !== null) {
        clearTimeout(handle);
      }
    },
  };
}

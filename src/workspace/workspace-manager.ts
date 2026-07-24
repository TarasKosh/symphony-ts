import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { ExternalCommandCapabilityError } from "../capabilities/external-command.js";
import type { Workspace } from "../domain/model.js";
import { ERROR_CODES } from "../errors/codes.js";
import type { WorkspaceHookRunner } from "./hooks.js";
import {
  WorkspacePathError,
  type WorkspacePathInfo,
  resolveWorkspacePath,
} from "./path-safety.js";

const CONTROL_DIRECTORY = ".symphony+";
const PROVISIONING_DIRECTORY = "provisioning";
const RECOVERY_DIRECTORY = "recovery";
const PROVISIONING_STATE_VERSION = 1;
const PROVISIONING_EVENT = "workspace_provisioning_incomplete";
const PROVISIONING_REMEDIATION =
  "Inspect the workspace and Symphony provisioning state; remove the workspace only after verifying it is safe, then retry.";
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DECIMAL_BIGINT_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const PROVISIONING_STATE_FIELDS = [
  "directoryIdentity",
  "generation",
  "state",
  "version",
  "workspaceKey",
  "workspacePath",
] as const;
const DIRECTORY_IDENTITY_FIELDS = ["birthtimeNs", "dev", "ino"] as const;

interface NoFollowStats {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly birthtimeNs: bigint;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface FileSystemLike {
  lstat(path: string, options: { bigint: true }): Promise<NoFollowStats>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(
    path: string,
    data: string,
    options: { encoding: "utf8"; flag: "wx" },
  ): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  rm(
    path: string,
    options?: { force?: boolean; recursive?: boolean },
  ): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rmdir(path: string): Promise<void>;
}

interface DirectoryIdentity {
  dev: string;
  ino: string;
  birthtimeNs: string;
}

interface ProvisioningState {
  version: 1;
  state: "in_progress" | "ready";
  workspaceKey: string;
  workspacePath: string;
  generation: string;
  directoryIdentity: DirectoryIdentity | null;
}

interface ProvisioningAttempt {
  generation: string;
  directoryCreated: boolean;
  directoryIdentity: DirectoryIdentity | null;
}

export interface WorkspaceProvisioningLogEntry {
  level: "info" | "warn" | "error";
  event: "workspace_provisioning_incomplete";
  outcome: "recovering" | "recovered" | "failed";
  issueId: string;
  workspacePath: string;
  errorCode: typeof ERROR_CODES.workspaceProvisioningIncomplete;
  remediation: string;
}

export type WorkspaceProvisioningLogger = (
  entry: WorkspaceProvisioningLogEntry,
) => void;

export interface WorkspaceManagerOptions {
  root: string;
  fs?: Partial<FileSystemLike>;
  hooks?: WorkspaceHookRunner | null;
  provisioningLogger?: WorkspaceProvisioningLogger;
}

const lifecycleTails = new Map<string, Promise<void>>();

export class WorkspaceManager {
  readonly root: string;
  readonly #fs: FileSystemLike;
  readonly #hooks: WorkspaceHookRunner | null;
  readonly #provisioningLogger: WorkspaceProvisioningLogger;

  constructor(options: WorkspaceManagerOptions) {
    this.root = options.root;
    this.#fs = createFileSystem(options.fs);
    this.#hooks = isHookRunner(options.hooks) ? options.hooks : null;
    this.#provisioningLogger = options.provisioningLogger ?? (() => {});
  }

  get hookRunner(): WorkspaceHookRunner | null {
    return this.#hooks;
  }

  resolveForIssue(issueId: string): WorkspacePathInfo {
    return resolveWorkspacePath(this.root, issueId);
  }

  async createForIssue(issueId: string): Promise<Workspace> {
    const resolved = this.resolveForIssue(issueId);
    return withLifecycleCoordinator(
      lifecycleKey(resolved),
      async () => await this.#createForResolvedIssue(issueId, resolved),
    );
  }

  async removeForIssue(issueId: string): Promise<boolean> {
    const resolved = this.resolveForIssue(issueId);
    return withLifecycleCoordinator(
      lifecycleKey(resolved),
      async () => await this.#removeForResolvedIssue(issueId, resolved),
    );
  }

  async #createForResolvedIssue(
    issueId: string,
    resolved: WorkspacePathInfo,
  ): Promise<Workspace> {
    let currentAttempt: ProvisioningAttempt | null = null;
    let recovering = false;

    try {
      await this.#ensureWorkspaceRoot(resolved.workspaceRoot);
      const workspaceStats = await this.#readWorkspaceDirectory(
        resolved.workspacePath,
      );
      try {
        await this.#validateExistingControlNamespace(resolved.workspaceRoot);
      } catch (error) {
        throw this.#provisioningFailure(
          issueId,
          resolved.workspacePath,
          "The manager provisioning control namespace is invalid.",
          error,
        );
      }
      const state = await this.#readProvisioningStateOrFail(issueId, resolved);

      if (workspaceStats !== null) {
        if (state === null) {
          return workspaceResult(resolved, false);
        }

        if (state.state === "ready") {
          if (
            state.directoryIdentity === null ||
            !identityMatches(
              state.directoryIdentity,
              directoryIdentity(workspaceStats),
            )
          ) {
            throw this.#provisioningFailure(
              issueId,
              resolved.workspacePath,
              "The ready workspace directory identity does not match its provisioning state.",
            );
          }

          return workspaceResult(resolved, false);
        }

        recovering = true;
        this.#emitProvisioning("recovering", issueId, resolved.workspacePath);

        try {
          if (state.directoryIdentity === null) {
            await this.#removeReservedEmptyWorkspace(resolved, state);
          } else {
            await this.#removeOwnedWorkspace(resolved, state);
          }
        } catch (error) {
          throw this.#provisioningFailure(
            issueId,
            resolved.workspacePath,
            "The interrupted workspace could not be recovered safely.",
            error,
          );
        }
      } else if (state !== null) {
        try {
          await this.#removeMatchingQuarantineForMissingWorkspace(
            resolved,
            state,
          );
        } catch (error) {
          throw this.#provisioningFailure(
            issueId,
            resolved.workspacePath,
            "Interrupted provisioning residue could not be removed safely.",
            error,
          );
        }
      }

      currentAttempt = {
        generation: randomUUID(),
        directoryCreated: false,
        directoryIdentity: null,
      };
      await this.#provisionNewWorkspace(issueId, resolved, currentAttempt);

      if (recovering) {
        this.#emitProvisioning("recovered", issueId, resolved.workspacePath);
      }

      return workspaceResult(resolved, true);
    } catch (error) {
      if (currentAttempt?.directoryCreated === true) {
        await this.#removeCurrentAttemptBestEffort(
          issueId,
          resolved,
          currentAttempt,
        );
      }

      if (error instanceof ExternalCommandCapabilityError) {
        throw error;
      }

      if (error instanceof WorkspacePathError) {
        throw error;
      }

      throw new WorkspacePathError(
        ERROR_CODES.workspaceCreateFailed,
        `Failed to prepare workspace for ${issueId}`,
        { cause: error },
      );
    }
  }

  async #removeForResolvedIssue(
    issueId: string,
    resolved: WorkspacePathInfo,
  ): Promise<boolean> {
    try {
      const existsAsDirectory = await this.#pathIsRealDirectory(
        resolved.workspacePath,
      );
      if (existsAsDirectory) {
        await this.#hooks?.runBestEffort({
          name: "beforeRemove",
          workspacePath: resolved.workspacePath,
        });
      }

      await this.#fs.rm(resolved.workspacePath, {
        force: true,
        recursive: true,
      });
      await this.#removeControlStateAfterExplicitRemoval(resolved);
      return true;
    } catch (error) {
      throw new WorkspacePathError(
        ERROR_CODES.workspaceCleanupFailed,
        `Failed to remove workspace for ${issueId}`,
        { cause: error },
      );
    }
  }

  async #provisionNewWorkspace(
    issueId: string,
    resolved: WorkspacePathInfo,
    attempt: ProvisioningAttempt,
  ): Promise<void> {
    await this.#writeProvisioningState(
      resolved,
      provisioningState(resolved, attempt),
    );

    try {
      await this.#fs.mkdir(resolved.workspacePath);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }

      const existing = await this.#readWorkspaceDirectory(
        resolved.workspacePath,
      );
      if (existing === null) {
        throw error;
      }

      const entries = await this.#fs.readdir(resolved.workspacePath);
      if (entries.length !== 0) {
        throw this.#provisioningFailure(
          issueId,
          resolved.workspacePath,
          "A populated workspace appeared after provisioning was reserved.",
          error,
        );
      }

      await this.#fs.rmdir(resolved.workspacePath);
      await this.#fs.mkdir(resolved.workspacePath);
    }

    attempt.directoryCreated = true;
    const createdStats = await this.#readRequiredOwnedDirectory(
      resolved.workspacePath,
    );
    attempt.directoryIdentity = directoryIdentity(createdStats);
    await this.#writeProvisioningState(
      resolved,
      provisioningState(resolved, attempt),
    );

    await this.#hooks?.run({
      name: "afterCreate",
      workspacePath: resolved.workspacePath,
    });

    await this.#writeProvisioningState(resolved, {
      ...provisioningState(resolved, attempt),
      state: "ready",
    });
  }

  async #removeCurrentAttemptBestEffort(
    issueId: string,
    resolved: WorkspacePathInfo,
    attempt: ProvisioningAttempt,
  ): Promise<void> {
    try {
      const currentState = await this.#readProvisioningState(resolved);
      if (
        currentState === null ||
        currentState.state !== "in_progress" ||
        currentState.generation !== attempt.generation
      ) {
        throw new Error(
          "The current provisioning generation no longer owns the workspace.",
        );
      }

      if (currentState.directoryIdentity === null) {
        await this.#removeReservedEmptyWorkspace(resolved, currentState);
      } else {
        if (
          attempt.directoryIdentity === null ||
          !identityMatches(
            currentState.directoryIdentity,
            attempt.directoryIdentity,
          )
        ) {
          throw new Error(
            "The current provisioning identity no longer owns the workspace.",
          );
        }
        await this.#removeOwnedWorkspace(resolved, currentState);
      }

      await this.#removeProvisioningStateBestEffort(resolved);
    } catch {
      this.#emitProvisioning("failed", issueId, resolved.workspacePath);
    }
  }

  async #removeReservedEmptyWorkspace(
    resolved: WorkspacePathInfo,
    expectedState: ProvisioningState,
  ): Promise<void> {
    const currentState = await this.#readProvisioningState(resolved);
    if (
      currentState === null ||
      currentState.state !== "in_progress" ||
      currentState.generation !== expectedState.generation ||
      currentState.directoryIdentity !== null
    ) {
      throw new Error("The provisioning reservation changed before cleanup.");
    }

    await this.#readRequiredOwnedDirectory(resolved.workspacePath);
    const entries = await this.#fs.readdir(resolved.workspacePath);
    if (entries.length !== 0) {
      throw new Error(
        "A provisioning reservation without an identity has a populated workspace.",
      );
    }

    await this.#fs.rmdir(resolved.workspacePath);
  }

  async #removeOwnedWorkspace(
    resolved: WorkspacePathInfo,
    expectedState: ProvisioningState,
  ): Promise<void> {
    if (expectedState.directoryIdentity === null) {
      throw new Error(
        "Provisioning state has no directory identity for recursive cleanup.",
      );
    }

    const reResolved = this.resolveForIssue(expectedState.workspaceKey);
    if (
      reResolved.workspaceRoot !== resolved.workspaceRoot ||
      reResolved.workspaceKey !== resolved.workspaceKey ||
      reResolved.workspacePath !== resolved.workspacePath
    ) {
      throw new Error("The workspace path changed before recursive cleanup.");
    }

    const currentState = await this.#readProvisioningState(resolved);
    if (
      currentState === null ||
      currentState.state !== "in_progress" ||
      !sameProvisioningGeneration(currentState, expectedState) ||
      currentState.directoryIdentity === null ||
      !identityMatches(
        currentState.directoryIdentity,
        expectedState.directoryIdentity,
      )
    ) {
      throw new Error(
        "Provisioning ownership changed before recursive cleanup.",
      );
    }

    const currentStats = await this.#readRequiredOwnedDirectory(
      resolved.workspacePath,
    );
    if (
      !identityMatches(
        expectedState.directoryIdentity,
        directoryIdentity(currentStats),
      )
    ) {
      throw new Error(
        "The workspace identity changed before recursive cleanup.",
      );
    }

    const recoveryRoot = await this.#ensureRecoveryDirectory(
      resolved.workspaceRoot,
    );
    const quarantinePath = recoveryPath(
      recoveryRoot,
      resolved.workspaceKey,
      expectedState.generation,
    );
    await this.#assertPathMissing(quarantinePath);
    await this.#fs.rename(resolved.workspacePath, quarantinePath);

    const movedStats = await this.#readRequiredOwnedDirectory(quarantinePath);
    if (
      !identityMatches(
        expectedState.directoryIdentity,
        directoryIdentity(movedStats),
      )
    ) {
      throw new Error(
        "The quarantined workspace identity changed before recursive cleanup.",
      );
    }

    await this.#fs.rm(quarantinePath, { force: true, recursive: true });
  }

  async #removeMatchingQuarantineForMissingWorkspace(
    resolved: WorkspacePathInfo,
    state: ProvisioningState,
  ): Promise<void> {
    const recoveryRoot = await this.#ensureRecoveryDirectory(
      resolved.workspaceRoot,
    );
    const quarantinePath = recoveryPath(
      recoveryRoot,
      resolved.workspaceKey,
      state.generation,
    );
    const quarantineStats = await this.#lstatOrNull(quarantinePath);
    if (quarantineStats === null) {
      return;
    }

    if (
      state.directoryIdentity === null ||
      !isRealDirectory(quarantineStats) ||
      !identityMatches(
        state.directoryIdentity,
        directoryIdentity(quarantineStats),
      )
    ) {
      throw new Error(
        "Recovery quarantine residue does not match provisioning state.",
      );
    }

    await this.#fs.rm(quarantinePath, { force: true, recursive: true });
  }

  async #removeControlStateAfterExplicitRemoval(
    resolved: WorkspacePathInfo,
  ): Promise<void> {
    let state: ProvisioningState | null = null;
    try {
      state = await this.#readProvisioningState(resolved);
    } catch {
      // The exact state file is still safe to remove after explicit deletion.
    }

    if (state?.directoryIdentity !== null && state !== null) {
      try {
        await this.#removeMatchingQuarantineForMissingWorkspace(
          resolved,
          state,
        );
      } catch {
        // Quarantine cleanup is best-effort and never broadens ownership.
      }
    }

    await this.#removeProvisioningStateBestEffort(resolved);
  }

  async #readProvisioningStateOrFail(
    issueId: string,
    resolved: WorkspacePathInfo,
  ): Promise<ProvisioningState | null> {
    try {
      return await this.#readProvisioningState(resolved);
    } catch (error) {
      throw this.#provisioningFailure(
        issueId,
        resolved.workspacePath,
        "The provisioning state is invalid or unreadable.",
        error,
      );
    }
  }

  async #readProvisioningState(
    resolved: WorkspacePathInfo,
  ): Promise<ProvisioningState | null> {
    const { controlRoot, provisioningRoot, statePath } = controlPaths(resolved);
    const stateStats = await this.#lstatOrNull(statePath);
    if (stateStats === null) {
      return null;
    }

    await this.#assertExistingRealDirectory(controlRoot);
    await this.#assertExistingRealDirectory(provisioningRoot);
    if (!isRealFile(stateStats)) {
      throw new Error("Provisioning state is not a real regular file.");
    }

    const serialized = await this.#fs.readFile(statePath, "utf8");
    return parseProvisioningState(serialized, resolved);
  }

  async #writeProvisioningState(
    resolved: WorkspacePathInfo,
    state: ProvisioningState,
  ): Promise<void> {
    const { statePath } = controlPaths(resolved);
    await this.#ensureControlDirectories(resolved.workspaceRoot);
    const temporaryPath = `${statePath}.${randomUUID()}.tmp`;

    try {
      await this.#fs.writeFile(temporaryPath, `${JSON.stringify(state)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      await this.#fs.rename(temporaryPath, statePath);
    } catch (error) {
      try {
        await this.#fs.rm(temporaryPath, { force: true });
      } catch {
        // State temp cleanup is best-effort; the original write error wins.
      }
      throw error;
    }
  }

  async #removeProvisioningStateBestEffort(
    resolved: WorkspacePathInfo,
  ): Promise<void> {
    try {
      await this.#fs.rm(controlPaths(resolved).statePath, { force: true });
    } catch {
      // Missing-workspace state may be replaced safely on a later create.
    }
  }

  async #ensureWorkspaceRoot(workspaceRoot: string): Promise<void> {
    await this.#fs.mkdir(workspaceRoot, { recursive: true });
    const stats = await this.#fs.lstat(workspaceRoot, { bigint: true });
    if (!isRealDirectory(stats)) {
      throw new WorkspacePathError(
        ERROR_CODES.workspacePathInvalid,
        `Workspace root is not a real directory: ${workspaceRoot}`,
      );
    }
  }

  async #ensureControlDirectories(workspaceRoot: string): Promise<void> {
    const controlRoot = join(workspaceRoot, CONTROL_DIRECTORY);
    await this.#ensureRealDirectory(controlRoot);
    await this.#ensureRealDirectory(join(controlRoot, PROVISIONING_DIRECTORY));
    await this.#ensureRealDirectory(join(controlRoot, RECOVERY_DIRECTORY));
  }

  async #validateExistingControlNamespace(
    workspaceRoot: string,
  ): Promise<void> {
    const controlRoot = join(workspaceRoot, CONTROL_DIRECTORY);
    const controlStats = await this.#lstatOrNull(controlRoot);
    if (controlStats === null) {
      return;
    }
    if (!isRealDirectory(controlStats)) {
      throw new Error(
        `Manager control path is not a real directory: ${controlRoot}`,
      );
    }

    for (const child of [PROVISIONING_DIRECTORY, RECOVERY_DIRECTORY]) {
      const childPath = join(controlRoot, child);
      const childStats = await this.#lstatOrNull(childPath);
      if (childStats !== null && !isRealDirectory(childStats)) {
        throw new Error(
          `Manager control path is not a real directory: ${childPath}`,
        );
      }
    }
  }

  async #ensureRecoveryDirectory(workspaceRoot: string): Promise<string> {
    await this.#ensureControlDirectories(workspaceRoot);
    return join(workspaceRoot, CONTROL_DIRECTORY, RECOVERY_DIRECTORY);
  }

  async #ensureRealDirectory(path: string): Promise<void> {
    try {
      await this.#fs.mkdir(path);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }

    await this.#assertExistingRealDirectory(path);
  }

  async #assertExistingRealDirectory(path: string): Promise<void> {
    const stats = await this.#fs.lstat(path, { bigint: true });
    if (!isRealDirectory(stats)) {
      throw new Error(`Manager control path is not a real directory: ${path}`);
    }
  }

  async #readWorkspaceDirectory(
    workspacePath: string,
  ): Promise<NoFollowStats | null> {
    const stats = await this.#lstatOrNull(workspacePath);
    if (stats === null) {
      return null;
    }

    if (!isRealDirectory(stats)) {
      throw new WorkspacePathError(
        ERROR_CODES.workspacePathInvalid,
        `Workspace path exists and is not a real directory: ${workspacePath}`,
      );
    }

    return stats;
  }

  async #readRequiredOwnedDirectory(path: string): Promise<NoFollowStats> {
    const stats = await this.#fs.lstat(path, { bigint: true });
    if (!isRealDirectory(stats)) {
      throw new Error(`Owned workspace path is not a real directory: ${path}`);
    }
    directoryIdentity(stats);
    return stats;
  }

  async #pathIsRealDirectory(path: string): Promise<boolean> {
    const stats = await this.#lstatOrNull(path);
    return stats !== null && isRealDirectory(stats);
  }

  async #assertPathMissing(path: string): Promise<void> {
    const stats = await this.#lstatOrNull(path);
    if (stats !== null) {
      throw new Error(`Recovery quarantine target already exists: ${path}`);
    }
  }

  async #lstatOrNull(path: string): Promise<NoFollowStats | null> {
    try {
      return await this.#fs.lstat(path, { bigint: true });
    } catch (error) {
      if (isMissingPathError(error)) {
        return null;
      }
      throw error;
    }
  }

  #provisioningFailure(
    issueId: string,
    workspacePath: string,
    detail: string,
    cause?: unknown,
  ): WorkspacePathError {
    this.#emitProvisioning("failed", issueId, workspacePath);
    return new WorkspacePathError(
      ERROR_CODES.workspaceProvisioningIncomplete,
      `Workspace provisioning is incomplete for ${issueId} at ${workspacePath}: ${detail} ${PROVISIONING_REMEDIATION}`,
      cause === undefined ? undefined : { cause },
    );
  }

  #emitProvisioning(
    outcome: WorkspaceProvisioningLogEntry["outcome"],
    issueId: string,
    workspacePath: string,
  ): void {
    try {
      this.#provisioningLogger({
        level:
          outcome === "recovering"
            ? "warn"
            : outcome === "recovered"
              ? "info"
              : "error",
        event: PROVISIONING_EVENT,
        outcome,
        issueId,
        workspacePath,
        errorCode: ERROR_CODES.workspaceProvisioningIncomplete,
        remediation: PROVISIONING_REMEDIATION,
      });
    } catch {
      // Diagnostics must never change workspace lifecycle behavior.
    }
  }
}

function createFileSystem(
  overrides: Partial<FileSystemLike> | undefined,
): FileSystemLike {
  return {
    lstat:
      overrides?.lstat ??
      (async (path, options) => await fs.lstat(path, options)),
    mkdir:
      overrides?.mkdir ??
      (async (path, options) => await fs.mkdir(path, options)),
    readFile:
      overrides?.readFile ??
      (async (path, encoding) => await fs.readFile(path, encoding)),
    writeFile:
      overrides?.writeFile ??
      (async (path, data, options) => await fs.writeFile(path, data, options)),
    rename:
      overrides?.rename ??
      (async (source, destination) => await fs.rename(source, destination)),
    rm: overrides?.rm ?? (async (path, options) => await fs.rm(path, options)),
    readdir: overrides?.readdir ?? (async (path) => await fs.readdir(path)),
    rmdir: overrides?.rmdir ?? (async (path) => await fs.rmdir(path)),
  };
}

function provisioningState(
  resolved: WorkspacePathInfo,
  attempt: ProvisioningAttempt,
): ProvisioningState {
  return {
    version: PROVISIONING_STATE_VERSION,
    state: "in_progress",
    workspaceKey: resolved.workspaceKey,
    workspacePath: resolved.workspacePath,
    generation: attempt.generation,
    directoryIdentity: attempt.directoryIdentity,
  };
}

function parseProvisioningState(
  serialized: string,
  resolved: WorkspacePathInfo,
): ProvisioningState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error("Provisioning state is not valid JSON.", { cause: error });
  }

  if (
    !isRecord(parsed) ||
    !hasExactFields(parsed, PROVISIONING_STATE_FIELDS) ||
    parsed.version !== PROVISIONING_STATE_VERSION ||
    (parsed.state !== "in_progress" && parsed.state !== "ready") ||
    parsed.workspaceKey !== resolved.workspaceKey ||
    parsed.workspacePath !== resolved.workspacePath ||
    typeof parsed.generation !== "string" ||
    !UUID_V4_PATTERN.test(parsed.generation)
  ) {
    throw new Error("Provisioning state does not match the version-1 schema.");
  }

  const identity = parseDirectoryIdentity(parsed.directoryIdentity);
  if (parsed.state === "ready" && identity === null) {
    throw new Error("Ready provisioning state requires a directory identity.");
  }

  return {
    version: PROVISIONING_STATE_VERSION,
    state: parsed.state,
    workspaceKey: parsed.workspaceKey,
    workspacePath: parsed.workspacePath,
    generation: parsed.generation,
    directoryIdentity: identity,
  };
}

function parseDirectoryIdentity(value: unknown): DirectoryIdentity | null {
  if (value === null) {
    return null;
  }

  if (
    !isRecord(value) ||
    !hasExactFields(value, DIRECTORY_IDENTITY_FIELDS) ||
    !isDecimalBigint(value.dev) ||
    !isDecimalBigint(value.ino) ||
    !isDecimalBigint(value.birthtimeNs)
  ) {
    throw new Error("Provisioning directory identity is invalid.");
  }

  return {
    dev: value.dev,
    ino: value.ino,
    birthtimeNs: value.birthtimeNs,
  };
}

function directoryIdentity(stats: NoFollowStats): DirectoryIdentity {
  if (
    typeof stats.dev !== "bigint" ||
    typeof stats.ino !== "bigint" ||
    typeof stats.birthtimeNs !== "bigint"
  ) {
    throw new Error("Filesystem directory identity is unavailable.");
  }

  return {
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    birthtimeNs: stats.birthtimeNs.toString(),
  };
}

function identityMatches(
  expected: DirectoryIdentity,
  actual: DirectoryIdentity,
): boolean {
  return (
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.birthtimeNs === actual.birthtimeNs
  );
}

function sameProvisioningGeneration(
  actual: ProvisioningState,
  expected: ProvisioningState,
): boolean {
  return (
    actual.version === expected.version &&
    actual.state === expected.state &&
    actual.workspaceKey === expected.workspaceKey &&
    actual.workspacePath === expected.workspacePath &&
    actual.generation === expected.generation
  );
}

function controlPaths(resolved: WorkspacePathInfo): {
  controlRoot: string;
  provisioningRoot: string;
  statePath: string;
} {
  const controlRoot = join(resolved.workspaceRoot, CONTROL_DIRECTORY);
  const provisioningRoot = join(controlRoot, PROVISIONING_DIRECTORY);
  return {
    controlRoot,
    provisioningRoot,
    statePath: join(provisioningRoot, `${resolved.workspaceKey}.json`),
  };
}

function recoveryPath(
  recoveryRoot: string,
  workspaceKey: string,
  generation: string,
): string {
  if (!UUID_V4_PATTERN.test(generation)) {
    throw new Error("Provisioning generation is invalid.");
  }
  return join(recoveryRoot, `${workspaceKey}-${generation}`);
}

function workspaceResult(
  resolved: WorkspacePathInfo,
  createdNow: boolean,
): Workspace {
  return {
    path: resolved.workspacePath,
    workspaceKey: resolved.workspaceKey,
    createdNow,
  };
}

function lifecycleKey(resolved: WorkspacePathInfo): string {
  return `${resolved.workspaceRoot}\0${resolved.workspaceKey}`;
}

async function withLifecycleCoordinator<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = lifecycleTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(async () => await gate);
  lifecycleTails.set(key, tail);

  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (lifecycleTails.get(key) === tail) {
      lifecycleTails.delete(key);
    }
  }
}

function isRealDirectory(stats: NoFollowStats): boolean {
  return stats.isDirectory() && !stats.isSymbolicLink();
}

function isRealFile(stats: NoFollowStats): boolean {
  return stats.isFile() && !stats.isSymbolicLink();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFields(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((field, index) => field === expected[index])
  );
}

function isDecimalBigint(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_BIGINT_PATTERN.test(value);
}

function isHookRunner(
  value: WorkspaceManagerOptions["hooks"],
): value is WorkspaceHookRunner {
  return (
    typeof value === "object" &&
    value !== null &&
    "run" in value &&
    typeof value.run === "function" &&
    "runBestEffort" in value &&
    typeof value.runBestEffort === "function"
  );
}

function isMissingPathError(
  error: unknown,
): error is NodeJS.ErrnoException & { code: "ENOENT" } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isAlreadyExistsError(
  error: unknown,
): error is NodeJS.ErrnoException & { code: "EEXIST" } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

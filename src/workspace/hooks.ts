import { type ChildProcess, spawn } from "node:child_process";
import { constants, accessSync } from "node:fs";
import { delimiter, join } from "node:path";

import {
  type CapabilityFailureMetadata,
  type ExternalCommandBoundary,
  ExternalCommandCapabilityError,
  classifyHookCommandPreflightResult,
  createHookCommandPreflight,
} from "../capabilities/external-command.js";
import type { WorkflowCommandCapabilities } from "../config/types.js";
import { ERROR_CODES } from "../errors/codes.js";

const DEFAULT_OUTPUT_LIMIT = 4_000;
const PROCESS_TERMINATION_GRACE_MS = 500;
const PROCESS_FORCE_KILL_GRACE_MS = 1_000;

export const WORKSPACE_HOOK_NAMES = [
  "afterCreate",
  "beforeRun",
  "afterRun",
  "beforeRemove",
] as const;

export type WorkspaceHookName = (typeof WORKSPACE_HOOK_NAMES)[number];

export interface HookCommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface WorkspaceHookLogEntry {
  level: "info" | "warn" | "error";
  event:
    | "workspace_hook_started"
    | "workspace_hook_completed"
    | "workspace_hook_failed"
    | "workspace_hook_timed_out";
  hook: WorkspaceHookName;
  workspacePath: string;
  durationMs?: number;
  exitCode?: number | null;
  errorCode?: string;
  stdout?: string;
  stderr?: string;
  capability?: string;
  command?: string;
  boundary?: ExternalCommandBoundary;
  remediation?: string;
}

export type WorkspaceHookLogger = (entry: WorkspaceHookLogEntry) => void;

export interface WorkspaceHookRunnerConfig {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
  timeoutMs: number;
}

export type HookCommandExecutor = (
  script: string,
  options: {
    cwd: string;
    timeoutMs: number;
    environment: NodeJS.ProcessEnv;
    shellExecutable?: string;
  },
) => Promise<HookCommandResult>;

export interface RunWorkspaceHookOptions {
  name: WorkspaceHookName;
  workspacePath: string;
}

export class HookCommandTimeoutError extends Error {
  readonly stdout: string;
  readonly stderr: string;

  constructor(input: { stdout: string; stderr: string }) {
    super("Workspace hook command timed out.");
    this.name = "HookCommandTimeoutError";
    this.stdout = input.stdout;
    this.stderr = input.stderr;
  }
}

export class WorkspaceHookError extends Error {
  readonly code: string;
  readonly hook: WorkspaceHookName;
  readonly workspacePath: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(input: {
    code: string;
    message: string;
    hook: WorkspaceHookName;
    workspacePath: string;
    exitCode?: number | null;
    stdout?: string;
    stderr?: string;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "WorkspaceHookError";
    this.code = input.code;
    this.hook = input.hook;
    this.workspacePath = input.workspacePath;
    this.exitCode = input.exitCode ?? null;
    this.stdout = input.stdout ?? "";
    this.stderr = input.stderr ?? "";
  }
}

export class WorkspaceHookRunner {
  readonly #config: WorkspaceHookRunnerConfig;
  readonly #commands: WorkflowCommandCapabilities;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #execute: HookCommandExecutor;
  readonly #log: WorkspaceHookLogger;
  readonly #outputLimit: number;
  readonly #nonce: (() => string) | undefined;

  constructor(input: {
    config: WorkspaceHookRunnerConfig;
    commands?: WorkflowCommandCapabilities;
    environment?: NodeJS.ProcessEnv;
    execute?: HookCommandExecutor;
    log?: WorkspaceHookLogger;
    outputLimit?: number;
    nonce?: () => string;
  }) {
    this.#config = input.config;
    this.#commands = input.commands ?? {};
    this.#environment = input.environment ?? process.env;
    this.#execute = input.execute ?? executeShellHook;
    this.#log = input.log ?? (() => {});
    this.#outputLimit = input.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
    this.#nonce = input.nonce;
  }

  async run(options: RunWorkspaceHookOptions): Promise<boolean> {
    const body = this.#config[options.name];
    const preflight = createHookCommandPreflight({
      hook: options.name,
      commands: this.#commands,
      ...(this.#nonce === undefined ? {} : { nonce: this.#nonce() }),
    });
    if (!body && preflight === null) {
      return false;
    }

    const script =
      preflight === null
        ? (body ?? "")
        : `${preflight.scriptPrefix}\n${body ?? ""}`;
    const startedAt = Date.now();
    this.#log({
      level: "info",
      event: "workspace_hook_started",
      hook: options.name,
      workspacePath: options.workspacePath,
    });

    try {
      const result = await this.#execute(script, {
        cwd: options.workspacePath,
        timeoutMs: this.#config.timeoutMs,
        environment: this.#environment,
        ...(preflight === null
          ? {}
          : { shellExecutable: resolveHookShellExecutable() }),
      });
      const durationMs = Date.now() - startedAt;
      const interpreted =
        preflight === null
          ? {
              error: null,
              successSeen: false,
              stdout: result.stdout,
              stderr: result.stderr,
            }
          : classifyHookCommandPreflightResult({
              preflight,
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
            });

      if (interpreted.error !== null) {
        this.#logCapabilityFailure(
          options,
          interpreted.error.capabilityFailure,
          durationMs,
          result.exitCode,
        );
        throw interpreted.error;
      }

      if (result.exitCode !== 0) {
        const error = new WorkspaceHookError({
          code: ERROR_CODES.hookFailed,
          message: `Workspace hook '${options.name}' failed with exit code ${result.exitCode ?? "unknown"}.`,
          hook: options.name,
          workspacePath: options.workspacePath,
          exitCode: result.exitCode,
          stdout: truncateOutput(interpreted.stdout, this.#outputLimit),
          stderr: truncateOutput(interpreted.stderr, this.#outputLimit),
        });
        this.#log({
          level: "error",
          event: "workspace_hook_failed",
          hook: options.name,
          workspacePath: options.workspacePath,
          durationMs,
          exitCode: error.exitCode,
          errorCode: error.code,
          stdout: error.stdout,
          stderr: error.stderr,
        });
        throw error;
      }

      this.#log({
        level: "info",
        event: "workspace_hook_completed",
        hook: options.name,
        workspacePath: options.workspacePath,
        durationMs,
        exitCode: result.exitCode,
        stdout: truncateOutput(interpreted.stdout, this.#outputLimit),
        stderr: truncateOutput(interpreted.stderr, this.#outputLimit),
      });
      return true;
    } catch (error) {
      if (
        error instanceof WorkspaceHookError ||
        error instanceof ExternalCommandCapabilityError
      ) {
        throw error;
      }

      const durationMs = Date.now() - startedAt;
      if (error instanceof HookCommandTimeoutError) {
        if (preflight !== null) {
          const interpreted = classifyHookCommandPreflightResult({
            preflight,
            exitCode: null,
            stdout: error.stdout,
            stderr: error.stderr,
            timedOut: true,
          });
          if (interpreted.error !== null) {
            this.#logCapabilityFailure(
              options,
              interpreted.error.capabilityFailure,
              durationMs,
              null,
            );
            throw interpreted.error;
          }
        }

        const hookError = new WorkspaceHookError({
          code: ERROR_CODES.hookTimedOut,
          message: `Workspace hook '${options.name}' timed out after ${this.#config.timeoutMs} ms.`,
          hook: options.name,
          workspacePath: options.workspacePath,
          cause: error,
        });
        this.#log({
          level: "error",
          event: "workspace_hook_timed_out",
          hook: options.name,
          workspacePath: options.workspacePath,
          durationMs,
          errorCode: hookError.code,
        });
        throw hookError;
      }

      const hookError = new WorkspaceHookError({
        code: ERROR_CODES.hookFailed,
        message: `Workspace hook '${options.name}' could not be launched.`,
        hook: options.name,
        workspacePath: options.workspacePath,
        cause: error,
      });
      this.#log({
        level: "error",
        event: "workspace_hook_failed",
        hook: options.name,
        workspacePath: options.workspacePath,
        durationMs,
        errorCode: hookError.code,
      });
      throw hookError;
    }
  }

  async runBestEffort(options: RunWorkspaceHookOptions): Promise<boolean> {
    try {
      return await this.run(options);
    } catch {
      return false;
    }
  }

  #logCapabilityFailure(
    options: RunWorkspaceHookOptions,
    failure: CapabilityFailureMetadata,
    durationMs: number,
    exitCode: number | null,
  ): void {
    this.#log({
      level: "error",
      event: "workspace_hook_failed",
      hook: options.name,
      workspacePath: options.workspacePath,
      durationMs,
      exitCode,
      errorCode: failure.code,
      capability: failure.capability,
      command: failure.command,
      boundary: failure.boundary,
      remediation: failure.remediation,
    });
  }
}

export async function executeShellHook(
  script: string,
  options: {
    cwd: string;
    timeoutMs: number;
    environment: NodeJS.ProcessEnv;
    shellExecutable?: string;
  },
): Promise<HookCommandResult> {
  return await new Promise<HookCommandResult>((resolve, reject) => {
    const child = spawn(options.shellExecutable ?? "sh", ["-lc", script], {
      cwd: options.cwd,
      env: options.environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let resolveChildClosed: (() => void) | null = null;
    const childClosed = new Promise<void>((resolve) => {
      resolveChildClosed = resolve;
    });

    const timeoutHandle = setTimeout(() => {
      if (settled) {
        return;
      }

      timedOut = true;
      void terminateHookProcess(child, childClosed).finally(() => {
        if (settled) {
          return;
        }

        settled = true;
        reject(new HookCommandTimeoutError({ stdout, stderr }));
      });
    }, options.timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (settled || timedOut) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      resolveChildClosed?.();
      resolveChildClosed = null;
      if (settled) {
        return;
      }

      if (timedOut) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

async function terminateHookProcess(
  child: ChildProcess,
  childClosed: Promise<void>,
): Promise<void> {
  if (process.platform === "win32") {
    const treeTerminated = await terminateWindowsProcessTree(child);
    if (!treeTerminated) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The direct child may already have exited.
      }
    }
    await waitForCompletion(childClosed, PROCESS_FORCE_KILL_GRACE_MS);
    return;
  }

  const pid = child.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // The process may already have exited.
      }
    }
  } else {
    try {
      child.kill("SIGTERM");
    } catch {
      // The process may already have exited.
    }
  }

  const childDidClose = await waitForCompletion(
    childClosed,
    PROCESS_TERMINATION_GRACE_MS,
  );
  if (childDidClose && (pid === undefined || !isUnixProcessGroupAlive(pid))) {
    return;
  }

  if (pid !== undefined) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may already have exited.
      }
    }
  } else {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may already have exited.
    }
  }

  await waitForCompletion(childClosed, PROCESS_FORCE_KILL_GRACE_MS);
}

function isUnixProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
}

function terminateWindowsProcessTree(child: ChildProcess): Promise<boolean> {
  const pid = child.pid;
  if (pid === undefined) {
    return Promise.resolve(false);
  }

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$rootProcessId = ${pid}`,
    "$allProcesses = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)",
    "function Stop-SymphonyProcessTree([uint32] $targetId) {",
    "  @($allProcesses | Where-Object { $_.ParentProcessId -eq $targetId }) | ForEach-Object { Stop-SymphonyProcessTree $_.ProcessId }",
    "  Stop-Process -Id $targetId -Force -ErrorAction SilentlyContinue",
    "}",
    "Stop-SymphonyProcessTree $rootProcessId",
  ].join("; ");

  return runTerminationHelper(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    PROCESS_FORCE_KILL_GRACE_MS,
  ).then(async (terminated) => {
    if (terminated) {
      return true;
    }

    return await runTerminationHelper(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      PROCESS_FORCE_KILL_GRACE_MS,
    );
  });
}

function runTerminationHelper(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (terminated: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      resolve(terminated);
    };
    let helper: ChildProcess;
    try {
      helper = spawn(command, args, {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }

    const timeoutHandle = setTimeout(() => {
      try {
        helper.kill("SIGKILL");
      } catch {
        // The helper may already have exited.
      }
      finish(false);
    }, timeoutMs);
    helper.once("error", () => {
      finish(false);
    });
    helper.once("close", (exitCode) => {
      finish(exitCode === 0);
    });
  });
}

function waitForCompletion(
  completion: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      resolve(completed);
    };
    const timeoutHandle = setTimeout(() => {
      finish(false);
    }, timeoutMs);
    void completion.then(() => {
      finish(true);
    });
  });
}

function resolveHookShellExecutable(): string {
  const pathValue = process.env.PATH ?? process.env.Path;
  if (pathValue === undefined) {
    return "sh";
  }

  const fileNames = process.platform === "win32" ? ["sh.exe", "sh"] : ["sh"];
  for (const pathEntry of pathValue.split(delimiter)) {
    const directory = pathEntry.replace(/^"(.*)"$/, "$1");
    if (directory.length === 0) {
      continue;
    }

    for (const fileName of fileNames) {
      const candidate = join(directory, fileName);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Continue searching the Symphony process PATH.
      }
    }
  }

  return "sh";
}

function truncateOutput(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit)}...[truncated]`;
}

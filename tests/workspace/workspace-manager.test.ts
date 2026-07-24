import { promises as fs } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ERROR_CODES } from "../../src/errors/codes.js";
import {
  WorkspaceHookRunner,
  WorkspaceManager,
  type WorkspacePathError,
} from "../../src/index.js";

const NONCE = "0123456789abcdef0123456789abcdef";
const STALE_GENERATION = "00000000-0000-4000-8000-000000000001";
const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

describe("WorkspaceManager", () => {
  it("creates a missing workspace directory with a deterministic path", async () => {
    const root = await createRoot();
    const manager = new WorkspaceManager({ root });

    const workspace = await manager.createForIssue("issue/123:needs review");

    expect(workspace.workspaceKey).toBe("issue_123_needs_review");
    expect(workspace.path).toBe(join(root, "issue_123_needs_review"));
    expect(workspace.createdNow).toBe(true);
  });

  it("reuses an existing workspace directory on later attempts", async () => {
    const root = await createRoot();
    const manager = new WorkspaceManager({ root });

    await manager.createForIssue("issue-123");
    const workspace = await manager.createForIssue("issue-123");

    expect(workspace.path).toBe(join(root, "issue-123"));
    expect(workspace.createdNow).toBe(false);
  });

  it("runs afterCreate for a fresh workspace and marks it ready", async () => {
    const root = await createRoot();
    const hookCalls: string[] = [];
    const hookEntries: string[][] = [];
    const hooks = new WorkspaceHookRunner({
      config: hookConfig({ afterCreate: "prepare" }),
      execute: async (_script, options) => {
        hookCalls.push(options.cwd);
        hookEntries.push(await fs.readdir(options.cwd));
        return hookResult();
      },
    });
    const manager = new WorkspaceManager({ root, hooks });

    const first = await manager.createForIssue("issue-123");
    await manager.createForIssue("issue-123");

    expect(hookCalls).toEqual([first.path]);
    expect(hookEntries).toEqual([[]]);
    await expect(
      readProvisioningState(root, "issue-123"),
    ).resolves.toMatchObject({
      version: 1,
      state: "ready",
      workspaceKey: "issue-123",
      workspacePath: first.path,
      directoryIdentity: {
        dev: expect.any(String),
        ino: expect.any(String),
        birthtimeNs: expect.any(String),
      },
    });
  });

  it("preserves a typed afterCreate command capability failure", async () => {
    const root = await createRoot();
    const hooks = createAfterCreateCapabilityRunner(
      vi.fn().mockResolvedValue(
        hookResult({
          exitCode: 127,
          stderr: failureMarker("required_command_not_found"),
        }),
      ),
    );
    const manager = new WorkspaceManager({ root, hooks });

    const failure = await manager
      .createForIssue("issue-123")
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: ERROR_CODES.requiredCommandNotFound,
      capability: "external_command",
      command: "rg",
      boundary: "hook:after_create",
      remediation: expect.any(String),
    });
    expect(failure).not.toMatchObject({
      code: ERROR_CODES.workspaceCreateFailed,
    });
  });

  it("removes a newly created empty workspace after afterCreate preflight failure", async () => {
    const root = await createRoot();
    const workspacePath = join(root, "issue-123");
    const hooks = createAfterCreateCapabilityRunner(
      vi.fn().mockResolvedValue(
        hookResult({
          exitCode: 126,
          stderr: failureMarker("required_command_execution_denied"),
        }),
      ),
    );
    const manager = new WorkspaceManager({ root, hooks });

    await expect(manager.createForIssue("issue-123")).rejects.toMatchObject({
      code: ERROR_CODES.requiredCommandExecutionDenied,
    });

    await expect(fs.access(workspacePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("recreates the workspace and reruns afterCreate on explicit retry", async () => {
    const root = await createRoot();
    const workspacePath = join(root, "issue-123");
    const execute = vi
      .fn()
      .mockResolvedValueOnce(
        hookResult({
          exitCode: 127,
          stderr: failureMarker("required_command_not_found"),
        }),
      )
      .mockResolvedValueOnce(
        hookResult({
          stdout: successMarker(),
        }),
      );
    const manager = new WorkspaceManager({
      root,
      hooks: createAfterCreateCapabilityRunner(execute),
    });

    await expect(manager.createForIssue("issue-123")).rejects.toMatchObject({
      code: ERROR_CODES.requiredCommandNotFound,
    });
    await expect(fs.access(workspacePath)).rejects.toMatchObject({
      code: "ENOENT",
    });

    await expect(manager.createForIssue("issue-123")).resolves.toMatchObject({
      path: workspacePath,
      workspaceKey: "issue-123",
      createdNow: true,
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("removes a newly created empty workspace after an ordinary afterCreate hook failure", async () => {
    const root = await createRoot();
    const workspacePath = join(root, "issue-123");
    const hooks = new WorkspaceHookRunner({
      config: hookConfig({ afterCreate: "prepare" }),
      execute: vi.fn().mockResolvedValue(
        hookResult({
          exitCode: 3,
          stderr: "ordinary hook failure",
        }),
      ),
    });
    const manager = new WorkspaceManager({ root, hooks });

    await expect(manager.createForIssue("issue-123")).rejects.toMatchObject({
      code: ERROR_CODES.workspaceCreateFailed,
    });
    await expect(fs.access(workspacePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not let recursive cleanup failure mask the original capability error", async () => {
    const root = await createRoot();
    const workspacePath = join(root, "issue-123");
    const cleanupFailure = Object.assign(
      new Error("recursive removal denied"),
      {
        code: "EACCES",
      },
    );
    const rm = vi.fn(
      async (
        path: string,
        options?: { force?: boolean; recursive?: boolean },
      ) => {
        if (
          path.startsWith(join(root, ".symphony+", "recovery")) &&
          options?.recursive === true
        ) {
          throw cleanupFailure;
        }
        await fs.rm(path, options);
      },
    );
    const manager = new WorkspaceManager({
      root,
      hooks: createAfterCreateCapabilityRunner(
        vi.fn().mockResolvedValue(
          hookResult({
            exitCode: 127,
            stderr: failureMarker("required_command_not_found"),
          }),
        ),
      ),
      fs: { rm },
    });

    const failure = await manager
      .createForIssue("issue-123")
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: ERROR_CODES.requiredCommandNotFound,
      capability: "external_command",
      command: "rg",
      boundary: "hook:after_create",
    });
    const recursiveCleanup = rm.mock.calls.find(
      ([path, options]) =>
        path.startsWith(join(root, ".symphony+", "recovery")) &&
        options?.recursive === true,
    );
    expect(recursiveCleanup).toBeDefined();
    await expect(fs.access(workspacePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.access(recursiveCleanup?.[0] ?? ""),
    ).resolves.toBeUndefined();
  });

  it("removes a newly created workspace that the failing hook populated", async () => {
    const root = await createRoot();
    const workspacePath = join(root, "issue-123");
    const hooks = new WorkspaceHookRunner({
      config: hookConfig({ afterCreate: "prepare" }),
      execute: vi.fn(async (_script, options) => {
        await writeFile(join(options.cwd, "partial-bootstrap.txt"), "partial");
        return hookResult({
          exitCode: 4,
          stderr: "bootstrap failed",
        });
      }),
    });
    const manager = new WorkspaceManager({ root, hooks });

    await expect(manager.createForIssue("issue-123")).rejects.toMatchObject({
      code: ERROR_CODES.workspaceCreateFailed,
    });
    await expect(fs.access(workspacePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.access(provisioningStatePath(root, "issue-123")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("recovers a leftover in-progress workspace and reruns afterCreate", async () => {
    const root = await createRoot();
    const workspacePath = join(root, "issue-123");
    const staleArtifactPath = join(workspacePath, "partial-bootstrap.txt");
    const freshArtifactPath = join(workspacePath, "fresh-bootstrap.txt");
    await fs.mkdir(workspacePath);
    await writeFile(staleArtifactPath, "partial");
    await writeProvisioningState(root, {
      state: "in_progress",
      workspaceKey: "issue-123",
      workspacePath,
      generation: STALE_GENERATION,
      directoryIdentity: await directoryIdentity(workspacePath),
    });
    const provisioningLogger = vi.fn();
    const execute = vi.fn(async (_script, options) => {
      await writeFile(join(options.cwd, "fresh-bootstrap.txt"), "fresh");
      return hookResult();
    });
    const manager = new WorkspaceManager({
      root,
      hooks: new WorkspaceHookRunner({
        config: hookConfig({ afterCreate: "prepare" }),
        execute,
      }),
      provisioningLogger,
    });

    await expect(manager.createForIssue("issue-123")).resolves.toMatchObject({
      path: workspacePath,
      workspaceKey: "issue-123",
      createdNow: true,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    await expect(fs.access(staleArtifactPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile(freshArtifactPath, "utf8")).resolves.toBe("fresh");
    expect(provisioningLogger).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        level: "warn",
        event: "workspace_provisioning_incomplete",
        outcome: "recovering",
        issueId: "issue-123",
        workspacePath,
        errorCode: ERROR_CODES.workspaceProvisioningIncomplete,
      }),
    );
    expect(provisioningLogger).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        level: "info",
        event: "workspace_provisioning_incomplete",
        outcome: "recovered",
        issueId: "issue-123",
        workspacePath,
        errorCode: ERROR_CODES.workspaceProvisioningIncomplete,
      }),
    );
    await expect(
      readProvisioningState(root, "issue-123"),
    ).resolves.toMatchObject({
      version: 1,
      state: "ready",
      workspaceKey: "issue-123",
      workspacePath,
      generation: expect.not.stringMatching(STALE_GENERATION),
    });
  });

  it("leaves a populated markerless legacy workspace untouched", async () => {
    const root = await createRoot();
    const workspacePath = join(root, "issue-123");
    const artifactPath = join(workspacePath, "existing.txt");
    await fs.mkdir(workspacePath);
    await writeFile(artifactPath, "keep");
    const execute = vi.fn().mockResolvedValue(
      hookResult({
        exitCode: 127,
        stderr: failureMarker("required_command_not_found"),
      }),
    );
    const manager = new WorkspaceManager({
      root,
      hooks: createAfterCreateCapabilityRunner(execute),
    });

    await expect(manager.createForIssue("issue-123")).resolves.toMatchObject({
      path: workspacePath,
      createdNow: false,
    });
    expect(execute).not.toHaveBeenCalled();
    await expect(fs.readFile(artifactPath, "utf8")).resolves.toBe("keep");
  });

  it("preserves an identity-mismatched in-progress workspace and reports the provisioning code", async () => {
    const root = await createRoot();
    const workspacePath = join(root, "issue-123");
    const artifactPath = join(workspacePath, "existing.txt");
    await fs.mkdir(workspacePath);
    await writeFile(artifactPath, "keep");
    const identity = await directoryIdentity(workspacePath);
    await writeProvisioningState(root, {
      state: "in_progress",
      workspaceKey: "issue-123",
      workspacePath,
      generation: STALE_GENERATION,
      directoryIdentity: {
        ...identity,
        ino: `${identity.ino}0`,
      },
    });
    const provisioningLogger = vi.fn();
    const execute = vi.fn().mockResolvedValue(hookResult());
    const manager = new WorkspaceManager({
      root,
      hooks: new WorkspaceHookRunner({
        config: hookConfig({ afterCreate: "prepare" }),
        execute,
      }),
      provisioningLogger,
    });

    await expect(manager.createForIssue("issue-123")).rejects.toMatchObject({
      code: ERROR_CODES.workspaceProvisioningIncomplete,
      message: expect.stringContaining(
        "remove the workspace only after verifying it is safe",
      ),
    });

    expect(execute).not.toHaveBeenCalled();
    await expect(fs.readFile(artifactPath, "utf8")).resolves.toBe("keep");
    expect(provisioningLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        event: "workspace_provisioning_incomplete",
        outcome: "failed",
        errorCode: ERROR_CODES.workspaceProvisioningIncomplete,
      }),
    );
  });

  it("preserves a workspace whose provisioning generation is malformed", async () => {
    const root = await createRoot();
    const workspacePath = join(root, "issue-123");
    const artifactPath = join(workspacePath, "existing.txt");
    await fs.mkdir(workspacePath);
    await writeFile(artifactPath, "keep");
    await writeProvisioningState(root, {
      state: "in_progress",
      workspaceKey: "issue-123",
      workspacePath,
      generation: "../../outside",
      directoryIdentity: await directoryIdentity(workspacePath),
    });
    const rename = vi.fn(
      async (source: string, destination: string) =>
        await fs.rename(source, destination),
    );
    const manager = new WorkspaceManager({
      root,
      fs: { rename },
    });

    await expect(manager.createForIssue("issue-123")).rejects.toMatchObject({
      code: ERROR_CODES.workspaceProvisioningIncomplete,
    });
    expect(rename).not.toHaveBeenCalled();
    await expect(fs.readFile(artifactPath, "utf8")).resolves.toBe("keep");
  });

  it("fails closed when an interrupted workspace quarantine target already exists", async () => {
    const root = await createRoot();
    const workspacePath = join(root, "issue-123");
    const workspaceArtifact = join(workspacePath, "workspace.txt");
    const quarantinePath = join(
      root,
      ".symphony+",
      "recovery",
      `issue-123-${STALE_GENERATION}`,
    );
    const quarantineArtifact = join(quarantinePath, "quarantine.txt");
    await fs.mkdir(workspacePath);
    await writeFile(workspaceArtifact, "workspace");
    await fs.mkdir(quarantinePath, { recursive: true });
    await writeFile(quarantineArtifact, "quarantine");
    await writeProvisioningState(root, {
      state: "in_progress",
      workspaceKey: "issue-123",
      workspacePath,
      generation: STALE_GENERATION,
      directoryIdentity: await directoryIdentity(workspacePath),
    });
    const execute = vi.fn().mockResolvedValue(hookResult());
    const manager = new WorkspaceManager({
      root,
      hooks: new WorkspaceHookRunner({
        config: hookConfig({ afterCreate: "prepare" }),
        execute,
      }),
    });

    await expect(manager.createForIssue("issue-123")).rejects.toMatchObject({
      code: ERROR_CODES.workspaceProvisioningIncomplete,
    });
    expect(execute).not.toHaveBeenCalled();
    await expect(fs.readFile(workspaceArtifact, "utf8")).resolves.toBe(
      "workspace",
    );
    await expect(fs.readFile(quarantineArtifact, "utf8")).resolves.toBe(
      "quarantine",
    );
  });

  it("surfaces a later recovery deletion failure and succeeds after the condition clears", async () => {
    const root = await createRoot();
    const workspacePath = join(root, "issue-123");
    const quarantinePath = join(
      root,
      ".symphony+",
      "recovery",
      `issue-123-${STALE_GENERATION}`,
    );
    await fs.mkdir(workspacePath);
    await writeFile(join(workspacePath, "partial.txt"), "partial");
    await writeProvisioningState(root, {
      state: "in_progress",
      workspaceKey: "issue-123",
      workspacePath,
      generation: STALE_GENERATION,
      directoryIdentity: await directoryIdentity(workspacePath),
    });
    const recoveryFailure = Object.assign(
      new Error("recursive removal denied"),
      {
        code: "EACCES",
      },
    );
    const rm = vi.fn(
      async (
        path: string,
        options?: { force?: boolean; recursive?: boolean },
      ) => {
        if (path === quarantinePath && options?.recursive === true) {
          throw recoveryFailure;
        }
        await fs.rm(path, options);
      },
    );
    const provisioningLogger = vi.fn();
    const firstManager = new WorkspaceManager({
      root,
      fs: { rm },
      provisioningLogger,
    });

    await expect(
      firstManager.createForIssue("issue-123"),
    ).rejects.toMatchObject({
      code: ERROR_CODES.workspaceProvisioningIncomplete,
    });
    await expect(fs.access(workspacePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.readFile(join(quarantinePath, "partial.txt"), "utf8"),
    ).resolves.toBe("partial");
    expect(provisioningLogger).toHaveBeenLastCalledWith(
      expect.objectContaining({
        level: "error",
        outcome: "failed",
        errorCode: ERROR_CODES.workspaceProvisioningIncomplete,
      }),
    );

    const execute = vi.fn().mockResolvedValue(hookResult());
    const retryManager = new WorkspaceManager({
      root,
      hooks: new WorkspaceHookRunner({
        config: hookConfig({ afterCreate: "prepare" }),
        execute,
      }),
    });

    await expect(
      retryManager.createForIssue("issue-123"),
    ).resolves.toMatchObject({
      path: workspacePath,
      createdNow: true,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(fs.access(quarantinePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves a populated identity-less provisioning reservation", async () => {
    const root = await createRoot();
    const workspacePath = join(root, "issue-123");
    const artifactPath = join(workspacePath, "existing.txt");
    await fs.mkdir(workspacePath);
    await writeFile(artifactPath, "keep");
    await writeProvisioningState(root, {
      state: "in_progress",
      workspaceKey: "issue-123",
      workspacePath,
      generation: STALE_GENERATION,
      directoryIdentity: null,
    });
    const manager = new WorkspaceManager({ root });

    await expect(manager.createForIssue("issue-123")).rejects.toMatchObject({
      code: ERROR_CODES.workspaceProvisioningIncomplete,
    });
    await expect(fs.readFile(artifactPath, "utf8")).resolves.toBe("keep");
  });

  it("serializes create calls across manager instances for the same workspace", async () => {
    const root = await createRoot();
    const hookStarted = deferred<void>();
    const releaseHook = deferred<void>();
    const execute = vi.fn(async () => {
      hookStarted.resolve();
      await releaseHook.promise;
      return hookResult();
    });
    const hooks = new WorkspaceHookRunner({
      config: hookConfig({ afterCreate: "prepare" }),
      execute,
    });
    const firstManager = new WorkspaceManager({ root, hooks });
    const secondManager = new WorkspaceManager({ root, hooks });

    const firstCreate = firstManager.createForIssue("issue-123");
    await hookStarted.promise;
    let secondSettled = false;
    const secondCreate = secondManager
      .createForIssue("issue-123")
      .finally(() => {
        secondSettled = true;
      });

    await Promise.resolve();
    expect(secondSettled).toBe(false);
    releaseHook.resolve();

    await expect(firstCreate).resolves.toMatchObject({ createdNow: true });
    await expect(secondCreate).resolves.toMatchObject({ createdNow: false });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("runs beforeRemove as a best-effort hook when deleting an existing workspace", async () => {
    const root = await createRoot();
    const hookCalls: string[] = [];
    const hooks = new WorkspaceHookRunner({
      config: hookConfig({ beforeRemove: "cleanup" }),
      execute: async (_script, options) => {
        hookCalls.push(options.cwd);
        return hookResult({
          exitCode: 1,
          stderr: "ignored",
        });
      },
    });
    const manager = new WorkspaceManager({ root, hooks });

    const workspace = await manager.createForIssue("issue-123");
    const removed = await manager.removeForIssue("issue-123");

    expect(removed).toBe(true);
    expect(hookCalls).toEqual([workspace.path]);
  });

  it("continues cleanup after a typed beforeRemove command capability failure", async () => {
    const root = await createRoot();
    const workspacePath = join(root, "issue-123");
    const hooks = new WorkspaceHookRunner({
      config: hookConfig(),
      commands: commandRequirement("rg", "beforeRemove"),
      nonce: () => NONCE,
      execute: vi.fn().mockResolvedValue(
        hookResult({
          exitCode: 127,
          stderr: failureMarker("required_command_not_found"),
        }),
      ),
    });
    const manager = new WorkspaceManager({ root, hooks });
    await manager.createForIssue("issue-123");

    await expect(manager.removeForIssue("issue-123")).resolves.toBe(true);
    await expect(fs.access(workspacePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails safely when the workspace path already exists as a file", async () => {
    const root = await createRoot();
    await writeFile(join(root, "issue-123"), "not a directory");
    const manager = new WorkspaceManager({ root });

    await expect(manager.createForIssue("issue-123")).rejects.toThrowError(
      expect.objectContaining<Partial<WorkspacePathError>>({
        code: ERROR_CODES.workspacePathInvalid,
      }),
    );
  });

  it("removes a workspace path during cleanup", async () => {
    const root = await createRoot();
    const manager = new WorkspaceManager({ root });

    const workspace = await manager.createForIssue("issue-123");
    const removed = await manager.removeForIssue("issue-123");

    expect(removed).toBe(true);
    await expect(
      fs.access(provisioningStatePath(root, "issue-123")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(manager.createForIssue("issue-123")).resolves.toEqual({
      path: workspace.path,
      workspaceKey: "issue-123",
      createdNow: true,
    });
  });
});

function createAfterCreateCapabilityRunner(
  execute: ConstructorParameters<typeof WorkspaceHookRunner>[0]["execute"],
): WorkspaceHookRunner {
  return new WorkspaceHookRunner({
    config: hookConfig(),
    commands: commandRequirement("rg", "afterCreate"),
    nonce: () => NONCE,
    ...(execute === undefined ? {} : { execute }),
  });
}

function hookConfig(
  overrides: Partial<{
    afterCreate: string | null;
    beforeRun: string | null;
    afterRun: string | null;
    beforeRemove: string | null;
    timeoutMs: number;
  }> = {},
) {
  return {
    afterCreate: null,
    beforeRun: null,
    afterRun: null,
    beforeRemove: null,
    timeoutMs: 100,
    ...overrides,
  };
}

function commandRequirement(
  command: string,
  hook: "afterCreate" | "beforeRun" | "afterRun" | "beforeRemove",
) {
  return {
    [command]: {
      hooks: [hook],
      agent: false,
      probeArgs: [],
    },
  };
}

function hookResult(
  overrides: Partial<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }> = {},
) {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    ...overrides,
  };
}

function successMarker(): string {
  return `__SYMPHONY_REQUIRED_COMMAND_V1__:${NONCE}:ok\n`;
}

function failureMarker(
  code: "required_command_not_found" | "required_command_execution_denied",
): string {
  return `__SYMPHONY_REQUIRED_COMMAND_V1__:${NONCE}:${code}:rg\n`;
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "symphony-task10-"));
  roots.push(root);
  return root;
}

function provisioningStatePath(root: string, workspaceKey: string): string {
  return join(root, ".symphony+", "provisioning", `${workspaceKey}.json`);
}

async function readProvisioningState(
  root: string,
  workspaceKey: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(
    await fs.readFile(provisioningStatePath(root, workspaceKey), "utf8"),
  ) as Record<string, unknown>;
}

async function writeProvisioningState(
  root: string,
  state: {
    state: "in_progress" | "ready";
    workspaceKey: string;
    workspacePath: string;
    generation: string;
    directoryIdentity: {
      dev: string;
      ino: string;
      birthtimeNs: string;
    } | null;
  },
): Promise<void> {
  await fs.mkdir(join(root, ".symphony+", "provisioning"), {
    recursive: true,
  });
  await fs.writeFile(
    provisioningStatePath(root, state.workspaceKey),
    JSON.stringify({
      version: 1,
      ...state,
    }),
    "utf8",
  );
}

async function directoryIdentity(path: string): Promise<{
  dev: string;
  ino: string;
  birthtimeNs: string;
}> {
  const stats = await fs.lstat(path, { bigint: true });
  return {
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    birthtimeNs: stats.birthtimeNs.toString(),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

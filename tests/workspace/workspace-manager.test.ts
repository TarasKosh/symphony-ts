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
const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    roots.splice(0).map(async (root) => {
      const manager = new WorkspaceManager({ root });
      await manager.removeForIssue("issue-123");
      await manager.removeForIssue("issue/123:needs review");
    }),
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

  it("runs afterCreate only for newly created workspaces", async () => {
    const root = await createRoot();
    const hookCalls: string[] = [];
    const hooks = new WorkspaceHookRunner({
      config: hookConfig({ afterCreate: "prepare" }),
      execute: async (_script, options) => {
        hookCalls.push(options.cwd);
        return hookResult();
      },
    });
    const manager = new WorkspaceManager({ root, hooks });

    const first = await manager.createForIssue("issue-123");
    await manager.createForIssue("issue-123");

    expect(hookCalls).toEqual([first.path]);
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

  it("does not let empty-directory cleanup failure mask the original capability error", async () => {
    const root = await createRoot();
    const workspacePath = join(root, "issue-123");
    const cleanupFailure = Object.assign(new Error("rmdir denied"), {
      code: "EACCES",
    });
    const rmdir = vi.fn().mockRejectedValue(cleanupFailure);
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
      fs: {
        lstat: (path) => fs.lstat(path),
        mkdir: (path, options) => fs.mkdir(path, options),
        rm: (path, options) => fs.rm(path, options),
        readdir: (path) => fs.readdir(path),
        rmdir,
      },
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
    expect(rmdir).toHaveBeenCalledWith(workspacePath);
    await expect(fs.access(workspacePath)).resolves.toBeUndefined();
  });

  it("never removes a newly created workspace that the failing hook populated", async () => {
    const root = await createRoot();
    const workspacePath = join(root, "issue-123");
    const artifactPath = join(workspacePath, "partial-bootstrap.txt");
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
    await expect(fs.readFile(artifactPath, "utf8")).resolves.toBe("partial");
  });

  it("never deletes or reruns afterCreate for a pre-existing populated workspace", async () => {
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

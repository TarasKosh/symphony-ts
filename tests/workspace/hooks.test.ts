import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  ERROR_CODES,
  HookCommandTimeoutError,
  type WorkspaceHookError,
  type WorkspaceHookLogEntry,
  WorkspaceHookRunner,
} from "../../src/index.js";

const NONCE = "0123456789abcdef0123456789abcdef";
const MISSING_COMMAND = "symphony_missing_command_9f7f4d16";

describe("WorkspaceHookRunner", () => {
  it("returns false when neither a hook body nor a command preflight is configured", async () => {
    const execute = vi.fn();
    const runner = createRunner({
      execute,
      config: hookConfig(),
    });

    await expect(
      runner.run({
        name: "beforeRun",
        workspacePath: "/tmp/workspace",
      }),
    ).resolves.toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("runs declared-command preflight before the hook body in one invocation", async () => {
    const body = "printf 'workflow-body'";
    const execute = vi.fn().mockResolvedValue(
      hookResult({
        stdout: successMarker(),
      }),
    );
    const runner = createRunner({
      config: hookConfig({ beforeRun: body }),
      commands: commandRequirement("rg", "beforeRun"),
      execute,
    });

    await expect(
      runner.run({
        name: "beforeRun",
        workspacePath: "/tmp/workspace",
      }),
    ).resolves.toBe(true);

    expect(execute).toHaveBeenCalledTimes(1);
    const script = execute.mock.calls[0]?.[0] as string;
    expect(script).not.toBe(body);
    expect(script.indexOf("rg")).toBeGreaterThanOrEqual(0);
    expect(script.indexOf("rg")).toBeLessThan(script.indexOf(body));
  });

  it("runs a preflight-only hook when the workflow hook body is omitted", async () => {
    const execute = vi.fn().mockResolvedValue(
      hookResult({
        stdout: successMarker(),
      }),
    );
    const runner = createRunner({
      config: hookConfig(),
      commands: commandRequirement("rg", "afterCreate"),
      execute,
    });

    await expect(
      runner.run({
        name: "afterCreate",
        workspacePath: "/tmp/workspace",
      }),
    ).resolves.toBe(true);

    expect(execute).toHaveBeenCalledTimes(1);
    const script = execute.mock.calls[0]?.[0] as string;
    expect(script).toContain("rg");
    expect(script).not.toMatch(/(?:^|\n)null(?:\n|$)/);
    expect(script).not.toMatch(/(?:^|\n)undefined(?:\n|$)/);
  });

  it("passes the explicit hook environment to the executor", async () => {
    const environment = {
      PATH: "/opt/workflow/bin",
      SYMPHONY_TEST_TOKEN: "never-log-this",
    };
    const execute = vi.fn().mockResolvedValue(hookResult());
    const runner = createRunner({
      config: hookConfig({ beforeRun: "true" }),
      environment,
      execute,
    });

    await runner.run({
      name: "beforeRun",
      workspacePath: "/tmp/workspace",
    });

    expect(execute).toHaveBeenCalledWith("true", {
      cwd: "/tmp/workspace",
      timeoutMs: 100,
      environment,
    });
  });

  it("preserves an undeclared workflow script byte-for-byte", async () => {
    const script = "  printf 'first' \n\nprintf '%s' \"$PATH\"  \n";
    const execute = vi.fn().mockResolvedValue(hookResult());
    const runner = createRunner({
      config: hookConfig({ beforeRun: script }),
      commands: commandRequirement("rg", "afterCreate"),
      execute,
    });

    await runner.run({
      name: "beforeRun",
      workspacePath: "/tmp/workspace",
    });

    expect(execute.mock.calls[0]?.[0]).toBe(script);
  });

  it("fails before the workflow body when a declared command is missing", async () => {
    const workspacePath = await mkdtemp(
      join(tmpdir(), "symphony-hook-preflight-"),
    );
    const bodyArtifact = join(workspacePath, "body-ran");
    const runner = createRunner({
      config: hookConfig({
        beforeRun: "printf 'ran' > body-ran",
        timeoutMs: 5_000,
      }),
      commands: commandRequirement(MISSING_COMMAND, "beforeRun"),
    });

    try {
      await expect(
        runner.run({
          name: "beforeRun",
          workspacePath,
        }),
      ).rejects.toMatchObject({
        code: ERROR_CODES.requiredCommandNotFound,
        capability: "external_command",
        command: MISSING_COMMAND,
        boundary: "hook:before_run",
        remediation: expect.any(String),
      });
      await expect(access(bodyArtifact)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("uses the real sh -lc boundary to stop before the body when a resolved command is not executable", async () => {
    const workspacePath = await mkdtemp(
      join(tmpdir(), "symphony-hook-preflight-denied-"),
    );
    const command = "symphony_hook_nonexecutable";
    const bodyArtifact = join(workspacePath, "body-ran");

    try {
      await writeFile(join(workspacePath, command), "not executable\n");
      await chmod(join(workspacePath, command), 0o644);

      const runner = createRunner({
        config: hookConfig({
          beforeRun: "printf 'ran' > body-ran",
          timeoutMs: 5_000,
        }),
        commands: commandRequirement(command, "beforeRun"),
        environment: {
          ...process.env,
          PATH: workspacePath,
        },
      });

      await expect(
        runner.run({
          name: "beforeRun",
          workspacePath,
        }),
      ).rejects.toMatchObject({
        code: ERROR_CODES.requiredCommandExecutionDenied,
        capability: "external_command",
        command,
        boundary: "hook:before_run",
      });
      await expect(access(bodyArtifact)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("uses the real sh -lc boundary with a literal hostile PATH entry and strips its owned preflight marker", async () => {
    const workspacePath = await mkdtemp(
      join(tmpdir(), "symphony-hook-preflight-path-"),
    );
    const command = "symphony_hook_path_tool";
    const hostilePathEntry = join(
      workspacePath,
      "literal path [glob] with spaces $dollar",
    );
    const logs: WorkspaceHookLogEntry[] = [];

    try {
      await mkdir(hostilePathEntry);
      const commandPath = join(hostilePathEntry, command);
      await writeFile(commandPath, "#!/bin/sh\nexit 99\n");
      await chmod(commandPath, 0o755);

      const runner = createRunner({
        config: hookConfig({
          beforeRun: "printf 'workflow body output'",
          timeoutMs: 5_000,
        }),
        commands: commandRequirement(command, "beforeRun"),
        environment: {
          ...process.env,
          PATH: hostilePathEntry,
        },
        log: (entry) => {
          logs.push(entry);
        },
      });

      await expect(
        runner.run({
          name: "beforeRun",
          workspacePath,
        }),
      ).resolves.toBe(true);

      expect(logs.at(-1)).toMatchObject({
        event: "workspace_hook_completed",
        stdout: "workflow body output",
      });
      expect(JSON.stringify(logs)).not.toContain(
        "__SYMPHONY_REQUIRED_COMMAND_V1__",
      );
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("treats real marker-like body output after default preflight as an ordinary hook failure", async () => {
    const workspacePath = await mkdtemp(
      join(tmpdir(), "symphony-hook-preflight-marker-"),
    );
    const command = "symphony_hook_marker_tool";

    try {
      const commandPath = join(workspacePath, command);
      await writeFile(commandPath, "#!/bin/sh\nexit 99\n");
      await chmod(commandPath, 0o755);
      const markerLikeBodyOutput = failureMarker(
        "required_command_not_found",
        command,
      ).trim();
      const runner = createRunner({
        config: hookConfig({
          beforeRun: `printf '%s\\n' '${markerLikeBodyOutput}'; exit 127`,
          timeoutMs: 5_000,
        }),
        commands: commandRequirement(command, "beforeRun"),
        environment: {
          ...process.env,
          PATH: workspacePath,
        },
      });

      await expect(
        runner.run({
          name: "beforeRun",
          workspacePath,
        }),
      ).rejects.toMatchObject({
        code: ERROR_CODES.hookFailed,
        exitCode: 127,
        stdout: "",
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it.each([
    {
      label: "not found",
      code: "required_command_not_found",
      exitCode: 127,
    },
    {
      label: "execution denied",
      code: "required_command_execution_denied",
      exitCode: 126,
    },
  ] as const)(
    "classifies a valid $label marker as a deterministic capability failure",
    async ({ code, exitCode }) => {
      const runner = createRunner({
        config: hookConfig({ beforeRun: "workflow-body" }),
        commands: commandRequirement("rg", "beforeRun"),
        execute: vi.fn().mockResolvedValue(
          hookResult({
            exitCode,
            stderr: failureMarker(code, "rg"),
          }),
        ),
      });

      await expect(
        runner.run({
          name: "beforeRun",
          workspacePath: "/tmp/workspace",
        }),
      ).rejects.toMatchObject({
        code,
        capability: "external_command",
        command: "rg",
        boundary: "hook:before_run",
        remediation: expect.any(String),
      });
    },
  );

  it.each([
    {
      label: "uses a stale nonce",
      exitCode: 127,
      stderr: failureMarker(
        "required_command_not_found",
        "rg",
        "fedcba9876543210fedcba9876543210",
      ),
    },
    {
      label: "names an undeclared command",
      exitCode: 127,
      stderr: failureMarker("required_command_not_found", "git"),
    },
    {
      label: "has an exit code that does not match the marker",
      exitCode: 126,
      stderr: failureMarker("required_command_not_found", "rg"),
    },
    {
      label: "contains arbitrary command-not-found stderr",
      exitCode: 127,
      stderr: "sh: rg: command not found\nPATH=/secret/bin\n",
    },
  ])(
    "does not trust hook-authored marker-like output when it $label",
    async ({ exitCode, stderr }) => {
      const runner = createRunner({
        config: hookConfig({ beforeRun: "workflow-body" }),
        commands: commandRequirement("rg", "beforeRun"),
        execute: vi.fn().mockResolvedValue(
          hookResult({
            exitCode,
            stderr,
          }),
        ),
      });

      await expect(
        runner.run({
          name: "beforeRun",
          workspacePath: "/tmp/workspace",
        }),
      ).rejects.toMatchObject({
        code: ERROR_CODES.requiredCommandCapabilityTransient,
        capability: "external_command",
        command: "rg",
        boundary: "hook:before_run",
      });
    },
  );

  it("classifies a valid failure marker before the owned success marker", async () => {
    const runner = createRunner({
      config: hookConfig({ beforeRun: "workflow-body" }),
      commands: commandRequirement("rg", "beforeRun"),
      execute: vi.fn().mockResolvedValue(
        hookResult({
          exitCode: 127,
          stdout: `${failureMarker(
            "required_command_not_found",
            "rg",
          )}${successMarker()}`,
        }),
      ),
    });

    await expect(
      runner.run({
        name: "beforeRun",
        workspacePath: "/tmp/workspace",
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.requiredCommandNotFound,
    });
  });

  it("treats marker-like output after the owned success marker as an ordinary hook failure", async () => {
    const runner = createRunner({
      config: hookConfig({ beforeRun: "workflow-body" }),
      commands: commandRequirement("rg", "beforeRun"),
      execute: vi.fn().mockResolvedValue(
        hookResult({
          exitCode: 127,
          stdout: `${successMarker()}${failureMarker(
            "required_command_not_found",
            "rg",
          )}`,
        }),
      ),
    });

    await expect(
      runner.run({
        name: "beforeRun",
        workspacePath: "/tmp/workspace",
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.hookFailed,
    });
  });

  it("classifies an unmarked preflight result as transient", async () => {
    const runner = createRunner({
      config: hookConfig({ beforeRun: "workflow-body" }),
      commands: commandRequirement("rg", "beforeRun"),
      execute: vi.fn().mockResolvedValue(
        hookResult({
          exitCode: 1,
          stderr: "opaque shell failure with TOKEN=do-not-surface",
        }),
      ),
    });

    const failure = await runner
      .run({
        name: "beforeRun",
        workspacePath: "/tmp/workspace",
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: ERROR_CODES.requiredCommandCapabilityTransient,
      capability: "external_command",
      command: "rg",
      boundary: "hook:before_run",
    });
    expect(JSON.stringify(failure)).not.toContain("do-not-surface");
  });

  it("does not accept an embedded success marker as preflight completion", async () => {
    const runner = createRunner({
      config: hookConfig({ beforeRun: "workflow-body" }),
      commands: commandRequirement("rg", "beforeRun"),
      execute: vi.fn().mockResolvedValue(
        hookResult({
          stdout: `shell diagnostic includes ${successMarker().trim()} in source\n`,
        }),
      ),
    });

    await expect(
      runner.run({
        name: "beforeRun",
        workspacePath: "/tmp/workspace",
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.requiredCommandCapabilityTransient,
      boundary: "hook:before_run",
    });
  });

  it("fails fatal hooks on non-zero body exit codes and truncates logged output", async () => {
    const logs: WorkspaceHookLogEntry[] = [];
    const runner = createRunner({
      config: hookConfig({
        afterCreate: "echo prepare",
        beforeRun: "echo run",
        timeoutMs: 500,
      }),
      outputLimit: 12,
      log: (entry) => {
        logs.push(entry);
      },
      execute: vi.fn().mockResolvedValue({
        exitCode: 12,
        signal: null,
        stdout: "1234567890abcdef",
        stderr: "failure-details",
      }),
    });

    await expect(
      runner.run({
        name: "beforeRun",
        workspacePath: "/tmp/workspace",
      }),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<WorkspaceHookError>>({
        code: ERROR_CODES.hookFailed,
        exitCode: 12,
        stdout: "1234567890ab...[truncated]",
        stderr: "failure-deta...[truncated]",
      }),
    );

    expect(logs).toEqual([
      {
        level: "info",
        event: "workspace_hook_started",
        hook: "beforeRun",
        workspacePath: "/tmp/workspace",
      },
      expect.objectContaining({
        level: "error",
        event: "workspace_hook_failed",
        hook: "beforeRun",
        workspacePath: "/tmp/workspace",
        exitCode: 12,
        errorCode: ERROR_CODES.hookFailed,
        stdout: "1234567890ab...[truncated]",
        stderr: "failure-deta...[truncated]",
      }),
    ]);
  });

  it("reports a shell launch rejection as hook_failed rather than hook_timed_out", async () => {
    const logs: WorkspaceHookLogEntry[] = [];
    const runner = createRunner({
      config: hookConfig({ beforeRun: "true", timeoutMs: 25 }),
      commands: commandRequirement("rg", "beforeRun"),
      log: (entry) => {
        logs.push(entry);
      },
      execute: vi
        .fn()
        .mockRejectedValue(
          new Error("spawn sh ENOENT PATH=/private/bin TOKEN=secret"),
        ),
    });

    const failure = await runner
      .run({
        name: "beforeRun",
        workspacePath: "/tmp/workspace",
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: ERROR_CODES.hookFailed,
    });
    expect(logs.at(-1)).toMatchObject({
      level: "error",
      event: "workspace_hook_failed",
      errorCode: ERROR_CODES.hookFailed,
    });
    expect(
      logs.some((entry) => entry.event === "workspace_hook_timed_out"),
    ).toBe(false);
  });

  it("reports a typed executor deadline expiry as hook_timed_out", async () => {
    const runner = createRunner({
      config: hookConfig({
        beforeRun: "long-running-hook",
        timeoutMs: 25,
      }),
      execute: vi.fn().mockRejectedValue(
        new HookCommandTimeoutError({
          stdout: "partial stdout",
          stderr: "partial stderr",
        }),
      ),
    });

    await expect(
      runner.run({
        name: "beforeRun",
        workspacePath: "/tmp/workspace",
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.hookTimedOut,
    });
  });

  it("classifies a declared-command timeout before the success marker as transient", async () => {
    const runner = createRunner({
      config: hookConfig({ beforeRun: "long-running-hook", timeoutMs: 25 }),
      commands: commandRequirement("rg", "beforeRun"),
      execute: vi.fn().mockRejectedValue(
        new HookCommandTimeoutError({
          stdout: "",
          stderr: "opaque preflight timeout PATH=/private TOKEN=secret",
        }),
      ),
    });

    const failure = await runner
      .run({
        name: "beforeRun",
        workspacePath: "/tmp/workspace",
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: ERROR_CODES.requiredCommandCapabilityTransient,
      command: "rg",
      boundary: "hook:before_run",
    });
    expect(JSON.stringify(failure)).not.toContain("/private");
    expect(JSON.stringify(failure)).not.toContain("secret");
  });

  it("keeps a declared-command timeout after the success marker as hook_timed_out", async () => {
    const runner = createRunner({
      config: hookConfig({ beforeRun: "long-running-hook", timeoutMs: 25 }),
      commands: commandRequirement("rg", "beforeRun"),
      execute: vi.fn().mockRejectedValue(
        new HookCommandTimeoutError({
          stdout: successMarker(),
          stderr: "body still running",
        }),
      ),
    });

    await expect(
      runner.run({
        name: "beforeRun",
        workspacePath: "/tmp/workspace",
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.hookTimedOut,
    });
  });

  it("drains and terminates the real hook boundary before classifying a body timeout", async () => {
    const workspacePath = await mkdtemp(
      join(tmpdir(), "symphony-hook-timeout-"),
    );
    const runner = createRunner({
      config: hookConfig({
        beforeRun:
          "printf '%s\\n' 'body-started'; node -e \"setTimeout(() => {}, 10000)\"",
        timeoutMs: 250,
      }),
      commands: commandRequirement("node", "beforeRun"),
    });
    const startedAt = Date.now();

    try {
      await expect(
        runner.run({
          name: "beforeRun",
          workspacePath,
        }),
      ).rejects.toMatchObject({
        code: ERROR_CODES.hookTimedOut,
      });
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  }, 5_000);

  it.each(["afterRun", "beforeRemove"] as const)(
    "logs a sanitized typed capability failure but suppresses it for best-effort %s",
    async (hook) => {
      const logs: WorkspaceHookLogEntry[] = [];
      const runner = createRunner({
        config: hookConfig({ [hook]: "workflow-cleanup" }),
        commands: commandRequirement("rg", hook),
        log: (entry) => {
          logs.push(entry);
        },
        execute: vi.fn().mockResolvedValue(
          hookResult({
            exitCode: 127,
            stderr: `${failureMarker(
              "required_command_not_found",
              "rg",
            )}PATH=/private/bin\nTOKEN=secret\n`,
          }),
        ),
      });

      await expect(
        runner.runBestEffort({
          name: hook,
          workspacePath: "/tmp/workspace",
        }),
      ).resolves.toBe(false);

      expect(logs.at(-1)).toMatchObject({
        level: "error",
        event: "workspace_hook_failed",
        errorCode: ERROR_CODES.requiredCommandNotFound,
        capability: "external_command",
        command: "rg",
        boundary: `hook:${toSnakeCase(hook)}`,
        remediation: expect.any(String),
      });
      expect(JSON.stringify(logs)).not.toContain("/private/bin");
      expect(JSON.stringify(logs)).not.toContain("secret");
    },
  );
});

function createRunner(
  input: ConstructorParameters<typeof WorkspaceHookRunner>[0] & {
    nonce?: () => string;
  },
): WorkspaceHookRunner {
  return new WorkspaceHookRunner({
    nonce: () => NONCE,
    ...input,
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

function successMarker(nonce = NONCE): string {
  return `__SYMPHONY_REQUIRED_COMMAND_V1__:${nonce}:ok\n`;
}

function failureMarker(
  code: "required_command_not_found" | "required_command_execution_denied",
  command: string,
  nonce = NONCE,
): string {
  return `__SYMPHONY_REQUIRED_COMMAND_V1__:${nonce}:${code}:${command}\n`;
}

function toSnakeCase(
  hook: "afterCreate" | "beforeRun" | "afterRun" | "beforeRemove",
): string {
  return hook.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

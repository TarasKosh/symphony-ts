import { describe, expect, it, vi } from "vitest";

import {
  CodexExternalCommandProbe,
  EXTERNAL_COMMAND_OUTPUT_BYTES_CAP,
  type ExternalCommandCapabilityError,
  createHookCommandPreflight,
  isCapabilityErrorCode,
  isDeterministicCapabilityErrorCode,
  isSafeExecutableBasename,
  resolveExternalCommandProbeTimeoutMs,
} from "../../src/capabilities/external-command.js";
import type { CodexCommandExecResult } from "../../src/codex/app-server-client.js";
import { ERROR_CODES } from "../../src/errors/codes.js";

const WORKSPACE = "C:\\workspaces\\ABC-123";
const SANDBOX_POLICY = {
  type: "workspaceWrite",
  writableRoots: [WORKSPACE, `${WORKSPACE}\\.git`],
};

describe("external command capability", () => {
  it("creates a hook-boundary descriptor only for commands declared in that hook", () => {
    const descriptor = createHookCommandPreflight({
      hook: "beforeRun",
      commands: {
        node: {
          hooks: ["afterCreate"],
          agent: false,
          probeArgs: [],
        },
        rg: {
          hooks: ["afterCreate", "beforeRun"],
          agent: true,
          probeArgs: ["--version"],
        },
      },
      nonce: "00112233445566778899aabbccddeeff",
    });

    expect(descriptor).toMatchObject({
      nonce: "00112233445566778899aabbccddeeff",
      commandNames: ["rg"],
    });
    expect(descriptor?.successMarker).toContain(
      "__SYMPHONY_REQUIRED_COMMAND_V1__:00112233445566778899aabbccddeeff:ok",
    );
    expect(descriptor?.scriptPrefix).toContain("rg");
    expect(descriptor?.scriptPrefix).toContain(
      "__SYMPHONY_REQUIRED_COMMAND_V1__",
    );
    expect(descriptor?.scriptPrefix).not.toContain("--version");
  });

  it("returns no hook descriptor when that boundary has no declarations", () => {
    expect(
      createHookCommandPreflight({
        hook: "beforeRun",
        commands: {
          rg: {
            hooks: ["afterCreate"],
            agent: true,
            probeArgs: ["--version"],
          },
        },
        nonce: "00112233445566778899aabbccddeeff",
      }),
    ).toBeNull();
  });

  it("uses a fresh marker nonce with at least 128 bits when none is injected", () => {
    const input = {
      hook: "beforeRun" as const,
      commands: {
        rg: {
          hooks: ["beforeRun" as const],
          agent: false,
          probeArgs: [],
        },
      },
    };

    const first = createHookCommandPreflight(input);
    const second = createHookCommandPreflight(input);

    expect(first?.nonce).toMatch(/^[0-9a-f]{32,}$/);
    expect(second?.nonce).toMatch(/^[0-9a-f]{32,}$/);
    expect(first?.nonce).not.toBe(second?.nonce);
  });

  it("executes an agent-boundary probe with direct argv, cwd, and sandbox", async () => {
    const execCommand = vi.fn().mockResolvedValue(result());

    await new CodexExternalCommandProbe({ platform: "linux" }).probe({
      command: "rg",
      probeArgs: ["--version"],
      workspacePath: WORKSPACE,
      sandboxPolicy: SANDBOX_POLICY,
      executor: { execCommand },
    });

    expect(execCommand).toHaveBeenCalledWith({
      command: ["rg", "--version"],
      cwd: WORKSPACE,
      timeoutMs: 15_000,
      outputBytesCap: EXTERNAL_COMMAND_OUTPUT_BYTES_CAP,
      sandboxPolicy: SANDBOX_POLICY,
    });
  });

  it.each([
    {
      label: "missing executable",
      response: result(
        "",
        "C:\\private\\bin\\rg.exe: command not found token=secret-value",
        127,
      ),
      code: ERROR_CODES.requiredCommandNotFound,
      deterministic: true,
    },
    {
      label: "execution denied",
      response: result(
        "",
        "C:\\private\\bin\\rg.exe: permission denied token=secret-value",
        126,
      ),
      code: ERROR_CODES.requiredCommandExecutionDenied,
      deterministic: true,
    },
    {
      label: "unclassified non-zero exit",
      response: result(
        "PATH=C:\\private\\bin;C:\\Windows\\System32",
        "probe failed token=secret-value",
        1,
      ),
      code: ERROR_CODES.requiredCommandCapabilityTransient,
      deterministic: false,
    },
  ])("classifies and sanitizes $label", async (input) => {
    const error = await captureError(
      new CodexExternalCommandProbe({ platform: "win32" }).probe({
        command: "rg",
        probeArgs: ["--token=probe-secret"],
        workspacePath: WORKSPACE,
        sandboxPolicy: SANDBOX_POLICY,
        executor: {
          execCommand: vi.fn().mockResolvedValue(input.response),
        },
      }),
    );

    expect(error).toMatchObject({
      name: "ExternalCommandCapabilityError",
      code: input.code,
      capability: "external_command",
      command: "rg",
      boundary: "agent",
      deterministic: input.deterministic,
    } satisfies Partial<ExternalCommandCapabilityError>);
    expect(error.remediation).toEqual(expect.any(String));

    const publicDiagnostic = `${error.message}\n${JSON.stringify(error)}`;
    expect(publicDiagnostic).not.toContain("C:\\private");
    expect(publicDiagnostic).not.toContain("PATH=");
    expect(publicDiagnostic).not.toContain("secret-value");
    expect(publicDiagnostic).not.toContain("probe-secret");
    expect(publicDiagnostic).not.toContain("probe failed");
    expect(error).not.toHaveProperty("cause");
    expect(error).not.toHaveProperty("stdout");
    expect(error).not.toHaveProperty("stderr");
    expect(error).not.toHaveProperty("path");
    expect(error).not.toHaveProperty("probeArgs");
  });

  it.each([
    {
      diagnostic:
        "'rg' is not recognized as an internal or external command token=secret",
      code: ERROR_CODES.requiredCommandNotFound,
    },
    {
      diagnostic:
        "CreateProcess failed with error 5: Access is denied token=secret",
      code: ERROR_CODES.requiredCommandExecutionDenied,
    },
  ])(
    "recognizes bounded app-server/OS signals without surfacing them",
    async (input) => {
      const error = await captureError(
        new CodexExternalCommandProbe({ platform: "win32" }).probe({
          command: "rg",
          probeArgs: ["--version"],
          workspacePath: WORKSPACE,
          sandboxPolicy: SANDBOX_POLICY,
          executor: {
            execCommand: vi
              .fn()
              .mockResolvedValue(result("", input.diagnostic, 1)),
          },
        }),
      );

      expect(error.code).toBe(input.code);
      expect(`${error.message}\n${JSON.stringify(error)}`).not.toContain(
        "token=secret",
      );
    },
  );

  it.each([
    {
      label: "OS not-found rejection",
      rejection: Object.assign(new Error("spawn rg token=secret"), {
        code: "ENOENT",
      }),
      code: ERROR_CODES.requiredCommandNotFound,
      deterministic: true,
    },
    {
      label: "OS execution-denied rejection",
      rejection: Object.assign(new Error("spawn rg token=secret"), {
        code: "EACCES",
      }),
      code: ERROR_CODES.requiredCommandExecutionDenied,
      deterministic: true,
    },
    {
      label: "timeout or protocol rejection",
      rejection: new Error(
        "command/exec timed out PATH=C:\\private token=secret",
      ),
      code: ERROR_CODES.requiredCommandCapabilityTransient,
      deterministic: false,
    },
  ])("classifies and sanitizes $label", async (input) => {
    const error = await captureError(
      new CodexExternalCommandProbe().probe({
        command: "rg",
        probeArgs: ["--version"],
        workspacePath: WORKSPACE,
        sandboxPolicy: SANDBOX_POLICY,
        executor: {
          execCommand: vi.fn().mockRejectedValue(input.rejection),
        },
      }),
    );

    expect(error).toMatchObject({
      code: input.code,
      deterministic: input.deterministic,
    });
    const publicDiagnostic = `${error.message}\n${JSON.stringify(error)}`;
    expect(publicDiagnostic).not.toContain("C:\\private");
    expect(publicDiagnostic).not.toContain("PATH=");
    expect(publicDiagnostic).not.toContain("token=secret");
  });

  it("uses the Windows executable suffix and bounded Windows timeout", async () => {
    const execCommand = vi.fn().mockResolvedValue(result());

    await new CodexExternalCommandProbe({ platform: "win32" }).probe({
      command: "rg",
      probeArgs: ["--version"],
      workspacePath: WORKSPACE,
      sandboxPolicy: SANDBOX_POLICY,
      executor: { execCommand },
    });

    expect(execCommand).toHaveBeenCalledWith({
      command: ["rg.exe", "--version"],
      cwd: WORKSPACE,
      timeoutMs: 60_000,
      sandboxPolicy: SANDBOX_POLICY,
    });
    expect(execCommand.mock.calls[0]?.[0]).not.toHaveProperty("outputBytesCap");
    expect(resolveExternalCommandProbeTimeoutMs("win32")).toBe(60_000);
    expect(resolveExternalCommandProbeTimeoutMs("linux")).toBe(15_000);
    expect(resolveExternalCommandProbeTimeoutMs("darwin")).toBe(15_000);
  });

  it("allows a Windows probe longer than the non-Windows timeout budget", async () => {
    const simulatedDurationMs = 20_000;
    const execCommand = vi.fn(
      async (input: { timeoutMs: number }): Promise<CodexCommandExecResult> => {
        if (input.timeoutMs <= simulatedDurationMs) {
          throw new Error("simulated command timeout");
        }
        return result();
      },
    );

    await new CodexExternalCommandProbe({ platform: "win32" }).probe({
      command: "rg",
      probeArgs: ["--version"],
      workspacePath: WORKSPACE,
      sandboxPolicy: SANDBOX_POLICY,
      executor: { execCommand },
    });
    expect(execCommand).toHaveBeenCalledTimes(1);
  });

  it("preserves an explicitly declared Windows extension", async () => {
    const execCommand = vi.fn().mockResolvedValue(result());

    await new CodexExternalCommandProbe({ platform: "win32" }).probe({
      command: "rg.exe",
      probeArgs: ["--version"],
      workspacePath: WORKSPACE,
      sandboxPolicy: SANDBOX_POLICY,
      executor: { execCommand },
    });

    expect(execCommand.mock.calls[0]?.[0].command).toEqual([
      "rg.exe",
      "--version",
    ]);
  });

  it.each(["rg", "rg.exe", "node-22", "python3.13", "tool_name"])(
    "accepts safe executable basename %s",
    (command) => {
      expect(isSafeExecutableBasename(command)).toBe(true);
    },
  );

  it.each([
    "",
    ".",
    "..",
    "rg command",
    "../rg",
    "bin/rg",
    "bin\\rg",
    "rg;rm",
    "rg$(whoami)",
    "rg\nnext",
    "-rg",
  ])("rejects unsafe executable basename %j", (command) => {
    expect(isSafeExecutableBasename(command)).toBe(false);
  });

  it("recognizes deterministic and transient capability error codes", () => {
    expect(
      isDeterministicCapabilityErrorCode(ERROR_CODES.requiredCommandNotFound),
    ).toBe(true);
    expect(
      isDeterministicCapabilityErrorCode(
        ERROR_CODES.requiredCommandExecutionDenied,
      ),
    ).toBe(true);
    expect(
      isDeterministicCapabilityErrorCode(
        ERROR_CODES.requiredCommandCapabilityTransient,
      ),
    ).toBe(false);
    expect(
      isCapabilityErrorCode(ERROR_CODES.requiredCommandCapabilityTransient),
    ).toBe(true);
    expect(
      isDeterministicCapabilityErrorCode(ERROR_CODES.githubPermissionDenied),
    ).toBe(true);
    expect(
      isDeterministicCapabilityErrorCode(ERROR_CODES.githubRemoteMissing),
    ).toBe(true);
    expect(isCapabilityErrorCode(ERROR_CODES.githubRemoteMissing)).toBe(true);
    expect(isCapabilityErrorCode(ERROR_CODES.githubCapabilityTransient)).toBe(
      true,
    );
    expect(isCapabilityErrorCode(ERROR_CODES.hookFailed)).toBe(false);
  });
});

function result(
  stdout = "",
  stderr = "",
  exitCode = 0,
): CodexCommandExecResult {
  return { exitCode, stdout, stderr };
}

async function captureError(
  promise: Promise<unknown>,
): Promise<ExternalCommandCapabilityError> {
  try {
    await promise;
    throw new Error("Expected promise to reject.");
  } catch (error) {
    return error as ExternalCommandCapabilityError;
  }
}

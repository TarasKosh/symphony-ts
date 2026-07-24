import { describe, expect, it, vi } from "vitest";

import {
  GITHUB_CAPABILITY_DIAGNOSTIC_BYTES_CAP,
  GITHUB_CAPABILITY_OUTPUT_BYTES_CAP,
  GhGithubCapabilityProbe,
  type GithubCapabilityError,
  isDeterministicGithubCapabilityErrorCode,
  isGithubCapabilityErrorCode,
  resolveGithubCapabilityProbeTimeoutMs,
} from "../../src/agent/github-capability.js";
import type { CodexCommandExecResult } from "../../src/codex/app-server-client.js";
import { ERROR_CODES } from "../../src/errors/codes.js";

const WORKSPACE = "C:\\workspaces\\ABC-123";
const SANDBOX_POLICY = {
  type: "workspaceWrite",
  writableRoots: [WORKSPACE, `${WORKSPACE}\\.git`],
};
const MISSING_GITHUB_REMOTE_DIAGNOSTIC =
  "none of the git remotes configured for this repository point to a known GitHub host.\nTo tell gh about a new GitHub host, please use `gh auth login`";
const NOT_A_GIT_REPOSITORY_DIAGNOSTIC =
  "fatal: not a git repository (or any of the parent directories): .git";
const DIAGNOSTIC_PREFIX = "GitHub CLI diagnostic: ";

describe("GhGithubCapabilityProbe", () => {
  it("allows for Windows command/exec sandbox startup overhead", () => {
    expect(resolveGithubCapabilityProbeTimeoutMs("win32")).toBe(60_000);
    expect(resolveGithubCapabilityProbeTimeoutMs("linux")).toBe(15_000);
    expect(resolveGithubCapabilityProbeTimeoutMs("darwin")).toBe(15_000);
  });

  it("checks identity, target repository, and push permission with non-mutating argv commands", async () => {
    const execCommand = vi
      .fn()
      .mockResolvedValueOnce(result("octocat\n"))
      .mockResolvedValueOnce(result("example/project\n"))
      .mockResolvedValueOnce(result("true\n"));
    const probe = new GhGithubCapabilityProbe({ platform: "win32" });

    await expect(
      probe.probe({
        workspacePath: WORKSPACE,
        sandboxPolicy: SANDBOX_POLICY,
        executor: { execCommand },
      }),
    ).resolves.toEqual({
      identity: "octocat",
      repository: "example/project",
      canPush: true,
    });

    expect(execCommand.mock.calls.map(([input]) => input.command)).toEqual([
      ["gh", "api", "user", "--jq", ".login"],
      [
        "gh",
        "repo",
        "view",
        "--json",
        "nameWithOwner",
        "--jq",
        ".nameWithOwner",
      ],
      ["gh", "api", "repos/example/project", "--jq", ".permissions.push"],
    ]);
    for (const [input] of execCommand.mock.calls) {
      expect(input).toMatchObject({
        cwd: WORKSPACE,
        timeoutMs: 60_000,
        sandboxPolicy: SANDBOX_POLICY,
      });
      if (process.platform === "win32") {
        expect(input).not.toHaveProperty("outputBytesCap");
      } else {
        expect(input.outputBytesCap).toBe(GITHUB_CAPABILITY_OUTPUT_BYTES_CAP);
      }
      expect(input).not.toHaveProperty("env");
    }
  });

  it("keeps the existing command timeout outside Windows", async () => {
    const execCommand = vi
      .fn()
      .mockResolvedValueOnce(result("octocat\n"))
      .mockResolvedValueOnce(result("example/project\n"))
      .mockResolvedValueOnce(result("true\n"));

    await new GhGithubCapabilityProbe({ platform: "linux" }).probe({
      workspacePath: WORKSPACE,
      sandboxPolicy: SANDBOX_POLICY,
      executor: { execCommand },
    });

    expect(execCommand.mock.calls.map(([input]) => input.timeoutMs)).toEqual([
      15_000, 15_000, 15_000,
    ]);
  });

  it("allows Windows probe steps beyond the previous timeout budget", async () => {
    const outputs = ["octocat\n", "example/project\n", "true\n"];
    const simulatedDurationMs = 20_000;
    const execCommand = vi.fn(
      async (input: { timeoutMs: number }): Promise<CodexCommandExecResult> => {
        if (input.timeoutMs <= simulatedDurationMs) {
          throw new Error("simulated command timeout");
        }
        return result(outputs.shift() ?? "");
      },
    );

    await expect(
      new GhGithubCapabilityProbe({ platform: "win32" }).probe({
        workspacePath: WORKSPACE,
        sandboxPolicy: SANDBOX_POLICY,
        executor: { execCommand },
      }),
    ).resolves.toMatchObject({
      identity: "octocat",
      repository: "example/project",
      canPush: true,
    });
    expect(execCommand).toHaveBeenCalledTimes(3);
  });

  it.each([
    {
      label: "missing executable",
      response: result("", "gh: command not found", 127),
      code: ERROR_CODES.githubCliNotFound,
      deterministic: true,
      diagnostic: "gh: command not found",
    },
    {
      label: "HTTP 401",
      response: result("", "HTTP 401: Bad credentials token=secret-value", 1),
      code: ERROR_CODES.githubAuthInvalid,
      deterministic: true,
      diagnostic: "HTTP 401: Bad credentials",
    },
    {
      label: "HTTP 403",
      response: result("", "HTTP 403: Forbidden token=secret-value", 1),
      code: ERROR_CODES.githubPermissionDenied,
      deterministic: true,
      diagnostic: "HTTP 403: Forbidden",
    },
    {
      label: "timeout or network failure",
      response: result("", "request timed out token=secret-value", 1),
      code: ERROR_CODES.githubCapabilityTransient,
      deterministic: false,
      diagnostic: "request timed out",
    },
  ])("classifies and redacts $label", async (input) => {
    const probe = new GhGithubCapabilityProbe();

    const error = await captureError(
      probe.probe({
        workspacePath: WORKSPACE,
        sandboxPolicy: SANDBOX_POLICY,
        executor: {
          execCommand: vi.fn().mockResolvedValue(input.response),
        },
      }),
    );

    expect(error).toMatchObject({
      name: "GithubCapabilityError",
      code: input.code,
      capability: "github",
      deterministic: input.deterministic,
    } satisfies Partial<GithubCapabilityError>);
    expect(error.message).toContain(input.diagnostic);
    expect(error.message).not.toContain("secret-value");
    expect(error.message).not.toContain("token=");
  });

  it("classifies a workspace without a GitHub-backed remote instead of the login remediation hint", async () => {
    const execCommand = vi
      .fn()
      .mockResolvedValueOnce(result("octocat\n"))
      .mockResolvedValueOnce(result("", MISSING_GITHUB_REMOTE_DIAGNOSTIC, 1));

    const error = await captureError(
      new GhGithubCapabilityProbe().probe({
        workspacePath: WORKSPACE,
        sandboxPolicy: SANDBOX_POLICY,
        executor: { execCommand },
      }),
    );

    expect(error).toMatchObject({
      code: ERROR_CODES.githubRemoteMissing,
      deterministic: true,
    } satisfies Partial<GithubCapabilityError>);
    expect(error.code).not.toBe(ERROR_CODES.githubAuthInvalid);
    expect(error.message).toContain("ticket workspace 'ABC-123'");
    expect(error.message).toContain("has no GitHub-backed git remote");
    expect(error.message).toContain(
      "none of the git remotes configured for this repository point to a known GitHub host.",
    );
    expect(error.message).toContain("please use `gh auth login`");
    expect(error.message).not.toContain("authentication is invalid or expired");
    expect(execCommand.mock.calls.map(([input]) => input.command)).toEqual([
      ["gh", "api", "user", "--jq", ".login"],
      [
        "gh",
        "repo",
        "view",
        "--json",
        "nameWithOwner",
        "--jq",
        ".nameWithOwner",
      ],
    ]);
  });

  it("classifies a non-repository workspace as a missing GitHub remote", async () => {
    const execCommand = vi
      .fn()
      .mockResolvedValueOnce(result("octocat\n"))
      .mockResolvedValueOnce(result("", NOT_A_GIT_REPOSITORY_DIAGNOSTIC, 1));

    await expect(
      new GhGithubCapabilityProbe().probe({
        workspacePath: WORKSPACE,
        sandboxPolicy: SANDBOX_POLICY,
        executor: { execCommand },
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.githubRemoteMissing,
      deterministic: true,
    } satisfies Partial<GithubCapabilityError>);
  });

  it.each([
    {
      label: "missing remote during identity",
      diagnostic: MISSING_GITHUB_REMOTE_DIAGNOSTIC,
      responses: [result("", MISSING_GITHUB_REMOTE_DIAGNOSTIC, 1)],
    },
    {
      label: "not a repository during identity",
      diagnostic: NOT_A_GIT_REPOSITORY_DIAGNOSTIC,
      responses: [result("", NOT_A_GIT_REPOSITORY_DIAGNOSTIC, 1)],
    },
    {
      label: "missing remote during permission",
      diagnostic: MISSING_GITHUB_REMOTE_DIAGNOSTIC,
      responses: [
        result("octocat\n"),
        result("example/project\n"),
        result("", MISSING_GITHUB_REMOTE_DIAGNOSTIC, 1),
      ],
    },
    {
      label: "not a repository during permission",
      diagnostic: NOT_A_GIT_REPOSITORY_DIAGNOSTIC,
      responses: [
        result("octocat\n"),
        result("example/project\n"),
        result("", NOT_A_GIT_REPOSITORY_DIAGNOSTIC, 1),
      ],
    },
  ])("keeps repository diagnostics step-scoped: $label", async (input) => {
    const execCommand = vi.fn();
    for (const response of input.responses) {
      execCommand.mockResolvedValueOnce(response);
    }

    const error = await captureError(
      new GhGithubCapabilityProbe().probe({
        workspacePath: WORKSPACE,
        sandboxPolicy: SANDBOX_POLICY,
        executor: { execCommand },
      }),
    );

    expect(error.code).toBe(ERROR_CODES.githubCapabilityTransient);
    expect(error.message).toContain(
      input.diagnostic.split("\n", 1)[0] ?? input.diagnostic,
    );
  });

  it("prefers a concrete HTTP 403 over textual authentication wording", async () => {
    const error = await captureError(
      new GhGithubCapabilityProbe().probe({
        workspacePath: WORKSPACE,
        sandboxPolicy: SANDBOX_POLICY,
        executor: {
          execCommand: vi
            .fn()
            .mockResolvedValue(
              result("", "HTTP 403: request requires authentication", 1),
            ),
        },
      }),
    );

    expect(error.code).toBe(ERROR_CODES.githubPermissionDenied);
  });

  it.each([
    "bad credentials",
    "not logged in",
    "not authenticated",
    "authentication failed",
    "requires authentication",
  ])("classifies genuine authentication evidence: %s", async (stderr) => {
    const error = await captureError(
      new GhGithubCapabilityProbe().probe({
        workspacePath: WORKSPACE,
        sandboxPolicy: SANDBOX_POLICY,
        executor: {
          execCommand: vi.fn().mockResolvedValue(result("", stderr, 1)),
        },
      }),
    );

    expect(error.code).toBe(ERROR_CODES.githubAuthInvalid);
  });

  it("classifies GitHub's integration permission diagnostic", async () => {
    const error = await captureError(
      new GhGithubCapabilityProbe().probe({
        workspacePath: WORKSPACE,
        sandboxPolicy: SANDBOX_POLICY,
        executor: {
          execCommand: vi
            .fn()
            .mockResolvedValue(
              result("", "Resource not accessible by integration", 1),
            ),
        },
      }),
    );

    expect(error.code).toBe(ERROR_CODES.githubPermissionDenied);
  });

  it.each([
    {
      label: "HTTP 401 before HTTP 403",
      stderr: "HTTP 401: Bad credentials; HTTP 403: Forbidden",
      code: ERROR_CODES.githubAuthInvalid,
    },
    {
      label: "missing remote before HTTP 401",
      stderr: `${MISSING_GITHUB_REMOTE_DIAGNOSTIC}\nHTTP 401: Bad credentials`,
      code: ERROR_CODES.githubRemoteMissing,
    },
    {
      label: "missing remote before HTTP 403",
      stderr: `${MISSING_GITHUB_REMOTE_DIAGNOSTIC}\nHTTP 403: Forbidden`,
      code: ERROR_CODES.githubRemoteMissing,
    },
  ])("uses deterministic precedence for $label", async (input) => {
    const execCommand = vi
      .fn()
      .mockResolvedValueOnce(result("octocat\n"))
      .mockResolvedValueOnce(result("", input.stderr, 1));
    const error = await captureError(
      new GhGithubCapabilityProbe().probe({
        workspacePath: WORKSPACE,
        sandboxPolicy: SANDBOX_POLICY,
        executor: { execCommand },
      }),
    );

    expect(error.code).toBe(input.code);
  });

  it("keeps a near-miss remote diagnostic transient", async () => {
    const stderr =
      "some git remotes configured here might not point to a known host";
    const execCommand = vi
      .fn()
      .mockResolvedValueOnce(result("octocat\n"))
      .mockResolvedValueOnce(result("", stderr, 1));
    const error = await captureError(
      new GhGithubCapabilityProbe().probe({
        workspacePath: WORKSPACE,
        sandboxPolicy: SANDBOX_POLICY,
        executor: { execCommand },
      }),
    );

    expect(error.code).toBe(ERROR_CODES.githubCapabilityTransient);
  });

  it.each([
    "Please use gh auth login",
    "HTTP 401: Bad credentials",
    "HTTP 403: Forbidden",
    "none of the git remotes configured for this repository point to a known GitHub host.",
  ])("does not classify stdout text as a diagnostic: %s", async (stdout) => {
    const stderr = "request timed out while contacting api.github.com";
    const error = await captureError(
      new GhGithubCapabilityProbe().probe({
        workspacePath: WORKSPACE,
        sandboxPolicy: SANDBOX_POLICY,
        executor: {
          execCommand: vi.fn().mockResolvedValue(result(stdout, stderr, 1)),
        },
      }),
    );

    expect(error.code).toBe(ERROR_CODES.githubCapabilityTransient);
    expect(error.message).toContain(stderr);
    expect(error.message).not.toContain(stdout);
  });

  it("does not fall back to stdout when stderr is empty", async () => {
    const stdout = "HTTP 401: Bad credentials; please use gh auth login";
    const error = await captureError(
      new GhGithubCapabilityProbe().probe({
        workspacePath: WORKSPACE,
        sandboxPolicy: SANDBOX_POLICY,
        executor: {
          execCommand: vi.fn().mockResolvedValue(result(stdout, "", 1)),
        },
      }),
    );

    expect(error.code).toBe(ERROR_CODES.githubCapabilityTransient);
    expect(error.message).not.toContain(stdout);
    expect(error.message).not.toContain(DIAGNOSTIC_PREFIX);
  });

  it.each([
    "gh: no such file or directory",
    "Forbidden by a local proxy",
    "permission denied while opening a local config file",
    "To recover, use gh auth login",
  ])("keeps a broad stderr substring transient: %s", async (stderr) => {
    const error = await captureError(
      new GhGithubCapabilityProbe().probe({
        workspacePath: WORKSPACE,
        sandboxPolicy: SANDBOX_POLICY,
        executor: {
          execCommand: vi.fn().mockResolvedValue(result("", stderr, 1)),
        },
      }),
    );

    expect(error.code).toBe(ERROR_CODES.githubCapabilityTransient);
    expect(error.message).toContain(stderr);
  });

  it("bounds classification to the GitHub command output cap", async () => {
    const stderr = `${"x".repeat(GITHUB_CAPABILITY_OUTPUT_BYTES_CAP)}HTTP 401: Bad credentials`;
    const error = await captureError(
      new GhGithubCapabilityProbe().probe({
        workspacePath: WORKSPACE,
        sandboxPolicy: SANDBOX_POLICY,
        executor: {
          execCommand: vi.fn().mockResolvedValue(result("", stderr, 1)),
        },
      }),
    );

    expect(error.code).toBe(ERROR_CODES.githubCapabilityTransient);
    expect(error.message).not.toContain("HTTP 401");
  });

  it("preserves valid UTF-8 when the classification cap splits a code point", async () => {
    const stderr = `${"x".repeat(
      GITHUB_CAPABILITY_OUTPUT_BYTES_CAP - 1,
    )}🙂HTTP 401: Bad credentials`;
    const error = await captureError(
      new GhGithubCapabilityProbe().probe({
        workspacePath: WORKSPACE,
        sandboxPolicy: SANDBOX_POLICY,
        executor: {
          execCommand: vi.fn().mockResolvedValue(result("", stderr, 1)),
        },
      }),
    );

    expect(error.code).toBe(ERROR_CODES.githubCapabilityTransient);
    expect(error.message).not.toContain("HTTP 401");
    expect(error.message).not.toContain("�");
  });

  it("redacts split GitHub tokens and authorization values from the diagnostic", async () => {
    const fakeToken = ["ghp_", "a".repeat(36)].join("");
    const splitToken = `g\u200bh\np_${"b".repeat(36)}`;
    const stderr = `HTTP 401: Bad credentials ${splitToken}; Authorization: Bearer ${fakeToken}`;
    const error = await captureError(
      new GhGithubCapabilityProbe().probe({
        workspacePath: WORKSPACE,
        sandboxPolicy: SANDBOX_POLICY,
        executor: {
          execCommand: vi.fn().mockResolvedValue(result("", stderr, 1)),
        },
      }),
    );

    expect(error.code).toBe(ERROR_CODES.githubAuthInvalid);
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain(fakeToken);
    expect(error.message).not.toContain("ghp_");
    expect(error.message).not.toContain("Authorization");
    expect(error.message).not.toContain("\n");
    expect(error.message).not.toContain("\u200b");
  });

  it.each(["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"])(
    "redacts the GitHub token family %s",
    async (tokenPrefix) => {
      const fakeToken = [tokenPrefix, "a".repeat(48)].join("");
      const stderr = `HTTP 401: Bad credentials ${fakeToken}; retained context`;
      const error = await captureError(
        new GhGithubCapabilityProbe().probe({
          workspacePath: WORKSPACE,
          sandboxPolicy: SANDBOX_POLICY,
          executor: {
            execCommand: vi.fn().mockResolvedValue(result("", stderr, 1)),
          },
        }),
      );

      expect(error.message).toContain("[REDACTED]");
      expect(error.message).not.toContain(fakeToken);
      expect(error.message).not.toContain(tokenPrefix);
    },
  );

  it.each([
    "GH_TOKEN=opaque-value",
    "GITHUB_TOKEN='opaque-value'",
    '"token":"opaque-value"',
    "access_token=opaque-value",
    "Authorization: Bearer opaque-value",
    "Bearer opaque-value",
  ])("redacts the credential construct %s", async (credential) => {
    const stderr = `HTTP 401: Bad credentials; ${credential}`;
    const error = await captureError(
      new GhGithubCapabilityProbe().probe({
        workspacePath: WORKSPACE,
        sandboxPolicy: SANDBOX_POLICY,
        executor: {
          execCommand: vi.fn().mockResolvedValue(result("", stderr, 1)),
        },
      }),
    );

    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain("opaque-value");
  });

  it.each(["\r", "\t", "\0", "\u2028", "\u200b", "\u001b[31m"])(
    "redacts a token split by control sequence %j",
    async (separator) => {
      const splitToken = `g${separator}h${separator}p_${"a".repeat(36)}`;
      const stderr = `HTTP 401: Bad credentials ${splitToken}`;
      const error = await captureError(
        new GhGithubCapabilityProbe().probe({
          workspacePath: WORKSPACE,
          sandboxPolicy: SANDBOX_POLICY,
          executor: {
            execCommand: vi.fn().mockResolvedValue(result("", stderr, 1)),
          },
        }),
      );

      expect(error.message).toContain("[REDACTED]");
      expect(error.message).not.toContain("p_");
      expect(error.message).not.toContain(separator);
      expect(error.message).not.toContain("\r");
      expect(error.message).not.toContain("\n");
    },
  );

  it("redacts before truncating so context after a long token remains visible", async () => {
    const longFakeToken = ["gho_", "a".repeat(3_000)].join("");
    const sentinel = "retained-after-redaction";
    const stderr = `HTTP 401: Bad credentials ${longFakeToken}; ${sentinel}`;
    const error = await captureError(
      new GhGithubCapabilityProbe().probe({
        workspacePath: WORKSPACE,
        sandboxPolicy: SANDBOX_POLICY,
        executor: {
          execCommand: vi.fn().mockResolvedValue(result("", stderr, 1)),
        },
      }),
    );

    expect(error.message).toContain("[REDACTED]");
    expect(error.message).toContain(sentinel);
    expect(error.message).not.toContain("… [truncated]");
    expect(error.message).not.toContain(longFakeToken);
  });

  it("truncates the diagnostic excerpt by UTF-8 bytes after redaction", async () => {
    const stderr = `HTTP 401: Bad credentials ${"🙂".repeat(
      GITHUB_CAPABILITY_DIAGNOSTIC_BYTES_CAP,
    )}`;
    const error = await captureError(
      new GhGithubCapabilityProbe().probe({
        workspacePath: WORKSPACE,
        sandboxPolicy: SANDBOX_POLICY,
        executor: {
          execCommand: vi.fn().mockResolvedValue(result("", stderr, 1)),
        },
      }),
    );
    const excerpt = error.message.split(DIAGNOSTIC_PREFIX)[1];

    expect(GITHUB_CAPABILITY_DIAGNOSTIC_BYTES_CAP).toBe(2_048);
    expect(excerpt).toBeDefined();
    expect(Buffer.byteLength(excerpt ?? "", "utf8")).toBeLessThanOrEqual(2_048);
    expect(excerpt).toContain("… [truncated]");
    expect(excerpt).not.toContain("�");
    expect(excerpt).not.toContain("\r");
    expect(excerpt).not.toContain("\n");
  });

  it("classifies push=false separately from transient failures", async () => {
    const execCommand = vi
      .fn()
      .mockResolvedValueOnce(result("octocat\n"))
      .mockResolvedValueOnce(result("example/project\n"))
      .mockResolvedValueOnce(result("false\n"));

    await expect(
      new GhGithubCapabilityProbe().probe({
        workspacePath: WORKSPACE,
        sandboxPolicy: SANDBOX_POLICY,
        executor: { execCommand },
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.githubPermissionDenied,
      deterministic: true,
    } satisfies Partial<GithubCapabilityError>);
  });

  it("redacts executor failures and classifies them as transient", async () => {
    const rejected = Object.assign(
      new Error("socket failed token=secret-value"),
      {
        code: "ENOENT",
        path: "gh",
        syscall: "spawn gh",
      },
    );
    const error = await captureError(
      new GhGithubCapabilityProbe().probe({
        workspacePath: WORKSPACE,
        sandboxPolicy: SANDBOX_POLICY,
        executor: {
          execCommand: vi.fn().mockRejectedValue(rejected),
        },
      }),
    );

    expect(error.code).toBe(ERROR_CODES.githubCapabilityTransient);
    expect(error.message).toContain("socket failed");
    expect(error.message).toContain(DIAGNOSTIC_PREFIX);
    expect(error.message).not.toContain("secret-value");
  });

  it("recognizes the missing-remote code as a deterministic GitHub capability error", () => {
    expect(
      isDeterministicGithubCapabilityErrorCode(ERROR_CODES.githubRemoteMissing),
    ).toBe(true);
    expect(isGithubCapabilityErrorCode(ERROR_CODES.githubRemoteMissing)).toBe(
      true,
    );
  });
});

function result(
  stdout: string,
  stderr = "",
  exitCode = 0,
): CodexCommandExecResult {
  return { exitCode, stdout, stderr };
}

async function captureError(
  promise: Promise<unknown>,
): Promise<GithubCapabilityError> {
  try {
    await promise;
    throw new Error("Expected promise to reject.");
  } catch (error) {
    return error as GithubCapabilityError;
  }
}
